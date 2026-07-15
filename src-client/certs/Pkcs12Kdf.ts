/* =============================================================================
   KDF DE PKCS#12 (RFC 7292, Annexe B.2) — dérivation par mot de passe PROPRE au
   format PKCS#12, distincte de PBKDF2. Module PUR : WebCrypto (crypto.subtle.digest)
   seul — aucun DOM, aucun réseau, aucun Buffer Node → testable headless.

   POURQUOI un KDF maison (même esprit que l'encodeur OpenSSH, exception assumée au
   principe n°11) : le MAC d'intégrité d'un fichier PKCS#12 N'utilise PAS PBKDF2 mais
   ce KDF historique de PKCS#12 — c'est ce qu'exige OpenSSL ≥ 1.1 pour VÉRIFIER le MAC
   (PBMAC1/RFC 9579, qui autoriserait PBKDF2 pour le MAC, est trop récent pour les
   consommateurs visés). Aucune librairie navigateur éprouvée n'expose ce KDF ; il est
   court, entièrement spécifié, et VALIDÉ PAR FIXTURE CROISÉE openssl (la clé de MAC
   dérivée ici, passée à HMAC-SHA-256, reproduit au bit près le MAC d'un .p12 openssl —
   cf. Tests/modules/test-certs.js). Le chiffrement des clés/certs, lui, reste sur
   PBKDF2 natif WebCrypto (cf. Pkcs12Builder) : ce KDF ne sert QUE la clé de MAC.

   ⚠ ENCODAGE DU MOT DE PASSE : PKCS#12 exige ici un BMPString (UTF-16BE + terminateur
   0x0000) — à l'inverse de PBES2/PBKDF2 qui prend les octets UTF-8 bruts. Ces deux
   conventions DIFFÉRENTES pour la même passphrase sont un piège d'interopérabilité
   classique ; elles ont été vérifiées empiriquement contre openssl.
   ============================================================================= */
export class Pkcs12Kdf {
  /** Sortie de SHA-256 : 32 octets (u dans la spec). */
  private static readonly U = 32;
  /** Taille de bloc de SHA-256 : 64 octets (v dans la spec) — pilote la longueur de D/S/P. */
  private static readonly V = 64;
  /** Diversificateur « clé d'intégrité (MAC) » (RFC 7292 §B.3 : 1=chiffrement, 2=IV, 3=MAC). */
  static readonly ID_MAC = 3;

  /** Encode une passphrase en BMPString PKCS#12 : chaque unité UTF-16 en gros-boutiste,
      suivie d'un terminateur 0x0000. Convient aux passphrases d'infrastructure (ASCII/BMP)
      et reproduit le comportement d'openssl (vérifié par fixture croisée). */
  static bmpString(passphrase: string): Uint8Array {
    const out = new Uint8Array((passphrase.length + 1) * 2); // +1 = terminateur 0x0000
    for (let i = 0; i < passphrase.length; i++) {
      const code = passphrase.charCodeAt(i);
      out[i * 2] = (code >> 8) & 0xff; // octet de poids fort (UTF-16 BIG-endian)
      out[i * 2 + 1] = code & 0xff;
    }
    return out; // les deux derniers octets restent à 0 (terminateur)
  }

  /** Dérive `length` octets selon PKCS#12 §B.2 : H^r(D‖I) par bloc, avec réinjection
      additive (I_j ← I_j + B + 1 mod 2^(8v)) entre blocs. Asynchrone car SHA-256 passe
      par crypto.subtle.digest. Le seul appelant v1 dérive la clé de MAC (id=3, 32 octets). */
  static async derive(id: number, password: Uint8Array, salt: Uint8Array, iterations: number, length: number): Promise<Uint8Array> {
    if (!(iterations >= 1)) throw new Error("Pkcs12Kdf : nombre d'itérations invalide (≥ 1 attendu)");
    const { U, V } = Pkcs12Kdf;
    // D = l'octet diversificateur répété sur toute une taille de bloc (v octets).
    const D = new Uint8Array(V).fill(id);
    // S = sel répété jusqu'à un multiple de v ; P = mot de passe répété jusqu'à un multiple de v.
    const S = Pkcs12Kdf.extend(salt, V);
    const P = Pkcs12Kdf.extend(password, V);
    const I = Pkcs12Kdf.concat(S, P); // I = S‖P, une suite de blocs de v octets
    const blocks = I.length / V;
    const count = Math.ceil(length / U); // nombre de blocs A_i à produire
    const out = new Uint8Array(count * U);
    const one = new Uint8Array(V); one[V - 1] = 1; // l'entier 1 sur v octets (le « +1 » de la spec)

    for (let i = 0; i < count; i++) {
      // A_i = H appliqué r fois, la première sur D‖I.
      let a = await Pkcs12Kdf.sha256(Pkcs12Kdf.concat(D, I));
      for (let r = 1; r < iterations; r++) a = await Pkcs12Kdf.sha256(a);
      out.set(a, i * U);
      // B = A_i répété/tronqué à v octets ; sert de terme additif réinjecté dans I.
      const B = Pkcs12Kdf.extend(a, V).subarray(0, V);
      // Chaque bloc de v octets de I : I_j = (I_j + B + 1) mod 2^(8v) — la subarray est une VUE,
      // la mutation se répercute donc dans I pour l'itération suivante.
      for (let j = 0; j < blocks; j++) {
        const block = I.subarray(j * V, j * V + V);
        Pkcs12Kdf.addInto(block, B);
        Pkcs12Kdf.addInto(block, one);
      }
    }
    return out.subarray(0, length);
  }

  /* --------------------------------------------------------------------------
     Helpers privés (octets uniquement — pas de Buffer Node)
     -------------------------------------------------------------------------- */

  /** Répète `src` jusqu'à la longueur MULTIPLE de `block` immédiatement suffisante
      (comportement des chaînes S/P de la spec). `src` vide → sortie vide. */
  private static extend(src: Uint8Array, block: number): Uint8Array {
    if (src.length === 0) return new Uint8Array(0);
    const len = block * Math.ceil(src.length / block);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = src[i % src.length];
    return out;
  }

  /** dst ← (dst + add) mod 2^(8·dst.length), gros-boutiste (addition sur octets avec retenue). */
  private static addInto(dst: Uint8Array, add: Uint8Array): void {
    let carry = 0;
    for (let i = dst.length - 1; i >= 0; i--) {
      const sum = dst[i] + add[i] + carry;
      dst[i] = sum & 0xff;
      carry = sum >> 8;
    }
  }

  private static concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  private static async sha256(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  }
}

/* =============================================================================
   PRIMITIVES D'ENCODAGE « WIRE » SSH — brique de bas niveau réutilisable par
   tous les encodeurs OpenSSH (clé publique authorized_keys, clé privée
   openssh-key-v1, certificat SSH signé). Module PUR : uniquement des octets
   (Uint8Array + btoa/atob comme PkiCrypto) — aucun DOM, aucun réseau, aucun
   Buffer Node → testable headless sous Node comme le reste de la PKI.

   Le format « wire » d'OpenSSH (RFC 4251 §5) sérialise des types simples :
   - uint32 / uint64 : entiers gros-boutistes (big-endian) de 4 / 8 octets ;
   - string          : uint32 de LONGUEUR suivi des octets bruts (une « string »
                       SSH est un tampon binaire, pas forcément du texte) ;
   - mpint           : entier multi-précision SIGNÉ (complément à deux),
                       longueur minimale, avec la RÈGLE DU ZÉRO DE TÊTE
                       (cf. mpint() ci-dessous) — utilisé pour n/e des clés RSA.

   Cette classe est un CONSTRUCTEUR incrémental (état = liste de tronçons) :
   chaque méthode renvoie `this` pour chaîner l'écriture, `build()` concatène.
   Les utilitaires sans état (utf8, concat, base64) sont des méthodes statiques.
   ============================================================================= */
export class SshWire {
  /** Tronçons accumulés (concaténés en une seule passe par build()). */
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  /** Ajoute des octets BRUTS (sans préfixe de longueur). */
  raw(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }

  /** Entier non signé 32 bits, gros-boutiste (big-endian). */
  uint32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error("SshWire : uint32 hors bornes [0, 2^32)");
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, false);
    return this.raw(bytes);
  }

  /** Entier non signé 64 bits, gros-boutiste (epoch de validité, serial…).
      Accepte number OU bigint : les serials de certificat sont des uint64
      complets, au-delà de Number.MAX_SAFE_INTEGER. */
  uint64(value: number | bigint): this {
    const big = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    if (big < 0n || big > 0xffffffffffffffffn) throw new Error("SshWire : uint64 hors bornes [0, 2^64)");
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, big, false);
    return this.raw(bytes);
  }

  /** « string » SSH : uint32 de longueur suivi des octets (tampon binaire). */
  string(bytes: Uint8Array): this {
    this.uint32(bytes.length);
    return this.raw(bytes);
  }

  /** « string » SSH à partir de TEXTE (encodé UTF-8) : noms d'algorithme,
      commentaires, identifiants… */
  cstring(text: string): this {
    return this.string(SshWire.utf8(text));
  }

  /** mpint SSH : entier multi-précision SIGNÉ, longueur minimale.
      RÈGLE DU ZÉRO DE TÊTE : comme le mpint est signé (complément à deux), une
      valeur POSITIVE dont l'octet de poids fort a le bit 0x80 armé DOIT être
      préfixée d'un 0x00 — sinon elle serait relue comme NÉGATIVE. Indispensable
      pour le module n (et parfois e) des clés RSA. Une valeur nulle → mpint vide. */
  mpint(magnitude: Uint8Array): this {
    // Représentation minimale : on retire les zéros de tête superflus.
    let start = 0;
    while (start < magnitude.length && magnitude[start] === 0) start++;
    const trimmed = magnitude.subarray(start);
    if (trimmed.length === 0) return this.uint32(0); // entier nul → longueur 0, aucun octet
    if ((trimmed[0] & 0x80) !== 0) {
      // Bit de poids fort armé : préfixer 0x00 pour rester POSITIF.
      this.uint32(trimmed.length + 1);
      this.raw(new Uint8Array([0]));
      return this.raw(trimmed);
    }
    this.uint32(trimmed.length);
    return this.raw(trimmed);
  }

  /** Concatène tous les tronçons écrits en un seul Uint8Array (une passe). */
  build(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /* --------------------------------------------------------------------------
     Utilitaires sans état (octets ↔ texte / base64), partagés par les encodeurs.
     -------------------------------------------------------------------------- */

  /** Texte → octets UTF-8 (TextEncoder : navigateur ET Node). */
  static utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  /** Concatène plusieurs tampons en un seul. */
  static concat(...parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /** Octets → base64 standard (btoa ; disponible navigateur et Node ≥ 16).
      Par tranches : String.fromCharCode(...tableau) sature la pile au-delà de ~100 Ko. */
  static toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  /** Base64 standard → octets (atob). */
  static fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
}

/* =============================================================================
   INTEROP WebCrypto ↔ FORMATS OpenSSH — extrait des clés WebCrypto le MATÉRIAU
   brut attendu par l'encodeur OpenSSH (OpenSshEncoder), et reconstruit une clé
   privée ed25519 signable à partir de sa graine. Module PUR : WebCrypto seul
   (navigateur ET Node ≥ 20 pour les tests) — aucun DOM, aucun réseau.

   Les clés de la PKI sont générées/importées via WebCrypto (comme X509Factory).
   Or l'encodeur OpenSSH raisonne en OCTETS bruts (graine ed25519, module/exposant
   RSA), pas en CryptoKey. Cette classe fait le pont, en un seul endroit :
   - ed25519 publique : export « raw » (32 octets) ;
   - ed25519 privée   : la GRAINE de 32 octets = les 32 DERNIERS octets de l'export
                        PKCS#8 (le préfixe ASN.1 d'un PKCS#8 ed25519 est FIXE,
                        cf. RFC 8410) ;
   - RSA publique     : module n et exposant e depuis l'export JWK (base64url) ;
   - signature de cert : reconstruit une CryptoKey ed25519 « sign » depuis la
                        graine, pour que crypto.subtle.sign produise la signature
                        du certificat (ed25519 DÉTERMINISTE — cf. OpenSshEncoder).
   ============================================================================= */
export class SshKeyMaterial {
  /** Préfixe ASN.1 FIXE d'un PKCS#8 ed25519 (RFC 8410) : 16 octets décrivant la
      structure, suivis des 32 octets de graine. On l'utilise pour RECONSTRUIRE un
      PKCS#8 à partir d'une graine ; l'extraction inverse prend les 32 derniers octets. */
  private static readonly ED25519_PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);

  /** Clé publique ed25519 (CryptoKey) → 32 octets bruts (pour authorized_keys / cert). */
  static async ed25519PublicRaw(publicKey: CryptoKey): Promise<Uint8Array> {
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    if (raw.length !== 32) throw new Error("SshKeyMaterial : clé publique ed25519 inattendue (32 octets requis)");
    return raw;
  }

  /** Clé privée ed25519 (CryptoKey extractible) → GRAINE de 32 octets.
      La graine = les 32 DERNIERS octets du PKCS#8 (préfixe ASN.1 fixe de 16 octets). */
  static async ed25519Seed(privateKey: CryptoKey): Promise<Uint8Array> {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
    if (pkcs8.length < 32) throw new Error("SshKeyMaterial : export PKCS#8 ed25519 trop court");
    return pkcs8.slice(pkcs8.length - 32);
  }

  /** Clé publique RSA (CryptoKey) → module n et exposant e en octets gros-boutistes
      (représentation minimale JWK ; l'encodeur applique la règle du zéro de tête mpint). */
  static async rsaPublicParts(publicKey: CryptoKey): Promise<{ modulus: Uint8Array; exponent: Uint8Array }> {
    const jwk = await crypto.subtle.exportKey("jwk", publicKey);
    if (!jwk.n || !jwk.e) throw new Error("SshKeyMaterial : JWK RSA sans module (n) ou exposant (e)");
    return { modulus: SshKeyMaterial.fromBase64Url(jwk.n), exponent: SshKeyMaterial.fromBase64Url(jwk.e) };
  }

  /** Reconstruit une CryptoKey ed25519 « sign » à partir d'une graine de 32 octets.
      Sert à SIGNER un certificat SSH quand on ne dispose que de la graine déchiffrée
      (la clé privée de la CA après déverrouillage). La clé est NON extractible : elle
      ne sert qu'à signer, sa graine ne ressort pas du moteur WebCrypto. */
  static async importEd25519PrivateForSigning(seed: Uint8Array): Promise<CryptoKey> {
    if (seed.length !== 32) throw new Error("SshKeyMaterial : graine ed25519 invalide (32 octets requis)");
    const pkcs8 = new Uint8Array(SshKeyMaterial.ED25519_PKCS8_PREFIX.length + 32);
    pkcs8.set(SshKeyMaterial.ED25519_PKCS8_PREFIX, 0);
    pkcs8.set(seed, SshKeyMaterial.ED25519_PKCS8_PREFIX.length);
    return crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, ["sign"]);
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** base64url (alphabet JWK : « - _ », padding optionnel) → octets. */
  private static fromBase64Url(b64url: string): Uint8Array {
    let standard = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (standard.length % 4 !== 0) standard += "=";
    // atob directement (sans dépendre de SshWire) : JWK n'a jamais de retour à la ligne.
    const binary = atob(standard);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
}

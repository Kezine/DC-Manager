/* =============================================================================
   CRYPTO CLIENT DE LA PKI — dérivation de la KEK (clé de chiffrement de clé) +
   enveloppe de la DEK (clé de chiffrement des données) + chiffrement des clés
   privées. Module PUR (WebCrypto seul : disponible dans le navigateur ET dans
   Node ≥ 18 pour les tests — aucun DOM, aucun réseau).

   ZÉRO-CONNAISSANCE (cadrage certs 2026-07-14 §2) : TOUT se passe ici, dans
   le navigateur — le serveur ne voit que le SEL, le nombre d'itérations et
   des blobs chiffrés (`wrapped_dek`, `key_enc`) qu'il est incapable de lire.

   CHIFFREMENT EN ENVELOPPE (décision « changement de phrase maître ») — DEUX
   clés, deux rôles, pour rendre le changement de phrase O(1) :

     phrase ──PBKDF2-SHA-256(sel)──► KEK ──AES-GCM──► wrapped_dek  (UN petit blob)
                                                          │  déchiffre
                                                          ▼
                       DEK (32 octets ALÉATOIRES, FIXE À VIE) ──AES-GCM──► key_enc

   - la DEK chiffre RÉELLEMENT toutes les clés privées ; tirée une fois à
     l'initialisation, elle NE CHANGE JAMAIS ;
   - la KEK, dérivée de la phrase, a pour SEUL travail de chiffrer (« emballer »)
     la DEK dans `wrapped_dek`. Changer la phrase = ré-emballer la DEK sous une
     nouvelle KEK (`rewrapDek`) : un seul petit blob réécrit, AUCUN `key_enc`
     touché (voir « Modèle cryptographique » dans docs/certs.md).

   Le `wrapped_dek` fait AUSSI office de keycheck : le déballage AES-GCM est
   AUTHENTIFIÉ — une mauvaise phrase produit une KEK fausse et `unwrapDek` JETTE.
   Pas de constante-témoin séparée à stocker.

   Extractibilité (correctif audit 2026-07-17) : l'enveloppe passe par
   `crypto.subtle.wrapKey`/`unwrapKey` — les octets de la DEK ne TOUCHENT JAMAIS
   la mémoire JS. Le déverrouillage produit une DEK de session NON extractible
   (unwrapKey extractable:false) : même sous page compromise (XSS), la clé maître
   peut être UTILISÉE mais pas EXFILTRÉE — strictement la garantie de l'ancienne
   clé dérivée directe. Seuls l'initialisation et le ré-emballage manipulent un
   handle extractible TRANSITOIRE (le temps d'un wrapKey), jamais exporté vers JS.

   Limite ASSUMÉE (documentée) : phrase perdue = KEK irrécupérable = DEK
   irrécupérable = clés privées perdues — c'est le but (aucune récupération, ni
   par nous ni par le serveur).
   ============================================================================= */
export class PkiCrypto {
  /** Version du schéma de dérivation/chiffrement (colonne kdf_version + préfixe des blobs). */
  static readonly KDF_VERSION = "v1";
  /** Itérations PBKDF2 par défaut à l'INITIALISATION (décision Q1 : ≥ 600 000 —
      les documents existants gardent leur valeur stockée, relue à chaque dérivation). */
  static readonly DEFAULT_ITERS = 600000;

  /** WebCrypto complet disponible ? `crypto.subtle` n'existe que dans un CONTEXTE SÉCURISÉ
      (HTTPS ou localhost) — servi en HTTP sur un hôte de LAN, le navigateur le retire et
      toute la PKI est inopérante. L'UI teste AVANT d'offrir les opérations de clé (bandeau
      actionnable au lieu d'un TypeError « reading 'importKey' »). */
  static available(): boolean {
    return typeof crypto !== "undefined" && !!crypto.subtle;
  }

  /** Sel aléatoire (base64, 16 octets) pour l'initialisation de la PKI d'un document. */
  static generateSaltB64(): string {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    return PkiCrypto.toB64(salt);
  }

  /** Dérive la KEK : passphrase + sel + itérations → AES-256-GCM NON extractible.
      La KEK ne sert QU'À emballer/déballer la DEK (usages wrapKey/unwrapKey — elle ne
      peut même pas chiffrer autre chose). Les paramètres viennent du serveur
      (GET /certs/pki) — la passphrase, de l'utilisateur. */
  static async deriveKek(passphrase: string, saltB64: string, iterations: number): Promise<CryptoKey> {
    if (typeof passphrase !== "string" || passphrase === "") throw new Error("PkiCrypto : passphrase vide");
    // Ceinture (l'UI teste available() en amont) : sans elle, l'échec serait un TypeError
    // cryptique « Cannot read properties of undefined (reading 'importKey') ».
    if (!PkiCrypto.available()) {
      throw new Error("PkiCrypto : WebCrypto (crypto.subtle) indisponible — l'application doit être servie en HTTPS (ou ouverte via localhost) pour les opérations de clé");
    }
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: PkiCrypto.fromB64(saltB64) as BufferSource, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false, // NON extractible : la KEK vit dans le moteur WebCrypto, jamais en mémoire JS
      ["wrapKey", "unwrapKey"], // son SEUL métier : l'enveloppe de la DEK
    );
  }

  /** INITIALISATION d'un document : tire une DEK aléatoire, l'emballe sous la KEK
      (→ `wrapped_dek` à stocker) et rend la DEK de session NON extractible prête à
      chiffrer/déchiffrer les clés privées. Correctif audit 2026-07-17 : la génération
      produit un handle extractible TRANSITOIRE (nécessaire à wrapKey), dont les octets
      ne sont JAMAIS exportés vers JS — l'export a lieu à l'intérieur du moteur WebCrypto,
      directement dans le blob chiffré. La DEK rendue à la session est RE-déballée
      NON extractible (ce qui valide au passage l'enveloppe fraîchement écrite). */
  static async initDek(kek: CryptoKey): Promise<{ wrappedDek: string; dek: CryptoKey }> {
    const transient = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const wrappedDek = await PkiCrypto.wrapDek(kek, transient);
    // Le handle extractible `transient` sort de portée ici — la seule DEK qui survit est non extractible.
    const dek = await PkiCrypto.unwrapDek(kek, wrappedDek);
    return { wrappedDek, dek };
  }

  /** DÉVERROUILLAGE : déballe la DEK depuis `wrapped_dek` avec la KEK dérivée de la phrase.
      JETTE si la phrase est mauvaise (KEK fausse → GCM refuse l'authentification) — c'est
      la vérification de phrase elle-même (le `wrapped_dek` FAIT office de keycheck).
      `unwrapKey(…, extractable:false)` : la DEK naît NON extractible dans le moteur
      WebCrypto, ses octets ne passent JAMAIS par la mémoire JS. */
  static async unwrapDek(kek: CryptoKey, wrappedDek: string): Promise<CryptoKey> {
    const { iv, ciphertext } = PkiCrypto.parseBlob(wrappedDek);
    try {
      return await crypto.subtle.unwrapKey(
        "raw", ciphertext as BufferSource, kek,
        { name: "AES-GCM", iv: iv as BufferSource },
        { name: "AES-GCM" },
        false, // NON extractible : utilisable en session, jamais exfiltrable — même par du code compromis de la page
        ["encrypt", "decrypt"],
      );
    } catch {
      // GCM refuse l'authentification : mauvaise phrase ou blob altéré. Message SANS détail (rien à divulguer).
      throw new Error("PkiCrypto : déchiffrement refusé (clé différente ou donnée altérée)");
    }
  }

  /** CHANGEMENT DE PHRASE MAÎTRE — cœur de l'opération O(1) : déballe la DEK sous
      l'ANCIENNE KEK et la ré-emballe sous la NOUVELLE. AUCUN `key_enc` n'est touché
      (la DEK est identique avant/après) ; seul le petit `wrapped_dek` change. JETTE si
      l'ancienne phrase est mauvaise (déballage refusé). Le déballage intermédiaire est
      extractible (wrapKey l'exige) mais TRANSITOIRE et jamais exporté vers JS — les
      octets voyagent de blob à blob à l'intérieur du moteur WebCrypto. */
  static async rewrapDek(oldKek: CryptoKey, newKek: CryptoKey, wrappedDek: string): Promise<string> {
    const { iv, ciphertext } = PkiCrypto.parseBlob(wrappedDek);
    let transient: CryptoKey;
    try {
      transient = await crypto.subtle.unwrapKey(
        "raw", ciphertext as BufferSource, oldKek,
        { name: "AES-GCM", iv: iv as BufferSource },
        { name: "AES-GCM" },
        true, // extractible : indispensable à wrapKey ci-dessous — handle transitoire, jamais exporté vers JS
        ["encrypt", "decrypt"],
      );
    } catch {
      throw new Error("PkiCrypto : déchiffrement refusé (clé différente ou donnée altérée)");
    }
    return PkiCrypto.wrapDek(newKek, transient);
  }

  /** Chiffre un secret (clé privée PEM/PKCS#8, graine, ou DEK b64) → `v1:<iv>:<ct>` (base64).
      Deux appels sur le même clair produisent des sorties DIFFÉRENTES (IV aléatoire). Utilisé
      avec la DEK (clés privées) ET avec la KEK (enveloppe de la DEK) — même format, autre clé. */
  static async encryptSecret(key: CryptoKey, plainText: string): Promise<string> {
    const iv = new Uint8Array(12); // 96 bits : taille nominale GCM, unique par chiffrement
    crypto.getRandomValues(iv);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plainText));
    return PkiCrypto.KDF_VERSION + ":" + PkiCrypto.toB64(iv) + ":" + PkiCrypto.toB64(new Uint8Array(ciphertext));
  }

  /** Déchiffre une chaîne produite par encryptSecret(). Jette une erreur EXPLICITE (sans
      aucune donnée sensible) si le format est inconnu, la clé différente ou le contenu altéré. */
  static async decryptSecret(key: CryptoKey, stored: string): Promise<string> {
    const { iv, ciphertext } = PkiCrypto.parseBlob(stored);
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
      return new TextDecoder().decode(plain);
    } catch {
      // GCM refuse l'authentification : clé différente (mauvaise phrase) ou donnée altérée. Message
      // SANS détail cryptographique — il n'y a rien à divulguer.
      throw new Error("PkiCrypto : déchiffrement refusé (clé différente ou donnée altérée)");
    }
  }

  /* --------------------------------------------------------------------------
     Interne
     -------------------------------------------------------------------------- */

  /** Emballe la DEK sous la KEK → blob `v1:<iv>:<ct>`. L'export des octets a lieu DANS le
      moteur WebCrypto (wrapKey = exportKey+encrypt fusionnés) : rien ne transite par JS. */
  private static async wrapDek(kek: CryptoKey, dek: CryptoKey): Promise<string> {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ciphertext = await crypto.subtle.wrapKey("raw", dek, kek, { name: "AES-GCM", iv: iv as BufferSource });
    return PkiCrypto.KDF_VERSION + ":" + PkiCrypto.toB64(iv) + ":" + PkiCrypto.toB64(new Uint8Array(ciphertext));
  }

  /** Découpe un blob `v1:<iv>:<ct>` (format partagé par key_enc ET wrapped_dek). Jette une
      erreur explicite si le format est inconnu — donnée corrompue ou version future. */
  private static parseBlob(stored: string): { iv: Uint8Array; ciphertext: Uint8Array } {
    const parts = typeof stored === "string" ? stored.split(":") : [];
    if (parts.length !== 3 || parts[0] !== PkiCrypto.KDF_VERSION) {
      throw new Error("PkiCrypto : format de blob chiffré inconnu — donnée corrompue ou version future");
    }
    return { iv: PkiCrypto.fromB64(parts[1]), ciphertext: PkiCrypto.fromB64(parts[2]) };
  }

  /* --------------------------------------------------------------------------
     Base64 ↔ octets — sans Buffer Node (module compilé pour le NAVIGATEUR ;
     btoa/atob existent aussi dans Node ≥ 16, où tournent les tests).
     -------------------------------------------------------------------------- */

  private static toB64(bytes: Uint8Array): string {
    let binary = "";
    // Par tranches : String.fromCharCode(...tableau) sature la pile au-delà de ~100 Ko.
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  private static fromB64(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
}

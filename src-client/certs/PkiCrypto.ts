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

   Le `wrapped_dek` fait AUSSI office de keycheck : le déchiffrement AES-GCM est
   AUTHENTIFIÉ — une mauvaise phrase produit une KEK fausse et `unwrapDek` JETTE.
   Pas de constante-témoin séparée à stocker.

   Extractibilité : la DEK vit dans la session en clé WebCrypto NON extractible
   (importée `extractable:false`) — même garantie que l'ancienne clé maître. Ses
   32 octets bruts n'existent en mémoire JS QUE le temps de l'initialisation, du
   déverrouillage ou du re-chiffrement (effacés aussitôt, best-effort) ; c'est
   strictement dans l'enveloppe de confiance déjà admise (les clés privées, elles,
   transitent en clair dans la page à la génération et à l'export).

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
  /** Taille de la DEK (clé de chiffrement des données) : 256 bits = 32 octets. */
  private static readonly DEK_BYTES = 32;

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
      La KEK ne sert QU'À emballer/déballer la DEK (encrypt/decrypt du seul `wrapped_dek`).
      Les paramètres viennent du serveur (GET /certs/pki) — la passphrase, de l'utilisateur. */
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
      ["encrypt", "decrypt"],
    );
  }

  /** INITIALISATION d'un document : tire une DEK aléatoire, l'emballe sous la KEK
      (→ `wrapped_dek` à stocker) et rend la DEK de session (NON extractible) prête à
      chiffrer/déchiffrer les clés privées. La DEK n'existe en octets bruts que le temps
      de cette fonction (effacés en sortie). */
  static async initDek(kek: CryptoKey): Promise<{ wrappedDek: string; dek: CryptoKey }> {
    const raw = new Uint8Array(PkiCrypto.DEK_BYTES);
    crypto.getRandomValues(raw);
    try {
      const wrappedDek = await PkiCrypto.encryptSecret(kek, PkiCrypto.toB64(raw)); // enveloppe = clair chiffré par la KEK
      const dek = await PkiCrypto.importDek(raw);
      return { wrappedDek, dek };
    } finally {
      raw.fill(0); // efface les octets bruts de la DEK dès que possible (best-effort : le b64 intermédiaire reste immuable jusqu'au GC)
    }
  }

  /** DÉVERROUILLAGE : déballe la DEK depuis `wrapped_dek` avec la KEK dérivée de la phrase.
      JETTE si la phrase est mauvaise (KEK fausse → GCM refuse l'authentification) — c'est
      la vérification de phrase elle-même (le `wrapped_dek` FAIT office de keycheck). La DEK
      rendue est NON extractible (session). */
  static async unwrapDek(kek: CryptoKey, wrappedDek: string): Promise<CryptoKey> {
    const rawB64 = await PkiCrypto.decryptSecret(kek, wrappedDek); // JETTE sur mauvaise phrase / blob altéré
    const raw = PkiCrypto.fromB64(rawB64);
    try {
      return await PkiCrypto.importDek(raw);
    } finally {
      raw.fill(0);
    }
  }

  /** CHANGEMENT DE PHRASE MAÎTRE — cœur de l'opération O(1) : déballe la DEK sous
      l'ANCIENNE KEK et la ré-emballe sous la NOUVELLE. AUCUN `key_enc` n'est touché
      (la DEK est identique avant/après) ; seul le petit `wrapped_dek` change. JETTE si
      l'ancienne phrase est mauvaise (déchiffrement refusé). La DEK n'est même pas importée
      en clé — on ne fait que re-chiffrer son clair (b64). */
  static async rewrapDek(oldKek: CryptoKey, newKek: CryptoKey, wrappedDek: string): Promise<string> {
    const rawB64 = await PkiCrypto.decryptSecret(oldKek, wrappedDek); // JETTE si l'ancienne phrase est mauvaise
    return PkiCrypto.encryptSecret(newKek, rawB64);                   // ré-emballe sous la nouvelle KEK
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
    const parts = typeof stored === "string" ? stored.split(":") : [];
    if (parts.length !== 3 || parts[0] !== PkiCrypto.KDF_VERSION) {
      throw new Error("PkiCrypto : format de blob chiffré inconnu — donnée corrompue ou version future");
    }
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: PkiCrypto.fromB64(parts[1]) as BufferSource },
        key,
        PkiCrypto.fromB64(parts[2]) as BufferSource,
      );
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

  /** Importe les octets bruts de la DEK en clé AES-GCM NON extractible (encrypt/decrypt). */
  private static importDek(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
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

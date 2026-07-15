/* =============================================================================
   CRYPTO CLIENT DE LA PKI — dérivation de la CLÉ MAÎTRE + keycheck +
   chiffrement des clés privées. Module PUR (WebCrypto seul : disponible dans
   le navigateur ET dans Node ≥ 18 pour les tests — aucun DOM, aucun réseau).

   ZÉRO-CONNAISSANCE (cadrage certs 2026-07-14 §2) : TOUT se passe ici, dans
   le navigateur — le serveur ne voit que le SEL, le nombre d'itérations et
   des blobs chiffrés (`keycheck_enc`, `key_enc`) qu'il est incapable de lire.

   Schéma (décision Q1, format VERSIONNÉ pour rotation future) :
   - clé maître = passphrase utilisateur → PBKDF2-SHA-256 (défaut 600 000
     itérations, sel aléatoire PAR document) → clé AES-256-GCM NON extractible
     (elle ne quitte jamais le moteur WebCrypto — pas d'export possible même
     par du code compromis de la page) ;
   - keycheck = une CONSTANTE CONNUE chiffrée par la clé dérivée, stockée par
     document : au déverrouillage, si le déchiffrement authentifié (GCM) rend
     la constante, la passphrase est bonne — détection IMMÉDIATE côté client,
     le serveur n'y participe pas ;
   - clés privées : AES-256-GCM par clé, IV aléatoire 12 o (jamais réutilisé),
     format stocké `v1:<iv>:<ct>` en base64 (le tag GCM est inclus dans <ct>
     par WebCrypto) — même philosophie que le SecretBox serveur, mais côté
     client et avec la clé maître de l'UTILISATEUR.

   Limite ASSUMÉE (documentée) : passphrase perdue = clés privées perdues —
   c'est le but (aucune récupération possible, ni par nous ni par le serveur).
   ============================================================================= */
export class PkiCrypto {
  /** Version du schéma de dérivation/chiffrement (colonne kdf_version + préfixe des blobs). */
  static readonly KDF_VERSION = "v1";
  /** Itérations PBKDF2 par défaut à l'INITIALISATION (décision Q1 : ≥ 600 000 —
      les documents existants gardent leur valeur stockée, relue à chaque dérivation). */
  static readonly DEFAULT_ITERS = 600000;
  /** Constante connue du keycheck — versionnée elle aussi (un changement = nouveau format). */
  static readonly KEYCHECK_PLAINTEXT = "dcmanager-pki-keycheck-v1";

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

  /** Dérive la clé maître : passphrase + sel + itérations → AES-256-GCM NON extractible.
      Les paramètres viennent du serveur (GET /certs/pki) — la passphrase, de l'utilisateur. */
  static async deriveKey(passphrase: string, saltB64: string, iterations: number): Promise<CryptoKey> {
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
      false, // NON extractible : la clé vit dans le moteur WebCrypto, jamais en mémoire JS
      ["encrypt", "decrypt"],
    );
  }

  /** Produit le keycheck d'un document (constante connue chiffrée) — à l'INITIALISATION. */
  static async makeKeycheck(key: CryptoKey): Promise<string> {
    return PkiCrypto.encryptSecret(key, PkiCrypto.KEYCHECK_PLAINTEXT);
  }

  /** Vérifie la passphrase au DÉVERROUILLAGE : true si la clé dérivée déchiffre la constante.
      false (jamais de throw) pour tout échec — mauvaise passphrase, blob altéré, format inconnu :
      dans tous les cas la réponse UI est la même (« clé maître incorrecte »). */
  static async verifyKeycheck(key: CryptoKey, storedKeycheck: string): Promise<boolean> {
    try {
      return (await PkiCrypto.decryptSecret(key, storedKeycheck)) === PkiCrypto.KEYCHECK_PLAINTEXT;
    } catch {
      return false;
    }
  }

  /** Chiffre un secret (clé privée PEM/PKCS#8, graine…) → `v1:<iv>:<ct>` (base64).
      Deux appels sur le même clair produisent des sorties DIFFÉRENTES (IV aléatoire). */
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
      // GCM refuse l'authentification : clé maître différente ou donnée altérée. Message SANS
      // détail cryptographique — il n'y a rien à divulguer.
      throw new Error("PkiCrypto : déchiffrement refusé (clé maître différente ou donnée altérée)");
    }
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

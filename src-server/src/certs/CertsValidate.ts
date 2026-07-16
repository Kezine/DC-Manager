/* =============================================================================
   VALIDATION PURE du module `certs/` (PKI interne) — même philosophie que
   NotifyValidate/ProviderConfigValidate : classe PURE (ni DB, ni réseau),
   griefs GROUPÉS (l'UI montre tout d'un coup), messages français uniques.

   Le serveur est ZÉRO-CONNAISSANCE (cadrage certs 2026-07-14) : il ne valide
   que des MÉTADONNÉES et des blobs OPAQUES — `key_enc` (clé privée chiffrée
   côté client) et `wrapped_dek` (DEK chiffrée par la KEK) ne sont jamais
   déchiffrés ni interprétés ici ; seuls leur type/taille sont bornés (anti-abus).
   ============================================================================= */

/** Familles d'objets suivis (cadrage §3) : CA X.509, feuille TLS, CA SSH,
    paire SSH simple, certificat SSH signé (format OpenSSH, distinct de X.509). */
export const CERT_KINDS = ["root-ca", "leaf-tls", "ssh-ca", "ssh-keypair", "ssh-cert"] as const;
export type CertKind = (typeof CERT_KINDS)[number];

/** Algorithmes de clé supportés (générés côté client — WebCrypto). */
export const KEY_ALGOS = ["ec-p256", "rsa-2048", "rsa-4096", "ed25519"] as const;

/** Types de SAN persistés en table (cadrage : dns | ip | email | principal SSH). */
export const SAN_TYPES = ["dns", "ip", "email", "principal"] as const;

/** Borne haute des blobs stockés (PEM public, clé chiffrée) — un certificat/une clé
    réels pèsent quelques Ko ; 1 Mo laisse une marge x100 sans ouvrir la porte à l'abus. */
const MAX_BLOB_CHARS = 1024 * 1024;

/** Entrée SAN validée (l'ordre du tableau devient `position` en DB). */
export interface SanCandidate {
  san_type: (typeof SAN_TYPES)[number];
  value: string;
}

/** Certificat VALIDÉ prêt à persister (métadonnées + blobs opaques). */
export interface CertificateCandidate {
  id: string;
  kind: CertKind;
  parent_id: string | null;
  label: string;
  subject: string;
  serial: string | null;
  not_before: string | null;
  not_after: string | null;
  fingerprint: string | null;
  key_algo: (typeof KEY_ALGOS)[number];
  public_pem: string | null;
  /** undefined = CONSERVER l'existant (mise à jour de métadonnées sans renvoyer la clé) ;
      null = pas de clé détenue ; chaîne = nouveau blob chiffré côté client. */
  key_enc: string | null | undefined;
  revoked_at: string | null;
  sans: SanCandidate[];
}

/** Paramètres PKI d'un document (côté CLIENT) : dérivation de la KEK + enveloppe de la DEK.
    `wrapped_dek` = la DEK (clé de chiffrement des données) chiffrée par la KEK dérivée de la
    phrase maître ; le serveur ne fait que le STOCKER (blob opaque, jamais déchiffré). Sert à la
    fois d'enveloppe de la DEK et de keycheck (l'unwrap authentifié valide la phrase côté client). */
export interface PkiParamsCandidate {
  kdf_version: string;
  kdf_salt: string;
  kdf_iters: number;
  wrapped_dek: string;
}

/** Erreur de validation à N griefs — les routes la traduisent en 400 { issues }. */
export class CertsConfigError extends Error {
  constructor(readonly issues: string[]) {
    super("données de certificat invalides : " + issues.join(" · "));
    this.name = "CertsConfigError";
  }
}

export class CertsValidate {
  /** Valide/normalise un certificat CANDIDAT (id fourni par l'URL, immuable en édition). */
  static parseCertificate(id: string, candidate: Record<string, unknown>): CertificateCandidate {
    const issues: string[] = [];
    if (typeof id !== "string" || id.trim() === "") issues.push("id : requis (segment d'URL)");

    const kind = typeof candidate.kind === "string" ? candidate.kind.trim() : "";
    if (!(CERT_KINDS as readonly string[]).includes(kind)) issues.push("kind : requis, parmi " + CERT_KINDS.join(" | "));

    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    if (label === "") issues.push("label : requis (nom d'affichage)");
    const subject = typeof candidate.subject === "string" ? candidate.subject.trim() : "";
    if (subject === "") issues.push("subject : requis (DN X.509 ou principal SSH)");

    const keyAlgo = typeof candidate.key_algo === "string" ? candidate.key_algo.trim() : "";
    if (!(KEY_ALGOS as readonly string[]).includes(keyAlgo)) issues.push("key_algo : requis, parmi " + KEY_ALGOS.join(" | "));

    // Émetteur : une RACINE (root-ca, ssh-ca, paire simple) n'en a pas ; un DÉRIVÉ doit en avoir un.
    // L'EXISTENCE du parent est vérifiée par la FK composite (doc_id, parent_id) de certs.db.
    const parentId = typeof candidate.parent_id === "string" && candidate.parent_id.trim() !== "" ? candidate.parent_id.trim() : null;
    if ((kind === "leaf-tls" || kind === "ssh-cert") && parentId === null) {
      issues.push("parent_id : requis pour un dérivé (" + kind + ") — l'émetteur (CA) doit être désigné");
    }
    if ((kind === "root-ca" || kind === "ssh-ca" || kind === "ssh-keypair") && parentId !== null) {
      issues.push("parent_id : sans objet pour « " + kind + " » (objet racine/autonome)");
    }
    if (parentId !== null && parentId === id.trim()) issues.push("parent_id : un certificat ne peut pas être son propre émetteur");

    const notBefore = CertsValidate.parseIso("not_before", candidate.not_before, issues);
    const notAfter = CertsValidate.parseIso("not_after", candidate.not_after, issues);
    if (notBefore && notAfter && Date.parse(notAfter) < Date.parse(notBefore)) {
      issues.push("not_after : antérieur à not_before");
    }
    const revokedAt = CertsValidate.parseIso("revoked_at", candidate.revoked_at, issues);

    const serial = typeof candidate.serial === "string" && candidate.serial.trim() !== "" ? candidate.serial.trim() : null;
    const fingerprint = typeof candidate.fingerprint === "string" && candidate.fingerprint.trim() !== "" ? candidate.fingerprint.trim() : null;

    const publicPem = CertsValidate.parseBlob("public_pem", candidate.public_pem, issues);
    // key_enc : ABSENT (undefined) = conserver l'existant — indispensable au flux zéro-connaissance
    // (la liste ne renvoie jamais key_enc : une mise à jour de métadonnées ne peut pas le rejouer).
    const keyEnc = candidate.key_enc === undefined ? undefined : CertsValidate.parseBlob("key_enc", candidate.key_enc, issues);

    const sans = CertsValidate.parseSans(candidate.sans, issues);

    if (issues.length) throw new CertsConfigError(issues);
    return {
      id: id.trim(), kind: kind as CertKind, parent_id: parentId, label, subject,
      serial, not_before: notBefore, not_after: notAfter, fingerprint,
      key_algo: keyAlgo as CertificateCandidate["key_algo"],
      public_pem: publicPem, key_enc: keyEnc, revoked_at: revokedAt, sans,
    };
  }

  /** Valide les paramètres PKI d'un document (initialisation — cadrage §3 pki_documents). */
  static parsePkiParams(candidate: Record<string, unknown>): PkiParamsCandidate {
    const issues: string[] = [];
    const version = typeof candidate.kdf_version === "string" ? candidate.kdf_version.trim() : "";
    // Seule la v1 (PBKDF2-SHA-256, décision Q1) existe — le format versionné autorise une rotation future.
    if (version !== "v1") issues.push("kdf_version : « v1 » attendu (PBKDF2-SHA-256)");
    const salt = typeof candidate.kdf_salt === "string" ? candidate.kdf_salt.trim() : "";
    if (salt === "" || !CertsValidate.isBase64(salt)) issues.push("kdf_salt : base64 non vide attendu");
    const iters = typeof candidate.kdf_iters === "number" && Number.isFinite(candidate.kdf_iters) ? Math.floor(candidate.kdf_iters) : NaN;
    // Plancher de la décision Q1 (≥ 600 000) — un client qui négocierait moins affaiblirait la clé maître.
    if (!(iters >= 600000)) issues.push("kdf_iters : entier ≥ 600000 attendu (décision Q1)");
    const wrappedDek = typeof candidate.wrapped_dek === "string" ? candidate.wrapped_dek.trim() : "";
    if (wrappedDek === "" || wrappedDek.length > MAX_BLOB_CHARS) issues.push("wrapped_dek : requis (DEK chiffrée par la KEK côté client)");
    if (issues.length) throw new CertsConfigError(issues);
    return { kdf_version: version, kdf_salt: salt, kdf_iters: iters, wrapped_dek: wrappedDek };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Date ISO 8601 optionnelle → chaîne normalisée ou null (grief si illisible). */
  private static parseIso(field: string, value: unknown, issues: string[]): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      issues.push(field + " : date ISO 8601 attendue");
      return null;
    }
    return value;
  }

  /** Blob opaque optionnel (PEM public, clé chiffrée) : chaîne bornée ou null. */
  private static parseBlob(field: string, value: unknown, issues: string[]): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") { issues.push(field + " : chaîne attendue"); return null; }
    if (value.length > MAX_BLOB_CHARS) { issues.push(field + " : dépasse la taille maximale (1 Mo)"); return null; }
    return value;
  }

  /** SAN : tableau ordonné (l'ordre devient `position`), types du cadrage, valeurs non vides. */
  private static parseSans(value: unknown, issues: string[]): SanCandidate[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) { issues.push("sans : tableau attendu"); return []; }
    const out: SanCandidate[] = [];
    value.forEach((entry, index) => {
      const type = entry && typeof entry.san_type === "string" ? entry.san_type.trim() : "";
      const val = entry && typeof entry.value === "string" ? entry.value.trim() : "";
      if (!(SAN_TYPES as readonly string[]).includes(type)) { issues.push("sans[" + index + "].san_type : parmi " + SAN_TYPES.join(" | ")); return; }
      if (val === "") { issues.push("sans[" + index + "].value : requis"); return; }
      out.push({ san_type: type as SanCandidate["san_type"], value: val });
    });
    return out;
  }

  /** Test base64 permissif (accepte le padding et l'alphabet standard). */
  private static isBase64(text: string): boolean {
    return /^[A-Za-z0-9+/]+={0,2}$/.test(text);
  }
}

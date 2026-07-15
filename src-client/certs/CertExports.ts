/* =============================================================================
   EXPORTS CLIENT DE LA PKI — assemble, APRÈS déverrouillage, les artefacts
   téléchargeables d'un certificat/clé : PEM (certificat, clé, fullchain, ca-chain),
   PKCS#12 et formats OpenSSH. Module PUR : logique de chaîne + concaténation PEM,
   délégation crypto à OpenSshEncoder / Pkcs12Builder — aucun DOM, aucun réseau.

   ZÉRO-CONNAISSANCE (cadrage certs 2026-07-14 §2) : tout matériau privé (clé PKCS#8,
   graine SSH) est déchiffré par l'APPELANT (session déverrouillée) et passé en clair
   à ces fonctions ; RIEN de déchiffré ne transite vers le serveur. Ce module ne
   connaît pas la clé maître et n'exécute aucune I/O.

   SÉPARATION DES RESPONSABILITÉS : ces fonctions renvoient un ARTEFACT
   { filename, mime, content } ; le déclenchement du téléchargement navigateur (DOM)
   est confié à `Download` (core/Download.ts) — la seule pièce non pure.

   RÉVOCATION (décision Q4) : un certificat révoqué (revoked_at posé) est EXCLU des
   exports. Les fonctions qui reçoivent l'enregistrement REFUSENT avec un message
   français explicite — garde-fou même si l'UI grise déjà le bouton.
   ============================================================================= */
import { OpenSshEncoder } from "./OpenSshEncoder";
import { Pkcs12Builder } from "./Pkcs12Builder";

/** Artefact d'export prêt à télécharger. `content` est du texte (PEM/OpenSSH) ou des
    octets (PKCS#12). Le déclenchement du téléchargement est SÉPARÉ (cf. Download). */
export interface ExportArtifact {
  filename: string;
  mime: string;
  content: string | Uint8Array;
}

/** Vue MINIMALE d'un certificat pour l'export (sous-ensemble du DTO serveur
    CertificateDetail) : ce dont les exports ont besoin — identité, émetteur,
    PEM public, révocation. Le `kind` n'est pas nécessaire ici (la résolution de
    chaîne est purement structurelle ; les formats SSH passent par `OpensshMaterial`). */
export interface CertExportRecord {
  id: string;
  label: string;
  parent_id: string | null;
  public_pem: string | null;
  revoked_at: string | null;
}

/** Matériau OpenSSH à exporter, discriminé par nature d'objet SSH (cadrage §2).
    - paire (ssh-keypair) ou CA (ssh-ca) ed25519 : graine + clé publique brutes ;
    - certificat SSH signé (ssh-cert) : la ligne .pub déjà émise (stockée en public_pem). */
export type OpensshMaterial =
  | { kind: "ssh-keypair" | "ssh-ca"; seed: Uint8Array; publicKey: Uint8Array; comment?: string }
  | { kind: "ssh-cert"; certLine: string };

export class CertExports {
  /** Types MIME des artefacts. `application/x-pem-file` / `application/x-pkcs12` sont
      les types usuels ; les fichiers SSH sont du texte (sauf la clé privée, marquée
      binaire pour inciter à l'enregistrement plutôt qu'à l'affichage). */
  static readonly MIME_PEM = "application/x-pem-file";
  static readonly MIME_PKCS12 = "application/x-pkcs12";
  static readonly MIME_TEXT = "text/plain; charset=utf-8";
  static readonly MIME_BINARY = "application/octet-stream";

  /* --------------------------------------------------------------------------
     PEM
     -------------------------------------------------------------------------- */

  /** Certificat public seul → `<label>.pem`. Refuse un certificat révoqué. */
  static pemCertificate(cert: CertExportRecord): ExportArtifact {
    CertExports.requireNotRevoked(cert);
    return { filename: CertExports.safeFileName(cert.label) + ".pem", mime: CertExports.MIME_PEM, content: CertExports.certPemBlock(cert) };
  }

  /** Clé privée PKCS#8 (DÉJÀ déchiffrée par l'appelant) → `<label>.key.pem`.
      Ne reçoit pas l'enregistrement (l'appelant n'expose la clé que d'un cert non
      révoqué) : la fonction se contente de normaliser et nommer le fichier. */
  static pemPrivateKey(label: string, pkcs8Pem: string): ExportArtifact {
    if (typeof pkcs8Pem !== "string" || pkcs8Pem.trim() === "") throw new Error("CertExports : clé privée PKCS#8 vide — export impossible");
    return { filename: CertExports.safeFileName(label) + ".key.pem", mime: CertExports.MIME_PEM, content: CertExports.normalizeLf(pkcs8Pem) };
  }

  /** Chaîne complète → `<label>.fullchain.pem` : feuille + émetteurs REMONTÉS par
      parent_id jusqu'à la racine, dans l'ordre. Refuse un certificat révoqué. */
  static pemFullchain(cert: CertExportRecord, allCerts: CertExportRecord[]): ExportArtifact {
    CertExports.requireNotRevoked(cert);
    const chain = CertExports.resolveIssuerChain(cert, allCerts);
    const content = chain.map((c) => CertExports.certPemBlock(c)).join("");
    return { filename: CertExports.safeFileName(cert.label) + ".fullchain.pem", mime: CertExports.MIME_PEM, content };
  }

  /** Chaîne d'autorité SANS la feuille → `<label>.ca-chain.pem`. Refuse un certificat
      révoqué et une racine (aucun émetteur à exporter). */
  static pemCaChain(cert: CertExportRecord, allCerts: CertExportRecord[]): ExportArtifact {
    CertExports.requireNotRevoked(cert);
    const chain = CertExports.resolveIssuerChain(cert, allCerts);
    if (chain.length < 2) throw new Error("CertExports : « " + cert.label + " » n'a pas d'émetteur (certificat racine) — aucune chaîne d'autorité à exporter");
    const content = chain.slice(1).map((c) => CertExports.certPemBlock(c)).join("");
    return { filename: CertExports.safeFileName(cert.label) + ".ca-chain.pem", mime: CertExports.MIME_PEM, content };
  }

  /* --------------------------------------------------------------------------
     OpenSSH
     -------------------------------------------------------------------------- */

  /** Artefacts OpenSSH selon la nature de l'objet (délègue l'encodage à OpenSshEncoder) :
      - ssh-keypair / ssh-ca : clé privée openssh-key-v1 (`<label>`) + ligne
        authorized_keys (`<label>.pub`) ;
      - ssh-cert : certificat SSH signé (`<label>-cert.pub`).
      Refuse un objet révoqué. */
  static opensshArtifacts(cert: CertExportRecord, material: OpensshMaterial): ExportArtifact[] {
    CertExports.requireNotRevoked(cert);
    const base = CertExports.safeFileName(cert.label);
    if (material.kind === "ssh-cert") {
      const line = CertExports.ensureTrailingLf(material.certLine);
      if (line.trim() === "") throw new Error("CertExports : ligne de certificat SSH vide — export impossible");
      return [{ filename: base + "-cert.pub", mime: CertExports.MIME_TEXT, content: line }];
    }
    // Paire/CA ed25519 : la clé privée (openssh-key-v1) et la clé publique authorized_keys.
    const privateKey = OpenSshEncoder.ed25519PrivateKey({ seed: material.seed, publicKey: material.publicKey, comment: material.comment });
    const publicLine = CertExports.ensureTrailingLf(OpenSshEncoder.ed25519PublicKeyLine(material.publicKey, material.comment));
    return [
      { filename: base, mime: CertExports.MIME_BINARY, content: privateKey },       // clé privée = fichier sensible
      { filename: base + ".pub", mime: CertExports.MIME_TEXT, content: publicLine }, // clé publique
    ];
  }

  /* --------------------------------------------------------------------------
     PKCS#12
     -------------------------------------------------------------------------- */

  /** Fichier PKCS#12 → `<label>.p12` : feuille + chaîne d'émission + clé privée,
      protégés par la passphrase saisie à l'export (paramètre). Refuse un cert révoqué.
      Délègue toute la crypto/ASN.1 à Pkcs12Builder. */
  static async pkcs12(cert: CertExportRecord, allCerts: CertExportRecord[], opts: { passphrase: string; privateKeyPkcs8Pem: string; pbkdf2Iterations?: number }): Promise<ExportArtifact> {
    CertExports.requireNotRevoked(cert);
    const chain = CertExports.resolveIssuerChain(cert, allCerts);
    const certChainPem = chain.map((c) => CertExports.certPemBlock(c));
    const der = await Pkcs12Builder.build({
      passphrase: opts.passphrase,
      privateKeyPkcs8Pem: opts.privateKeyPkcs8Pem,
      certChainPem,
      friendlyName: cert.label,
      pbkdf2Iterations: opts.pbkdf2Iterations,
    });
    return { filename: CertExports.safeFileName(cert.label) + ".p12", mime: CertExports.MIME_PKCS12, content: der };
  }

  /* --------------------------------------------------------------------------
     Résolution de chaîne d'émission (fonction PURE, réutilisable/testable)
     -------------------------------------------------------------------------- */

  /** Remonte la chaîne d'émission par parent_id : renvoie [feuille, …, racine].
      Garde-fous : émetteur INTROUVABLE → erreur explicite ; BOUCLE de parent_id
      (cycle) → erreur, jamais de boucle infinie. */
  static resolveIssuerChain(cert: CertExportRecord, allCerts: CertExportRecord[]): CertExportRecord[] {
    const byId = new Map<string, CertExportRecord>();
    for (const c of Array.isArray(allCerts) ? allCerts : []) byId.set(c.id, c);
    const chain: CertExportRecord[] = [cert];
    const seen = new Set<string>([cert.id]);
    let current = cert;
    while (current.parent_id !== null && current.parent_id !== undefined && current.parent_id !== "") {
      const parent = byId.get(current.parent_id);
      if (!parent) {
        throw new Error("CertExports : chaîne d'émission incomplète — l'émetteur « " + current.parent_id + " » du certificat « " + current.label + " » est introuvable");
      }
      if (seen.has(parent.id)) {
        throw new Error("CertExports : boucle détectée dans la chaîne d'émission (parent_id circulaire) — export impossible");
      }
      seen.add(parent.id);
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** PEM du certificat public d'un enregistrement, normalisé LF. Erreur si absent
      (une chaîne dont un maillon n'a pas de certificat public est inexportable). */
  private static certPemBlock(cert: CertExportRecord): string {
    if (typeof cert.public_pem !== "string" || cert.public_pem.trim() === "") {
      throw new Error("CertExports : le certificat « " + cert.label + " » n'a pas de PEM public — export impossible");
    }
    return CertExports.ensureTrailingLf(CertExports.normalizeLf(cert.public_pem));
  }

  /** Refuse un certificat révoqué (garde-fou de la décision Q4). PUBLIC : `CertZip.bundleFor`
      s'en sert comme garde-fou partagé (même message que les exports unitaires) sur les chemins
      qu'il assemble lui-même (ex. `.pub` seul), sans dupliquer la formulation. */
  static requireNotRevoked(cert: CertExportRecord): void {
    if (cert && typeof cert.revoked_at === "string" && cert.revoked_at.trim() !== "") {
      throw new Error("CertExports : « " + cert.label + " » est révoqué — exclu des exports (décision Q4)");
    }
  }

  /** Normalise les fins de ligne en LF (CRLF/CR → LF). */
  private static normalizeLf(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  /** Garantit exactement un saut de ligne final (concaténation PEM propre). */
  private static ensureTrailingLf(text: string): string {
    const trimmed = text.replace(/\n+$/, "");
    return trimmed + "\n";
  }

  /** Nom de fichier SÛR dérivé du label : caractères interdits (Windows) → « _ »,
      espaces de bord retirés. Duplique volontairement la règle de Download.safeName
      (module DOM) pour garder CE module PUR ; repli « certificat » si le label est vide.
      PUBLIC : `CertZip` réutilise le MÊME assainisseur pour les noms de dossier/fichier du ZIP. */
  static safeFileName(label: string): string {
    const cleaned = String(label || "").replace(/[\\/:*?"<>|]+/g, "_").trim();
    return cleaned === "" ? "certificat" : cleaned;
  }
}

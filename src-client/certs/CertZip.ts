/* =============================================================================
   CertZip — EMBALLAGE ZIP côté client des exports de la PKI (fflate en clair,
   @zip.js/zip.js pour le ZIP protégé par mot de passe). Module PUR : assemble le
   BUNDLE d'un certificat (les mêmes artefacts que CertExports, regroupés par kind,
   FILTRABLES par catégorie) et empaquette une ou plusieurs listes d'artefacts en
   une archive ZIP — aucun DOM, aucun réseau. Le déclenchement du téléchargement
   (DOM) reste confié à `Download` (core/Download.ts).

   POURQUOI fflate (choix utilisateur, principe n°12) : ~8 Ko gz tree-shakés à
   l'usage (on n'importe QUE `zipSync`), MIT, activement maintenue, API synchrone
   (`zipSync`) sans dépendance. Le ZIP n'est qu'un CONTENEUR : on réutilise
   CertExports tel quel pour le CONTENU des fichiers (« le ZIP n'est qu'un
   emballage », cadrage certs 2026-07-15 §6).

   POURQUOI @zip.js/zip.js pour le ZIP CHIFFRÉ (choix utilisateur, principe n°12) :
   fflate ne chiffre pas ; zip.js produit un ZIP AES-256 (WinZip AE-2) ouvrable par
   7-Zip/WinRAR (mais PAS par l'explorateur Windows natif, qui ignore l'AES ZIP).
   On l'utilise SANS Web Workers (`useWebWorkers: false`) : le bundle client est
   MONOLITHIQUE (dc-manager.html inliné) — un worker issu d'un blob n'y survivrait
   pas — et les tests tournent sous Node. Le codec s'exécute donc sur le thread
   courant (petits fichiers texte : coût négligeable).

   STORE (level 0) : les artefacts sont de PETITS fichiers texte (PEM/OpenSSH). La
   compression n'apporterait presque rien pour un coût CPU réel — on empaquette
   sans compresser (fonctionnellement suffisant, cf. cadrage §6). Vaut pour les DEUX
   chemins (fflate en clair, zip.js chiffré) : seul le chiffrement s'ajoute.

   ZÉRO-CONNAISSANCE : comme CertExports, ce module reçoit le matériau privé DÉJÀ
   déchiffré par l'appelant (session déverrouillée) et n'exécute aucune I/O. Un cert
   RÉVOQUÉ est REFUSÉ (garde-fou partagé `CertExports.requireNotRevoked`, même
   message) — les appelants l'excluent déjà en amont. Le mot de passe du ZIP chiffré
   ne sert QU'À dériver la clé AES ici : jamais stocké, jamais journalisé.
   ============================================================================= */
import { zipSync } from "fflate";
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, configure as zipConfigure } from "@zip.js/zip.js";
import * as x509 from "@peculiar/x509";
import { CertExports, type CertExportRecord, type ExportArtifact, type OpensshMaterial } from "./CertExports";
import { SshWire } from "./SshWire";
import { SshKeyMaterial } from "./SshKeyMaterial";

/** CATÉGORIE d'artefacts d'un bundle — clé STABLE partagée par la décision d'affichage
    (BulkActions.exportChoices) et l'assemblage (bundleFor) : chaque catégorie cochée dans le dialogue
    d'export groupé sélectionne les artefacts correspondants. Vit ICI (l'assemblage possède la
    correspondance catégorie → fichiers : public = cert.pem/.pub/-cert.pub ; fullchain/ca-chain = chaînes PEM
    d'une feuille TLS ; key = clé privée PKCS#8 ou OpenSSH). BulkActions n'en importe que le TYPE (couplage
    runtime nul). */
export type ExportCategoryKey = "public" | "fullchain" | "ca-chain" | "key";

/** Vue d'un certificat pour l'assemblage d'un BUNDLE : un CertExportRecord (identité + PEM public +
    révocation) enrichi du `kind` (aiguille la composition) et du `subject` (commentaire OpenSSH). */
export interface CertBundleRecord extends CertExportRecord {
  /** "root-ca" | "leaf-tls" | "ssh-ca" | "ssh-keypair" | "ssh-cert". */
  kind: string;
  /** Commentaire OpenSSH (identité lisible) pour ssh-keypair/ssh-ca — repris du `subject`. */
  subject?: string;
}

/** Une ENTRÉE du ZIP : les artefacts d'un certificat, éventuellement rangés dans un sous-dossier
    (`folder` = libellé du cert pour un ZIP multi-certificats ; absent = fichiers à la racine, cas
    de l'export unitaire « Tout (ZIP) »). */
export interface ZipEntry {
  folder?: string;
  artifacts: ExportArtifact[];
}

export class CertZip {
  /* --------------------------------------------------------------------------
     BUNDLE d'un certificat (les artefacts, selon kind) — réutilise CertExports
     -------------------------------------------------------------------------- */

  /** Artefacts du BUNDLE d'un certificat selon son kind (cadrage §6). Clé privée incluse SEULEMENT
      si `keyPemOrNull` est fourni (session déverrouillée, matériau déjà déchiffré) :
      - leaf-tls  : cert.pem + fullchain.pem (+ ca-chain.pem si demandé) (+ key.pem) — noms GÉNÉRIQUES,
                    l'identité est portée par le dossier <label>/ (multi) ou le nom du ZIP (unitaire) ;
      - root-ca   : cert.pem (+ key.pem) ;
      - ssh-ca/ssh-keypair : clé OpenSSH privée + .pub si clé fournie, sinon la seule ligne .pub publique ;
      - ssh-cert  : le certificat SSH (-cert.pub) (+ key.pem du sujet si clé fournie).

      FILTRAGE PAR CATÉGORIES (dialogue d'export groupé) : `categories` = ensemble des catégories COCHÉES
      (public / fullchain / ca-chain / key). On filtre à l'assemblage plutôt qu'en aval (le nommage des
      fichiers reste à UN seul endroit). `categories` null/undefined = bundle HISTORIQUE (export unitaire
      « Tout (ZIP) » et appelants d'origine — INCHANGÉ) : {public, fullchain, key} SANS ca-chain (la chaîne
      d'autorité n'a jamais fait partie du bundle unitaire ; c'est une catégorie propre au dialogue groupé).
      Correspondance catégorie → artefact : public = cert.pem / ligne .pub / -cert.pub ; key = key.pem /
      clé privée OpenSSH (pas de catégorie SSH dédiée — public/key couvrent les lignes/clés SSH).

      Un cert RÉVOQUÉ est REFUSÉ (garde-fou partagé — les appelants l'excluent déjà). ASYNC : la conversion
      d'une clé privée SSH (PKCS#8 → graine ed25519) passe par WebCrypto. */
  static async bundleFor(cert: CertBundleRecord, allCerts: CertExportRecord[], keyPemOrNull: string | null, categories?: Set<ExportCategoryKey> | null): Promise<ExportArtifact[]> {
    CertExports.requireNotRevoked(cert);
    const kind = cert.kind;
    const key = typeof keyPemOrNull === "string" && keyPemOrNull.trim() !== "" ? keyPemOrNull : null;
    // `categories` absent = bundle historique {public, fullchain, key} (SANS ca-chain — cf. en-tête de méthode).
    const selected = categories || new Set<ExportCategoryKey>(["public", "fullchain", "key"]);
    const want = (cat: ExportCategoryKey): boolean => selected.has(cat);
    const arts: ExportArtifact[] = [];

    if (kind === "root-ca" || kind === "leaf-tls") {
      if (want("public")) arts.push(CertZip.renamed("cert.pem", CertExports.pemCertificate(cert)));
      if (kind === "leaf-tls" && want("fullchain")) arts.push(CertZip.renamed("fullchain.pem", CertExports.pemFullchain(cert, allCerts)));
      if (kind === "leaf-tls" && want("ca-chain")) arts.push(CertZip.renamed("ca-chain.pem", CertExports.pemCaChain(cert, allCerts)));
      if (key && want("key")) arts.push(CertZip.renamed("key.pem", CertExports.pemPrivateKey(cert.label, key)));
    } else if (kind === "ssh-ca" || kind === "ssh-keypair") {
      if (key) {
        // Clé détenue + déverrouillé : artefacts OpenSSH complets (clé privée openssh-key-v1 + ligne .pub).
        // On filtre par catégorie : la ligne .pub = « public », la clé privée openssh-key-v1 = « key ».
        const seed = await CertZip.ed25519SeedFromPkcs8Pem(key);
        const publicKey = CertZip.ed25519PublicFromLine(cert.public_pem || "");
        const material: OpensshMaterial = { kind, seed, publicKey, comment: cert.subject };
        for (const a of CertExports.opensshArtifacts(cert, material)) {
          const isPublicLine = a.filename.endsWith(".pub");
          if (isPublicLine ? want("public") : want("key")) arts.push(a);
        }
      } else if (want("public")) {
        // Clé absente (ou session verrouillée) : la seule ligne publique authorized_keys (= public_pem).
        arts.push({ filename: CertExports.safeFileName(cert.label) + ".pub", mime: CertExports.MIME_TEXT, content: CertZip.ensureTrailingLf(cert.public_pem || "") });
      }
    } else if (kind === "ssh-cert") {
      if (want("public")) for (const a of CertExports.opensshArtifacts(cert, { kind: "ssh-cert", certLine: cert.public_pem || "" })) arts.push(a);
      if (key && want("key")) arts.push(CertZip.renamed("key.pem", CertExports.pemPrivateKey(cert.label, key)));
    }
    return arts;
  }

  /* --------------------------------------------------------------------------
     Assemblage du ZIP (fflate) + helpers purs testables
     -------------------------------------------------------------------------- */

  /** Résout la LISTE PLATE des fichiers du ZIP (chemin complet → octets) avec la logique de dossiers/dédup
      PARTAGÉE par les deux chemins d'emballage (fflate en clair ET zip.js chiffré) — le nommage vit à UN seul
      endroit, jamais dupliqué. Chaque entrée AVEC `folder` devient un sous-dossier ASSAINI
      (CertExports.safeFileName) et DÉDUPLIQUÉ (suffixe -2, -3…) ; ses fichiers sont assainis et dédupliqués
      DANS le dossier. Une entrée SANS dossier (export unitaire) dépose ses fichiers à la RACINE, dédupliqués
      contre le premier niveau. Fonction PURE (arborescence des chemins) — aucun encodage ZIP ici. */
  static resolveEntries(entries: ZipEntry[]): Array<{ path: string; content: Uint8Array }> {
    const files: Array<{ path: string; content: Uint8Array }> = [];
    const usedTop = new Set<string>();   // noms de premier niveau : dossiers ET fichiers déposés à la racine
    for (const entry of Array.isArray(entries) ? entries : []) {
      const artifacts = Array.isArray(entry.artifacts) ? entry.artifacts : [];
      if (typeof entry.folder === "string" && entry.folder.trim() !== "") {
        const folder = CertZip.dedupe(CertExports.safeFileName(entry.folder), usedTop);
        const usedInFolder = new Set<string>();
        for (const art of artifacts) {
          const name = CertZip.dedupe(CertExports.safeFileName(art.filename), usedInFolder);
          files.push({ path: folder + "/" + name, content: CertZip.toBytes(art.content) });   // « dossier/fichier » = arbo
        }
      } else {
        for (const art of artifacts) {
          const name = CertZip.dedupe(CertExports.safeFileName(art.filename), usedTop);
          files.push({ path: name, content: CertZip.toBytes(art.content) });
        }
      }
    }
    return files;
  }

  /** Empaquette des entrées en une archive ZIP (Uint8Array) — chemin EN CLAIR (fflate, `zipSync`). Arborescence
      et dédup via le helper partagé `resolveEntries`. STORE (level 0), cf. en-tête. */
  static zipArtifacts(entries: ZipEntry[]): Uint8Array {
    const files: Record<string, Uint8Array> = {};
    for (const f of CertZip.resolveEntries(entries)) files[f.path] = f.content;
    return zipSync(files, { level: 0 });
  }

  /** Empaquette des entrées en une archive ZIP CHIFFRÉE par mot de passe (Uint8Array) — chemin PROTÉGÉ
      (@zip.js/zip.js, AES-256 / WinZip AE-2). MÊME arborescence et MÊME dédup que `zipArtifacts` (helper
      partagé `resolveEntries`) : les chemins de fichiers sont identiques, seul le chiffrement s'ajoute.
      `encryptionStrength: 3` = AES-256 (1=AES-128, 2=AES-192) ; STORE (level 0, cf. en-tête). Sans Web Workers
      (`useWebWorkers: false`) : bundle client monolithique + tests Node. ASYNC (API zip.js asynchrone). Le mot
      de passe ne sert QU'À dériver la clé AES ici — jamais stocké ni journalisé (aucune trace en erreur). */
  static async zipArtifactsEncrypted(entries: ZipEntry[], password: string): Promise<Uint8Array> {
    if (typeof password !== "string" || password === "") throw new Error("CertZip : mot de passe requis pour un ZIP chiffré");
    zipConfigure({ useWebWorkers: false });   // idempotent : jamais de Web Worker (bundle monolithique + Node)
    const writer = new ZipWriter(new Uint8ArrayWriter(), { password, encryptionStrength: 3 });
    for (const f of CertZip.resolveEntries(entries)) {
      await writer.add(f.path, new Uint8ArrayReader(f.content), { level: 0 });   // level 0 = STORE (pas de compression)
    }
    return writer.close();
  }

  /** Renvoie un nom UNIQUE dans `used` (qu'il enrichit) : `name` s'il est libre, sinon `stem-2.ext`,
      `stem-3.ext`… — le suffixe est inséré AVANT l'extension pour garder le fichier ouvrable. Vaut aussi
      pour un dossier (aucune extension → suffixe en fin). Fonction PURE (dédup des collisions). */
  static dedupe(name: string, used: Set<string>): string {
    const base = name === "" ? "fichier" : name;
    if (!used.has(base)) { used.add(base); return base; }
    const { stem, ext } = CertZip.splitExt(base);
    for (let i = 2; i < 100000; i++) {
      const candidate = stem + "-" + i + ext;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
    // Repli quasi impossible (100000 homonymes) : suffixe horodaté, garanti absent.
    const fallback = stem + "-" + Date.now() + ext;
    used.add(fallback);
    return fallback;
  }

  /** Scinde un nom de fichier en radical + extension (dernier point). Point EN TÊTE (nom « caché ») ou
      absence de point → tout est radical (extension vide). Fonction PURE (arborescence des chemins). */
  static splitExt(name: string): { stem: string; ext: string } {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return { stem: name, ext: "" };
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Copie un artefact en lui donnant un nom de fichier GÉNÉRIQUE (l'identité est dans le dossier/nom du ZIP). */
  private static renamed(filename: string, art: ExportArtifact): ExportArtifact {
    return { filename, mime: art.mime, content: art.content };
  }

  /** Contenu d'artefact (texte OU octets) → octets (fflate ne manipule que des Uint8Array). */
  private static toBytes(content: string | Uint8Array): Uint8Array {
    return typeof content === "string" ? new TextEncoder().encode(content) : content;
  }

  /** Garantit exactement un saut de ligne final (ligne .pub propre) — même règle que CertExports. */
  private static ensureTrailingLf(text: string): string {
    return text.replace(/\n+$/, "") + "\n";
  }

  /** Clé privée PKCS#8 PEM (ed25519, déjà déchiffrée) → GRAINE de 32 octets, via WebCrypto.
      Duplique volontairement CertsAdminView.seedFromPkcs8Pem (méthode PRIVÉE de la vue) : garde CertZip
      AUTONOME et évite de toucher la vue (L2/L3). WebCrypto reste PUR (navigateur ET Node ≥ 18). */
  private static async ed25519SeedFromPkcs8Pem(pkcs8Pem: string): Promise<Uint8Array> {
    const der = x509.PemConverter.decodeFirst(pkcs8Pem);
    const key = await crypto.subtle.importKey("pkcs8", der, "Ed25519", true, ["sign"]);
    return SshKeyMaterial.ed25519Seed(key);
  }

  /** Ligne authorized_keys ed25519 → 32 octets de clé publique brute (32 derniers octets du blob wire).
      Duplique volontairement CertsAdminView.ed25519PubFromLine (même raison que ci-dessus). */
  private static ed25519PublicFromLine(line: string): Uint8Array {
    const token = String(line || "").trim().split(/\s+/)[1] || "";
    if (token === "") throw new Error("CertZip : ligne OpenSSH illisible (clé publique absente) — bundle impossible");
    const blob = SshWire.fromBase64(token);
    if (blob.length < 32) throw new Error("CertZip : ligne OpenSSH illisible (blob trop court) — bundle impossible");
    return blob.slice(blob.length - 32);
  }
}

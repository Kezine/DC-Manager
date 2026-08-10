/* Tests modules — PIÈCES JOINTES (lot A, socle sans UI — cadrage 2026-08-10).
   ----------------------------------------------------------------------------
   Couvre les quatre piliers du chantier HORS collection (la spec/validation/cascade
   vivent, elles, dans test-shared-validation.js, section « collection attachments ») :
   - le BUNDLE compagnon `.nmfa` (enveloppe GÉNÉRALISÉE `BinaryBundle`) : roundtrip
     bit-fidèle + NON-RÉGRESSION du `.nmfb` d'images (octet pour octet vs l'ancien
     algorithme, recopié ici en GOLDEN — la généralisation ne devait rien changer) ;
   - l'assainissement du nom de téléchargement (`ContentDisposition`, décision D6 :
     guillemets, CRLF, non-ASCII → RFC 5987) ;
   - le stockage disque serveur (`AttachmentFiles`, décision D4) : id opaque =
     nom de fichier (anti path-traversal PAR CONSTRUCTION) + purge d'orphelins
     (décision D5) sur de VRAIS fichiers (os.tmpdir(), nettoyés) ;
   - l'intégration `DocumentStore` (better-sqlite3 RÉEL) : maintenance = purge des
     binaires dont l'id a QUITTÉ la collection, suppression de document = dossier
     emporté — et les helpers/cascade du Store client (récursion réelle).
   Doctrine : docs/attachments.md ; harnais et assertions : harness.js. */
"use strict";
const fs = require("fs");
const os = require("os");
const { ck, section, path, D, SERVER, ImageStore, SharedSchema, makeStore } = require("./harness.js");

/* -------- better-sqlite3 RÉEL (même sonde/politique que test-relational-repository : ÉCHEC actionnable,
   jamais un skip silencieux). -------- */
let SQLITE = null, SQLITE_ERROR = "";
try {
  const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
  new Candidate(":memory:").close();
  SQLITE = Candidate;
} catch (e) { SQLITE_ERROR = ((e && e.message) || String(e)).split("\n")[0]; }
const requireSqlite = () => {
  if (SQLITE) return true;
  ck(false, "better-sqlite3 RÉEL indisponible (" + SQLITE_ERROR + ") — `npm install` dans src-server/ ; ÉCHEC au lieu d'un saut");
  return false;
};

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

module.exports = async () => {
  const { BinaryBundle } = D("data/BinaryBundle.js");
  const { AttachmentStore } = D("data/AttachmentStore.js");

  await section("data : bundle .nmfa (AttachmentStore/BinaryBundle) — roundtrip bit-fidèle, signatures étanches", async () => {
  {
    // -- ROUNDTRIP : deux binaires (contenus distincts) + clé d'appariement → build → parse → identiques. --
    const blobA = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
    const blobB = new Blob([new Uint8Array([9, 8, 7, 6, 5])], { type: "text/plain" });
    const bundle = AttachmentStore.buildBundle([
      { id: "att-a", type: "application/pdf", blob: blobA },
      { id: "att-b", type: "text/plain", blob: blobB },
    ], "AK1");
    const parsed = AttachmentStore.parseBundle(await bundle.arrayBuffer());
    ck.eq(parsed.key, "AK1", "parseBundle : clé d'appariement restaurée");
    ck.eq(parsed.entries.length, 2, "parseBundle : les 2 entrées restaurées");
    ck.eq(parsed.entries[0].id + "/" + parsed.entries[0].type, "att-a/application/pdf", "parseBundle : id + type MIME de la 1re entrée");
    ck(sameBytes(await bytesOf(parsed.entries[0].blob), new Uint8Array([1, 2, 3])), "parseBundle : binaire 1 restauré OCTET POUR OCTET");
    ck(sameBytes(await bytesOf(parsed.entries[1].blob), new Uint8Array([9, 8, 7, 6, 5])), "parseBundle : binaire 2 restauré (offsets du manifeste respectés)");

    // -- SIGNATURES : un tampon quelconque est rejeté ; un .nmfa n'est PAS lisible comme .nmfb (et
    //    réciproquement) — les deux compagnons sont ÉTANCHES malgré l'enveloppe commune (décision D7). --
    let threw = false; try { AttachmentStore.parseBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer); } catch (_) { threw = true; }
    ck(threw, "parseBundle : signature NMFA invalide → exception");
    let crossed = false; try { ImageStore.parseBundle(await bundle.arrayBuffer()); } catch (_) { crossed = true; }
    ck(crossed, "un .nmfa n'est PAS lisible comme .nmfb (ImageStore.parseBundle rejette la signature)");
    const nmfb = ImageStore.buildBundle([{ id: "im-1", name: "face", u_height: 1, face: "front", with_ears: true, description: "", type: "image/png", blob: new Blob([new Uint8Array([4, 4])], { type: "image/png" }) }], "FK1");
    let crossedBack = false; try { AttachmentStore.parseBundle(await nmfb.arrayBuffer()); } catch (_) { crossedBack = true; }
    ck(crossedBack, "un .nmfb n'est PAS lisible comme .nmfa (réciproque)");
    ck(BinaryBundle.hasSignature(await bundle.arrayBuffer(), "NMFA") && !BinaryBundle.hasSignature(await bundle.arrayBuffer(), "NMFB"),
      "hasSignature : identifie le bon compagnon (base du SCAN de dossier par signature)");
  }
  });

  await section("data : NON-RÉGRESSION .nmfb — la généralisation BinaryBundle émet l'OCTET POUR OCTET de l'ancien algorithme", async () => {
  {
    // L'ANCIEN algorithme d'ImageStore.buildBundle, recopié ICI en GOLDEN (c'est le point du test : si
    // la généralisation dérivait — ordre des champs du manifeste, entête, offsets — les .nmfb existants
    // deviendraient illisibles ou différents au re-save). Même rec, même clé → mêmes octets.
    const legacyBuild = (recs, key) => {
      const manifest = { v: 1, key: key || null, images: recs.map((r) => ({ id: r.id, name: r.name || "", u_height: (r.face === "autre") ? 1 : (r.u_height || 1), face: r.face, with_ears: r.face === "front" ? r.with_ears !== false : false, description: r.description || "", type: r.type || (r.blob && r.blob.type) || "", bytes: r.blob ? r.blob.size : 0 })) };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      const head = new Uint8Array(9); head.set([0x4E, 0x4D, 0x46, 0x42], 0); head[4] = 1;
      new DataView(head.buffer).setUint32(5, manifestBytes.length, true);
      const parts = [head, manifestBytes]; recs.forEach((r) => { if (r.blob) parts.push(r.blob); });
      return new Blob(parts, { type: "application/octet-stream" });
    };
    const recs = [
      { id: "im-a", name: "Façade avant", u_height: 2, face: "front", with_ears: true, description: "desc", type: "image/png", blob: new Blob([new Uint8Array([10, 20, 30])], { type: "image/png" }) },
      { id: "im-b", name: "Arrière", u_height: 1, face: "rear", with_ears: false, description: "", type: "image/webp", blob: new Blob([new Uint8Array([42])], { type: "image/webp" }) },
    ];
    const expected = await bytesOf(legacyBuild(recs, "FK-golden"));
    const actual = await bytesOf(ImageStore.buildBundle(recs, "FK-golden"));
    ck.eq(actual.length, expected.length, "non-régression .nmfb : MÊME taille totale que l'ancien algorithme");
    ck(sameBytes(actual, expected), "non-régression .nmfb : BIT-IDENTIQUE à l'ancien algorithme (entête + manifeste + blobs)");
    // Et le roundtrip existant reste vrai à travers l'enveloppe commune :
    const back = ImageStore.parseBundle(await ImageStore.buildBundle(recs, "FK-golden").arrayBuffer());
    ck.eq(back.key, "FK-golden", "roundtrip .nmfb via BinaryBundle : clé restaurée");
    ck.eq(back.recs.length, 2, "roundtrip .nmfb via BinaryBundle : images restaurées");
  }
  });

  await section("serveur : ContentDisposition — nom de download ASSAINI (D6 : CRLF, guillemets, non-ASCII → RFC 5987)", async () => {
  {
    const { ContentDisposition } = SERVER("ContentDisposition.js");

    // -- cas NOMINAL : ASCII simple → les deux paramètres portent le même nom. --
    ck.eq(ContentDisposition.attachment("rapport.pdf"), "attachment; filename=\"rapport.pdf\"; filename*=UTF-8''rapport.pdf",
      "nom ASCII simple : attachment + filename + filename* identiques");

    // -- INJECTION D'EN-TÊTE : CR/LF (et tout contrôle C0/DEL) RETIRÉS — la seule classe dangereuse. --
    const evil = ContentDisposition.attachment("a\r\nSet-Cookie: pwn=1\u0000.pdf");
    ck(!/[\r\n\u0000]/.test(evil), "CRLF/NUL : AUCUN caractère de contrôle ne survit dans l'en-tête (anti-injection)");
    ck(evil.includes("Set-Cookie:"), "CRLF : le TEXTE restant est inoffensif une fois les contrôles retirés (pas de nouvelle ligne)");

    // -- GUILLEMETS / ANTISLASH : la quoted-string ne peut pas être cassée. --
    ck.eq(ContentDisposition.asciiFallback('mon "doc" final.pdf'), "mon 'doc' final.pdf", "guillemets → apostrophes dans le repli ASCII (quoted-string intacte)");
    ck.eq(ContentDisposition.asciiFallback("a\\b.pdf"), "a_b.pdf", "antislash → _ (pas d'échappement quoted-pair hasardeux)");

    // -- NON-ASCII : repli `_` dans filename, nom FIDÈLE percent-encodé dans filename* (RFC 5987). --
    ck.eq(ContentDisposition.asciiFallback("été à Liège.pdf"), "_t_ _ Li_ge.pdf", "non-ASCII → _ dans le repli (vieux agents)");
    ck.eq(ContentDisposition.rfc5987Encode("été.pdf"), "%C3%A9t%C3%A9.pdf", "filename* : UTF-8 percent-encodé (accents restaurés par les agents modernes)");
    ck(ContentDisposition.attachment("été.pdf").endsWith("filename*=UTF-8''%C3%A9t%C3%A9.pdf"), "attachment : le paramètre étendu porte le nom fidèle");

    // -- attr-char RFC 5987 : les 4 caractères qu'encodeURIComponent laisse passer sont encodés AUSSI. --
    ck.eq(ContentDisposition.rfc5987Encode("l'étoile (*).txt"), "l%27%C3%A9toile%20%28%2A%29.txt", "filename* : ' ( ) * percent-encodés (hors grammaire attr-char)");

    // -- VIDE / contrôles seuls : repli « fichier » (un download sans nom est illisible). --
    ck.eq(ContentDisposition.stripControls(""), "fichier", "nom vide → « fichier »");
    ck.eq(ContentDisposition.stripControls("\r\n\t"), "fichier", "nom fait de contrôles/blancs → « fichier »");
  }
  });

  await section("serveur : AttachmentFiles — id opaque (anti path-traversal PAR CONSTRUCTION) + I/O disque + purge d'orphelins (D5)", async () => {
  {
    const { AttachmentFiles } = SERVER("AttachmentFiles.js");

    // -- LOGIQUE PURE : isSafeId — le SEUL juge de ce qui peut devenir un nom de fichier. --
    for (const good of ["att-5f0c1c2a", "doc-c0ffee", "A1_b.2-c", "m1x9z0abc", "a"]) {
      ck.eq(AttachmentFiles.isSafeId(good), true, "isSafeId(« " + good + " ») = true (alphanumériques + ._-)");
    }
    for (const bad of ["", "..", ".", "../x", "a/b", "a\\b", ".tmp-x", ".cache", "a b", "é", "a\u0000b", null, undefined, 42, "x".repeat(129)]) {
      ck.eq(AttachmentFiles.isSafeId(bad), false, "isSafeId(" + JSON.stringify(String(bad)) + ") = false (séparateur, point en tête, contrôle, longueur…)");
    }
    ck(AttachmentFiles.isTempName(AttachmentFiles.tempName()) && !AttachmentFiles.isSafeId(AttachmentFiles.tempName()),
      "tempName : reconnu temporaire, JAMAIS un id valide (préfixe « . » exclu par isSafeId)");

    // -- COMPOSITION DE CHEMINS : validante, aucun moyen d'en sortir. --
    const files = new AttachmentFiles(path.join(os.tmpdir(), "dcm-att-pure"));
    ck(files.pathFor("doc-1", "att-1").endsWith(path.join("attachments", "doc-1", "att-1")), "pathFor : <racine>/attachments/<docId>/<attachmentId>");
    for (const traversal of ["../evil", "..", "a/../../b", "a\\..\\b"]) {
      let threwTraversal = false; try { files.pathFor("doc-1", traversal); } catch (_) { threwTraversal = true; }
      ck(threwTraversal, "pathFor(« " + traversal + " ») → LÈVE (défense en profondeur, même si la route a déjà validé)");
    }
    let threwDoc = false; try { files.dirFor("../ailleurs"); } catch (_) { threwDoc = true; }
    ck(threwDoc, "dirFor : docId malformé → LÈVE aussi (les DEUX segments sont gardés)");

    // -- I/O RÉELLES (dossier temporaire, nettoyé) : écriture .tmp → promote atomique → lecture → purge. --
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-att-"));
    try {
      const io = new AttachmentFiles(root);
      const dir = io.ensureDir("doc-1");
      ck(fs.existsSync(dir), "ensureDir : dossier du document créé");
      // upload façon multer : un temporaire dans le dossier CIBLE, promu vers l'id définitif (rename atomique)
      const temp = path.join(dir, AttachmentFiles.tempName());
      fs.writeFileSync(temp, Buffer.from([1, 2, 3, 4]));
      io.promote(temp, "doc-1", "att-keep");
      ck(!fs.existsSync(temp), "promote : le temporaire a disparu (rename, pas copie)");
      ck.eq((io.statOf("doc-1", "att-keep") || {}).size, 4, "statOf : taille du binaire promu");
      ck.eq(io.statOf("doc-1", "att-absent"), null, "statOf : binaire absent → null (le 404 du download)");
      // orphelins : un binaire dé-référencé + un temporaire abandonné (crash d'upload simulé)
      fs.writeFileSync(path.join(dir, "att-orphan"), Buffer.from([9, 9, 9]));
      fs.writeFileSync(path.join(dir, AttachmentFiles.tempName()), Buffer.from([7]));
      ck.eq(JSON.stringify(io.listIds("doc-1").sort()), JSON.stringify(["att-keep", "att-orphan"]), "listIds : ids présents, temporaires EXCLUS");
      const purge = io.purgeOrphans("doc-1", new Set(["att-keep"]));
      ck.eq(purge.purged, 2, "purgeOrphans : orphelin + temporaire abandonné supprimés (2)");
      ck.eq(purge.bytes, 4, "purgeOrphans : octets récupérés comptés (3 + 1)");
      ck.eq(JSON.stringify(io.listIds("doc-1")), JSON.stringify(["att-keep"]), "purgeOrphans : le binaire RÉFÉRENCÉ survit (liste fournie = collection, D5)");
      // lecture streamée : le contenu du référencé est intact après la purge
      const streamed = await new Promise((res, rej) => { const chunks = []; const s = io.readStream("doc-1", "att-keep"); s.on("data", (c) => chunks.push(c)); s.on("end", () => res(Buffer.concat(chunks))); s.on("error", rej); });
      ck(sameBytes(new Uint8Array(streamed), new Uint8Array([1, 2, 3, 4])), "readStream : binaire relu octet pour octet");
      io.removeDocumentDir("doc-1");
      ck(!fs.existsSync(dir), "removeDocumentDir : le dossier du document est emporté (suppression de document)");
      ck.eq(JSON.stringify(io.listIds("doc-1")), "[]", "listIds sur dossier absent → [] (document sans pièce jointe)");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  });

  await section("serveur : DocumentStore + pièces jointes (better-sqlite3 RÉEL) — maintenance purge le dé-référencé, la suppression de document emporte le dossier", async () => {
  {
    if (!requireSqlite()) return;
    const { DocumentStore } = SERVER("documents.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-attdoc-"));
    try {
      const docs = new DocumentStore(dir, SQLITE);
      const doc = docs.create("Doc pièces jointes");
      const repo = docs.repo(doc.id);
      // Un enregistrement de collection + SON binaire, et un binaire ORPHELIN (enregistrement supprimé
      // ou jamais créé — crash d'upload après promote, p. ex.).
      repo.upsert("attachments", { id: "att-ref", name: "Convention", file_name: "c.pdf", mime: "application/pdf", size: 2, equipment_id: null, sub_equipment_id: null }, 1);
      docs.attachmentFiles.ensureDir(doc.id);
      fs.writeFileSync(docs.attachmentFiles.pathFor(doc.id, "att-ref"), Buffer.from([1, 2]));
      fs.writeFileSync(docs.attachmentFiles.pathFor(doc.id, "att-orphan"), Buffer.from([3, 4, 5]));
      const report = docs.maintenance(doc.id);
      ck.eq(report.purgedAttachments, 1, "maintenance : le binaire dont l'id a QUITTÉ la collection est purgé (ids référencés = requête sur la table attachments)");
      ck.eq(report.purgedAttachmentBytes, 3, "maintenance : octets récupérés dans le rapport");
      ck.eq(typeof report.purgedImages, "number", "maintenance : le rapport images existant est intact (extension, pas remplacement)");
      ck(fs.existsSync(docs.attachmentFiles.pathFor(doc.id, "att-ref")), "maintenance : le binaire RÉFÉRENCÉ survit (D5 — jamais d'unlink hors maintenance, et la maintenance ne touche que les orphelins)");
      // Suppression du DOCUMENT : l'enregistrement part avec le .db, le dossier de binaires suit.
      const attachmentsDir = docs.attachmentFiles.dirFor(doc.id);
      ck(fs.existsSync(attachmentsDir), "pré-condition : le dossier attachments/<docId> existe");
      docs.delete(doc.id);
      ck(!fs.existsSync(attachmentsDir), "suppression de document : attachments/<docId>/ emporté récursivement");
      docs.closeAll();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  });

  await section("client : Store — helpers attachmentsOf* (index FK, tri) + cascade RÉELLE équipement → sous-équipement → pièces jointes", async () => {
  {
    const s = await makeStore();
    const eq = await s.create("equipments", { name: "SRV-37", type: "server" });
    const sub = await s.create("subEquipments", { name: "Drive LTO", equipment_id: eq.id });
    const attEq2 = await s.create("attachments", { name: "Zébulon", file_name: "z.pdf", mime: "application/pdf", equipment_id: eq.id });
    const attEq1 = await s.create("attachments", { name: "Convention", file_name: "c.pdf", mime: "application/pdf", equipment_id: eq.id });
    const attSub = await s.create("attachments", { name: "Garantie", file_name: "g.pdf", mime: "application/pdf", sub_equipment_id: sub.id });
    ck(attEq1 && attEq2 && attSub, "création : 3 pièces jointes valides acceptées par le Store (spec partagée)");
    ck.eq(s.attachmentsOfEquipment(eq.id).map((a) => a.name).join(","), "Convention,Zébulon", "attachmentsOfEquipment : pièces de l'équipement, TRIÉES par nom");
    ck.eq(s.attachmentsOfSubEquipment(sub.id).map((a) => a.name).join(","), "Garantie", "attachmentsOfSubEquipment : pièce du sous-équipement");
    ck.eq(s.attachmentsOfEquipment(eq.id).some((a) => a.id === attSub.id), false, "exclusivité : la pièce du sous-équipement n'apparaît PAS sur l'équipement (FK distinctes)");
    // MIME hors liste blanche → REFUSÉ par le Store (la validation partagée est le garde-fou du mode fichier).
    ck.eq(await s.create("attachments", { name: "Piégée", file_name: "x.html", mime: "text/html", equipment_id: eq.id }), null,
      "création REFUSÉE : mime text/html hors liste blanche (invariant partagé, anti-XSS-stocké)");
    // CASCADE RÉELLE (pas un plan sur corpus simulé — le Store applique Cascade.planMany) : supprimer
    // l'ÉQUIPEMENT emporte ses pièces ET celles de son sous-équipement (récursion, décision D3).
    await s.remove("equipments", eq.id);
    ck.eq(s.all("attachments").length, 0, "cascade Store : équipement supprimé → TOUTES ses pièces supprimées (directes + celles du sous-équipement, récursion)");
    ck.eq(s.get("subEquipments", sub.id), null, "cascade Store : le sous-équipement a bien suivi le maître (pré-condition de la récursion)");
  }
  });
};

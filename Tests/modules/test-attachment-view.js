/* Tests modules — VIEWER intégré des pièces jointes (cadrage B, lot du 2026-08-11).
   Trois modules PURS (aucun DOM) : le choix du rendu par MIME/extension
   (core/AttachmentViewKind), la politique d'images du markdown (core/MarkdownImagePolicy),
   et le repli extension → MIME du sélecteur de fichier (ui/FilePicker.resolveMime, la seule
   partie pure du composant — le reste manipule le DOM). Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SharedSchema } = require("./harness.js");

module.exports = async () => {
  const { AttachmentViewKind } = D("core/AttachmentViewKind.js");
  const { MarkdownImagePolicy } = D("core/MarkdownImagePolicy.js");
  const { FilePicker } = D("ui/FilePicker.js");

  await section("AttachmentViewKind.kindOf — choix du rendu par MIME puis extension", async () => {
    // MIME reconnu = autorité.
    ck.eq(AttachmentViewKind.kindOf("application/pdf", "doc.pdf"), "pdf", "application/pdf → pdf");
    ck.eq(AttachmentViewKind.kindOf("image/png", "photo.png"), "image", "image/png → image");
    ck.eq(AttachmentViewKind.kindOf("image/jpeg", "x.jpg"), "image", "image/jpeg → image");
    ck.eq(AttachmentViewKind.kindOf("image/webp", "x.webp"), "image", "image/webp → image");
    ck.eq(AttachmentViewKind.kindOf("text/markdown", "readme.md"), "markdown", "text/markdown → markdown");
    ck.eq(AttachmentViewKind.kindOf("text/plain", "notes.txt"), "text", "text/plain → text");
    ck.eq(AttachmentViewKind.kindOf("text/csv", "data.csv"), "text", "text/csv → text (pas de rendu tabulaire v1)");

    // Le paramètre de charset ne perturbe pas la classification.
    ck.eq(AttachmentViewKind.kindOf("text/plain; charset=utf-8", "notes.txt"), "text", "MIME avec ; charset → normalisé");
    ck.eq(AttachmentViewKind.kindOf("TEXT/MARKDOWN", "x.md"), "markdown", "MIME insensible à la casse");

    // Repli/raffinement par extension : un .md stocké en text/plain DOIT rendre en markdown.
    ck.eq(AttachmentViewKind.kindOf("text/plain", "GUIDE.MD"), "markdown", ".md en text/plain → markdown (casse ignorée)");
    ck.eq(AttachmentViewKind.kindOf("text/plain", "x.markdown"), "markdown", ".markdown en text/plain → markdown");
    ck.eq(AttachmentViewKind.kindOf("text/csv", "notes.md"), "markdown", ".md gagne même en text/csv");

    // MIME VIDE : repli pur par extension.
    ck.eq(AttachmentViewKind.kindOf("", "readme.md"), "markdown", "mime vide + .md → markdown");
    ck.eq(AttachmentViewKind.kindOf("", "notes.txt"), "text", "mime vide + .txt → text");
    ck.eq(AttachmentViewKind.kindOf("", "data.csv"), "text", "mime vide + .csv → text");
    ck.eq(AttachmentViewKind.kindOf("", "doc.pdf"), "pdf", "mime vide + .pdf → pdf");
    ck.eq(AttachmentViewKind.kindOf("", "img.jpeg"), "image", "mime vide + .jpeg → image");
    ck.eq(AttachmentViewKind.kindOf(null, "img.png"), "image", "mime null + .png → image");

    // Non visualisables : office (MIME présent mais non classant) et inconnus → null (pas de bouton « Afficher »).
    ck.eq(AttachmentViewKind.kindOf("application/vnd.oasis.opendocument.text", "x.odt"), null, "ODT → null");
    ck.eq(AttachmentViewKind.kindOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x.docx"), null, "DOCX → null");
    ck.eq(AttachmentViewKind.kindOf("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x.xlsx"), null, "XLSX → null");
    ck.eq(AttachmentViewKind.kindOf("", "archive.zip"), null, "mime vide + extension inconnue → null");
    ck.eq(AttachmentViewKind.kindOf("", "sansextension"), null, "mime vide + aucune extension → null");
  });

  await section("MarkdownImagePolicy.classify — local / same-origin / external (base document)", async () => {
    const base = "https://dcm.example.org/app/index.html";

    // Locales (contenu embarqué) : toujours rendues.
    ck.eq(MarkdownImagePolicy.classify("data:image/png;base64,AAAA", base), "local", "data: → local");
    ck.eq(MarkdownImagePolicy.classify("blob:https://dcm.example.org/xyz", base), "local", "blob: → local");
    ck.eq(MarkdownImagePolicy.classify("", base), "local", "src vide → local (rien à neutraliser)");

    // Same-origin (relatives et absolues sur la même origine que l'app) : rendues d'office.
    ck.eq(MarkdownImagePolicy.classify("images/schema.png", base), "same-origin", "relative → same-origin (résolue contre la base)");
    ck.eq(MarkdownImagePolicy.classify("/static/logo.png", base), "same-origin", "absolue racine même hôte → same-origin");
    ck.eq(MarkdownImagePolicy.classify("https://dcm.example.org/x.png", base), "same-origin", "URL absolue même origine → same-origin");

    // Externes : neutralisées (autre origine, protocole, port, schéma exotique, URL cassée).
    ck.eq(MarkdownImagePolicy.classify("https://evil.example.com/pixel.png", base), "external", "autre hôte → external");
    ck.eq(MarkdownImagePolicy.classify("http://dcm.example.org/x.png", base), "external", "autre schéma (http vs https) → external");
    ck.eq(MarkdownImagePolicy.classify("https://dcm.example.org:8443/x.png", base), "external", "autre port → external");
    ck.eq(MarkdownImagePolicy.classify("//evil.example.com/x.png", base), "external", "protocole-relatif vers autre hôte → external");
    ck.eq(MarkdownImagePolicy.classify("javascript:alert(1)", base), "external", "schéma exotique (javascript:) → external (neutralisé)");

    // Base reverse-proxy sous-dossier : le <base> déplace la résolution des relatives, l'origine reste identique.
    const proxied = "https://dcm.example.org/dcmanager/";
    ck.eq(MarkdownImagePolicy.classify("img/a.png", proxied), "same-origin", "relative sous <base> sous-dossier → same-origin");
  });

  await section("FilePicker.resolveMime — repli extension → MIME (D-B2)", async () => {
    const table = { ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".csv": "text/csv" };
    const isValid = (t) => SharedSchema.isAttachmentMime(t);

    // Type navigateur RECONNU : conservé tel quel (jamais réécrit par une extension trompeuse).
    ck.eq(FilePicker.resolveMime("doc.pdf", "application/pdf", table, isValid), "application/pdf", "type reconnu → conservé");
    ck.eq(FilePicker.resolveMime("weird.pdf", "text/plain", table, isValid), "text/plain", "type reconnu même si extension autre → conservé");

    // Type VIDE : résolu par l'extension.
    ck.eq(FilePicker.resolveMime("notes.md", "", table, isValid), "text/markdown", "type vide + .md → text/markdown (résolu)");
    ck.eq(FilePicker.resolveMime("readme.MARKDOWN", "", table, isValid), "text/markdown", "type vide + .markdown (casse) → text/markdown");
    ck.eq(FilePicker.resolveMime("data.csv", "", table, isValid), "text/csv", "type vide + .csv → text/csv");

    // Type INCONNU de la validation : résolu par l'extension.
    ck.eq(FilePicker.resolveMime("data.csv", "application/vnd.ms-excel", table, isValid), "text/csv", "type inconnu + extension connue → résolu");
    ck.eq(FilePicker.resolveMime("notes.md", "application/octet-stream", table, isValid), "text/markdown", "type inconnu + .md → text/markdown");

    // Ni type reconnu ni extension connue → type d'origine rendu tel quel (sera REFUSÉ par la validation en aval).
    ck.eq(FilePicker.resolveMime("archive.zip", "", table, isValid), "", "type vide + extension inconnue → \"\" (refus en aval)");
    ck.eq(FilePicker.resolveMime("noext", "", table, isValid), "", "type vide + aucune extension → \"\" (refus)");
    ck.eq(isValid(FilePicker.resolveMime("archive.zip", "", table, isValid)), false, "le MIME résolu d'un .zip échoue bien à la validation");
    ck.eq(isValid(FilePicker.resolveMime("notes.md", "", table, isValid)), true, "le MIME résolu d'un .md passe la validation (text/markdown admis)");
  });
};

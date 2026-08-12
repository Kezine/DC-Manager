import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { Html } from "../../core/Html";
import { Format } from "../../core/Format";
import { Download } from "../../core/Download";
import { Notify } from "../../ui/Notify";
import { I18n } from "../../i18n/I18n";
import { Markdown } from "../../core/Markdown";
import { AttachmentViewKind } from "../../core/AttachmentViewKind";
import { MarkdownImagePolicy } from "../../core/MarkdownImagePolicy";
import type { FormHost } from "./shared";

/* =============================================================================
   AttachmentUi — briques d'UI PARTAGÉES des pièces jointes (principe n°3).

   Deux surfaces ont EXACTEMENT le même besoin :
     - la fiche ÉQUIPEMENT (`EquipmentForms.equipmentDetail`, DANS la chaîne
       d'héritage des formulaires) ;
     - la fiche SOUS-ÉQUIPEMENT (`SubEquipmentForms.detail`, HORS de la chaîne,
       comme `FaceEditor`).
   Dupliquer la section « Pièces jointes » entre les deux les ferait diverger au
   premier ajustement. Elle vit donc ICI, dans un module autonome qui n'importe
   QUE des feuilles (Icons/Html/Format/Download/Notify/I18n) — jamais `DetailForms`
   ni `EquipmentForms` : l'OUVERTURE de la fiche d'une pièce est INJECTÉE
   (`openAttachment`), ce qui évite tout cycle de modules (la fiche équipement
   passe `(this as any).attachmentDetail` — `this` résout vers `Forms` à l'appel ;
   la fiche sous-équipement passe `DetailForms.attachmentDetail`, qu'elle importe
   en usage DIFFÉRÉ).

   `download` est le geste UNIQUE de téléchargement d'un binaire — partagé par les
   deux sections, la fiche `attachmentDetail` ET le sous-onglet du listing. Il
   distingue les DEUX modes SANS drapeau, par le backend (D4) : en mode API,
   `downloadUrl` sert une URL serveur STREAMÉE (`Content-Disposition: attachment`,
   jamais le binaire en mémoire) ; en mode fichier, elle est nulle → on lit le
   blob d'IndexedDB (`getBlob`) et on déclenche le download côté navigateur.
   ============================================================================= */
export class AttachmentUi {
  /** Déclenche le TÉLÉCHARGEMENT d'une pièce jointe. `att` = l'enregistrement (id + file_name). */
  static async download(host: FormHost, att: any): Promise<void> {
    const store = host.attachmentStore;
    if (!store || !att) return;
    // Mode API : l'URL serveur streame le binaire (Content-Disposition: attachment force le download,
    // cookies SSO transmis par une ancre same-origin) — jamais chargé en mémoire (D4/D6).
    const url = store.downloadUrl(att.id);
    if (url) {
      const a = document.createElement("a");
      a.href = url; a.download = att.file_name || att.id;   // le serveur fait autorité sur le nom via l'en-tête
      document.body.appendChild(a); a.click(); a.remove();
      return;
    }
    // Mode fichier : le binaire vit dans IndexedDB → blob puis download navigateur (nom d'origine assaini).
    const blob = await store.getBlob(att.id).catch(() => null);
    if (!blob) { Notify.toast(I18n.t("attachment.binaryMissing"), "err"); return; }
    Download.blob(Download.safeName(att.file_name || att.id), blob);
  }

  /* =============================================================================
     VIEWER intégré (cadrage B, 2026-08-11) — affiche une pièce jointe DANS la pile
     de modales sans quitter l'app, 100 % client (aucune route serveur) et dans les
     DEUX modes (`getBlob` est mode-agnostique). Types rendus : image, texte,
     markdown, PDF (cf. `AttachmentViewKind`) ; les autres (ODT/DOCX/XLSX…) n'ont
     pas de bouton « Afficher » (verdict `null`) et restent en téléchargement seul.
     Le viewer est un niveau `info` (SANS `onSave`, `hideFooter`) : il s'empile
     PARTOUT, y compris au-dessus d'un formulaire d'édition (garde D9b).
     ============================================================================= */
  /** Plafond de texte AFFICHÉ (1 Mo) : au-delà on tronque + bandeau, sinon un fichier de dizaines de Mo
      figerait l'onglet. La lecture reste bornée à ce plafond (on ne charge jamais tout le blob en texte). */
  private static readonly TEXT_VIEW_LIMIT = 1024 * 1024;

  /** Ouvre le VIEWER d'une pièce jointe `att` (enregistrement `attachments`). Binaire absent → toast (cas
      D8 du visualiseur autonome). Le contenu binaire des types image/PDF passe par un `objectURL` RÉVOQUÉ à
      la fermeture de la modale (`onClose`) — jamais de fuite par ouvertures répétées (précédent :
      `PerspectiveEditor.open`). */
  static async view(host: FormHost, att: any): Promise<void> {
    const store = host.attachmentStore;
    if (!store || !att) return;
    const blob = await store.getBlob(att.id).catch(() => null);
    if (!blob) { Notify.toast(I18n.t("attachment.binaryMissing"), "err"); return; }
    const kind = AttachmentViewKind.kindOf(att.mime, att.file_name);

    const root = document.createElement("div");
    root.className = "attachment-viewer";
    // objectURL créé UNIQUEMENT pour les rendus binaires (image/PDF) ; texte/markdown lisent le blob en texte.
    let objectUrl: string | null = null;

    if (kind === "image") {
      objectUrl = URL.createObjectURL(blob);
      const img = document.createElement("img");
      img.className = "attachment-view-image";
      img.src = objectUrl;
      img.alt = att.file_name || att.name || "";
      root.appendChild(img);
    } else if (kind === "pdf") {
      // PDF (D-B1) : visionneuse NATIVE du navigateur via `<iframe>` sur le blob local. PAS d'attribut
      // `sandbox` (il bloque le plugin PDF de certains navigateurs) — le blob est local, jamais servi inline
      // par l'origine (D6 révisé). Dégradation gracieuse : un navigateur qui ne rend pas le PDF laisse
      // l'iframe vide, l'utilisateur garde le pied « Télécharger ». Validation multi-navigateurs à l'œil.
      objectUrl = URL.createObjectURL(blob);
      const frame = document.createElement("iframe");
      frame.className = "attachment-view-pdf";
      frame.src = objectUrl;
      frame.title = att.file_name || att.name || I18n.t("attachment.view.title");
      root.appendChild(frame);
    } else if (kind === "text") {
      void AttachmentUi._fillText(root, blob);
    } else if (kind === "markdown") {
      void AttachmentUi._fillMarkdown(root, blob);
    } else {
      // Défense : le bouton « Afficher » est masqué pour un type non visualisable ; si on y parvient malgré
      // tout, un repli lisible plutôt qu'une modale vide.
      const note = document.createElement("p"); note.className = "attachment-view-note";
      note.textContent = I18n.t("attachment.view.notViewable");
      root.appendChild(note);
    }

    // Pied : « Télécharger » (réutilise le geste UNIQUE `download`) — même bouton que la fiche détail.
    const dlBtn = document.createElement("button"); dlBtn.type = "button"; dlBtn.className = "btn btn-ghost";
    dlBtn.innerHTML = `<span class="gi">${Icons.EXPORT}</span>${I18n.t("lists.chrome.rowDownload")}`;
    dlBtn.onclick = () => { void AttachmentUi.download(host, att); };

    host.openModal({
      title: att.name || att.file_name || I18n.t("attachment.view.title"),
      subtitle: Html.escape([att.file_name, Format.bytes(att.size)].filter(Boolean).join(" · ")),
      body: root,
      footerActions: [dlBtn],
      hideFooter: true,   // niveau `info` : JAMAIS d'`onSave` (empilable partout, garde D9b)
      wide: true,
      stackKey: "view:attachments/" + att.id,
      // RÉVOCATION de l'objectURL : `onClose` est rappelé à la disparition du niveau, quelle qu'en soit la
      // cause (← Retour, ✕, Échap, clic hors modale, dédup de pile) — point de révocation UNIQUE, pas de fuite.
      onClose: () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } },
    });
  }

  /** Remplit `root` avec le rendu TEXTE brut d'un blob (tronqué à 1 Mo), en `textContent` — JAMAIS innerHTML
      (le contenu est arbitraire : l'injecter en HTML serait un XSS). */
  private static async _fillText(root: HTMLElement, blob: Blob): Promise<void> {
    const truncated = blob.size > AttachmentUi.TEXT_VIEW_LIMIT;
    const text = await (truncated ? blob.slice(0, AttachmentUi.TEXT_VIEW_LIMIT) : blob).text().catch(() => null);
    if (text == null) { AttachmentUi._appendReadError(root); return; }
    if (truncated) root.appendChild(AttachmentUi._truncationBanner());
    const pre = document.createElement("pre");
    pre.className = "attachment-view-text";
    pre.textContent = text;   // 🚨 textContent (sûr) — jamais innerHTML sur un contenu de fichier
    root.appendChild(pre);
  }

  /** Remplit `root` avec le rendu MARKDOWN d'un blob (tronqué à 1 Mo), en variante plein-cadre `.md-body-full`.
      Politique d'images D-B3 : locales/same-origin rendues, EXTERNES neutralisées avec bouton d'activation
      (pour CETTE ouverture uniquement). Le HTML rendu (défauts micromark SÛRS) est mémorisé pour le re-rendu. */
  private static async _fillMarkdown(root: HTMLElement, blob: Blob): Promise<void> {
    const truncated = blob.size > AttachmentUi.TEXT_VIEW_LIMIT;
    const text = await (truncated ? blob.slice(0, AttachmentUi.TEXT_VIEW_LIMIT) : blob).text().catch(() => null);
    if (text == null) { AttachmentUi._appendReadError(root); return; }
    if (truncated) root.appendChild(AttachmentUi._truncationBanner());

    const rendered = Markdown.render(text);   // défauts micromark : HTML brut échappé, protocoles filtrés
    const body = document.createElement("div");
    body.className = "md-body md-body-full";
    body.innerHTML = rendered;
    const externals = AttachmentUi._applyImagePolicy(body, false);

    // Bouton « Afficher les images externes » : proposé SEULEMENT s'il y a au moins une externe neutralisée.
    // Il re-rend depuis le HTML FRAIS en autorisant les externes, pour cette ouverture (aucune persistance).
    if (externals > 0) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn btn-ghost btn-sm attachment-view-extimg";
      btn.textContent = I18n.t("attachment.view.showExternalImages", { count: externals });
      btn.onclick = () => {
        body.innerHTML = rendered;
        AttachmentUi._applyImagePolicy(body, true);
        btn.remove();
      };
      root.appendChild(btn);
    }
    root.appendChild(body);
  }

  /** Applique la politique d'images D-B3 au markdown DÉJÀ rendu dans `container` : locales/same-origin
      laissées telles quelles, EXTERNES remplacées par un lien sûr montrant l'URL (jamais suivie
      automatiquement) — sauf si `allowExternal`. Renvoie le nombre d'images EXTERNES rencontrées. La
      CLASSIFICATION est pure (`MarkdownImagePolicy`, testée) ; seule la manipulation DOM vit ici. */
  private static _applyImagePolicy(container: HTMLElement, allowExternal: boolean): number {
    const base = (typeof document !== "undefined" && document.baseURI) ? document.baseURI : "";
    let externalCount = 0;
    container.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src");
      if (MarkdownImagePolicy.classify(src, base) !== "external") return;   // local / same-origin : rendues
      externalCount++;
      if (allowExternal) return;   // activées pour cette ouverture : on laisse l'<img> charger
      const holder = document.createElement("span");
      holder.className = "md-ext-image";
      holder.title = I18n.t("attachment.view.externalImageTitle");
      // Lien SÛR (href échappé + schéma en liste blanche http/https, sinon simple texte) montrant l'URL.
      holder.innerHTML = `<span class="gi" aria-hidden="true">${Icons.IMAGE}</span>` + Html.externalLink(src || "", src || "");
      img.replaceWith(holder);
    });
    return externalCount;
  }

  private static _truncationBanner(): HTMLElement {
    const banner = document.createElement("div");
    banner.className = "attachment-view-truncated";
    banner.textContent = I18n.t("attachment.view.truncated");
    return banner;
  }
  private static _appendReadError(root: HTMLElement): void {
    const note = document.createElement("p");
    note.className = "attachment-view-note";
    note.textContent = I18n.t("attachment.view.readError");
    root.appendChild(note);
  }

  /** Ajoute la section « Pièces jointes » à une fiche PORTEUSE — MASQUÉE si `rows` est vide (on n'ajoute
      pas un bloc muet à une fiche déjà dense, patron de la section « Applications hébergées »). Chaque
      ligne : libellé CLIQUABLE → `openAttachment(id)` (sa fiche s'empile, la fiche porteuse se reconstruit
      au retour via son `onResume`), taille formatée, et un bouton-ICÔNE Télécharger (principe n°14). */
  static section(store: Store, host: FormHost, root: HTMLElement, rows: any[], openAttachment: (id: string) => void): void {
    if (!rows || !rows.length) return;
    const divider = document.createElement("div");
    divider.className = "section-divider";
    divider.textContent = I18n.t("attachment.section", { count: rows.length });
    root.appendChild(divider);

    const tw = document.createElement("div"); tw.className = "table-wrap";
    const body = rows.map((att: any) =>
      `<tr>`
      + `<td class="cell-name"><span data-att-view="${Html.escape(att.id)}" role="button" tabindex="0" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;" title="${Html.escape(I18n.t("attachment.openDetail"))}">${Html.escape(att.name || I18n.t("lists.ph.noName"))}</span></td>`
      + `<td class="cell-num">${Html.escape(Format.bytes(att.size))}</td>`
      + `<td class="cell-actions"><button class="btn btn-ghost btn-sm icon-action" data-att-dl="${Html.escape(att.id)}" title="${I18n.t("lists.chrome.rowDownload")}" aria-label="${I18n.t("lists.chrome.rowDownload")}">${Icons.EXPORT}</button></td>`
      + `</tr>`,
    ).join("");
    tw.innerHTML = `<table><thead><tr><th>${I18n.t("lists.col.name")}</th><th class="cell-num">${I18n.t("lists.col.size")}</th><th style="text-align:right;">${I18n.t("lists.chrome.actions")}</th></tr></thead><tbody>${body}</tbody></table>`;
    root.appendChild(tw);

    tw.querySelectorAll("[data-att-view]").forEach((el) => {
      const open = () => openAttachment((el as HTMLElement).dataset.attView!);
      (el as HTMLElement).onclick = open;
      (el as HTMLElement).onkeydown = (ev: KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } };
    });
    tw.querySelectorAll("[data-att-dl]").forEach((el) => {
      (el as HTMLElement).onclick = () => { void AttachmentUi.download(host, store.get("attachments", (el as HTMLElement).dataset.attDl!)); };
    });
  }
}

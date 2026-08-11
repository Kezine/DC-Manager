import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { Html } from "../../core/Html";
import { Format } from "../../core/Format";
import { Download } from "../../core/Download";
import { Notify } from "../../ui/Notify";
import { I18n } from "../../i18n/I18n";
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

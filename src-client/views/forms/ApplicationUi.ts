import { Html } from "../../core/Html";
import { I18n } from "../../i18n/I18n";
import { AsyncSection } from "./AsyncSection";

/* =============================================================================
   ApplicationUi — la section « Applications hébergées » d'une fiche PORTEUSE.

   Jumelle exacte d'`AttachmentUi.section`, et pour la même raison (principe n°3) :
   DEUX fiches ont EXACTEMENT le même besoin — la fiche ÉQUIPEMENT
   (`EquipmentForms.equipmentDetail`, dans la chaîne d'héritage des formulaires) et
   la fiche VM (`DetailForms.vmDetail`, plus bas dans la même chaîne). Le bloc y
   était recopié ; la garde G7 (rendu ASYNC, cf. docs/hydratation.md § Vague 2)
   aurait fait recopier une seconde mécanique par-dessus la première.

   Le module n'importe que des FEUILLES (Html/I18n/AsyncSection) : l'OUVERTURE de
   la fiche d'une application est INJECTÉE (`openApplication`), ce qui évite tout
   cycle de modules — la fiche équipement passe `(this as any).applicationDetail`
   (`this` statique résout vers `Forms` à l'appel), la fiche VM sa propre méthode.

   MASQUÉE si vide : on n'ajoute pas un bloc muet à une fiche déjà dense (règle
   commune aux sections spares / pièces jointes / sous-équipements liés).
   ============================================================================= */
export class ApplicationUi {
  /** Section alimentée en ASYNC (garde G7) : `rows` est la promesse d'un jumeau async du Store
      (`applicationsOfEquipmentAsync` / `applicationsOfVmAsync`). La place de la section est réservée
      immédiatement, son contenu arrive ensuite (cf. `AsyncSection`) — sinon elle atterrirait en fin de
      fiche, après les blocs construits en synchrone. Point d'entrée des FICHES. */
  static sectionAsync(root: HTMLElement, rows: Promise<any[]>, openApplication: (id: string) => void): void {
    AsyncSection.attach(root, rows, (holder, list) => ApplicationUi.section(holder, list, openApplication));
  }

  /** Rendu de la section pour des lignes CONNUES. Chaque ligne : nom CLIQUABLE → `openApplication(id)`
      (la fiche de l'application s'empile ; la fiche porteuse se reconstruit au retour via son
      `onResume`) et l'URL rendue par la primitive UNIQUE `Html.externalLink` (liste blanche http/https
      + noopener). Rien n'est rendu si la liste est vide. */
  static section(root: HTMLElement, rows: any[], openApplication: (id: string) => void): void {
    if (!rows || !rows.length) return;
    const divider = document.createElement("div");
    divider.className = "section-divider";
    divider.textContent = I18n.t("detail.application.hostedSection", { count: rows.length });
    root.appendChild(divider);

    const tw = document.createElement("div"); tw.className = "table-wrap";
    const body = rows.map((app: any) =>
      `<tr>`
      + `<td class="cell-name"><span data-app-view="${Html.escape(app.id)}" role="button" tabindex="0" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;" title="${Html.escape(I18n.t("detail.application.openApp"))}">${Html.escape(app.name || I18n.t("lists.ph.noName"))}</span></td>`
      + `<td>${app.url ? Html.externalLink(app.url) : '<span style="color:var(--fg-dimmer)">—</span>'}</td>`
      + `</tr>`,
    ).join("");
    tw.innerHTML = `<table><thead><tr><th>${I18n.t("lists.col.name")}</th><th>URL</th></tr></thead><tbody>${body}</tbody></table>`;
    root.appendChild(tw);

    tw.querySelectorAll("[data-app-view]").forEach((el) => {
      const open = () => openApplication((el as HTMLElement).dataset.appView!);
      (el as HTMLElement).onclick = open;
      (el as HTMLElement).onkeydown = (ev: KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } };
    });
  }
}

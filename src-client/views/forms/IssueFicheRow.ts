import { I18n } from "../../i18n/I18n";
import { IssueStatus } from "../../core/IssueStatus";
import type { IssueFicheHooks, IssueFicheItem } from "../IssueFicheHooks";

/* Rangée « Tickets » DISCRÈTE d'une fiche (détail équipement / VM / spare / sous-équipement) :
   badge « N ticket(s) ouvert(s) » + bouton « Ouvrir un ticket » + un MINI-LISTING des derniers
   tickets de la cible et un bouton « Afficher plus ». Helper PARTAGÉ par les quatre fiches
   (principe n°3 : UNE seule implémentation, pas une par fiche).

   Ne connaît que le contrat `IssueFicheHooks` (injecté) — aucun import de la vue ni du client
   tickets. No-op si `hooks` est null (feature retirée → rien ne s'affiche dans les fiches).

   ── 🚨 CE QUI DIFFÈRE D'`InterventionFicheRow`, ET POURQUOI ───────────────────────────
   Là-bas, badge et mini-listing sont chargés en ASYNCHRONE (deux appels réseau, un placeholder
   « … », un repli silencieux en cas d'échec) parce que les interventions vivent dans une base
   SERVEUR séparée. ICI, `issues` est une COLLECTION DU DOCUMENT : tout est lu SYNCHRONEMENT dans le
   Store via `core/IssueTargetSummary` (pur, testé). Conséquences visibles dans ce fichier :
   - la rangée est peinte EN UNE FOIS, dans son état définitif — aucun clignotement, aucun état
     d'erreur à absorber, aucune promesse ;
   - et elle FONCTIONNE EN MODE FICHIER (principe n°15), contrairement à celle des interventions.
     Seul le bouton « Ouvrir un ticket » dépend du mode API, parce que lui seul parle au tracker :
     le hook `createFor` est alors simplement ABSENT et le bouton n'est pas rendu (jamais grisé).

   TROIS ACTIONS, TROIS SÉMANTIQUES DE NAVIGATION — c'est la partie qu'on se trompe facilement :
   - une LIGNE du mini-listing EMPILE la fiche du ticket par-dessus la fiche courante (`openDetail`) :
     on ne change ni de vue ni de niveau visible, ← Retour ramène à l'objet ;
   - « Afficher plus » CHANGE DE VUE : on ferme d'abord la fiche (`close`, un POP — les fiches détail
     sont en lecture seule, rien à perdre) PUIS on ouvre l'onglet Tickets filtré sur la cible ;
   - « Ouvrir un ticket » EMPILE une modale de création et ne ferme RIEN — écart DÉLIBÉRÉ avec
     « Déclarer une intervention », qui navigue vers un autre onglet. Ici la création est une modale
     de l'app (principe n°11) : valider comme annuler ramène à la fiche, qui est le contexte utile. */
export class IssueFicheRow {
  /** Nombre de tickets listés sous le badge — les plus récemment actifs, tous états confondus
      (un ticket clos la semaine dernière fait partie de l'histoire de l'objet). */
  private static readonly LATEST_COUNT = 3;

  /** Ajoute la rangée à `root`. @param close  ferme la fiche courante (typiquement `() => host.closeModal?.()`). */
  static attach(
    root: HTMLElement,
    hooks: IssueFicheHooks | null | undefined,
    target: { kind: string; id: string; label: string },
    close: () => void,
  ): void {
    if (!hooks) return;   // feature retirée → aucune intégration dans les fiches

    // LECTURE SYNCHRONE (cf. l'en-tête) : on connaît l'état définitif AVANT de peindre quoi que ce
    // soit. Une cible sans aucun ticket ne mérite pas une section vide dans la fiche — mais le
    // bouton « Ouvrir un ticket », lui, garde tout son sens : c'est justement là qu'on en ouvre un.
    const digest = hooks.digestFor(target.kind, target.id, IssueFicheRow.LATEST_COUNT);
    const canCreate = typeof hooks.createFor === "function";
    if (digest.total === 0 && !canCreate) return;

    const divider = document.createElement("div");
    divider.className = "section-divider";
    divider.textContent = I18n.t("issues.fiche.section");
    root.appendChild(divider);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 8px";

    // Badge : « N ouvert(s) » en teinte d'AVERTISSEMENT (quelque chose reste à traiter sur cet
    // objet), sinon muet. Même langage visuel que le badge d'interventions, à dessein : les deux
    // rangées se lisent l'une sous l'autre dans la même fiche.
    const badge = document.createElement("span");
    badge.className = "pill";
    if (digest.openCount > 0) {
      badge.textContent = I18n.t("issues.fiche.openCount", { n: digest.openCount });
      badge.style.borderColor = "var(--warn)"; badge.style.color = "var(--warn)";
    } else {
      badge.textContent = I18n.t("issues.fiche.none");
      badge.style.borderColor = "var(--fg-dimmer)"; badge.style.color = "var(--fg-dim)";
    }
    row.appendChild(badge);

    if (hooks.createFor) {
      const create = hooks.createFor.bind(hooks);
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn btn-ghost btn-sm";
      btn.textContent = I18n.t("issues.fiche.create");
      btn.title = I18n.t("issues.fiche.createTitle");
      // Aucun `close()` ici : la modale de création s'EMPILE sur la fiche (cf. l'en-tête).
      btn.onclick = () => create(target.kind, target.id, target.label);
      row.appendChild(btn);
    }
    root.appendChild(row);

    if (digest.latest.length) {
      const list = document.createElement("div");
      list.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:0 0 8px";
      for (const item of digest.latest) list.appendChild(IssueFicheRow.line(item, () => hooks.openDetail(item.id)));
      root.appendChild(list);
    }

    if (digest.total > 0) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button"; moreBtn.className = "btn btn-ghost btn-sm";
      moreBtn.textContent = I18n.t("issues.fiche.showMore");
      moreBtn.title = I18n.t("issues.fiche.showMoreTitle");
      // CHANGEMENT DE VUE : on ferme la fiche (pop) PUIS on ouvre l'onglet Tickets filtré sur la
      // cible. Aucun LIBELLÉ transmis : la chip de la barre le résout elle-même à chaque rendu.
      moreBtn.onclick = () => { close(); hooks.openListFor(target.kind, target.id); };
      root.appendChild(moreBtn);
    }
  }

  /** Une ligne CLIQUABLE du mini-listing : bouton ACCESSIBLE (`role="button"` + tabindex +
      Entrée/Espace — même facture que le mini-listing des interventions et que les noms cliquables
      des grilles de baie) qui EMPILE la fiche du ticket. Les pastilles viennent d'`IssueStatus`,
      SOURCE UNIQUE de l'état affiché (HTML sûr par construction : couleurs constantes, libellé brut
      échappé) — on ne recompose surtout pas un second rendu de statut ici. */
  private static line(item: IssueFicheItem, open: () => void): HTMLElement {
    const line = document.createElement("div");
    // Marges négatives : le liseré de survol dépasse du texte SANS décaler l'alignement avec le badge.
    line.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;cursor:pointer;border-radius:4px;padding:2px 4px;margin:0 -4px";
    line.setAttribute("role", "button"); line.tabIndex = 0;
    line.title = I18n.t("issues.fiche.openDetail");
    const activate = (ev: Event): void => { ev.preventDefault(); open(); };
    line.onclick = activate;
    line.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") activate(e); };
    line.onmouseenter = () => { line.style.background = "var(--bg-2)"; };
    line.onmouseleave = () => { line.style.background = ""; };

    const key = document.createElement("span");
    key.style.cssText = "font-family:var(--mono);color:var(--fg-dim);white-space:nowrap";
    key.textContent = item.key || "—";

    const title = document.createElement("span");
    title.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    title.textContent = item.summary;
    title.title = item.summary;   // titre complet en survol (la ligne peut être tronquée)

    // `IssueStatus.pills` rend du HTML SÛR (cf. son en-tête § ÉCHAPPEMENT) : injection assumée.
    const state = document.createElement("span");
    state.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex:0 0 auto";
    state.innerHTML = IssueStatus.pills(item);

    line.append(key, title, state);
    return line;
  }
}

import { I18n } from "../../i18n/I18n";
import { Format } from "../../core/Format";
import { InterventionsFormat, type BadgeClass } from "../../core/InterventionsFormat";
import type { InterventionFicheHooks, InterventionFicheItem } from "../InterventionFicheHooks";

/* Rangée « Interventions » DISCRÈTE d'une fiche (détail équipement/VM/spare) : badge « N ouverte(s) »
   (chargé en async, SILENCIEUX en cas d'échec réseau — jamais bloquant) + bouton « Déclarer une
   intervention » + un MINI-LISTING des dernières interventions de la cible et un bouton « Afficher plus ».
   Helper PARTAGÉ par les quatre fiches (principe n°3 : une seule implémentation).

   Ne connaît que le contrat `InterventionFicheHooks` (injecté) — aucun import de la vue ni du client
   interventions. No-op si `hooks` est null (mode fichier / hors API → rien ne s'affiche dans les fiches).

   DÉCLARER = CHANGER DE VUE : le bouton FERME d'abord la fiche courante (`close` — un POP de la pile de
   modales, sans perte : les fiches détail sont en lecture seule) PUIS délègue à `declareFor` (navigation
   vers l'onglet Interventions + modale de création pré-liée). Si la fiche était EMPILÉE sur une autre
   modale, celle-ci redevient visible sous la modale de création — comportement de pile assumé.

   MINI-LISTING (« N dernières », TOUTES — pas seulement les ouvertes ; tri activité récente côté serveur) :
   chargé en async comme le badge, SILENCIEUX en échec réseau (rien ne s'affiche) et rien non plus si 0
   intervention. Chaque ligne est INFORMATIVE (non cliquable en phase 1 — la cliquabilité viendra avec la
   pile de modales : push de la fiche d'intervention par-dessus la fiche courante). « Afficher plus » suit
   EXACTEMENT la même séquence que « Déclarer » (close puis openListFor) : c'est un CHANGEMENT DE VUE, la
   vue Interventions s'ouvrant FILTRÉE sur la cible (chip retirable). */
export class InterventionFicheRow {
  /** Nombre de dernières interventions listées sous le badge (D2/D3 : les plus récemment actives, toutes). */
  private static readonly LATEST_COUNT = 3;
  /** Ajoute la rangée à `root`. @param close  ferme la fiche courante (typiquement `() => host.closeModal?.()`). */
  static attach(
    root: HTMLElement,
    hooks: InterventionFicheHooks | null | undefined,
    target: { kind: string; id: string; label: string },
    close: () => void,
  ): void {
    if (!hooks) return;   // hors mode API → aucune intégration dans les fiches

    const divider = document.createElement("div");
    divider.className = "section-divider";
    divider.textContent = I18n.t("interventions.fiche.section");
    root.appendChild(divider);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 8px";

    // Badge : placeholder « … » le temps du chargement, puis « N ouverte(s) »/« aucune », mute si indisponible.
    const badge = document.createElement("span");
    badge.className = "pill";
    badge.textContent = "…";
    const mute = (): void => { badge.style.borderColor = "var(--fg-dimmer)"; badge.style.color = "var(--fg-dim)"; };
    mute();

    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn btn-ghost btn-sm";
    btn.textContent = I18n.t("interventions.fiche.declare");
    btn.onclick = () => { close(); hooks.declareFor(target.kind, target.id, target.label); };

    row.append(badge, btn);
    root.appendChild(row);

    // Chargement ASYNCHRONE, non bloquant : un échec réseau laisse un « — » discret (jamais d'erreur remontée).
    hooks.countOpen(target.kind, target.id).then((n) => {
      if (n > 0) {
        badge.textContent = I18n.t("interventions.fiche.openCount", { n });
        badge.style.borderColor = "var(--warn)"; badge.style.color = "var(--warn)";
      } else {
        badge.textContent = I18n.t("interventions.fiche.none");
        mute();
      }
    }).catch(() => { badge.textContent = "—"; mute(); });

    // MINI-LISTING + « Afficher plus » : conteneurs créés VIDES (rien de visible tant que rien n'est chargé),
    // remplis par le chargement async ci-dessous. Le bouton reste masqué jusqu'à ≥ 1 intervention.
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:0 0 8px";
    root.appendChild(list);

    const moreBtn = document.createElement("button");
    moreBtn.type = "button"; moreBtn.className = "btn btn-ghost btn-sm";
    moreBtn.textContent = I18n.t("interventions.fiche.showMore");
    moreBtn.style.display = "none";   // apparaît seulement s'il y a au moins une intervention à montrer
    // « Afficher plus » = CHANGER DE VUE, comme « Déclarer » : on ferme la fiche (pop) PUIS on ouvre la vue
    // Interventions FILTRÉE sur la cible (elle a déjà son libellé — c'est celui de la fiche → chip retirable).
    moreBtn.onclick = () => { close(); hooks.openListFor(target.kind, target.id, target.label); };
    root.appendChild(moreBtn);

    // Chargement ASYNCHRONE, non bloquant : en échec réseau OU si aucune intervention, on ne montre RIEN
    // (le bloc reste réduit au badge + « Déclarer »). Jamais d'erreur remontée à l'utilisateur.
    hooks.latestFor(target.kind, target.id, InterventionFicheRow.LATEST_COUNT).then((items) => {
      if (!items.length) return;
      for (const item of items) list.appendChild(InterventionFicheRow.line(item));
      moreBtn.style.display = "";
    }).catch(() => { /* silencieux : le mini-listing est un confort, jamais bloquant */ });
  }

  /** Une ligne INFORMATIVE du mini-listing (NON cliquable en phase 1 — cf. en-tête). Réutilise les helpers
      de formatage partagés (principe n°14) : `Format.dateTime` pour la date, et les CLÉS i18n + classes de
      badge d'`InterventionsFormat` pour statut/priorité — aucun re-formatage maison. */
  private static line(item: InterventionFicheItem): HTMLElement {
    const line = document.createElement("div");
    line.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px";

    const date = document.createElement("span");
    date.style.cssText = "font-family:var(--mono);color:var(--fg-dim);white-space:nowrap";
    date.textContent = Format.dateTime(item.updated_date);

    const title = document.createElement("span");
    title.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    title.textContent = item.title;
    title.title = item.title;   // titre complet en survol (la ligne peut être tronquée)

    line.append(
      date, title,
      InterventionFicheRow.pill(I18n.t(InterventionsFormat.statusLabelKey(item.status)), InterventionsFormat.statusClass(item.status)),
      InterventionFicheRow.pill(I18n.t(InterventionsFormat.priorityLabelKey(item.priority)), InterventionsFormat.priorityClass(item.priority)),
    );
    return line;
  }

  /** Pastille sémantique (mêmes couleurs que la vue Interventions/Notifications/Certs — BadgeClass → variable
      CSS). Duplication ASSUMÉE de ce petit mapping (déjà répliqué dans ces vues, cf. leur `badge`) : la LOGIQUE
      de la classe, elle, reste unique dans `InterventionsFormat.statusClass`/`priorityClass`. */
  private static pill(text: string, cls: BadgeClass): HTMLElement {
    const span = document.createElement("span");
    span.className = "pill"; span.textContent = text;
    if (cls === "ok") { span.style.borderColor = "var(--ok)"; span.style.color = "var(--ok)"; }
    else if (cls === "err") { span.style.borderColor = "var(--err)"; span.style.color = "var(--err)"; }
    else if (cls === "warn") { span.style.borderColor = "var(--warn)"; span.style.color = "var(--warn)"; }
    else if (cls === "dim") { span.style.borderColor = "var(--fg-dimmer)"; span.style.color = "var(--fg-dim)"; }
    return span;
  }
}

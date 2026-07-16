import { I18n } from "../../i18n/I18n";
import type { InterventionFicheHooks } from "../InterventionFicheHooks";

/* Rangée « Interventions » DISCRÈTE d'une fiche (détail équipement/VM/spare) : badge « N ouverte(s) »
   (chargé en async, SILENCIEUX en cas d'échec réseau — jamais bloquant) + bouton « Déclarer une
   intervention ». Helper PARTAGÉ par les trois fiches (principe n°3 : une seule implémentation).

   Ne connaît que le contrat `InterventionFicheHooks` (injecté) — aucun import de la vue ni du client
   interventions. No-op si `hooks` est null (mode fichier / hors API → rien ne s'affiche dans les fiches).

   MODALE DANS MODALE : la fiche est DÉJÀ dans la modale UNIQUE de l'app. Le bouton FERME donc d'abord la
   fiche courante (`close`, ici sans perte : les fiches détail sont en lecture seule) PUIS délègue à
   `declareFor` (navigation + modale de création pré-liée). */
export class InterventionFicheRow {
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
  }
}

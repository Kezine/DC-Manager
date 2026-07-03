import type { Store } from "../../store";
import type { ModalOptions } from "../../ui/Modal";
import { FLOORS } from "../../domain/constants";
import { Ip } from "../../core/Ip";

/* Helpers et types PARTAGÉS par les formulaires (extraits de l'ancien Forms.ts monolithique). */

/** Libellés de forme de waypoint (réplique WAYPOINT_KIND_LABELS du monolithe). */
export const WAYPOINT_KIND_LABELS: Record<string, string> = { point: "Pin (point de passage)", segment: "Chemin de câbles (rail)", brush: "Brosse de brassage (baie)" };

export const locOptions = (store: Store) => [{ value: "", label: "— aucun —" }].concat(store.sitesSorted().map((s: any) => ({ value: s.id, label: s.name || s.id })));
export const floorOptions = (sel: string) => { const s = String(sel == null ? "" : sel); const o = [{ value: "", label: "— étage —" }].concat(FLOORS.map((f) => ({ value: f, label: "Étage " + f }))); if (s && !FLOORS.includes(s)) o.push({ value: s, label: s + " (hors liste)" }); return o; };

/** Options d'orientation au sol (0/90/180/270) — partagées par les formulaires baie / équipement libre. */
export const ORIENT_OPTS = [{ value: "0", label: "0°" }, { value: "90", label: "90°" }, { value: "180", label: "180°" }, { value: "270", label: "270°" }];

export const divider = (txt: string) => { const d = document.createElement("div"); d.className = "section-divider"; d.textContent = txt; return d; };
export const row2 = (...fields: HTMLElement[]) => { const r = document.createElement("div"); r.className = "form-row"; fields.forEach((f) => r.appendChild(f)); return r; };
/** Remplace les options d'un <select> existant (préserve l'élément + ses handlers). */
export const setOptions = (sel: HTMLSelectElement, opts: { value: string; label: string; disabled?: boolean }[], value?: string) => {
  sel.innerHTML = "";
  opts.forEach((o) => { const op = document.createElement("option"); op.value = o.value; op.textContent = o.label; if (o.disabled) op.disabled = true; sel.appendChild(op); });
  if (value != null) sel.value = value;
};

export const ipNetOptions = (store: Store) => store.all("ipNetworks").slice()
  .sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || ""))
  .map((n: any) => ({ value: n.id, label: Ip.short(n) }));
export const eqOptions = (store: Store, none: string) => [{ value: "", label: none }].concat(
  store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || "(équipement)" })));

/** Services applicatifs des formulaires (câblés par le shell). */
export interface FormHost {
  openModal(opts: ModalOptions): void;
  setDirty?(v: boolean): void;
  /** « Localiser » : ferme la modale, bascule en vue 3D et centre la caméra sur l'objet.
      `returnAction` (optionnel) = ce qu'exécute le bouton « Retour » de la vue 3D (ex. rouvrir la fiche). */
  locate?(kind: "equipment" | "rack" | "cable" | "port", id: string, returnAction?: () => void): void;
}

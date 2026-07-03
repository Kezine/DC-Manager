import type { Store } from "../../store";
import type { ModalOptions } from "../../ui/Modal";
import { FLOORS } from "../../domain/constants";
import { Ip } from "../../core/Ip";

/* Helpers et types PARTAGÉS par les formulaires (extraits de l'ancien Forms.ts monolithique). */

/** Libellés de forme de waypoint (réplique WAYPOINT_KIND_LABELS du monolithe). */
export const WAYPOINT_KIND_LABELS: Record<string, string> = { point: "Pin (point de passage)", segment: "Chemin de câbles (rail)", brush: "Brosse de brassage (baie)" };

/** Options d'orientation au sol (0/90/180/270) — partagées par les formulaires baie / équipement libre. */
export const ORIENT_OPTS = [{ value: "0", label: "0°" }, { value: "90", label: "90°" }, { value: "180", label: "180°" }, { value: "270", label: "270°" }];

/** Briques d'UI et listes d'options PARTAGÉES par les formulaires — classe sémantique à méthodes statiques
    (principe n°2 : pas de fonctions libres exportées ; les DONNÉES ci-dessus restent de simples exports). */
export class FormUi {
  /** Options « site / bâtiment » (— aucun — en tête). */
  static locOptions(store: Store): Array<{ value: string; label: string }> {
    return [{ value: "", label: "— aucun —" }].concat(store.sitesSorted().map((s: any) => ({ value: s.id, label: s.name || s.id })));
  }
  /** Options « étage » (une valeur courante hors liste est conservée, marquée). */
  static floorOptions(sel: string): Array<{ value: string; label: string }> {
    const s = String(sel == null ? "" : sel);
    const o = [{ value: "", label: "— étage —" }].concat(FLOORS.map((f) => ({ value: f, label: "Étage " + f })));
    if (s && !FLOORS.includes(s)) o.push({ value: s, label: s + " (hors liste)" });
    return o;
  }
  /** Intercalaire de section. */
  static divider(txt: string): HTMLElement { const d = document.createElement("div"); d.className = "section-divider"; d.textContent = txt; return d; }
  /** Rangée de champs côte à côte. */
  static row2(...fields: HTMLElement[]): HTMLElement { const r = document.createElement("div"); r.className = "form-row"; fields.forEach((f) => r.appendChild(f)); return r; }
  /** Remplace les options d'un <select> existant (préserve l'élément + ses handlers). */
  static setOptions(sel: HTMLSelectElement, opts: { value: string; label: string; disabled?: boolean }[], value?: string): void {
    sel.innerHTML = "";
    opts.forEach((o) => { const op = document.createElement("option"); op.value = o.value; op.textContent = o.label; if (o.disabled) op.disabled = true; sel.appendChild(op); });
    if (value != null) sel.value = value;
  }
  /** Options « réseau IP » triées par libellé. */
  static ipNetOptions(store: Store): Array<{ value: string; label: string }> {
    return store.all("ipNetworks").slice()
      .sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || ""))
      .map((n: any) => ({ value: n.id, label: Ip.short(n) }));
  }
  /** Options « équipement » triées par nom (`none` en tête). */
  static eqOptions(store: Store, none: string): Array<{ value: string; label: string }> {
    return [{ value: "", label: none }].concat(
      store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || "(équipement)" })));
  }
}

/** Services applicatifs des formulaires (câblés par le shell). */
export interface FormHost {
  openModal(opts: ModalOptions): void;
  setDirty?(v: boolean): void;
  /** « Localiser » : ferme la modale, bascule en vue 3D et centre la caméra sur l'objet.
      `returnAction` (optionnel) = ce qu'exécute le bouton « Retour » de la vue 3D (ex. rouvrir la fiche). */
  locate?(kind: "equipment" | "rack" | "cable" | "port", id: string, returnAction?: () => void): void;
}

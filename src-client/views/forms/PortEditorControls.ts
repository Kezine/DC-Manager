import type { Store } from "../../store";
import { PowerAnalysis } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Normalize } from "../../core/Normalize";
import { PortRoles } from "../../registries/PortRoles";
import { PORT_DIRECTIONS, POWER_PHASES } from "../../domain/constants";

/** Contexte injecté par le formulaire d'équipement à ses contrôles de port (couplage par INTERFACE, pas d'accès
    en dur au monolithe — cf. CLAUDE.md n°2). `equipment` = l'équipement édité (null si création) ; `currentType()`
    = son type COURANT dans le formulaire (peut différer de `equipment.type` tant que non enregistré) ;
    `rerenderPorts()` = re-rendu de la liste de ports après un changement qui en modifie la structure. */
export interface PortEditorHost {
  store: Store;
  equipment: any | null;
  currentType: () => string;
  rerenderPorts: () => void;
}

/** Brouillon de PORT manipulé par le formulaire d'équipement et ses contrôles — CONTRAT module↔save, jusqu'ici
    implicite (`any`). `id` est RÉEL (les FK ports↔agrégats tiennent avant l'enregistrement). Les champs OPTIONNELS
    sont posés à la volée : breakout (parent_port_id/lane), position de façade (face_*), terminaison (bundle/strand),
    réseau (assertion terminale), power (direction/calibre/phase). Le save (EquipmentForms.onSave) les neutralise
    selon le type d'équipement / le genre du port. */
export interface PortDraft {
  id: string;
  name: string;
  port_type_id: string | null;
  role: string;
  aggregate_id: string | null;
  description: string;
  parent_port_id?: string | null;
  lane?: number | null;
  face_x?: number | null;
  face_y?: number | null;
  face_side?: string;
  bundle_id?: string | null;
  strand_a?: number | null;
  strand_b?: number | null;
  network_id?: string | null;
  network_ids?: string[];
  direction?: string;
  power_max_a?: number | null;
  phase?: string;
}

/** Sous-UI d'édition d'un PORT dans le formulaire d'équipement : affectation de brins (patch), réseau asserté
    (terminal), sens/calibre/phase (power), + les 2 panneaux de synthèse (occupation patch, charge/warnings power).
    Opère sur le brouillon de port `p` passé par le formulaire ; ne connaît que le `host` (store + contexte du
    formulaire) — testable et réutilisable hors du monolithe EquipmentForms. */
export class PortEditorControls {
  constructor(private host: PortEditorHost) {}
  private get store(): Store { return this.host.store; }

  /** L'équipement édité est-il (couramment) un patch ? */
  isPatch(): boolean { return this.host.currentType() === "patch_panel"; }

  /** Faisceaux terminés par cet équipement (une de ses 2 extrémités). */
  patchBundles(): any[] {
    const eq = this.host.equipment;
    return eq ? this.store.all("cableBundles").filter((b: any) => b.endpoint_a_equipment_id === eq.id || b.endpoint_b_equipment_id === eq.id) : [];
  }

  /** PATCH : chaque port « pioche » 1 (simplex) ou 2 (duplex Tx/Rx) brins physiques dans le POOL d'un faisceau
      terminé par ce patch. Le 2e brin n'apparaît que si le connecteur est duplex (PortType.duplex). */
  patchStrandControls(p: PortDraft): HTMLElement {
    const store = this.store;
    const wrap = document.createElement("span"); wrap.style.cssText = "display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;";
    const bundles = this.patchBundles();
    const bOpts = [{ value: "", label: "— faisceau —" }].concat(bundles.map((b: any) => ({ value: b.id, label: (b.name || "(faisceau)") + " · " + store.bundleOccupancy(b.id).free + " libre" })));
    const bSel = FormControls.select(bOpts, p.bundle_id || ""); bSel.className = "sub-input app-select"; wrap.appendChild(bSel);
    bSel.onchange = () => { p.bundle_id = bSel.value || null; if (!p.bundle_id) { p.strand_a = null; p.strand_b = null; } this.host.rerenderPorts(); };
    if (p.bundle_id) {
      const bundle: any = store.get("cableBundles", p.bundle_id);
      const maxStrand = bundle ? bundle.fiber_count : undefined;
      const duplex = !!(p.port_type_id && (store.get("portTypes", p.port_type_id) || {} as any).duplex);
      const saI = FormControls.number(p.strand_a != null ? p.strand_a : "", { min: 1, max: maxStrand, step: 1, placeholder: duplex ? "Tx" : "brin" });
      saI.style.width = "62px"; saI.className = "sub-input";
      saI.oninput = () => { const v = parseInt(saI.value, 10); p.strand_a = isFinite(v) && v >= 1 ? v : null; };
      wrap.appendChild(saI);
      if (duplex) {
        const sbI = FormControls.number(p.strand_b != null ? p.strand_b : "", { min: 1, max: maxStrand, step: 1, placeholder: "Rx" });
        sbI.style.width = "62px"; sbI.className = "sub-input";
        sbI.oninput = () => { const v = parseInt(sbI.value, 10); p.strand_b = isFinite(v) && v >= 1 ? v : null; };
        wrap.appendChild(sbI);
      } else { p.strand_b = null; }
    }
    return wrap;
  }

  /** RÉSEAU d'un port TERMINAL (source unique ; déduit ailleurs). Filtré par le genre du port (data/power).
      Vide = JOKER. Édite le PRINCIPAL sans écraser un multi-réseaux préexistant (import/API) ; pastille « +N »
      si réseaux additionnels (éditeur multi complet : V2 — cf. docs/deduction-reseau.md). */
  terminalNetworkControl(p: PortDraft): HTMLElement {
    const store = this.store;
    const kind = PortRoles.kind(p.role);
    const nets = store.all("networks").filter((n: any) => (n.kind === "power" ? "power" : "data") === kind).sort((a: any, b: any) => (a.label || "").localeCompare(b.label || ""));
    const opts = [{ value: "", label: "— réseau (joker) —" }].concat(nets.map((n: any) => ({ value: n.id, label: (n.kind === "power" ? "⚡ " : "") + (n.label || "(réseau)") })));
    const sel = FormControls.select(opts, p.network_id || ""); sel.className = "sub-input app-select"; sel.title = "Réseau PRINCIPAL asserté par ce port (source du réseau ; vide = joker).";
    sel.onchange = () => {
      // P5/P8c : la FUSION réseau (anti-clobber #14) est PURE → Normalize.mergePrincipal (testée en isolation, hors DOM).
      // Elle gère : joker vide (network_ids=[] car « joker + réseaux » irreprésentable), port mono (REMPLACE le
      // principal sans laisser l'ancien inamovible), multi préexistant (préserve les additionnels, principal en tête).
      const r = Normalize.mergePrincipal(Array.isArray(p.network_ids) ? p.network_ids : [], p.network_id || null, sel.value || null);
      p.network_id = r.network_id; p.network_ids = r.network_ids;
      // joker (removed > 0) : des réseaux additionnels ont été retirés → on SIGNALE la perte (pas d'effacement muet).
      if (r.removed) Notify.toast(r.removed + " réseau(x) du port retiré(s) (joker : le port adopte le réseau déduit).");
      this.host.rerenderPorts();   // P5(c) : rafraîchit la pastille « +N » (onchange ne re-rendait pas) et l'aperçu réseau.
    };
    // Retour UNIFIÉ : toujours un span-conteneur (le select, + une pastille « +N » si des réseaux additionnels
    // existent) — plus de double forme de retour (bare select vs wrap) à gérer côté appelant.
    const wrap = document.createElement("span"); wrap.style.cssText = "display:inline-flex;gap:4px;align-items:center;";
    wrap.appendChild(sel);
    const extra = (Array.isArray(p.network_ids) ? p.network_ids : []).filter((n: string) => n !== (p.network_id || null)).length;
    if (extra > 0) {
      const badge = document.createElement("span"); badge.className = "pill"; badge.textContent = "+" + extra; badge.title = extra + " réseau(x) additionnel(s) (édition multi : à venir)";
      wrap.appendChild(badge);
    }
    return wrap;
  }

  /** POWER : sens de l'énergie (source/sink) + calibre (A) + phase (départ = source). Pilote l'analyse énergie. */
  powerPortControls(p: PortDraft): HTMLElement {
    const wrap = document.createElement("span"); wrap.style.cssText = "display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;";
    const dirSel = FormControls.select([{ value: "", label: "— sens —" }].concat(PORT_DIRECTIONS.map((d) => ({ value: d.id, label: d.label }))), p.direction || ""); dirSel.className = "sub-input app-select";
    dirSel.onchange = () => { p.direction = dirSel.value || ""; if (p.direction !== "source") p.phase = ""; this.host.rerenderPorts(); };
    wrap.appendChild(dirSel);
    const ampI = FormControls.number(p.power_max_a != null ? p.power_max_a : "", { min: 0, step: 1, placeholder: "A" }); ampI.style.width = "60px"; ampI.className = "sub-input"; ampI.title = "Calibre / plafond de courant (A).";
    ampI.oninput = () => { const v = parseFloat(ampI.value); p.power_max_a = isFinite(v) && v >= 0 ? v : null; };
    wrap.appendChild(ampI);
    if (p.direction === "source") {   // phase seulement pour un départ / une sortie (source)
      const phSel = FormControls.select([{ value: "", label: "— phase —" }].concat(POWER_PHASES.map((ph: string) => ({ value: ph, label: ph }))), p.phase || ""); phSel.className = "sub-input app-select"; phSel.title = "Phase (départ triphasé réparti).";
      phSel.onchange = () => { p.phase = phSel.value || ""; };
      wrap.appendChild(phSel);
    }
    return wrap;
  }

  /** Résumé d'occupation des faisceaux terminés par ce patch (brins utilisés / capacité) → dans `el`. Reflète le
      STORE (brins enregistrés) ; les saisies en cours sont validées à l'enregistrement. */
  renderPatchInfo(el: HTMLElement): void {
    const bundles = this.isPatch() ? this.patchBundles() : [];
    if (!bundles.length) { el.textContent = this.isPatch() ? "Aucun faisceau ne se termine sur ce patch (rattachez-les depuis l'onglet Faisceaux)." : ""; return; }
    el.textContent = "Faisceaux : " + bundles.map((b: any) => { const o = this.store.bundleOccupancy(b.id); return (b.name || "(faisceau)") + " " + o.used + "/" + o.capacity + " brins"; }).join(" · ");
  }

  /** Charge par départ/phase + avertissements de fiabilité (SPOF, PSU non câblée…) → dans `el`. Reflète le STORE. */
  renderPowerInfo(el: HTMLElement): void {
    el.innerHTML = "";
    const eq = this.host.equipment; if (!eq) return;
    const pa = new PowerAnalysis(this.store);
    const line = (txt: string, warn?: boolean) => { const d = document.createElement("div"); d.className = "form-hint"; if (warn) d.style.color = "var(--danger, #c0392b)"; d.textContent = txt; el.appendChild(d); };
    const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
    const deps = pa.departLoads(eq.id);
    if (deps.length) {
      line("Départs : " + deps.map((d) => { const p: any = this.store.get("ports", d.key); return (p && p.name ? p.name : "?") + " " + fmt(d.usedA) + "/" + (d.capacityA != null ? d.capacityA : "?") + " A" + (d.overloaded ? " ⛔" : d.warn ? " ⚠" : ""); }).join(" · "));
      const phs = pa.phaseLoads(eq.id).filter((x) => x.key !== "?");
      if (phs.length) line("Phases : " + phs.map((x) => x.key + " " + fmt(x.usedA) + "/" + (x.capacityA != null ? x.capacityA : "?") + " A" + (x.overloaded ? " ⛔" : x.warn ? " ⚠" : "")).join(" · "));
    }
    // origin_unknown = info (redondance non vérifiable), pas un danger avéré → icône + sévérité moindres (cf. PowerAnalysis.isInfo).
    for (const w of pa.equipmentWarnings(eq.id)) { const info = PowerAnalysis.isInfo(w.code); line((info ? "ℹ " : "⚠ ") + w.message, !info); }
  }
}

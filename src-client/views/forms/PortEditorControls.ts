import type { Store } from "../../store";
import { PowerAnalysis } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Normalize } from "../../core/Normalize";
import { PortRoles } from "../../registries/PortRoles";
import { PORT_DIRECTIONS, POWER_PHASES } from "../../domain/constants";
import { I18n } from "../../i18n/I18n";   // lot B2a : options des tables de libellés (labelKey → I18n.t)

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
  poe_budget_w?: number | null;
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
    const bOpts = [{ value: "", label: I18n.t("forms.port.bundleNone") }].concat(bundles.map((b: any) => ({ value: b.id, label: I18n.t("forms.port.bundleOpt", { name: b.name || I18n.t("lists.ph.bundle"), free: store.bundleOccupancy(b.id).free }) })));
    const bSel = FormControls.select(bOpts, p.bundle_id || ""); bSel.className = "sub-input app-select"; wrap.appendChild(bSel);
    bSel.onchange = () => { p.bundle_id = bSel.value || null; if (!p.bundle_id) { p.strand_a = null; p.strand_b = null; } this.host.rerenderPorts(); };
    if (p.bundle_id) {
      const bundle: any = store.get("cableBundles", p.bundle_id);
      const maxStrand = bundle ? bundle.fiber_count : undefined;
      const duplex = !!(p.port_type_id && (store.get("portTypes", p.port_type_id) || {} as any).duplex);
      const saI = FormControls.number(p.strand_a != null ? p.strand_a : "", { min: 1, max: maxStrand, step: 1, placeholder: duplex ? I18n.t("forms.port.strandTx") : I18n.t("forms.port.strandSimplex") });
      saI.style.width = "62px"; saI.className = "sub-input";
      saI.oninput = () => { const v = parseInt(saI.value, 10); p.strand_a = isFinite(v) && v >= 1 ? v : null; };
      wrap.appendChild(saI);
      if (duplex) {
        const sbI = FormControls.number(p.strand_b != null ? p.strand_b : "", { min: 1, max: maxStrand, step: 1, placeholder: I18n.t("forms.port.strandRx") });
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
    const opts = [{ value: "", label: I18n.t("forms.port.netJoker") }].concat(nets.map((n: any) => ({ value: n.id, label: (n.kind === "power" ? "⚡ " : "") + (n.label || I18n.t("lists.ph.network")) })));
    const sel = FormControls.select(opts, p.network_id || ""); sel.className = "sub-input app-select"; sel.title = I18n.t("forms.port.netTitle");
    sel.onchange = () => {
      // P5/P8c : la FUSION réseau (anti-clobber #14) est PURE → Normalize.mergePrincipal (testée en isolation, hors DOM).
      // Elle gère : joker vide (network_ids=[] car « joker + réseaux » irreprésentable), port mono (REMPLACE le
      // principal sans laisser l'ancien inamovible), multi préexistant (préserve les additionnels, principal en tête).
      const r = Normalize.mergePrincipal(Array.isArray(p.network_ids) ? p.network_ids : [], p.network_id || null, sel.value || null);
      p.network_id = r.network_id; p.network_ids = r.network_ids;
      // joker (removed > 0) : des réseaux additionnels ont été retirés → on SIGNALE la perte (pas d'effacement muet).
      if (r.removed) Notify.toast(I18n.t("forms.port.netRemoved", { count: r.removed }));
      this.host.rerenderPorts();   // P5(c) : rafraîchit la pastille « +N » (onchange ne re-rendait pas) et l'aperçu réseau.
    };
    // Retour UNIFIÉ : toujours un span-conteneur (le select, + une pastille « +N » si des réseaux additionnels
    // existent) — plus de double forme de retour (bare select vs wrap) à gérer côté appelant.
    const wrap = document.createElement("span"); wrap.style.cssText = "display:inline-flex;gap:4px;align-items:center;";
    wrap.appendChild(sel);
    const extra = (Array.isArray(p.network_ids) ? p.network_ids : []).filter((n: string) => n !== (p.network_id || null)).length;
    if (extra > 0) {
      const badge = document.createElement("span"); badge.className = "pill"; badge.textContent = "+" + extra; badge.title = I18n.t("forms.port.netExtraTitle", { count: extra });
      wrap.appendChild(badge);
    }
    return wrap;
  }

  /** SENS de l'énergie (source/sink) d'un port POWER ou POE — contrôle segmenté (`.rm-toggle`). Libellés adaptés à
      la catégorie : Source/Sink (power) vs PSE/PD (poe, cosmétique — le champ stocke bien source/sink). Un
      changement re-rend la liste (phase power conditionnée à « source » ; tête + jauge POE recalculées à partir des
      seuls producteurs). Contrôle NU (le formulaire l'enveloppe dans une rangée libellée). */
  sensControl(p: PortDraft, mode: "power" | "poe"): HTMLElement {
    const opts = mode === "poe"
      ? [{ value: "source", label: I18n.t("forms.port.pse") }, { value: "sink", label: I18n.t("forms.port.pd") }]
      : PORT_DIRECTIONS.map((d) => ({ value: d.id, label: I18n.t(d.labelKey) }));
    return FormControls.segmented(opts, p.direction || "", (v) => { p.direction = v || ""; if (p.direction !== "source") p.phase = ""; this.host.rerenderPorts(); }, { ariaLabel: I18n.t("forms.port.sens") });
  }

  /** Calibre (A) d'un port POWER. Contrôle nu (unité A). */
  caliberControl(p: PortDraft): HTMLElement {
    const w = FormControls.unitNumber(p.power_max_a != null ? p.power_max_a : "", "A", { min: 0, step: 1 });
    (w as any)._input.title = I18n.t("forms.port.ampTitle");
    (w as any)._input.oninput = () => { const v = parseFloat((w as any).value); p.power_max_a = isFinite(v) && v >= 0 ? v : null; };
    return w;
  }

  /** Phase (L1/L2/L3) d'un DÉPART power (source). Contrôle nu. */
  phaseControl(p: PortDraft): HTMLElement {
    const sel = FormControls.select([{ value: "", label: I18n.t("forms.port.phaseNone") }].concat(POWER_PHASES.map((ph: string) => ({ value: ph, label: ph }))), p.phase || ""); sel.className = "app-select"; sel.title = I18n.t("forms.port.phaseTitle");
    sel.onchange = () => { p.phase = sel.value || ""; };
    return sel;
  }

  /** Résumé d'occupation des faisceaux terminés par ce patch (brins utilisés / capacité) → dans `el`. Reflète le
      STORE (brins enregistrés) ; les saisies en cours sont validées à l'enregistrement. */
  renderPatchInfo(el: HTMLElement): void {
    const bundles = this.isPatch() ? this.patchBundles() : [];
    if (!bundles.length) { el.textContent = this.isPatch() ? I18n.t("forms.port.noPatchBundle") : ""; return; }
    el.textContent = I18n.t("forms.port.bundlesPrefix") + bundles.map((b: any) => { const o = this.store.bundleOccupancy(b.id); return I18n.t("forms.port.bundleUsage", { name: b.name || I18n.t("lists.ph.bundle"), used: o.used, capacity: o.capacity }); }).join(" · ");
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
      line(I18n.t("forms.port.departs", { list: deps.map((d) => { const p: any = this.store.get("ports", d.key); return (p && p.name ? p.name : "?") + " " + fmt(d.usedA) + "/" + (d.capacityA != null ? d.capacityA : "?") + " A" + (d.overloaded ? " ⛔" : d.warn ? " ⚠" : ""); }).join(" · ") }));
      const phs = pa.phaseLoads(eq.id).filter((x) => x.key !== "?");
      if (phs.length) line(I18n.t("forms.port.phases", { list: phs.map((x) => x.key + " " + fmt(x.usedA) + "/" + (x.capacityA != null ? x.capacityA : "?") + " A" + (x.overloaded ? " ⛔" : x.warn ? " ⚠" : "")).join(" · ") }));
    }
    // origin_unknown = info (redondance non vérifiable), pas un danger avéré → icône + sévérité moindres (cf. PowerAnalysis.isInfo).
    for (const w of pa.equipmentWarnings(eq.id)) { const info = PowerAnalysis.isInfo(w.code); line((info ? "ℹ " : "⚠ ") + w.message, !info); }
  }
}

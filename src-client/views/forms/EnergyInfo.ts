import type { Store } from "../../store";
import { PowerAnalysis } from "../../store";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { Html } from "../../core/Html";
import { I18n } from "../../i18n/I18n";
import { POWER_LOAD_WARN_FRACTION } from "../../domain/constants";

/** Bilan ÉNERGIE d'un équipement — LECTURE SEULE, calculé sur l'état ENREGISTRÉ (PowerAnalysis) :
    - JAUGE de budget PoE (charge des PD câblés / budget total déclaré) d'une SOURCE (switch) marquée PoE ;
    - CHARGES par départ/phase (power) + AVERTISSEMENTS de fiabilité (« non alimenté », SPOF, redondance…).
    Destiné à la modale d'INFO de l'équipement (consultation), PAS au formulaire d'édition (saisie) — d'où le
    déplacement depuis EquipmentForms/PortEditorControls. Réutilisable (fiche, futur tableau de bord). */
export class EnergyInfo {
  private static fmt(n: number): string { return String(Math.round(n * 10) / 10); }

  /** Rend la JAUGE de budget PoE dans `el` (structure `.gauge-card`). Uniquement si l'équipement est une SOURCE
      (switch) marquée PoE ET qu'il y a quelque chose à montrer (budget renseigné OU charge PoE réelle). Renvoie
      true si une jauge a été rendue. */
  static renderPoeGauge(store: Store, eq: any, el: HTMLElement): boolean {
    if (!eq || !eq.poe_device || !EquipmentTypes.isPoeSource(eq.type)) return false;
    const { loadW, budgetW, over } = new PowerAnalysis(store).poeSupply(eq.id);
    if (budgetW == null && loadW <= 0) return false;   // ni budget ni charge → rien à afficher
    const warn = !over && budgetW != null && budgetW > 0 && loadW >= budgetW * POWER_LOAD_WARN_FRACTION;
    const pct = (budgetW != null && budgetW > 0) ? Math.min(100, (loadW / budgetW) * 100) : (loadW > 0 ? 100 : 0);
    const rest = budgetW != null ? budgetW - loadW : null;
    el.className = "gauge-card"; el.innerHTML = "";
    const top = document.createElement("div"); top.className = "gauge-top";
    const allocS = document.createElement("span"); allocS.className = "alloc" + (over ? " over" : "");
    allocS.innerHTML = Html.escape(EnergyInfo.fmt(loadW)) + ' <span class="alloc-total">/ ' + Html.escape(budgetW != null ? EnergyInfo.fmt(budgetW) : "—") + " W</span>";
    const restS = document.createElement("span"); restS.className = "rest" + (over ? " over" : "");
    restS.textContent = rest == null ? "" : (rest >= 0 ? I18n.t("equipment.equip.poeRest", { w: EnergyInfo.fmt(rest) }) : I18n.t("equipment.equip.poeOverBy", { w: EnergyInfo.fmt(-rest) }));
    top.appendChild(allocS); top.appendChild(restS);
    const bar = document.createElement("div"); bar.className = "gauge" + (over ? " over" : warn ? " warn" : "");
    const fill = document.createElement("div"); fill.className = "gauge-fill"; fill.style.width = pct + "%"; bar.appendChild(fill);
    const st = document.createElement("div"); st.className = "gauge-state " + (over ? "over" : warn ? "warn" : "ok");
    st.textContent = I18n.t(over ? "equipment.equip.poeStateOver" : warn ? "equipment.equip.poeStateWarn" : "equipment.equip.poeStateOk");
    el.appendChild(top); el.appendChild(bar); el.appendChild(st);
    return true;
  }

  /** Rend les CHARGES par départ/phase + AVERTISSEMENTS de fiabilité dans `el` (lignes `.form-hint`). Renvoie true
      si au moins une ligne a été rendue. Logique DÉPLACÉE de PortEditorControls.renderPowerInfo (édition → info). */
  static renderPowerLines(store: Store, eq: any, el: HTMLElement): boolean {
    if (!eq) return false;
    const pa = new PowerAnalysis(store);
    let any = false;
    const line = (txt: string, warn?: boolean) => { const d = document.createElement("div"); d.className = "form-hint"; if (warn) d.style.color = "var(--danger, #c0392b)"; d.textContent = txt; el.appendChild(d); any = true; };
    const deps = pa.departLoads(eq.id);
    if (deps.length) {
      line(I18n.t("forms.port.departs", { list: deps.map((d) => { const p: any = store.get("ports", d.key); return (p && p.name ? p.name : "?") + " " + EnergyInfo.fmt(d.usedA) + "/" + (d.capacityA != null ? d.capacityA : "?") + " A" + (d.overloaded ? " ⛔" : d.warn ? " ⚠" : ""); }).join(" · ") }));
      const phs = pa.phaseLoads(eq.id).filter((x) => x.key !== "?");
      if (phs.length) line(I18n.t("forms.port.phases", { list: phs.map((x) => x.key + " " + EnergyInfo.fmt(x.usedA) + "/" + (x.capacityA != null ? x.capacityA : "?") + " A" + (x.overloaded ? " ⛔" : x.warn ? " ⚠" : "")).join(" · ") }));
    }
    // origin_unknown = info (redondance non vérifiable), pas un danger avéré → icône + sévérité moindres (cf. PowerAnalysis.isInfo).
    for (const w of pa.equipmentWarnings(eq.id)) { const info = PowerAnalysis.isInfo(w.code); line((info ? "ℹ " : "⚠ ") + w.message, !info); }
    return any;
  }
}

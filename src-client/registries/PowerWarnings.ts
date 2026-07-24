import { I18n } from "../i18n/I18n";
import type { PowerWarning, PowerWarningCode } from "../../src-shared/PowerAnalysis";

/** Table code → clé i18n `analysis.power.*`. EXHAUSTIVE et STATIQUE (pas de fabrication dynamique de clé, fragile
    au renommage) : le moteur d'analyse (`src-shared/PowerAnalysis`) est TS pur SANS I18n — il n'émet qu'un code + des
    params ; ajouter un code au moteur impose d'ajouter sa clé ici (le compilateur l'exige, `Record` exhaustif). */
const MESSAGE_KEY: Record<PowerWarningCode, string> = {
  psu_uncabled: "analysis.power.psuUncabled",
  no_source: "analysis.power.noSource",
  spof: "analysis.power.spof",
  origin_unknown: "analysis.power.originUnknown",
  psu_undersized: "analysis.power.psuUndersized",
  poe_over_budget: "analysis.power.poeOverBudget",
  poe_port_over: "analysis.power.poePortOver",
  poe_pd_unfed: "analysis.power.poePdUnfed",
  pdu_over_capacity: "analysis.power.pduOverCapacity",
  network_over_amp: "analysis.power.networkOverAmp",
};

/** Résolution des LIBELLÉS des avertissements énergie (`PowerWarning`) — pont entre le moteur PARTAGÉ (qui n'émet que
    des codes + params, sans i18n) et la localisation CLIENTE. Ce découplage permet au moteur de vivre dans src-shared/
    (consommable côté serveur) sans traîner i18next. Registre à méthodes statiques (modèle : `PortRoles`). */
export class PowerWarnings {
  /** Libellé traduit d'un avertissement : `I18n.t(analysis.power.<clé>, params)`. Code inconnu → repli LISIBLE (le
      code brut) plutôt qu'une clé i18n manquante affichée telle quelle (robustesse si le moteur devance le mapping). */
  static message(w: PowerWarning): string {
    const key = MESSAGE_KEY[w.code];
    return key ? I18n.t(key, w.params) : w.code;
  }
}

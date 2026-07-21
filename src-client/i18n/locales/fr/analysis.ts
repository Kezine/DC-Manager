/* ============================================================================
   Domaine `analysis` — FRANÇAIS. Messages d'ANALYSE produits par le store (modules
   `store/Store.ts`, `store/PowerAnalysis.ts`, `store/CableRouteAnalyzer.ts`) et
   RENDUS à l'écran (toasts, bilans, descriptions de câble). Regroupés ici plutôt
   qu'éparpillés dans `cable`/`domain` : ce sont des sorties d'analyse métier, pas
   des libellés de formulaire. Résolus par `I18n.t` À L'ÉMISSION (au runtime, après
   `I18n.init()`), jamais au chargement. Agrégé par `../fr.ts`. Voir docs/i18n.md. */
export const analysis = {
  cable: {
    typeMissing: "Type de câble manquant",
    portTypeMissing: "Un port n'a pas de type défini",
    incompatible: "Incompatible : câble « {{family}} » vs ports « {{pf}} » / « {{pt}} »",
    breakReason: "Suite au déplacement de l'équipement « {{equip}} », la liaison vers « {{remote}} » sur le port « {{port}} » n'est plus valide.",
  },
  power: {
    psuUncabled: "{{n}} alimentation(s) non câblée(s) — redondance amoindrie.",
    noSource: "Aucune alimentation valide (câblée vers une source) — équipement non alimenté.",
    spof: "Alimentations non redondantes — même source d'origine (point unique de défaillance).",
    originUnknown: "Origine des alimentations indéterminable (sens ou tableau amont non renseignés) — redondance non vérifiable.",
    psuUndersized: "Alimentation « {{name}} » ({{amps}} A) insuffisante pour la charge max seule ({{req}} A requis).",
    poeOverBudget: "Survente POE : {{alloc}} W alloués aux ports producteurs dépassent le budget de {{budget}} W.",
  },
} as const;

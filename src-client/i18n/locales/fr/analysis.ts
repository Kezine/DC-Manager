/* ============================================================================
   Domaine `analysis` — FRANÇAIS. Messages d'ANALYSE produits par le store (modules
   `store/Store.ts`, `store/CableRouteAnalyzer.ts`) et RENDUS à l'écran (toasts, bilans,
   descriptions de câble). Les clés `power.*` résolvent les CODES du moteur partagé
   `src-shared/PowerAnalysis.ts` (codes+params sans i18n), via `registries/PowerWarnings`.
   Regroupés ici plutôt
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
    poeOverBudget: "Survente POE : la charge des PD ({{load}} W) dépasse le budget total de {{budget}} W.",
    poePortOver: "Port « {{port}} » : le PD connecté consomme {{load}} W, au-delà du budget du port ({{budget}} W).",
    poePdUnfed: "Port PoE « {{port}} » non alimenté (aucun injecteur PSE actif câblé).",
    pduOverCapacity: "Capacité de l'équipement dépassée : {{load}} A en aval pour {{cap}} A déclarés.",
    networkOverAmp: "Réseau « {{name}} » : {{load}} A tirés pour une capacité de {{cap}} A.",
  },
} as const;

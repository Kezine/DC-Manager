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
  /* GRAMMAIRE DE ROUTE (`store/CableRouteAnalyzer`) — messages des CODES d'erreur, et motifs de blocage de
     placement. Les CODES sont stables, ces libellés ne le sont pas : ils se reformulent librement.
     ⚠ PLUSIEURS PAIRES DE CLÉS (…Rooms/…Places, portA/BRoom/…Floor, roomWpInTransit/roomWpOnFloor) : c'est
     la décision D4 du chantier « câblage des équipements d'étage » — le message nomme ce que l'utilisateur
     VOIT, « salle » quand c'en est une, « étage » quand c'en est un. Tant que la route ne traverse que des
     salles, c'est le libellé HISTORIQUE, au caractère près (même bascule qu'au décompte du mini-graphe). */
  route: {
    floorPinInRoom: "« {{name}} » (pin d'étage) ne peut pas être posé à l'intérieur d'une salle — sortez d'abord par un exit",
    unplaced: "« {{name}} » n'est pas posé dans une salle",
    roomWpInTransit: "« {{name}} » (waypoint de salle) au milieu d'un tronçon hors salle",
    roomWpOnFloor: "« {{name}} » (waypoint de salle) alors que la route est sur un étage",
    wrongRoom: "« {{name}} » est dans une autre salle que le segment courant",
    exitWrongRoom: "exit « {{name}} » : la sortie doit être un exit de la salle courante",
    exitReentry: "exit « {{name}} » : ré-entrée dans la salle quittée — appariez avec un exit d'une AUTRE salle",
    exitUnpaired: "exit non appairé — ajoutez l'exit d'une autre salle, ou un pin d'étage, pour fermer le tronçon",
    portARoom: "le port A n'est pas dans la salle où la route commence",
    portAFloor: "le port A n'est pas sur l'étage où la route commence",
    portBRoom: "le port B n'est pas dans la salle où la route finit",
    portBFloor: "le port B n'est pas sur l'étage où la route finit",
    portsSplitRooms: "ports dans deux salles différentes — la route doit sortir par un exit de chaque salle",
    portsSplitPlaces: "ports dans deux emplacements différents — la route doit sortir par un exit",
    blockedManyRooms: "câblé vers plusieurs salles à la fois ({{names}}) — re-routez ou détachez un câble",
    blockedManyPlaces: "câblé vers plusieurs emplacements à la fois ({{names}}) — re-routez ou détachez un câble",
    blockedOne: "câblé vers « {{name}} » — re-routez le câble (exits) ou détachez-le",
    blockedRackEquip: "« {{name}} » : {{why}}",
    equipFallback: "(équipement)",
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

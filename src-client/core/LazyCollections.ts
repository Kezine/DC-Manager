/* =============================================================================
   LazyCollections — LA liste des collections chargées PARESSEUSEMENT en mode API
   (chantier « lazy-load des collections », cf. docs/hydratation.md).

   POURQUOI UN SEUL ENDROIT : une collection lazy touche plusieurs chemins — ce
   que le boot NE tire PAS (`RestAdapter.load`), ce que le Store DÉCLARE après
   chaque hydratation complète (`Store.init` → `HydrationState.declareLazy`), et
   ce dont les gardes G1-G10 dérivent leur comportement. La liste doit donc être
   posée UNE fois : chaque vague du chantier ajoute SA collection ici, et le reste
   suit (`vms` est EXCLU du chantier, cf. le cadrage).
   ⚠ « et rien d'autre ne change » vaut pour les gardes GÉNÉRIQUES (G1-G4, G6, G9) ;
   une collection a ses POINTS DURS propres — sections de fiches (G7), aperçu de
   cascade (G5), facettes de listing (G8), consommateurs synchrones divers (G10) —,
   qui se traitent avec les patrons établis, une fois, à l'ajout du nom
   (cf. docs/hydratation.md § Vague 2 et § Vague 3).

   ⚠ Cette liste est une INTENTION, pas un état : la vérité d'exécution vit dans
   `core/HydrationState` (`store.hydration.isHydrated(c)`), qui sait qu'une
   collection lazy a pu redevenir `full` en cours de session (export G2,
   hydratation à la demande d'un formulaire). Aucun consommateur ne doit tester
   l'appartenance à cette liste pour décider d'un comportement : il teste l'ÉTAT.
   Elle n'a qu'un seul lecteur légitime — l'hôte (`app/main.ts`), qui l'injecte
   dans le Store au démarrage.

   MODE FICHIER / VISUALISEUR : la liste n'y est jamais appliquée (« le document
   EST le fichier », principe n°15). La garantie n'est pas un `if (mode)` ici
   mais une CONSTRUCTION du Store : sans état d'hydratation traçant injecté,
   aucune collection ne peut être déclarée lazy (cf. `Store` constructeur).
   ============================================================================= */

/** Collections chargées PARESSEUSEMENT en mode API (vague 1 : `contacts` ; vague 2 :
    `attachments` + `applications` ; vague 3 : `wifiClients`, la plus VOLUMINEUSE —
    alimentée par la synchro d'un contrôleur wifi, c'est elle qui porte le gain réel ;
    vague 4 : `spares` — rendue possible par M4b, qui rafraîchit au cache les spares
    DÉTACHÉS par la cascade serveur, et par la résolution GROUPÉE des libellés de
    cibles d'intervention, cf. docs/hydratation.md § « Vague 4 »).
    DONNÉE pure (cf. CLAUDE.md principe n°2 : les tables restent de simples exports).
    Les noms doivent appartenir à `EntityRegistry.COLLECTIONS` — un nom fautif serait
    silencieusement sans effet, d'où l'invariant testé (Tests/modules/test-lazy-contacts.js
    pour la vague 1, test-lazy-vague2.js pour la 2, test-lazy-vague3.js pour la 3,
    test-lazy-vague4.js pour la 4 — qui verrouille le contenu EXACT de la liste).
    ⚠ `wifiClients` appartient à une feature AMOVIBLE : retirer l'inventaire wifi impose de
    retirer son nom d'ICI (cf. docs/wifi-unifi.md § « Suppression de la feature »). */
export const LAZY_COLLECTIONS_API: readonly string[] = ["contacts", "attachments", "applications", "wifiClients", "spares"];

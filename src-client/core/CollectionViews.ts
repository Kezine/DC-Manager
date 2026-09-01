/* =============================================================================
   COLLECTIONVIEWS — « quel ONGLET montre les objets de cette collection ? »

   POURQUOI CE MODULE (chantier « liens directs », cadrage 2026-09-01, décision A1).
   Un lien direct porteur de `?vue=1` doit ACTIVER la vue de l'objet avant d'ouvrir
   sa fiche. Il faut donc traduire une collection en nom d'onglet — une question à
   laquelle personne ne répondait jusqu'ici : `EntityLinkOpener` ouvrait la fiche
   PAR-DESSUS la vue courante, quelle qu'elle fût.

   La correspondance est 1:1 et complète (21 collections à fiche ⇄ 21 onglets de
   liste), mais elle n'est PAS DEVINABLE : deux onglets ne portent pas le nom de
   leur collection — `datacenters` s'affiche dans l'onglet **salles** et
   `ipAddresses` dans l'onglet **ipam**. Une convention « nom en minuscules sans
   séparateur » aurait donc marché 19 fois sur 21, ce qui est la pire des
   situations : le bug ne se voit que sur deux liens, et seulement chez qui les
   utilise. D'où une carte EXPLICITE, et un VERROU de test qui échoue EN NOMMANT
   la collection à fiche qui n'aurait pas d'onglet déclaré (même patron que le
   verrou d'exhaustivité du menu, `app/NavModel` + `Tests/modules/test-nav-model.js`).

   Module PUR : ni DOM, ni Shell, ni Store — une carte et deux lectures.
   ============================================================================= */

/** Familles vivant dans une base SERVEUR séparée (cf. `src-shared/AppLink`) : ce ne sont pas des
    collections du document, mais elles ont bien un onglet — et pour elles, l'activation n'est pas
    optionnelle : leur fiche est peinte PAR leur vue, il n'y a pas d'autre chemin. */
export type ExternalFamily = "intervention" | "cert";

export class CollectionViews {
  /** Collection du document → nom de la VUE qui la liste. Les 21 collections à fiche
      (`DetailForms.DETAIL_COLLECTIONS`) y sont, et rien d'autre : les 4 collections sans fiche
      (`ports`, `aggregates`, `rackItems`, `waypoints`) sont des SOUS-OBJETS, sans onglet ni fiche —
      les inscrire ici promettrait une navigation qui n'existe pas. */
  static readonly VIEW_OF_COLLECTION: Readonly<Record<string, string>> = {
    equipments: "equipements",
    subEquipments: "sousequipements",
    racks: "racks",
    cables: "cables",
    cableBundles: "faisceaux",
    networks: "reseaux",
    ipNetworks: "ipnetworks",
    ipAddresses: "ipam",             // ⚠ l'onglet ne porte PAS le nom de sa collection
    dhcpRanges: "dhcpranges",
    datacenters: "salles",           // ⚠ idem — « salles » liste les datacenters
    sites: "sites",
    groups: "groupes",
    floors: "etages",
    spares: "spares",
    contacts: "contacts",
    vms: "vms",
    wifiClients: "wifi",
    cableTypes: "cabletypes",
    portTypes: "porttypes",
    applications: "applications",
    attachments: "attachments",
  };

  /** Famille hors document → sa vue. Deux entrées, mais la même règle : le nom ne se devine pas
      (`cert` ⇄ onglet « certificats »). */
  static readonly VIEW_OF_EXTERNAL: Readonly<Record<ExternalFamily, string>> = {
    intervention: "interventions",
    cert: "certificats",
  };

  /** Onglet d'une collection, ou `null` si elle n'en a pas (sous-objet, ou collection inconnue).
      `null` n'est pas une anomalie côté appelant : c'est « il n'y a pas de vue à activer », et le
      lien s'ouvre alors par-dessus la vue courante, comme avant le chantier. */
  static viewOf(collection: string): string | null {
    return CollectionViews.VIEW_OF_COLLECTION[collection] || null;
  }

  /** Onglet d'une famille hors document. */
  static viewOfExternal(family: ExternalFamily): string | null {
    return CollectionViews.VIEW_OF_EXTERNAL[family] || null;
  }

  /** Collections déclarées — pour le VERROU de test, jamais réécrites à la main. */
  static declaredCollections(): readonly string[] {
    return Object.keys(CollectionViews.VIEW_OF_COLLECTION);
  }

  /** Noms d'onglets déclarés, familles externes comprises — pour le VERROU de test (« cet onglet
      existe-t-il vraiment dans `main.ts` ? »). */
  static declaredViews(): readonly string[] {
    return [...Object.values(CollectionViews.VIEW_OF_COLLECTION), ...Object.values(CollectionViews.VIEW_OF_EXTERNAL)];
  }
}

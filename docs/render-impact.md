# Carte d'impact de rendu (collection → reconstruction)

> Référence pour le **rechargement granulaire** en mode API (REST). Quand un autre
> client modifie le document, le serveur diffuse un *changeset* (cf. §4) ; le client
> décide, à partir de cette carte, **ce qu'il doit réellement reconstruire** au lieu
> de tout recharger. Source de vérité du code : [`src/sync/RenderImpact.ts`](../src/sync/RenderImpact.ts).

## 1. Pourquoi cette carte existe

Historiquement, à chaque notification de changement (SSE) ou conflit (409), le client
faisait un **rechargement total** : re-tirage des 20 collections + reconstruction
COMPLÈTE de la scène 3D (géométrie + re-décodage de toutes les textures de façade).
Pour un document volumineux, c'est un gel d'UI de ~1 s — déclenché même quand le seul
changement était, p. ex., une adresse IP ou un spare (qui ne sont **jamais dessinés**
en 3D).

La carte associe à **chaque collection** son *impact de rendu* sur la scène 3D du
Datacenter — le seul rendu vraiment coûteux. Elle permet de **sauter la reconstruction
3D** quand aucune collection « dessinée » n'a changé.

## 2. Principe de classification (et le piège à éviter)

L'impact est jugé sur **ce qui est DESSINÉ** dans la scène 3D persistante (meshes,
couleurs, labels, textures) — **pas** sur ce qui est lu à la volée :

- Les **tooltips**, **menus contextuels** et le **panneau latéral** sont re-dérivés à
  la demande (au survol / clic / re-render de vue) à partir du `Store` frais. Ils ne
  comptent **pas** comme impact 3D : une collection lue uniquement par eux est `none`.
- Une collection est lue **indirectement** via des helpers du `Store`
  (`portConnectorSize` → `portTypes`, `cableColor` → `networks`…). Ces dépendances
  indirectes **comptent** : elles ont été tracées (cf. §3), pas seulement les
  `store.get("collection")` littéraux.

> ⚠️ **Risque dominant : la sous-invalidation.** Classer `geometry` en `none` par erreur
> réintroduit le bug du *mesh périmé* (un élément supprimé reste dessiné). La règle est
> donc **conservatrice** : dans le doute, `geometry`. Un faux `geometry` ne coûte qu'une
> reconstruction inutile (lent mais correct) ; un faux `none` affiche des données
> fausses (rapide mais faux). On préfère toujours le premier.

Trois niveaux (`ThreeImpact`) :

| Niveau | Signification | Action de reconstruction |
|---|---|---|
| `none` | aucun mesh/couleur/texture 3D ne dépend de cette collection | **aucune** reconstruction 3D (re-render de liste éventuel, jamais de rebuild) |
| `recolor` | seules des **couleurs** dessinées changent | recoloration en place possible (P4) ; **P1 fait un rebuild complet** par sécurité |
| `geometry` | des **meshes / labels / textures** changent | **reconstruction complète** de la scène |

## 3. La carte, collection par collection

### Dessiné en 3D — `geometry`

| Collection | Justification (ce qui est dessiné) |
|---|---|
| `datacenters` | sol, murs, grille, décor de salle ; orientation/dimensions |
| `racks` | baies (coque, capots, montants), position/orientation |
| `rackItems` | occupants pseudo-éléments (caches / blanking plates, brosses…) |
| `equipments` | occupants rackés (U), équipements libres, ports posés, labels |
| `ports` | connecteurs de port (position, couleur câblé/libre) |
| `cables` | tubes de câble (tracé spline, extrémités, éclairs power) |
| `waypoints` | pins, brosses, OOB, segments de routage |
| `floors` | décor d'étage multi-salles (plans, ancrages) |
| `sites` | **labels** de bâtiment dans le décor multi-salles (`siteLabel`) |
| `portTypes` | **taille des connecteurs** de port dessinés (`portConnectorSize` → `portTypes`) |
| `cableTypes` | **éclairs power** (`kind === "power"`) le long des câbles |

### Couleur dessinée seulement — `recolor`

| Collection | Justification |
|---|---|
| `networks` | **couleur des câbles** 3D (`cableColor` → réseau principal du câble) |
| `groups` | **couleur des occupants** rackés (`group.color`) |

> En P1, `recolor` est traité comme `geometry` (rebuild complet) côté câblage : correct,
> juste sous-optimal. Une recoloration **en place** (sans reconstruction géométrique) est
> prévue en P4 — le moteur a déjà `applyColorMode` (occupants) et la reconstruction
> ciblée des câbles (`rebuildCables`).

### Hors 3D — `none`

| Collection | Justification (jamais dessinée en 3D) |
|---|---|
| `ipNetworks` | gestion d'adressage — vues liste uniquement |
| `ipAddresses` | gestion d'adressage — vues liste uniquement |
| `dhcpRanges` | gestion d'adressage — vues liste uniquement |
| `spares` | inventaire de pièces de rechange — vue liste uniquement |
| `aggregates` | agrégats de ports (LAG) — détail d'équipement / graphe, pas la 3D |
| `cableBundles` | groupage de câbles — lu seulement par le **tooltip** (`cableBundleOf`), re-dérivé à la demande |

> **Cas à cheval (limite connue, affinable en P5).** `equipments`, `cables` et
> `networks` couvrent à la fois des entités **dessinées** et des entités **hors-3D**
> (p. ex. un équipement d'**inventaire non placé** n'a aucun rendu 3D). Au grain
> *collection*, on ne peut pas distinguer → on les classe au pire (`geometry`/`recolor`).
> Le grain *champ/état* (placement vs inventaire) qui les rendrait `none` quand c'est
> légitime est l'objet de **P5** (cf. [rest-migration.md](rest-migration.md)).

## 4. Le *changeset* diffusé par le serveur

À chaque écriture, le serveur connaît déjà les collections touchées (corps du
`/transact`, paramètres du CRUD). Il les joint à l'événement SSE **et** au flux de
notification, sous la forme :

```jsonc
{
  "rev": 42,                 // révision du document après l'écriture
  "origin": "<client-id>",   // auteur (le client source s'ignore lui-même)
  "by": { "name": "...", "ip": "..." },
  "changeset": {
    "full": false,           // true = import/snapshot/inconnu → tout recharger
    "collections": ["racks", "equipments"],  // collections touchées
    "meta": false,           // méta-document (nom…) modifiée
    "images": false          // au moins une image de façade modifiée
  }
}
```

`full: true` est le **repli sûr** : import `/snapshot`, route non reconnue, ou client
qui ignore le champ → comportement historique (rechargement total). La rétro-compatibilité
est ainsi garantie : un client plus ancien lit `rev` et recharge tout, comme avant.

## 5. Du changeset au plan de rechargement

Le client transforme le changeset en **plan** via [`ReloadPlanner`](../src/sync/ReloadPlanner.ts)
(module pur, testé) :

```
plan = {
  refetchCollections: string[] | null,  // null = tout le document (repli) ; liste ciblée = rechargement granulaire
  threeRebuild: "none" | "recolor" | "geometry",
  refreshMeta: boolean,
}
```

- `threeRebuild` = **pire** impact parmi les collections du changeset (`none < recolor <
  geometry`), relevé à `geometry` si des images ont changé. → décide d'appeler ou non
  `dcView.invalidate3D()`.
- `refetchCollections` = collections à re-tirer. Liste ciblée → `Store.reloadCollections`
  ne re-tire QUE celles-ci (rechargement granulaire) ; `null` → `init()` complet (repli :
  import/snapshot/conflit 409).
- `refreshMeta` = relire la méta-document.

## 6. État d'implémentation (par phases)

| Phase | Contenu | État |
|---|---|---|
| **P1** | Changeset serveur + saut de reconstruction 3D quand aucune collection 3D n'a changé | ✅ |
| **P2** | Re-tirage **partiel** des collections (`Store.reloadCollections` + `reloadMeta`) au lieu d'un `init()` global | ✅ |
| **P3** | Cache de **textures de façade par id** dans le moteur 3D (plus de re-décodage au rebuild) | ✅ |
| **P4** | Reconstruction 3D **incrémentale** (par salle/baie) + recoloration en place (`recolor`) | ⏳ |
| **P5** | Grain **champ/état** pour les collections à cheval (`equipments`/`cables`/`networks`) | ⏳ |

## 7. Invariant de test

Un test unitaire vérifie que **toute** collection de `EntityRegistry.COLLECTIONS` possède
une entrée dans la carte (pas d'oubli silencieux lors de l'ajout d'une collection). Voir
`Tests/modules/run.js` (section « sync / RenderImpact + ReloadPlanner »).

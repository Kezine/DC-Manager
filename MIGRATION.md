# NetMap — migration du HTML monolithique vers TypeScript (orienté objet)

But : sortir **doucement** de l'app mono-fichier
(`netmap-vNNN-*.html`, ~19 000 lignes dont un seul `<script>` de ~15 000) vers
une application **TypeScript orientée objet**, compilée par **webpack**, sans
jamais casser la base existante.

## Principes

1. **Orienté objet, pas de fonctions « nues ».** Les helpers libres du HTML
   (`uid`, `normRackOrientation`, `isCableStatus`, …) deviennent des **méthodes
   statiques** de classes cohérentes (`Id`, `Normalize`, `GroupTypes`, …). Les
   constantes pures (données) restent des `export const` dans `domain/constants.ts`.
2. **Une classe = un fichier.**
3. **Strangler pattern.** On extrait couche par couche, de la plus pure (modèle)
   vers la plus couplée au DOM (vues). À chaque étape, `npm run typecheck` +
   `npm run build` doivent rester verts.
4. **Filet de régression conservé.** `Tests/run.js` (213 tests) continue de
   tourner contre le dernier `.html` livré tant que la logique n'est pas portée ;
   il sera ensuite reciblé sur les modules compilés.
5. **Sortie mono-fichier préservée.** `npm run build` réinjecte le bundle dans le
   HTML (`html-inline-script-webpack-plugin`) → un seul `dist/netmap.html`
   autonome, ce qui garde fonctionnel l'export « viewer standalone » (qui lit
   `document.documentElement.outerHTML`).

## Outillage

| Commande            | Effet                                                        |
|---------------------|-------------------------------------------------------------|
| `npm install`       | installe webpack + TypeScript + loaders                     |
| `npm run typecheck` | `tsc --noEmit` (porte de type)                              |
| `npm run test:modules` | compile en CJS (`tsconfig.node.json`) + tests modules    |
| `npm run build`     | bundle de production → `dist/netmap.html` (un seul fichier) |
| `npm run dev`       | webpack-dev-server (HMR) — **requiert Node ≥ 20**           |
| `npm run watch`     | rebuild incrémental (Node 19 OK)                            |
| `npm run test:legacy` | harnais de régression sur le dernier HTML livré           |

> Node installé ici : v19.9.0. La compilation marche ; `webpack serve` (dev) veut
> Node ≥ 20 (`npm run watch` reste utilisable en attendant).

## Arborescence cible

```
src/
  core/        Id, Normalize, … (services transverses)
  domain/      constants.ts (données) + registres (GroupTypes, CableStatuses, …)
  models/      Entity + 18 entités + EntityRegistry           ← FAIT
  data/        FieldIndex, DataAdapter, BrowserStorageAdapter, RestAdapter   (à venir)
  store/       Store (CRUD async, index secondaires, undo/redo)              (à venir)
  geometry/    project3D, géométrie rack/side/wall, painter, …               (à venir)
  registries/  PortTypes / CableTypes / EquipmentTypes par défaut            (à venir)
  views/       ListController, GraphView, DatacenterView                     (à venir)
  app/         main.ts (bootstrap)
  index.html   coquille (markup + CSS à migrer en phase « Shell »)
```

## Feuille de route

- [x] **Phase 0 — Socle build.** package.json, tsconfig, webpack (sortie
      mono-fichier), `dist/netmap.html` qui compile.
- [x] **Phase 1 — Modèle de domaine.** `Entity` + 18 sous-classes + registre,
      avec leurs dépendances (constantes, `Id`, `Normalize`, registres). Type-check
      et build verts ; régression legacy intacte (213/213).
- [x] **Phase 2 — Couche données.** `FieldIndex` (+ helpers de match en statiques),
      `DataAdapter` (base abstraite), `BrowserStorageAdapter`, `RestAdapter` ; types
      partagés (`Snapshot`/`Transaction`/`ListResult`) ; config (`INDEX_SPEC`, tailles).
      Le global UI `noteUndoable` devient un callback injecté (`onUndoable`). Porté
      à l'identique ; tsc + build verts.
- [x] **Phase 3 — Store.** CRUD async, transactions, undo/redo, helpers métier
      (résolution inverse par index), cascade déclarative (`CASCADE_SPEC`),
      (dé)sérialisation + migration des dispositions. Catalogues par défaut tirés
      en avance (`registries/defaultCatalogs`, données seules). **Filet de
      régression au niveau MODULES** (`Tests/modules/run.js` via `npm run
      test:modules` : compile en CJS puis exerce modèle + données + store —
      32/32). tsc + build + legacy (213/213) verts.
- [ ] **Phase 4 — Géométrie & registres** (classes de méthodes statiques) ;
      promouvoir `defaultCatalogs` en registres OO (`PortTypes`/`CableTypes`).
- [ ] **Phase 5 — Vues** (`ListController`, `GraphView`, `DatacenterView`).
- [ ] **Phase 6 — Shell / UI.** Migration du `<head>`/`<style>`/`<body>` et du
      bootstrap ; câblage final ; retrait du mono-fichier.

## État actuel (Phases 1–2)

Modèle de domaine **et** couche d'accès aux données extraits **à l'identique**
(mêmes normalisations / défauts / rétro-compat / logique transactionnelle que le
HTML v172). `src/app/main.ts` est un point d'entrée provisoire qui instancie le
registre + un adapter pour prouver la chaîne — il sera remplacé par le vrai
bootstrap en phase 6.

Le filet de régression au niveau **modules** arrive en phase 3 (le Store est la
première couche dont le comportement justifie des tests directs ; la couche
données y sera couverte au passage). D'ici là, `Tests/run.js` continue de valider
le comportement contre le dernier HTML livré.

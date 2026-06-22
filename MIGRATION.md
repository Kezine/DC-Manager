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
- [ ] **Phase 2 — Couche données.** `FieldIndex`, `DataAdapter` (+ Browser/Rest).
- [ ] **Phase 3 — Store.** CRUD async, transactions, undo/redo, helpers métier.
      Recibler `Tests/run.js` sur les modules (remplacer l'extraction du `<script>`
      par un import du bundle de test).
- [ ] **Phase 4 — Géométrie & registres** (classes de méthodes statiques).
- [ ] **Phase 5 — Vues** (`ListController`, `GraphView`, `DatacenterView`).
- [ ] **Phase 6 — Shell / UI.** Migration du `<head>`/`<style>`/`<body>` et du
      bootstrap ; câblage final ; retrait du mono-fichier.

## État actuel (Phase 1)

Le modèle est extrait **à l'identique** (mêmes normalisations / valeurs par
défaut / rétro-compat que le HTML v172). `src/app/main.ts` est un point d'entrée
provisoire qui instancie le registre pour prouver la chaîne — il sera remplacé par
le vrai bootstrap en phase 6.

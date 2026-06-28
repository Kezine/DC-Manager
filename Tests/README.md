# DC Manager — Tests

Filet de régression **au niveau MODULES** : il exerce le **TypeScript compilé** (le code
réel de l'app), sans navigateur. C'est désormais **LA** référence de tests — l'ancien
harnais *legacy* (qui extrayait le `<script>` du monolithe `netmap-vNNN.html`) a été
**retiré** une fois la migration terminée ; ses suites ont été absorbées ici.

## Lancer

```bash
npm run test          # alias de test:modules
npm run test:modules  # tsc -p tsconfig.node.json  (→ dist-test/)  puis  node Tests/modules/run.js
```

Sortie : la liste des assertions (`✓` / `✗ FAIL`) puis un total ; code de sortie ≠ 0 si un test échoue.

## Comment ça marche

`Tests/modules/run.js` importe les **modules compilés** depuis `dist-test/` (généré par
`tsc -p tsconfig.node.json` en CommonJS) — `Store`, `BrowserStorageAdapter`, entités,
géométrie pure (`Projection`, `Box`, `Painter`, `RackGeometry`, `RackScene`, `Resolver3D`,
`FloorLayout`), registres, vues testables en mode *headless* (`GraphView`, `DatacenterView`),
`SaveState`, `ImageStore`, etc. Un mini-framework fournit `ck(cond, libellé)` / `ck.eq(a, b, libellé)`
et une fabrique `makeStore()` (Store en mémoire, adapter non persistant).

## Principe

Les tests **caractérisent le comportement courant** (garde-fous, pas une spécification).
Échec après un changement *voulu* → on met à jour le test ; échec après un refactor *censé
ne rien changer* → régression.

## Écrire un test

Tout vit dans `Tests/modules/run.js` (un seul fichier, sections `console.log("• …")` +
blocs `{ … }`). Pour une nouvelle couche : importer le module compilé en tête (`const { X } =
D("chemin/Module.js")`) puis ajouter un bloc d'assertions avant le total final.

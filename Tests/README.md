# NetMap — Tests

Harnais de tests **neuf** (sans rapport avec `../Scrapped/`, qui contient d'anciens
smoke-tests *jetés*). But : rendre vérifiables **en Node, sans navigateur** les
parties stables et pures de l'app, pour servir de **filet de régression** avant les
gros refactors (perf 3D, découpe de méthodes, fusion de doublons).

## Lancer

```bash
# teste le dernier netmap-vNNN*.html du dossier parent
node Tests/run.js

# ou un fichier précis
node Tests/run.js netmap-v158-perf-micro-opts.html
```

Sortie : `node --check` (syntaxe) puis les suites ; code de sortie ≠ 0 si un test échoue.

## Comment ça marche

`run.js` extrait le `<script>` du `.html`, stubbe le DOM/navigateur (assez pour que
le boot ne plante pas), évalue le script et **expose une API curée** dans
`globalThis.__NM__` (classes d'entités, `Store`, `BrowserStorageAdapter`, `project3D`,
`equipmentTypeColor`, …) plus une fabrique `makeStore()` qui crée un Store en mémoire
(adapter non persistant) **et** réassigne le `store` global du script (pour les
helpers qui en dépendent).

## Écrire une suite

Un fichier `Tests/suites/NN-nom.test.js` exporte :

```js
module.exports = {
  name: "Ma suite",
  run: async (NM, ck) => {
    const store = await NM.makeStore();
    ck(condition, "libellé");          // pass/fail
    ck.eq(obtenu, attendu, "libellé");  // égalité (===) avec diff
    await ck.throws(() => f(), "doit lever");
  }
};
```

## Principe

Les tests **caractérisent le comportement COURANT** (ce sont des garde-fous, pas une
spécification). Si un test échoue après un changement *voulu*, on met à jour le test ;
s'il échoue après un refactor *censé ne rien changer*, c'est une régression.

## Portée actuelle

- `01-data-layer` — Store (CRUD), index FK (`portsOf`/`cablesOfPort`/`equipmentsOfRack`),
  cascade de suppression, undo/redo, clone.
- `02-geometry` — `project3D`, `equipmentTypeColor` (pures), `normRackOrientation`, `floorNum`.
- `03-entities` — normalisation au constructeur + rétro-compat (Cable.network_ids, Waypoint OOB).

À étendre : helpers dépendant du `store` global (resolvePort3D, rackOccupants, cableRoute…)
— testables via `makeStore()` + appel des fonctions exposées.

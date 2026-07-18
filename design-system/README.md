# Galerie « design-system »

Previews HTML **autonomes** documentant les primitives d'interface de DC Manager,
destinées à être poussées vers un projet **claude.ai/design** (le design system y
sert de référence visuelle et de banc d'essai des composants).

Chaque preview est une **page HTML valide et autosuffisante** : le CSS courant de
l'app y est **inliné en entier** (aucune ressource relative — la galerie claude.ai
ne peut charger de fichier voisin de façon fiable), et le seul JavaScript embarqué
est le bouton de bascule de thème.

## Régénérer

```sh
node design-system/build.js
```

Le script **RÉGÉNÈRE INTÉGRALEMENT** `design-system/previews/` (il efface puis
réécrit le dossier — idempotent : deux exécutions donnent des fichiers identiques).
Aucune dépendance externe (Node pur).

Sortie type :

```
  Icônes         : 49 (source : require(dist-test/…/Icons.js))
  Tokens         : 21 (:root) / 15 ([data-theme=light])
  Previews       : 9 carte(s) régénérée(s)
  Lint classes   : OK (toutes les classes non-`ds-` existent dans dc-manager.css)
```

## Les previews sont DÉRIVÉES — ne jamais les éditer à la main

`previews/**.html` est **généré**. On ne le modifie **jamais** directement : toute
correction se fait dans une **source**, puis on relance `build.js`. Les sources sont :

| Source | Rôle |
|---|---|
| `src-client/styles/dc-manager.css` | CSS courant de l'app, inliné dans chaque preview |
| `src-client/ui/Icons.ts` | registre des icônes (via le compilé, cf. plus bas) |
| `design-system/templates/**.html` | le **markup** de chaque carte (miroir des primitives `src-client/ui/`) |
| `design-system/build.js` | assemblage + générateurs (tokens de couleur, grille d'icônes) |

### Discipline de resynchronisation (esprit du principe n°13 « doc à jour »)

Faire évoluer une primitive UI (une classe, une structure DOM, une icône) implique,
**dans la foulée** :

1. mettre à jour le template correspondant dans `design-system/templates/` (chaque
   template commente en tête la ou les sources TS/CSS qu'il reflète) ;
2. relancer `node design-system/build.js` ;
3. resynchroniser le projet **claude.ai/design** avec le nouveau contenu de
   `previews/` (opération manuelle, hors de ce dépôt).

Une preview en retard sur la primitive qu'elle illustre est un **bug** de doc : la
corriger, ou le signaler explicitement.

## Structure

```
design-system/
  build.js              # générateur (Node, sans dépendance)
  templates/            # markup source par carte, groupé par famille
    <groupe>/<carte>.html
  previews/             # SORTIE générée — ne pas éditer
    <groupe>/<carte>.html
```

### Anatomie d'un template

- **1re ligne** = marqueur `@dsCard` (recopié tel quel en 1re ligne de la preview) :
  ```html
  <!-- @dsCard group="Boutons" name="Boutons" subtitle="…variantes…" -->
  ```
  `group`/`name`/`subtitle` alimentent le titre de la page et servent de repères à
  la galerie. Le fichier de sortie suit l'arborescence du template
  (`templates/boutons/boutons.html` → `previews/boutons/boutons.html`).
- **Jetons** remplacés par `build.js` (uniquement HORS commentaires — un commentaire
  peut donc citer un jeton sans qu'il soit expansé) :
  - `{{COLOR_TOKENS}}` — grille des tokens de couleur des deux thèmes (parsée du CSS) ;
  - `{{ICONS_GRID}}` — grille du registre complet d'icônes ;
  - `{{MONO_STACK}}` — valeur de `--mono` ;
  - `{{ICON:NOM}}` — le SVG de `Icons.NOM` (un nom inconnu fait échouer le build).

### Icônes — stratégie de chargement

Les SVG vivent dans `src-client/ui/Icons.ts` (constantes statiques). `build.js` :

1. **priorité au compilé** `dist-test/src-client/ui/Icons.js` s'il existe (présent
   après `npm run test`) : `require` direct, source de vérité exécutable ;
2. **repli** par extraction regex des `static readonly NOM = '<svg…>'` du source
   `.ts` (aucune compilation requise).

La source effectivement utilisée est indiquée dans le rapport de `build.js`.

### Thème

Chaque preview démarre en **sombre** (défaut de l'app = absence d'attribut). Un
bouton fixe ☀/🌙 bascule `data-theme="light"` sur `<html>`, à l'identique de
`applyTheme` (`src-client/app/main.ts`) — le CSS thème via `[data-theme="light"]`.

## Lint de classes

À chaque build, `build.js` contrôle que les classes utilisées dans les previews
existent bien dans `dc-manager.css`. Sont **exclues** du lint :

- les classes d'habillage de la galerie (préfixe `ds-`, propres à ces pages) ;
- une courte liste d'**accroches JS** connues (`modal-save`, `modal-cancel`…) —
  générées par les primitives réelles mais jamais stylées (elles ne servent qu'au
  `querySelector`). Elles sont reproduites par fidélité et documentées dans `build.js`.

Toute autre classe absente du CSS est signalée (typo probable dans un template).

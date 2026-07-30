# Carton de design — Éditeur de ROUTE (assignation des waypoints d'un câble / faisceau)

> **Type** : brief PROSPECTIF (spec d'UI à refondre), destiné à Claude Design. Contrairement aux
> `design-system/templates/*` (miroirs fidèles du code existant), ce document décrit une UI à
> RECONCEVOIR. Objectif : produire une exploration/maquette prête à guider l'implémentation.
> **Aucun code n'est écrit à ce stade** — seule cette spec l'est.
> **Langue** : français (domaine métier francophone). Réutiliser les primitives et tokens de
> `src-client/styles/dc-manager.css` (voir la galerie `design-system/previews/`).

---

## 1. Contexte

Un **câble** (et un **faisceau**/trunk) porte une **route** : une liste **ORDONNÉE** de **waypoints**
(points de passage) qui décrit son cheminement physique du bout A au bout B. Les waypoints sont des
objets du modèle, posés dans les salles ou sur les étages :

| Glyphe | Type | Rôle dans la route |
|---|---|---|
| ◆ | **point** (salle) | passage ponctuel dans une salle |
| ▬ | **segment** (salle) | passage le long d'un chemin (goulotte) |
| ▦ | **brosse** (baie) | entrée/sortie de baie (passe-câbles) |
| ⏏ | **exit** (salle) | **SORTIE de la salle** — fait quitter la salle au câble |
| ◎ | **pin d'étage** | nomme l'ÉTAGE traversé (cheminement hors salles) |

La route obéit à une **grammaire** (automate `store/CableRouteAnalyzer.ts`) : la route est « dans » un
conteneur (salle ou étage), un **⏏ exit la fait sortir** (état « transit »), elle doit ensuite
**arriver** dans un autre conteneur (l'exit de la salle d'arrivée, ou un ◎ pin d'étage). Erreurs à
codes stables : `wrong_room`, `exit_wrong_room`, `exit_reentry`, `exit_unpaired`, `ports_split`,
`portA_room`/`portB_room` (bout hors du conteneur où la route commence/finit)…

La route s'édite à DEUX endroits :
- le **formulaire Câble** et le **formulaire Faisceau** (`views/forms/CableForms.ts`) — **l'objet de ce
  carton** ;
- l'outil **Routage** des vues 2D/3D (`views/dc/RouteTool.ts`) — clic sur les waypoints dans la scène.
  Il reste hors périmètre, mais le formulaire est l'éditeur CANONIQUE (principe n°10 : tout est
  éditable sans les vues).

---

## 2. L'existant — et pourquoi c'est insuffisant

### 2.1 Formulaire Câble (le « riche »)

```
Points de passage
  Points (3)     [☑ ◆ Sortie Tableau Elc · DC - LG274]  [☐ ◆ Power WP 2 · DC - LG274] …
  Pins d'étage(1)[☐ ◎ WP étage · ét. 2]
  Segments (1)   [☐ ▬ WP-10 · DC - LG274]
  Brosses (5)    [☐ ▦ Brosse 3 · DC - LG274]  [☐ ▦ Brosse 8 · DC - LG274] …
  Exits (4)      [☑ ⏏ SortieGenerique · DC - LG274]  [☑ ⏏ SorieGeneriqueArchive · Local Archive] …

Route : ◆ DC - LG274 → ⏏ DC - LG274 → ⏏ Local Archive      ← hint texte (1re erreur seulement si invalide)

Ordre des points
  [1] ◆ Sortie Tableau Elc · DC - LG274   [↑][↓]
  [2] ⏏ SortieGenerique · DC - LG274      [↑][↓]
  [3] ⏏ SorieGeneriqueArchive · Local Archive [↑][↓]
```

- **Sélection** = nuage de **cases à cocher** de TOUS les waypoints du document, groupés par TYPE
  (pas par salle). L'**ordre** vit dans une SECONDE liste, avec des boutons ↑/↓ pas-à-pas.
- L'ordre d'insertion = l'ordre de clic → il faut souvent réordonner après coup.
- Le retour de validation est un hint texte sous le nuage : résumé de route + **première** erreur.
- À l'ajout d'une case, un garde-fou « exit terminal » refuse par **toast** (contexte perdu aussitôt).

### 2.2 Formulaire Faisceau (copie dégradée)

- Le MÊME nuage de cases, mais **sans groupes** (tri plat par nom), **sans résumé de route** et
  **sans aucun retour de validation** — seul le toast « exit terminal » existe à l'ajout.
- Conséquence réelle (corpus SONUMA, 2026-07-30) : un faisceau routé par **l'exit de la mauvaise
  salle** (route partant d'une salle ne contenant AUCUNE de ses extrémités) est **silencieusement non
  dessiné** en 2D/3D. Aucun indice dans le formulaire. Diagnostic à la main obligatoire.
  *(Une validation « extrémités ⇄ route » est en cours d'ajout côté code — la maquette doit lui
  donner sa place, cf. §4.4.)*

### 2.3 Les maux, en synthèse

1. **Deux représentations** de la même chose (nuage coché + liste ordonnée) — la sélection et l'ordre
   sont découplés alors que la route EST une séquence.
2. Le nuage de cases **ne passe pas à l'échelle** (déjà ~14 waypoints sur le corpus réel ; un document
   multi-salles en aura des dizaines) et **groupe par type**, alors que la question de l'utilisateur
   est « **par où** je passe » → le groupement naturel est le **CONTENEUR** (salle/étage).
3. **Aucune pertinence** : les waypoints des salles des deux bouts devraient venir en tête ; ceux de
   salles étrangères sont du bruit (et la source de l'incident §2.2).
4. La **grammaire est invisible** : rien ne dit « ici il FAUT un exit », « après cet exit, il faut
   l'exit d'une AUTRE salle ou un pin d'étage ». On découvre les règles par toasts de refus.
5. Le **retour d'erreur est pauvre** : une seule erreur, en texte, jamais rattachée à L'ÉTAPE fautive.
6. Réordonner = clics ↑/↓ répétés, pénible dès 4 étapes.

---

## 3. Réflexion d'implémentation (à quoi les contrôles se lient)

*Section de fond — noms = existant sauf mention contraire.*

- **Donnée éditée** : `cable.waypoint_ids: string[]` / `bundle.waypoint_ids: string[]` (ordonnée A→B).
- **Analyse** : `store.cableRoute(draft)` → `{ steps, errors[{code,message}], valid, hasExits,
  startContainer, endContainer, containerA, containerB }`. Les `steps` portent chacun leur waypoint,
  leur type et leur **conteneur** — de quoi rattacher chaque erreur à une étape.
  `store.cableRouteSummary(r)` → « ◆ Salle A → ⏏ Salle A → ◎ ét. 1 → ⏏ Salle B ».
- **Bouts** : câble = conteneurs des 2 ports (`containerA/B`) ; faisceau = conteneurs des 2 patchs
  (`equipmentNamedContainer`). En cours d'ajout : `bundleRoute(bundle)` qui vérifie la cohérence
  extrémités ⇄ route (l'équivalent faisceau de `portA_room`/`portB_room` + `ports_split`), en
  tolérant une route saisie à l'envers (A dans le conteneur d'arrivée).
- **Libellé de conteneur** : `store.containerLabel(c)` (« Salle X », « Bât. Y · ét. 1 »).
- Un waypoint **non posé** (`unplaced`) est signalable mais inutilisable.

---

## 4. Ce que le nouvel éditeur doit être

### 4.1 UNE représentation : la CHAÎNE ordonnée

La route se lit et s'édite comme une **chaîne d'étapes** entre deux ancres fixes :

```
[Bout A — GPFS21 · DC - LG274]                        ← ancre (non éditable ici), conteneur affiché
   │
   ├─ 1. ▦ Brosse 3 · DC - LG274            [⋮⋮] [×]
   ├─ 2. ⏏ SortieGenerique · DC - LG274     [⋮⋮] [×]
   ├─ 3. ⏏ SorieGeneriqueArchive · Local Archive [⋮⋮] [×]
   ├─ (+ Ajouter une étape…)                ← ouvre le sélecteur §4.2
   │
[Bout B — Patch Fibre · Local Archive]                ← ancre, conteneur affiché
```

- **Une seule liste**, ordonnée = la route. Suppression par étape (×), réordonnancement par
  **glisser-déposer** (poignée ⋮⋮) + repli clavier/boutons ↑/↓ (accessibilité, mobile).
- Les **tronçons** peuvent être visuellement regroupés par conteneur (bandeau discret « DC - LG274 »,
  « transit », « Local Archive ») — la route se lit alors comme le résumé actuel, mais en riche.

### 4.2 Ajout d'étape : sélecteur à RECHERCHE, groupé par CONTENEUR, trié par PERTINENCE

- Le « + Ajouter une étape » ouvre un **popover à recherche** (pattern `SearchPop`/`entityPicker`,
  principe n°14 — PAS un nuage de cases) listant les waypoints utilisables :
  - **groupés par conteneur** (salle/étage), l'ordre des groupes suivant la **pertinence** :
    ① conteneur COURANT de la route (où en est la grammaire), ② conteneurs des bouts A/B,
    ③ le reste ;
  - chaque item : glyphe + nom + (type discret) ; les **exits** visuellement saillants (ce sont les
    articulations de la route) ;
  - les waypoints **grammaticalement impossibles** à cette position : **grisés + motif en tooltip**
    (ex. « la route a quitté DC - LG274 — il faut l'exit d'une autre salle ou un pin d'étage »),
    plutôt que refus par toast après coup ;
  - waypoints **non posés** : grisés « non posé ».
- L'insertion se fait par défaut **en fin de route**, mais un « + » discret entre deux étapes permet
  l'insertion au milieu (cas réel : ajouter la brosse oubliée avant l'exit).

### 4.3 La grammaire, VISIBLE

- Après un ⏏ exit, l'état « **transit** » apparaît comme un segment stylé distinct (pointillé,
  libellé « transit — en attente d'arrivée ») tant que le tronçon n'est pas refermé → `exit_unpaired`
  devient un état VISIBLE au lieu d'une erreur au save.
- Chaque **erreur** de l'analyse (`r.errors`) s'affiche **sur l'étape fautive** (liseré/pastille
  `--err` + message court), pas seulement en pied de formulaire. Le pied garde une **synthèse**
  (« Route valide : ◆ … → ⏏ … » / « 2 problèmes »).
- Suggestion contextuelle en fin de chaîne : « il manque l'exit de Local Archive pour rejoindre le
  bout B » (déductible de `endContainer` vs conteneur du bout B).

### 4.4 Cohérence extrémités ⇄ route (câble ET faisceau)

- Les **ancres A/B** affichent leur conteneur et passent en **alerte** quand la route ne les dessert
  pas (`portA_room`/`portB_room`, et leur équivalent faisceau en cours d'ajout) : c'est le remède UX
  de l'incident §2.2 — « la route relie “Local Archive” à “Local Technique”, mais le bout A est dans
  “DC - LG274” ».
- Cas « route à l'envers » (A saisi dans le conteneur d'arrivée) : proposer une action **« Inverser
  la route »** plutôt qu'une erreur (le moteur tolère déjà l'inversion au rendu).

### 4.5 Parité câble / faisceau

Le composant est **LE MÊME** pour les deux formulaires (seules les ancres changent : ports pour un
câble, patchs pour un faisceau). Plus jamais deux éditeurs de route qui divergent.

---

## 5. Règles à retranscrire visuellement (synthèse)

1. La route est **ordonnée A→B** ; les bouts sont des ancres hors liste.
2. **Dans une salle** : ses ◆/▬/▦ + son ⏏ sont proposables ; ceux des autres salles non.
3. **Après un ⏏** (transit) : seuls un ⏏ d'une AUTRE salle ou un ◎ pin d'étage referment le tronçon ;
   re-rentrer dans la salle quittée = `exit_reentry`.
4. **◎ pin d'étage** : jamais À L'INTÉRIEUR d'une salle ; nomme l'étage en début de route, en transit,
   ou entre étages.
5. Deux bouts dans deux conteneurs **différents** ⇒ la route DOIT sortir (`ports_split`).
6. Bout ≠ conteneur de départ/arrivée de la route ⇒ alerte sur l'ancre (§4.4).
7. Un waypoint **non posé** est visible mais inutilisable.

---

## 6. États à maquetter

1. **Route vide** (câble intra-baie : « aucun point de passage — tracé direct »).
2. **Intra-salle** : 2–3 étapes ◆/▦, pas d'exit.
3. **Inter-salles nominal** : ▦ → ⏏ salle A → ⏏ salle B (groupes de conteneur visibles).
4. **Inter-salles via étage** : ⏏ salle A → ◎ ét. 2 → ⏏ salle B.
5. **Transit ouvert** (`exit_unpaired`) : segment « transit » en attente + suggestion.
6. **Erreur rattachée à une étape** (`wrong_room` / `exit_reentry`) : étape en liseré `--err`.
7. **Incohérence de bout** (§4.4) : ancre A en alerte, message nommant les conteneurs + action
   « Inverser la route » pour le cas à l'envers.
8. **Popover d'ajout** ouvert : recherche, groupes par conteneur, exits saillants, items grisés
   avec motif.
9. **Waypoint non posé** dans la route (existant historique) : étape grisée « non posé ».
10. **Longue route** (6+ étapes, 3 conteneurs) : lisibilité du groupement.
11. **Responsive < 560 px** : chaîne empilée, poignées tactiles, popover plein écran.

---

## 7. Primitives à réutiliser (design-system)

- **Popover à recherche** → pattern `SearchPop`/`entityPicker` (cf. cartes formulaires) ; champ de
  recherche NORMALISÉ de l'app.
- **Glyphes** : ceux de `Waypoint.glyph` (◆ ▬ ▦ ⏏ ◎) — ne pas en inventer d'autres.
- **Pastilles** `.pill` pour numéros d'étape et conteneurs ; tokens `--accent`/`--warn`/`--err`.
- **Boutons-icône** (`iconAction`) pour × / ↑ / ↓ ; `btn-ghost btn-sm` existants.
- **Hints** `.form-hint` (+ `.err`) pour la synthèse de pied.
- Bandeaux de groupe : sobres (cf. en-têtes de groupes des listings), PAS de cartes lourdes —
  la modale câble est déjà dense.

---

## 8. Livrables attendus de Claude Design

1. **Maquette de la chaîne de route** (états §6.1–6.7, clair ET sombre).
2. **Maquette du popover d'ajout** (§6.8) : recherche + groupes + grisés motivés.
3. Micro-interactions : glisser-déposer (curseur, placeholder), insertion entre étapes, action
   « Inverser la route ».
4. Recommandation d'intégration dans la modale Câble existante (déjà chargée : bouts, type, réseau,
   statut…) : la chaîne remplace les 3 champs actuels (« Points de passage », hint route, « Ordre des
   points ») dans le MÊME encombrement vertical ou moins.
5. Rendu **responsive** (§6.11).

Sources reflétées (pour ancrer la maquette sur l'existant) :
`src-client/views/forms/CableForms.ts` (cableForm §points-de-passage, bundleForm §route),
`src-client/store/CableRouteAnalyzer.ts` (grammaire, codes d'erreur, résumé),
`src-client/models/Waypoint.ts` (glyphes, types), `src-client/views/dc/RouteTool.ts` (éditeur de
scène, hors périmètre), `src-client/styles/dc-manager.css` (`.pill`, `.form-hint`, `.btn-ghost`,
`SearchPop`), `docs/faisceaux.md` (routes partagées des trunks).

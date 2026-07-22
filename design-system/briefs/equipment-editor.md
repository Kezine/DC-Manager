# Carton de design — Modale d'ÉDITION d'un équipement (variations)

> **Type** : brief pour Claude Design. Objectif : produire une **maquette** de la modale d'édition d'équipement
> qui **représente les VARIATIONS** de la modale selon l'équipement (type, dimensionnement, placement, inventaire…).
> La modale EXISTE déjà (`src-client/views/forms/EquipmentForms.ts`, méthode `equipmentEditor`) — ce carton en
> décrit fidèlement la structure et surtout ses **états conditionnels**, pour une exploration visuelle / refonte.
> **Langue** : français (domaine métier francophone). Réutiliser tokens et primitives de
> `src-client/styles/dc-manager.css` (galerie `design-system/previews/`) : `Modal` standard (`FormHost`), `form-field`,
> `FormControls` (text/number/select/date/toggle `.toggle-pill`), `.list-chrome`, `.pill`, chips (`ChipsInput`).

---

## 0. Périmètre

- **HORS scope — l'éditeur de PORTS / agrégats / breakout** : il a son **propre carton** (`port-editor-poe.md` +
  `port-editor-poe.maquette.html`). Ne le maquettez PAS ici — représentez juste sa **place** dans la modale (une
  section « Ports » en bas), éventuellement repliée/schématique. (À n'inclure que si ça SIMPLIFIE la lecture.)
- **DANS le scope** : identité, administratif + **énergie**, groupes, description, **dimensions**, **placement**,
  **façade** (images) — et TOUTES leurs variations conditionnelles.

## 1. Contexte

Un **équipement** = matériel répertorié, éventuellement **placé** (baie / libre / sol / paroi / étagère / plan
d'étage) et câblé. Sa modale d'édition est une **modale standard** de l'app (`Modal`, `wide`), en **une colonne**,
découpée en sections par des **séparateurs** (`FormUi.divider`). Beaucoup de champs sont **conditionnels** : c'est
là tout l'intérêt de la maquette — montrer la modale **caméléon** selon l'équipement.

Le **type** d'équipement (ids ANGLAIS) : `switch` · `server` · `enclosure` · `pc` · `printer` · `ap` · `camera`
(Caméra IP) · `patch_panel` · `pdu` · `switchboard` (tableau élec.) · `ups` (onduleur) · `other`. Chaque type a une
**icône** + une **couleur** stable (`EquipmentTypes`). Certains sont « **system** » (pilotage fin, non supprimables).

## 2. Structure de la modale (sections, de haut en bas)

1. **Identité** — Nom · **Type** (select, icône) · bascule **« Inventaire seul »** (`.toggle-pill`, pleine largeur) ·
   Marque · Modèle · N° de série.
2. **Administratif** (séparateur) — Date d'achat · Fin de garantie · Bon de commande · Date d'attribution · Attribué à.
3. **Énergie** (dans la même zone admin — **très variable selon le type**, cf. §3.A) — capacité (A) et/ou
   consommation (W) et/ou **bloc POE**.
4. **Groupes** — Groupe primaire (select, pilote la couleur) + Groupes secondaires (chips de recherche).
5. **Description** (zone de texte).
6. *(à partir d'ici : masqué si « Inventaire seul » — cf. §3.B)*
7. **Dimensions** (séparateur) — **Dimensionnement** = `En U (rack)` **ou** `Libre (mm)` (cf. §3.C).
8. **Placement** (séparateur, dépend du dimensionnement — cf. §3.D).
9. **Façade** — bouton « Façade… » (ouvre un éditeur d'images de façade dédié) + miniatures des faces définies.
10. **Ports** *(HORS scope — carton dédié ; juste sa place)*.
11. Pied : **« Créé/Modifié par {auteur} le {date} »** (mode API) + boutons **Annuler / Enregistrer** de la modale.

---

## 3. LES VARIATIONS (le cœur du carton)

### A. Selon le TYPE — bloc ÉNERGIE

| Cas (type) | Capacité | Consommation | Bloc POE |
|---|---|---|---|
| **switch / server / pc / printer / ap / camera / enclosure / other** | — | **Conso nominale (W)** + **Conso max (W)** | POE **si** « équipement POE » (cf. plus bas) |
| **pdu** | **Capacité max (A)** (`pdu_max_a`) | Conso nom./max (W) | — |
| **switchboard** (tableau électrique = racine d'alim) | **Capacité max (A)** | **AUCUNE conso** (il *fournit*, ne consomme pas) | — |
| **ups** (onduleur) | — | Conso (W) | — |
| **camera** (PoE PD typique) | — | Conso (W) = ce qu'elle tire en PoE | souvent **PD** côté ports |

- **Bloc POE de l'équipement** (variation transverse, quand l'équipement fait du PoE) : une **bascule « Équipement
  POE »** + **Budget POE total (W)** + une **jauge de budget** (charge des PD connectés / budget). ⚠ Ce bloc est
  **déjà spécifié** dans le carton port-editor-poe (§3.2) — le **reprendre à l'identique**, ne pas réinventer.

### B. « Inventaire seul » (bascule ON)

Masque TOUT le bas de la modale : **Dimensions, Placement, Façade, Ports disparaissent**. Ne restent que
identité + administratif/énergie + groupes + description. → un état à maquetter (modale **courte**).

### C. DIMENSIONNEMENT — `En U` vs `Libre`

- **En U (rack)** : **Hauteur (U)** · **Profondeur** (préréglages mm : 600/800/1000/1200 + « Personnalisée… » →
  saisie mm) · bascule **« Occupe les deux faces »** (verrouille le U) · **Largeur du boîtier (mm)** (vide = pleine
  largeur 19″) + **Alignement** (gauche/centre/droite, si largeur réduite) · **Débord de façade (mm)** (rare).
- **Libre (L × l × h en mm)** : **Longueur** · **Largeur** · **Hauteur** (3 champs mm). Pas de U.

### D. PLACEMENT — dépend du dimensionnement

- **Dimensionnement `En U` → placement RACK** : **Baie** (select) · **Position (U)** (vide = libre) · **Face**
  (avant/arrière, si baie double/half-depth).
- **Dimensionnement `Libre` → Mode de placement** (select) — **5 sous-formulaires distincts** :
  1. **Au sol d'une salle** (`sol`) : **Salle** · Position **X / Y (mm)** · **Hauteur Z (mm)** (négatif = sous
     faux-plancher).
  2. **Latéral (marge de baie)** (`side`) : **Baie** · Face av/ar · Côté G/D · Position **U (bord haut)** · Colonne ·
     Accroche (montant/paroi).
  3. **Paroi de baie (mural)** (`wall`) : **Baie** · Paroi G/D · Marge avant/arrière · Position **U (base)** · Colonne ·
     Face orientée (centre / façade).
  4. **Sur un plan d'étage** (`floor`) : **Bâtiment** · **Étage** · Position **X / Y (mm)** · Hauteur Z.
  5. **Posé sur une étagère (tray)** (`tray`) : **Étagère** (select) · Position **X / Y (mm)** (vide = auto).
  + état **« — non placé — »** (aucun mode) : juste un rappel/hint.

> Principe n°10 de l'app : **tout est éditable par le formulaire** (placement, position X/Y, Z, orientation…) sans
> passer par les vues 2D/3D. La modale est donc l'**équivalent exhaustif** des manipulations 2D/3D.

### E. FAÇADE

Bouton **« Façade… »** (ouvre un éditeur d'images séparé) + **miniatures** des faces déjà définies (avant / arrière /
faces annexes pour les équipements libres). Variation : 0 image (juste le bouton) vs plusieurs faces posées.

---

## 4. États à MAQUETTER (matrice de variations)

1. **Switch en U, placé en baie** (cas le plus courant) : identité + conso (W) + dimensions U + placement rack.
2. **Switchboard (tableau élec.)** : capacité (A), **pas de conso**, souvent libre + placement mural/sol.
3. **PDU en U** : capacité (A) + conso.
4. **Équipement POE** (switch PoE) : bloc POE (bascule + budget + **jauge**) dans l'énergie.
5. **Caméra IP** (`camera`, libre) : conso (W) + placement **plan d'étage** ou **paroi**.
6. **Onduleur (UPS)** : énergie simple + dimensionnement libre.
7. **« Inventaire seul »** : modale **courte** (pas de dimensions/placement/façade/ports).
8. **Dimensionnement Libre + `Mode de placement`** : montrer **au moins 2** sous-formulaires (ex. *sol* et *tray*)
   pour illustrer que les champs changent radicalement selon le mode.
9. **Façade** : état avec 2–3 miniatures de faces vs état vide.
10. **Responsive < 560 px** : la modale reste **une colonne** lisible, champs empilés, aucun scroll horizontal.

*(Inutile de tout combiner : viser ~6–8 vignettes d'états représentatives couvrant A→E.)*

## 5. Primitives à réutiliser (design-system)

- **Modale** = `Modal` standard (`FormHost`, `wide`) — jamais une page pleine (principe n°11).
- **Séparateurs de section** = `FormUi.divider`. **Champs** = `FormControls` (`text`/`number`/`select`/`date` avec
  boutons 📅/Aujourd'hui/effacer/`.toggle-pill`) dans des **`form-field`** (label + contrôle + hint).
- **Bascules** (inventaire, occupe 2 faces, équipement POE) = `.toggle-pill` (pilule + témoin ●, pas de plein).
- **Groupes secondaires** = **chips** (`ChipsInput`, recherche + pastilles colorées). **Type** = select avec icône.
- **Jauge POE** = la barre `.gauge` du carton port-editor-poe (états normal / ≈80 % / survente).
- **Unités** : suffixe discret dans le champ (**A** capacité, **W** conso/budget, **mm** dimensions, **U** hauteur).

## 6. Sources reflétées (ancrer la maquette sur l'existant)

- `src-client/views/forms/EquipmentForms.ts` (`equipmentEditor` : identité, admin/énergie, groupes, dimensions,
  placements, façade ; visibilité conditionnelle dans `sync()`/`syncSalle()`).
- `src-client/domain/constants.ts` (`EQUIPMENT_TYPES` + note `system`, `EQUIPMENT_PLACEMENT_MODES`, préréglages
  profondeur) · `src-client/registries/EquipmentTypes.ts` (icône/couleur/`resolveId`).
- `src-client/styles/dc-manager.css` (`.toggle-pill`, `form-field`, `.pill`, `.list-chrome`, `.gauge`, `.unit-inp`).
- Bloc POE : `design-system/briefs/port-editor-poe.md` §3.2 (à reprendre tel quel).
- `design-system/templates/modales/fiche-detail.html` (miroir de la FICHE lecture — pour la cohérence visuelle).

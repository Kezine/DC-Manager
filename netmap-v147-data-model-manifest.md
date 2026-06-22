# NetMap — v147 (`netmap-v147-wall-mount.html`)

**CHANGEMENT DE SCHÉMA : `equipments` += `wall_lr`, `wall_margin`, `wall_u`, `wall_col`, `wall_orient` ; nouveau
`placement_mode` = `"wall"`.** (+ v146 : `SIDE_U_STEP` 4 → 2, pas de schéma.)

## Nouveau mode de placement : MONTAGE EN PAROI
Un équipement (dims LIBRES, `dim_mode "free"`) peut être plaqué contre une **paroi latérale** (gauche/droite) d'une
baie, dans la **marge avant** ou **arrière** (l'espace entre la façade/l'arrière et les montants, créé par
`front_margin_mm` / une cage plus courte que la profondeur extérieure). Disponible quand la profondeur de marge ≥ 1U.

### Champs ajoutés (équipements)
- `placement_mode = "wall"` — monté en paroi (rattaché au `rack_id` de la baie hôte ; héritage de lieu via le rack).
- `wall_lr` ∈ {`left`,`right`} — paroi gauche/droite.
- `wall_margin` ∈ {`front`,`rear`} — marge avant/arrière.
- `wall_u` (entier ≥ 1) — U de base (bandes de `SIDE_U_STEP` = 2U).
- `wall_col` (entier ≥ 0) — colonne le long de la profondeur de marge.
- `wall_orient` ∈ {`center`,`facade`} — la FACE de l'équipement pointe vers le **centre** du rack (⊥) ou vers la
  **façade** de la marge (avant pour la marge avant, arrière pour la marge arrière).

Dimensions : réutilise `free_w_mm` / `free_h_mm` / `free_l_mm`.

## Géométrie (repère baie local)
- Marges : avant `y∈[−hd, −hd+front_margin]`, arrière `y∈[−hd+front_margin+cage, +hd]`.
- Grille : colonnes le long de la profondeur de marge (largeur mini `WALL_COL_MIN = 2U·U_MM`) × bandes 2U (z).
- `orient="center"` : protrusion vers le centre (X), face normale ±X. `orient="facade"` : profondeur le long de la
  marge (Y), face normale vers la face extérieure de la marge (∓Y).
- Helpers : `rackMarginDepth`, `rackWallEnabled`, `rackWallGeo`, `wallSlotBoxLocal`, `wallEquipBoxLocal`,
  `rackWallOccupants`, `wallSlotFree`, `wallFreeSlots`.

## Code touché
- Modèle `Equipment` (champs + `placement_mode "wall"`).
- 3D `_rackBox3D` : unités `wall` (boîte + ports + étiquette) et `wallfree` (plaque cliquable, gardée par face
  visible/distance/flag).
- `resolvePort3D` : branche `wall` (normale selon `wall_orient`).
- Pose : `assignWallSlot(rackId, wall, margin, col, uTop, onDone)` (clic 3D sur un emplacement mural libre).
- `equipmentDcId` / `equipmentLocationBits` / `equipmentPlacementShort` / `unrackedEquipments` reconnaissent `wall`.
- Formulaire d'équipement : un mural s'édite en « Libre » (dims) ; son placement mural est PRÉSERVÉ à l'enregistrement.

## À VÉRIFIER EN NAVIGATEUR (1re version, géométrie à confirmer visuellement)
- Régler une **marge avant** > 1U (ou une cage < profondeur pour une marge arrière) → en 3D, des emplacements
  muraux libres apparaissent sur les parois G/D de la marge (orbiter pour les voir de côté).
- Clic sur un emplacement → choix équipement + orientation (centre/façade) → l'équipement se monte ; ses ports/câbles
  suivent ; l'occlusion bascule avant/arrière selon la face regardée.

## Rétro-compatibilité
Totale : champs absents → défauts (`left`/`front`/`1`/`0`/`center`) ; aucun équipement existant n'est en mode `wall`.
Une baie sans marge (front_margin 0, cage = profondeur) n'expose aucun emplacement mural.

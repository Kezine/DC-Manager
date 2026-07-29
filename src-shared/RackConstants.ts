/* ============================================================================
   COTES GÉNÉRALES DE BAIE — code PARTAGÉ front ⇄ back (TS pur).

   SOURCE UNIQUE des cinq cotes du standard 19″ dont dépendent à la fois la
   VALIDATION partagée et la GÉOMÉTRIE du front. Elles vivaient en DOUBLE :
   déclarées dans `src-client/domain/constants.ts` et RÉPLIQUÉES dans
   `src-shared/TrayGeometry` (sous des noms préfixés `TRAY_*`, alors qu'elles
   n'ont rien de propre à une étagère) puis dans `src-shared/RackDepthPolicy`.
   Deux en-têtes justifiaient la réplique par la même phrase : « l'unifier
   reviendrait à migrer `domain/constants.ts` en entier ».

   ⚠ CETTE PHRASE ÉTAIT FAUSSE, et c'est le seul enseignement de ce module.
   Rien n'obligeait à déplacer les 262 lignes de `domain/constants.ts` : il
   suffisait d'en extraire les CINQ cotes réellement partagées. L'estimation
   portait sur le fichier au lieu de porter sur les valeurs, et une déduplication
   de dix lignes est restée ouverte plusieurs lots pour cette raison. Le sens de
   la dépendance est celui que `TRAY_DEPTH_DEFAULT_MM` suivait DÉJÀ, dans l'autre
   sens, depuis le lot 6 : la valeur vit en PARTAGÉ, le front la RÉ-EXPORTE.

   Ce fichier n'est possible que depuis la levée de l'auto-suffisance de
   `src-shared/` (doctrine §6.7) : ses voisins l'importent avec l'extension
   **`.js`** — impérative, NodeNext l'exige côté serveur.

   NOMMAGE : suffixe `_MM` systématique, parce que l'unité est la seule chose
   qu'on se trompe à lire. `domain/constants.ts` conserve ses noms historiques
   (`RACK_MOUNT_WIDTH`, `RACK_DEPTH_DEFAULT`) par ALIAS de ré-export — les
   renommer côté front toucherait des dizaines de fichiers pour un bénéfice nul,
   et ce lot déduplique des VALEURS, il ne renomme pas une API.
   ============================================================================ */

/** Hauteur d'un U (mm). */
export const U_MM = 44.45;

/** Entraxe des rails 19″ (mm) = largeur de la zone de montage. */
export const RACK_MOUNT_WIDTH_MM = 482.6;

/** Largeur d'une oreille de montage, par côté (mm). Le corps 19″ d'un équipement vaut donc
    `RACK_MOUNT_WIDTH_MM − 2 × RACK_EAR_MM` — c'est aussi la largeur d'un plateau d'étagère. */
export const RACK_EAR_MM = 15;

/** Épaisseur RÉSERVÉE aux oreilles DEVANT la cage (mm) : la façade de tout occupant est posée à cette
    distance du plan de montage, les oreilles remplissant la réserve dans la continuité de la face,
    sans collision avec les montants. */
export const RACK_EAR_STANDOFF_MM = 3;

/** Profondeur EXTÉRIEURE par défaut d'une baie (mm) — celle du châssis. */
export const RACK_DEPTH_DEFAULT_MM = 1000;

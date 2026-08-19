/* =============================================================================
   ScanAffordance — DÉCISION de visibilité du scan caméra (greffon de champ,
   entrée globale). Documentation : docs/qr-scan.md § « L'UI de scan ».

   DOCTRINE (maquette qr-saisie-camera) : « pas d'icône morte » — le bouton de
   scan d'un champ n'apparaît que là où il a des chances de SERVIR : pointeur
   GROSSIER (tactile) ou écran ÉTROIT (téléphone en salle), FORÇABLE par
   préférence utilisateur (webcam sur poste fixe, ou préférence « scan
   partout »). Et dans tous les cas : une caméra doit EXISTER et le contexte
   doit permettre `getUserMedia` (HTTPS/localhost — cf. docs/qr-scan.md
   § Sécurité) — sinon le bouton ne mènerait qu'à un message d'échec.

   MODULE PUR (testé : Tests/modules/test-scan-ui.js) : les prédicats sont
   INJECTÉS en booléens — c'est l'appelant (`ui/ScanControl`) qui évalue
   matchMedia, sonde `BarcodeDetection.listCameras()` et lit les préférences.
   Aucune lecture de DOM ni d'API navigateur ici. Les REQUÊTES MÉDIA sont
   publiées en constantes pour que tous les appelants évaluent la même chose. */

/** Environnement RÉSOLU par l'appelant (booléens bruts — aucune API ici). */
export interface ScanAffordanceInput {
  /** `matchMedia(COARSE_POINTER_QUERY)` — pointeur grossier (tactile). */
  coarsePointer: boolean;
  /** `matchMedia(NARROW_SCREEN_QUERY)` — écran étroit (< 900px, spec maquette). */
  narrowScreen: boolean;
  /** Préférence de FORÇAGE active : « scan partout » OU « toujours afficher le bouton ». */
  forced: boolean;
  /** Au moins une caméra énumérée (`BarcodeDetection.listCameras().length > 0`). */
  hasCamera: boolean;
  /** `getUserMedia` plausible (contexte sécurisé — `navigator.mediaDevices` présent). */
  secureContext: boolean;
}

export class ScanAffordance {
  static readonly COARSE_POINTER_QUERY = "(pointer: coarse)";
  static readonly NARROW_SCREEN_QUERY = "(max-width: 900px)";

  /** Bouton de scan PAR CHAMP (greffon déclaré ou générique) : (tactile OU étroit
      OU forcé) ET caméra ET contexte — la première parenthèse évite l'icône morte
      sur PC 16/9, les deux conditions dures évitent un bouton qui ne peut qu'échouer. */
  static fieldButton(input: ScanAffordanceInput): boolean {
    return (input.coarsePointer || input.narrowScreen || input.forced)
      && input.hasCamera && input.secureContext;
  }

  /** Entrée GLOBALE « scanner une étiquette » (topbar) : PAS conditionnée au
      tactile — scanner une étiquette à la webcam depuis un poste fixe est un cas
      d'usage entier (ouvrir une fiche). Seules les conditions DURES s'appliquent. */
  static globalEntry(input: ScanAffordanceInput): boolean {
    return input.hasCamera && input.secureContext;
  }
}

/* =============================================================================
   LABELFONTASSETS — la FONTE EMBARQUÉE des étiquettes imprimables, prête à poser
   dans un document. Documentation : docs/qr-scan.md § « Rendu d'impression ».

   POURQUOI EMBARQUER (retour terrain 2026-08-25 : « l'espacement entre les
   chiffres n'est pas constant, contrairement à l'aperçu ») : le document
   d'impression est une iframe ISOLÉE — il ne voit ni la feuille de l'app ni ses
   `url(../fonts/…)`. Sans `@font-face` en data: URI, il retombe sur une police du
   SYSTÈME, et une autre police, ce sont d'autres chasses : l'imprimé cesse de
   ressembler à l'aperçu. Déclarer la MÊME fonte des deux côtés est la seule façon
   d'en être sûr, plutôt que d'espérer que le système choisisse la même.

   🚨 POURQUOI CE FICHIER EXISTE, plutôt que ces six lignes dans LabelPrintDialog :
   un `import … from "*.woff2"` n'est une CHAÎNE que sous webpack (`asset/inline`).
   `ui/LabelPrintDialog` est chargé sous NODE par les tests (via la chaîne des
   fiches) — l'import y serait irrésolu et ferait tomber toute la suite. Les
   assets vivent donc à l'écart, et seul le bootstrap (`app/main.ts`, jamais
   requis par les tests) les importe pour les INJECTER dans `LabelPrintDialog.setup`.

   Les woff2 sont ceux, déjà vendorés et OFL, de la feuille de l'app
   (`src-client/fonts/`) : aucun asset nouveau, aucune requête réseau.
   ⚠ Il n'y a PAS de monospace vendorée : les identifiants d'étiquette perdent leur
   chasse fixe et s'appuient sur `font-variant-numeric:tabular-nums` pour aligner
   les chiffres (cf. `LabelHtml.CSS`). Ajouter `IBMPlexMono-latin-*.woff2` ici
   suffirait à la rendre.
   ============================================================================= */

import { LabelHtml } from "../core/LabelHtml";
import type { LabelFontFace } from "../core/LabelHtml";
import plexLatin400 from "../fonts/IBMPlexSans-latin-400.woff2";
import plexLatinExt400 from "../fonts/IBMPlexSans-latin-ext-400.woff2";
import plexLatin600 from "../fonts/IBMPlexSans-latin-600.woff2";
import plexLatinExt600 from "../fonts/IBMPlexSans-latin-ext-600.woff2";
import plexLatin700 from "../fonts/IBMPlexSans-latin-700.woff2";
import plexLatinExt700 from "../fonts/IBMPlexSans-latin-ext-700.woff2";

/* Plages Unicode des subsets (identiques à celles de la feuille de l'app — mêmes
   fichiers, même découpe). Le navigateur choisit le subset PAR GLYPHE. */
const LATIN_RANGE = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT_RANGE = "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

/** Les fontes à embarquer : latin + latin-ext (app francophone) sur les TROIS graisses que
    l'étiquette utilise réellement — 400 (courant), 600 (propriétaire), 700 (identifiant).
    La 500 de la feuille de l'app n'est pas reprise : aucune règle d'étiquette ne l'appelle. */
const LABEL_FONT_FACES: readonly LabelFontFace[] = [
  { family: "IBM Plex Sans", weight: 400, src: plexLatin400, unicodeRange: LATIN_RANGE },
  { family: "IBM Plex Sans", weight: 400, src: plexLatinExt400, unicodeRange: LATIN_EXT_RANGE },
  { family: "IBM Plex Sans", weight: 600, src: plexLatin600, unicodeRange: LATIN_RANGE },
  { family: "IBM Plex Sans", weight: 600, src: plexLatinExt600, unicodeRange: LATIN_EXT_RANGE },
  { family: "IBM Plex Sans", weight: 700, src: plexLatin700, unicodeRange: LATIN_RANGE },
  { family: "IBM Plex Sans", weight: 700, src: plexLatinExt700, unicodeRange: LATIN_EXT_RANGE },
];

/** Bloc `@font-face` prêt à poser — calculé UNE fois (les URI sont des constantes de build). */
export const LABEL_FONT_CSS = LabelHtml.fontFaceCss(LABEL_FONT_FACES);

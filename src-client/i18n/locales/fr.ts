/* ============================================================================
   Catalogue de traduction — FRANÇAIS (langue de RÉFÉRENCE).
   ----------------------------------------------------------------------------
   AGRÉGATEUR par DOMAINE : chaque domaine vit dans son propre fichier
   (`./fr/<domaine>.ts`, exporté `as const`) et est recomposé ici. Ce découpage
   évite un fichier monolithe à mesure que la migration i18n ajoute des centaines
   de clés par lot. Le CHEMIN d'import ne change pas : `I18n.ts` et le test
   (`dist-test/i18n/locales/fr.js`) importent toujours `./locales/fr`.

   POURQUOI un fichier .ts (et non .json) : le tsconfig n'active pas
   `resolveJsonModule`, et `as const` fige gratuitement le TYPE des clés —
   l'anglais (`en.ts`) doit calquer EXACTEMENT cette structure (garde-fou :
   `Tests/modules/test-i18n.js` compare récursivement les deux catalogues).

   RÈGLE : le FRANÇAIS est la source de vérité. Toute chaîne UI migrée est
   déplacée ICI (dans son domaine) telle quelle, puis traduite dans `en.ts` sous
   la MÊME clé. Voir docs/i18n.md pour la procédure d'ajout.

   Domaines : `tabs`/`interventions` (pilotes) ; `ui` (primitives réutilisables),
   `shell` (ossature/réglages), `app` (documents fichier/REST, boot), `graph`
   (vue Netmap) — lot B1 « chrome & primitives ». */
import { tabs } from "./fr/tabs";
import { interventions } from "./fr/interventions";
import { ui } from "./fr/ui";
import { shell } from "./fr/shell";
import { app } from "./fr/app";
import { graph } from "./fr/graph";

export const fr = { tabs, interventions, ui, shell, app, graph } as const;

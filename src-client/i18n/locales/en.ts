/* ============================================================================
   Catalogue de traduction — ANGLAIS.
   ----------------------------------------------------------------------------
   AGRÉGATEUR par DOMAINE (calque de `fr.ts`) : chaque domaine vit dans
   `./en/<domaine>.ts`. Le français reste la source de vérité : ne JAMAIS ajouter
   ici une clé absente de `fr.ts`. Le test `Tests/modules/test-i18n.js` échoue au
   moindre écart (clé manquante d'un côté ou de l'autre, valeur vide, feuille
   non-chaîne). Le CHEMIN d'import ne change pas (`./locales/en`). */
import { tabs } from "./en/tabs";
import { interventions } from "./en/interventions";
import { ui } from "./en/ui";
import { shell } from "./en/shell";
import { app } from "./en/app";
import { graph } from "./en/graph";

export const en = { tabs, interventions, ui, shell, app, graph } as const;

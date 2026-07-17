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
import { lists } from "./en/lists";
import { forms } from "./en/forms";
import { cable } from "./en/cable";
import { ipam } from "./en/ipam";
import { domain } from "./en/domain";
import { rack } from "./en/rack";
import { equipment } from "./en/equipment";
import { detail } from "./en/detail";
import { face } from "./en/face";
import { dc } from "./en/dc";

export const en = { tabs, interventions, ui, shell, app, graph, lists, forms, cable, ipam, domain, rack, equipment, detail, face, dc } as const;

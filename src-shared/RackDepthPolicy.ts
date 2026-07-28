/* ============================================================================
   POLITIQUE DE PROFONDEUR D'UNE BAIE — code PARTAGÉ front ⇄ back (TS pur).

   SOURCE UNIQUE de la façon dont on lit la profondeur d'une baie : profondeur
   extérieure, cage (entraxe des montants avant ↔ arrière), marges avant/arrière
   et cavités de portes creuses. C'est de ces cinq règles que dérivent, en aval,
   la place disponible pour un montage, l'espace partagé par deux montages dos à
   dos, la longueur d'un plateau d'étagère et le dessin des montants.

   POURQUOI CE MODULE EXISTE
   ---------------------------------------------------------------------------
   Ces règles étaient écrites DEUX FOIS — `RackGeometry` (rendu 2D/3D, formulaires)
   et la classe `RackDepth` de `src-shared/DataValidation.ts` (règles T2c / V6d) —
   et les deux **DIVERGEAIENT** (cf. `docs/placement.md` §6.14) :

     1. la validation BORNAIT la cage à la profondeur extérieure, le front NON :
        une baie déclarant une cage plus profonde que son propre châssis était
        DESSINÉE avec une cage qui en débordait, et sa longueur de plateau
        d'étagère pouvait dépasser ce que la validation autorise ;
     2. pour une cage strictement entre 0 et 1 mm, le front rendait 1, la
        validation 0.

   ARBITRAGE (§6.14) : la version BORNÉE l'emporte — une cage ne peut pas être
   plus profonde que le châssis qui la contient. Le plancher à 1 disparaît avec
   elle : une cage sub-millimétrique vaut 0, comme le dit déjà la validation.

   ⚠ CE QUI N'EST **PAS** ICI, ET POURQUOI. La marge de SÉCURITÉ derrière une
   porte (`RACK_DEPTH_SAFETY_MM`) n'est pas une lecture de la géométrie mais une
   RÈGLE DE PRUDENCE : la validation la retranche, le rendu ne la retranche pas
   (il dessine ce qui existe physiquement). Ce n'est donc pas une divergence, et
   elle reste chez chacun de ses deux consommateurs.

   ⚠ DEUX PATRONS COEXISTENT dans `DataValidation.ts`, et c'est VOULU. Ce module
   y est **IMPORTÉ directement** (l'auto-suffisance de `src-shared/` a été levée —
   cf. `CLAUDE.md`, section « Code partagé ») ; `TrayGeometry`, lui, continue d'y
   être **INJECTÉ** (`ValidationCollaborators`, avec garde-fou d'échec fermé). Le
   patron d'injection n'est plus une nécessité technique, il se défend sur son seul
   mérite de découplage — son retrait est un lot à part. Ne pas uniformiser à la
   volée : l'un se lit à l'import, l'autre au point d'appel.

   ⚠ IMPORT ENTRE FICHIERS PARTAGÉS : le spécificateur DOIT porter l'extension
   `.js` (`import { RackDepthPolicy } from "./RackDepthPolicy.js"`). NodeNext
   (serveur) l'exige ; l'omettre compile côté front et CASSE le build serveur.
   ============================================================================ */

/* ---- cote GÉNÉRALE de baie : IMPORTÉE de sa source unique (`RackConstants`). Elle était
   RÉPLIQUÉE ici, sous le même argument qu'en tête de `TrayGeometry` — « l'unifier reviendrait
   à migrer `domain/constants.ts` en entier ». C'était faux : cinq cotes suffisaient.
   RÉ-EXPORTÉE pour ne rien casser chez qui l'importait d'ici, et parce que la profondeur par
   défaut fait partie de la POLITIQUE que ce module publie. ---- */
export { RACK_DEPTH_DEFAULT_MM } from "./RackConstants.js";
import { RACK_DEPTH_DEFAULT_MM } from "./RackConstants.js";

export class RackDepthPolicy {
  /** Profondeur EXTÉRIEURE (mm) : celle du châssis. `0` et l'absence retombent sur le défaut —
      une baie de profondeur nulle n'a pas de sens et casserait toutes les cotes dérivées. */
  static outerDepth(rack: Record<string, any>): number {
    return rack.depth || RACK_DEPTH_DEFAULT_MM;
  }

  /** Profondeur de CAGE (entraxe des montants avant ↔ arrière, mm). Non déclarée ⇒ toute la
      profondeur extérieure.
      ⚠ BORNÉE à la profondeur extérieure : une cage ne peut pas être plus profonde que le châssis
      qui la contient. C'est l'arbitrage du lot (§6.14) — le front ne bornait pas et dessinait donc
      une cage débordant du châssis, alors que la validation, elle, la ramenait déjà. */
  static cage(rack: Record<string, any>): number {
    const d = RackDepthPolicy.outerDepth(rack);
    return (rack.cage_depth_mm > 0) ? Math.min(d, rack.cage_depth_mm | 0) : d;
  }

  /** Porte d'une face (`"front"` / `"rear"`), telle que l'enregistrement la porte — ou rien. */
  static door(rack: Record<string, any>, face: string): any {
    return (face === "rear") ? rack.door_rear : rack.door_front;
  }

  /** Profondeur utile SUPPLÉMENTAIRE apportée par la cavité d'une porte CREUSE (0 sinon) : un
      équipement peut dépasser du plan de montage jusque dans la porte. */
  static doorExtra(rack: Record<string, any>, face: string): number {
    const d = RackDepthPolicy.door(rack, face);
    return (d && d.enabled && d.hollow) ? Math.max(0, d.hollow_mm | 0) : 0;
  }

  /** La baie porte-t-elle AU MOINS une porte activée (avant ou arrière) ? */
  static hasDoor(rack: Record<string, any>): boolean {
    const f = RackDepthPolicy.door(rack, "front"), r = RackDepthPolicy.door(rack, "rear");
    return !!((f && f.enabled) || (r && r.enabled));
  }

  /** Marge AVANT (façade → montants avant, mm), BORNÉE pour que la cage tienne : ce qui reste
      derrière la cage ne peut pas être négatif. Saisie vide ou absente ⇒ 0. */
  static frontMargin(rack: Record<string, any>): number {
    const d = RackDepthPolicy.outerDepth(rack);
    const fm = (rack.front_margin_mm != null && rack.front_margin_mm !== "") ? Math.max(0, rack.front_margin_mm | 0) : 0;
    return Math.min(fm, Math.max(0, d - RackDepthPolicy.cage(rack)));
  }

  /** Marge ARRIÈRE (montants arrière → face arrière, mm) = ce que la cage et la marge avant
      laissent. Elle n'est jamais saisie : elle se DÉDUIT, d'où l'absence de champ. */
  static rearMargin(rack: Record<string, any>): number {
    const d = RackDepthPolicy.outerDepth(rack);
    return Math.max(0, d - RackDepthPolicy.cage(rack) - RackDepthPolicy.frontMargin(rack));
  }
}

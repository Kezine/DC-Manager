/* =============================================================================
   PortCompatibility — « ces deux ports peuvent-ils être reliés, et si non,
   POURQUOI exactement ? »

   Classe PURE : aucun DOM, aucun store, aucun modèle. Elle ne prend que deux
   descriptions de type de port (famille + connecteur) et rend un VERDICT en
   codes — jamais une phrase (patron `PowerAnalysis`/`RouteEligibility`) : la
   traduction se fait AU RENDU. Un module pur qui produirait du français serait
   intraduisible et intestable.

   ---------------------------------------------------------------------------
   CE QUE CE MODULE NE CHANGE PAS. La règle de compatibilité de l'application
   reste « MÊME FAMILLE, sinon rien » (`Store.cableCompatible`), et un câble dont
   les bouts diffèrent reste BLOQUÉ EN BROUILLON — décision utilisateur du
   2026-09-02, prise contre la recommandation « passer après confirmation ». Ce
   module n'assouplit RIEN : il ne sert qu'à DIRE pourquoi, et à le dire au bon
   moment.

   ---------------------------------------------------------------------------
   POURQUOI IL EXISTE (retour terrain T3). « On sait connecter du FC sur du
   SFP28, physiquement possible mais logiquement aberrant, au moins afficher un
   warning. » Deux constats mesurés derrière cette phrase :

   1. **L'app ne lisait QUE la famille.** Un type de port porte pourtant DEUX
      clés distinctes depuis toujours : `family` (compatibilité du signal) et
      `connector` (le connecteur physique). Le catalogue livré le montre —
      « FC 32G » a `family: "FC"` et `connector: "SFP28"` : **même cage, signal
      incompatible**. `connector` ne servait qu'à la taille 3D. L'information
      qui permet de distinguer « ça ne rentre même pas » de « ça rentre mais ça
      n'a aucun sens » était donc dans les données depuis le début, jamais lue.

   2. **Le refus était SILENCIEUX et DIFFÉRÉ.** L'outil de traçage de route
      accepte n'importe quels deux ports ; le câble créé se retrouve ensuite
      figé en brouillon (`cableIsComplete` → `cableMaxStatus`) sans que personne
      n'ait jamais dit pourquoi au moment du geste. L'utilisateur découvrait un
      câble « qui ne veut pas sortir de brouillon ».

   ⚠ LE CONNECTEUR NE SERT QU'À FORMULER, JAMAIS À REFUSER. C'est une propriété
   VOULUE, et c'est ce qui rend ce module sûr sur des données réelles : les
   types de port sont saisis à la main, leur `connector` peut être vide,
   approximatif ou fantaisiste. Un verdict qui s'en servirait pour REFUSER
   ferait échouer des câblages légitimes sur une donnée cosmétique. Ici, le
   verdict « refuse-t-on ? » ne dépend QUE de la famille (exactement comme
   avant) ; le connecteur ne fait que choisir entre deux LIBELLÉS. Une donnée
   fausse dégrade donc le message, jamais le comportement.

   ⚠ LA COMPARAISON EST INSENSIBLE À LA CASSE ET AUX ESPACES DE BORD, pour la
   même raison : « SFP28 », « sfp28 » et « SFP28 » saisis à la main désignent le
   même connecteur, et personne ne veut d'un message qui change selon la frappe.
   La FAMILLE, elle, est comparée telle quelle — c'est une clé d'appariement du
   modèle, comparée à l'identique partout ailleurs dans l'app (`Store`,
   `CableForms`) ; la normaliser ICI et pas là-bas créerait deux règles.
   ============================================================================= */

/** Verdict d'appariement de deux ports. Codes — la traduction se fait au rendu. */
export type PortCompatVerdict =
  /** Mêmes familles : appariement normal. */
  | "ok"
  /** Familles différentes, MÊME connecteur physique : ça se branche, ça n'a pas de sens
      (ex. FC 32G dans une cage SFP28). Refusé comme le reste — mais c'est le cas qu'il faut
      NOMMER, sans quoi l'utilisateur ne comprend pas pourquoi son câble reste en brouillon. */
  | "aberrant"
  /** Familles ET connecteurs différents : les deux bouts ne se rencontrent même pas physiquement. */
  | "impossible"
  /** Au moins un port sans type : on ne juge pas (et on ne prétend pas juger). */
  | "unknown";

/** Description MINIMALE d'un type de port — le strict nécessaire au verdict.
    Interface étroite VOLONTAIRE : elle documente la dépendance exacte au modèle et permet
    de tester le module sans construire un `PortType` complet. */
export interface PortTypeShape {
  family?: string | null;
  connector?: string | null;
}

/** Verdict complet : le code + de quoi rédiger le message chez l'appelant. */
export interface PortCompatResult {
  verdict: PortCompatVerdict;
  /** Familles des deux ports, telles quelles (vides si type inconnu). */
  familyA: string;
  familyB: string;
  /** Connecteurs des deux ports, tels quels. */
  connectorA: string;
  connectorB: string;
}

export class PortCompatibility {
  /** Connecteur EFFECTIF d'un type : `connector` s'il est renseigné, sinon la famille —
      c'est déjà la règle du modèle (`PortType` : « défaut = `family` »), reprise ici pour ne
      pas juger « connecteurs différents » sur un champ simplement laissé vide. */
  static connectorOf(type: PortTypeShape | null | undefined): string {
    if (!type) return "";
    const c = (type.connector || "").trim();
    return c || (type.family || "").trim();
  }

  /** Famille d'un type (vide si absente). */
  static familyOf(type: PortTypeShape | null | undefined): string {
    return type ? (type.family || "").trim() : "";
  }

  /** Deux connecteurs désignent-ils la même cage ? Comparaison insensible à la casse
      (cf. l'en-tête : ces valeurs sont saisies à la main). Deux connecteurs INCONNUS ne
      sont jamais « les mêmes » — on ne déduit rien d'une absence. */
  static sameConnector(a: string, b: string): boolean {
    const x = (a || "").trim().toLowerCase(), y = (b || "").trim().toLowerCase();
    return !!x && !!y && x === y;
  }

  /** LE verdict. `null`/type manquant d'un côté ⇒ `unknown` : on ne juge pas ce qu'on ne sait pas. */
  static compare(typeA: PortTypeShape | null | undefined, typeB: PortTypeShape | null | undefined): PortCompatResult {
    const familyA = PortCompatibility.familyOf(typeA), familyB = PortCompatibility.familyOf(typeB);
    const connectorA = PortCompatibility.connectorOf(typeA), connectorB = PortCompatibility.connectorOf(typeB);
    const base = { familyA, familyB, connectorA, connectorB };
    if (!familyA || !familyB) return Object.assign({ verdict: "unknown" as const }, base);
    if (familyA === familyB) return Object.assign({ verdict: "ok" as const }, base);
    // Familles différentes : le REFUS est déjà acquis (règle inchangée). Le connecteur ne
    // départage plus que le LIBELLÉ — cf. l'avertissement de l'en-tête.
    return Object.assign(
      { verdict: (PortCompatibility.sameConnector(connectorA, connectorB) ? "aberrant" : "impossible") as PortCompatVerdict },
      base,
    );
  }

  /** Cet appariement empêche-t-il le câble d'être complet ? VRAI pour `aberrant` comme pour
      `impossible` — c'est la décision utilisateur du 2026-09-02 (« bloqué brouillon ») ;
      FAUX pour `unknown`, où l'incomplétude vient d'ailleurs (un port sans type).

      ⚠ Ce prédicat DÉCRIT `Store.cableCompatible`, il ne le remplace pas : la règle d'écriture
      reste chez le Store, qui compare aussi la famille du CÂBLE. Le jour où l'on voudrait
      assouplir (confirmation explicite plutôt que blocage), c'est ICI que la décision se
      relit — et le test qui suit ce prédicat dira exactement ce qui change. */
  static blocks(verdict: PortCompatVerdict): boolean {
    return verdict === "aberrant" || verdict === "impossible";
  }
}

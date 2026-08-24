/* ============================================================================
   CARTFAMILIES — carte PURE « collection → FAMILLE de panier », source UNIQUE de
   l'invariant « un panier ne porte qu'UNE famille à la fois »
   (cf. docs/panier.md, cadrage du 2026-08-24, décision P1).

   POURQUOI une famille plutôt que la collection : deux collections peuvent
   partager la MÊME anatomie d'action, et doivent alors cohabiter dans le panier.
   C'est le cas des câbles et des faisceaux — `LabelPrintPolicy.isFlagKind()` les
   déclare déjà STRICTEMENT équivalents (mêmes contenus, formats, champs et
   défauts d'étiquette) : la famille `links` ne fait que NOMMER cette classe
   d'équivalence, elle n'en invente aucune.

   Le découpage est celui de l'anatomie RÉELLE, pas d'un regroupement de confort
   (décision P1, option A) : deux collections se retrouvent dans la même famille
   quand la politique d'impression ne SAIT PAS les distinguer (`isFlagKind`,
   `isSpareLike`), jamais parce qu'elles se ressemblent de loin. Équipements et
   baies diffèrent vraiment (formats offerts, champs offerts, gabarit par
   défaut) : chacun sa famille, et les élargir demanderait d'INTERSECTER leurs
   offres — ce que rien ne réclame.

   Une collection ABSENTE de la carte n'a pas de famille : elle n'entre pas au
   panier. C'est volontaire (décision P1 bis) — une collection y entre le jour où
   au moins une action groupée l'accepte, jamais avant : offrir le geste sans
   l'issue serait un mensonge d'interface.
   ============================================================================ */

/** Familles de panier — une par classe d'équivalence d'anatomie d'action. */
export type CartFamily = "links" | "equipments" | "racks" | "components";

/** LA carte. Donnée pure (principe n°2 : les données restent de simples exports).

    `components` réunit spares et sous-équipements pour la MÊME raison que `links` réunit
    câbles et faisceaux : `LabelPrintPolicy.isSpareLike()` les déclare équivalents (mêmes
    contenus, mêmes formats, mêmes champs offerts, même gabarit par défaut). Ce qui les
    distingue — stock vs installé — ne change pas la FORME de l'étiquette, et c'est la forme
    qui décide ici. Étiqueter d'un coup un bac de disques dont certains sont montés et
    d'autres en réserve est d'ailleurs le geste naturel. */
const COLLECTION_FAMILY: Readonly<Record<string, CartFamily>> = {
  cables: "links",
  cableBundles: "links",
  equipments: "equipments",
  racks: "racks",
  subEquipments: "components",
  spares: "components",
};

export class CartFamilies {
  /** Famille d'une collection, ou `null` si elle n'entre pas au panier. */
  static of(collection: string): CartFamily | null {
    return COLLECTION_FAMILY[collection] || null;
  }

  /** Collections d'une famille (ordre de la carte) — sert aux libellés et aux tests. */
  static collectionsOf(family: CartFamily): string[] {
    return Object.keys(COLLECTION_FAMILY).filter((c) => COLLECTION_FAMILY[c] === family);
  }

  /** Deux collections peuvent-elles cohabiter dans le MÊME panier ? */
  static compatible(a: string, b: string): boolean {
    const familyOfA = CartFamilies.of(a);
    return !!familyOfA && familyOfA === CartFamilies.of(b);
  }
}

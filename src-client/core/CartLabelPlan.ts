/* ============================================================================
   CARTLABELPLAN — ce qu'IMPRIMER UN PANIER veut dire, par famille (cf.
   docs/panier.md § « L'action imprimer les étiquettes »). Module PUR : il ne
   connaît ni le Store, ni le DOM, ni les enregistrements — seulement la règle.

   POURQUOI UN MODULE : deux décisions cohabitent dans l'action d'impression, et
   toutes deux sont des règles MÉTIER qui doivent être écrites une seule fois
   (principe n°3) et vérifiables en isolation (principe n°7) :

     1. **Quel sujet de politique** (`LabelPrintKind`) pour la famille. La modale
        n'en accepte qu'UN pour toute la planche — ce qui ne pose aucun problème
        puisqu'une famille est précisément un ensemble de collections que
        `LabelPrintPolicy` traite à l'identique (`isFlagKind`, `isSpareLike`).
     2. **Combien d'étiquettes par élément.** Un lien s'étiquette PAR PAIRE (un
        drapeau à chaque bout, décision P9, en parité avec la fiche et l'action
        de ligne) ; tout le reste s'étiquette une fois.

   Une famille ABSENTE d'ici n'a pas d'action d'impression : `main.ts` ne la
   déclare alors pas dans `CartPanel.setup({ families })`, et ses listings ne
   posent aucune case. Ajouter une famille au panier = ajouter une entrée ICI et
   son constructeur de sujet — rien d'autre.
   ============================================================================ */

import type { CartFamily } from "./CartFamilies";
import type { LabelPrintKind } from "./LabelPrintPolicy";

/** Plan d'impression d'une famille — consommé tel quel par le câblage de `main.ts`. */
export interface CartLabelPlan {
  /** Sujet de politique de la planche entière (cf. `LabelPrintPolicy`). */
  kind: LabelPrintKind;
  /** Étiquettes tirées PAR élément du panier (2 = les deux extrémités d'un lien). */
  labelsPerItem: number;
}

const PLANS: Readonly<Record<string, CartLabelPlan>> = {
  // `cable` vaut pour toute la famille : `isFlagKind` met câble et faisceau sur le même plan.
  links: { kind: "cable", labelsPerItem: 2 },
  // `spare` vaut pour toute la famille : `isSpareLike` met spare et sous-équipement sur le même plan.
  components: { kind: "spare", labelsPerItem: 1 },
};

export class CartLabelPlans {
  /** Plan d'une famille, ou `null` si elle n'a pas d'action d'impression. */
  static of(family: CartFamily): CartLabelPlan | null {
    return PLANS[family] || null;
  }

  /** Familles imprimables — l'argument `families` de `CartPanel.setup`, dérivé plutôt
      que recopié (une liste tenue à la main finirait par diverger de cette table). */
  static families(): CartFamily[] {
    return Object.keys(PLANS) as CartFamily[];
  }
}

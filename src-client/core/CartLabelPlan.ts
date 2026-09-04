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
     2. **Comment le lot se DÉVELOPPE en étiquettes.** Un lien s'étiquette PAR
        PAIRE (un drapeau à chaque bout, décision P9, en parité avec la fiche et
        l'action de ligne) ; tout le reste s'étiquette une fois.
        🚨 T11 : ce n'est plus un NOMBRE que le panier applique lui-même
        (`labelsPerItem`, qui poussait deux fois le même sujet dans la modale),
        mais le DÉFAUT d'une bascule que la modale offre — A / B / A+B. Le
        panier passe donc UN sujet par élément et c'est `LabelPrintPolicy.expand`
        qui multiplie : la volumétrie redevient réglable après coup, et la modale
        peut MARQUER quel drapeau va sur quel bout (ce qu'un doublon ne permettait
        pas). Une famille sans bascule (petit matériel, équipements) n'en déclare
        simplement pas.

   Une famille ABSENTE d'ici n'a pas d'action d'impression : `main.ts` ne la
   déclare alors pas dans `CartPanel.setup({ families })`, et ses listings ne
   posent aucune case. Ajouter une famille au panier = ajouter une entrée ICI et
   son constructeur de sujet — rien d'autre.
   ============================================================================ */

import type { CartFamily } from "./CartFamilies";
import type { LabelPrintKind, LabelEndsMode } from "./LabelPrintPolicy";

/** Plan d'impression d'une famille — consommé tel quel par le câblage de `main.ts`. */
export interface CartLabelPlan {
  /** Sujet de politique de la planche entière (cf. `LabelPrintPolicy`). */
  kind: LabelPrintKind;
  /** DÉFAUT de la bascule d'extrémités de la modale (T11) — `ab` pour ce qui a deux bouts.
      Absent = la famille n'a pas d'extrémités, la bascule n'y sera même pas offerte. */
  defaultEndsMode?: LabelEndsMode;
}

const PLANS: Readonly<Record<string, CartLabelPlan>> = {
  // `cable` vaut pour toute la famille : `isFlagKind` met câble et faisceau sur le même plan.
  // Un lien s'étiquette par PAIRE : la bascule part donc sur « A + B » (décision P9, T11).
  links: { kind: "cable", defaultEndsMode: "ab" },
  // `spare` vaut pour toute la famille : `isSpareLike` met spare et sous-équipement sur le même plan.
  components: { kind: "spare" },
  // Les équipements ont leur propre anatomie (baie · U, famille + marque/modèle, série, ET
  // propriétaire — le seul sujet qui en porte un), donc leur propre famille et leur propre plan.
  equipments: { kind: "equipment" },
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

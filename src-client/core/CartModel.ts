/* ============================================================================
   CARTMODEL — l'ÉTAT PUR du panier d'actions groupées (cf. docs/panier.md,
   cadrage du 2026-08-24). Aucun DOM, aucun Store, aucun stockage : cette classe
   ne sait qu'ajouter, retirer et faire respecter l'invariant de famille. La
   persistance et l'affichage vivent dans `ui/CartPanel` ; la carte des familles
   dans `core/CartFamilies` (principe n°2 — une responsabilité, un fichier).

   CE QU'ON STOCKE (décision P3) : `{ collection, id, label }`. Le `label` est un
   SECOURS d'affichage — il permet de montrer le panier sans réhydrater une
   collection paginée. Il n'est JAMAIS la vérité : au moment d'agir, l'appelant
   relit chaque enregistrement dans le Store, et ceux qui ont disparu entre-temps
   (suppression par un autre client, SSE) sont exclus et SIGNALÉS, jamais cause
   d'un échec global.

   INVARIANT DE FAMILLE : le panier ne porte qu'une famille à la fois. `add` ne
   décide RIEN à la place de l'utilisateur quand la famille diverge — il rend le
   verdict `conflict` et laisse l'UI proposer le remplacement (décision P6). Le
   remplacement lui-même est explicite : `replaceWith`.

   PLAFOND : `MAX`. Le cadrage a tranché 200, mais l'impression tire aujourd'hui
   UN appel réseau par étiquette unique, sans bridage de concurrence (dette P8) —
   la V1-Beta se tient donc volontairement à 50, le temps que le pool existe.
   Monter la constante ensuite suffit : elle est le SEUL endroit qui la porte.
   ============================================================================ */

import { CartFamilies, type CartFamily } from "./CartFamilies";

/** Un élément du panier — identité + libellé de secours (cf. en-tête). */
export interface CartItem {
  collection: string;
  id: string;
  label: string;
}

/** Verdict d'un ajout — l'UI en tire son message ET, pour `conflict`, sa proposition. */
export type CartAddResult =
  /** Ajouté. */
  | "added"
  /** Déjà présent : rien n'a bougé (l'ajout est idempotent). */
  | "already"
  /** Collection hors panier (aucune famille — cf. CartFamilies). */
  | "unsupported"
  /** Autre famille que celle du panier : à l'UI de proposer le remplacement. */
  | "conflict"
  /** Plafond atteint. */
  | "full";

/** Forme PERSISTÉE (et donc reçue d'un stockage potentiellement corrompu). */
export interface CartSnapshot {
  items: CartItem[];
}

export class CartModel {
  /** Plafond d'éléments — cf. en-tête (200 au cadrage, 50 tant que P8 n'est pas fait). */
  static readonly MAX = 50;

  private items: CartItem[] = [];

  /** Clé d'identité d'un élément — `collection:id`, la collection faisant partie de l'identité. */
  private static keyOf(collection: string, id: string): string { return collection + ":" + id; }

  /** Famille courante du panier, `null` s'il est vide (il accepte alors n'importe laquelle). */
  family(): CartFamily | null {
    return this.items.length ? CartFamilies.of(this.items[0].collection) : null;
  }

  size(): number { return this.items.length; }
  isEmpty(): boolean { return this.items.length === 0; }

  /** Copie de la liste, dans l'ORDRE D'AJOUT (l'ordre du panier = l'ordre de la planche). */
  all(): CartItem[] { return this.items.slice(); }

  has(collection: string, id: string): boolean {
    const key = CartModel.keyOf(collection, id);
    return this.items.some((it) => CartModel.keyOf(it.collection, it.id) === key);
  }

  /** Le panier accepterait-il cette collection EN L'ÉTAT (sans remplacement) ? */
  accepts(collection: string): boolean {
    if (!CartFamilies.of(collection)) return false;
    return this.isEmpty() || CartFamilies.compatible(this.items[0].collection, collection);
  }

  /** Ajoute — sans jamais vider le panier de sa propre initiative (cf. `conflict`). */
  add(item: CartItem): CartAddResult {
    if (!CartFamilies.of(item.collection)) return "unsupported";
    if (this.has(item.collection, item.id)) return "already";
    if (!this.accepts(item.collection)) return "conflict";
    if (this.items.length >= CartModel.MAX) return "full";
    this.items.push({ collection: item.collection, id: item.id, label: item.label || "" });
    return "added";
  }

  /** Vide le panier PUIS ajoute — le geste explicite derrière le dialogue de remplacement. */
  replaceWith(item: CartItem): CartAddResult {
    this.clear();
    return this.add(item);
  }

  /** Retire un élément. Rend vrai s'il y était. */
  remove(collection: string, id: string): boolean {
    const key = CartModel.keyOf(collection, id);
    const before = this.items.length;
    this.items = this.items.filter((it) => CartModel.keyOf(it.collection, it.id) !== key);
    return this.items.length !== before;
  }

  clear(): void { this.items = []; }

  toJSON(): CartSnapshot { return { items: this.all() }; }

  /** Relecture TOLÉRANTE d'un stockage : tout ce qui n'est pas un élément valide est ignoré,
      et l'invariant de famille est re-imposé (un stockage bricolé à la main ne doit pas
      pouvoir installer un panier que l'UI ne saurait plus représenter). */
  static fromJSON(raw: any): CartModel {
    const model = new CartModel();
    const items = raw && Array.isArray(raw.items) ? raw.items : [];
    for (const candidate of items) {
      if (!candidate || typeof candidate.collection !== "string" || typeof candidate.id !== "string") continue;
      model.add({ collection: candidate.collection, id: candidate.id, label: String(candidate.label || "") });
    }
    return model;
  }
}

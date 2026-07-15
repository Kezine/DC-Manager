/** Élément de catalogue libellable. */
export interface Labelled { id: string; label: string; }
/** Repli : valeur littérale, ou fonction (v) => string. */
export type LabelFallback = string | ((v: any) => string);

/* Fabrique de résolveurs de libellé sur un catalogue [{id,label}…].
   Remplace la fonction libre `makeLabeler` par une méthode statique (le résolveur
   renvoyé reste une fermeture — c'est la VALEUR produite, pas une fonction « nue »
   posée à plat dans un fichier). */
export class Labeler {
  /** v → label de l'entrée dont id === v, sinon `fallback` (défaut ""). */
  static make(list: Labelled[], fallback?: LabelFallback): (v: any) => string {
    return (v) => {
      const e = list.find((x) => x.id === v);
      if (e) return e.label;
      return typeof fallback === "function" ? fallback(v) : (fallback != null ? fallback : "");
    };
  }
}

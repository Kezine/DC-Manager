/** Primitives DOM partagées (création d'éléments SVG/HTML). */
export class Dom {
  static readonly SVGNS = "http://www.w3.org/2000/svg";

  /** Crée un élément SVG `tag` avec un dictionnaire d'attributs. */
  static svg(tag: string, attrs?: Record<string, any>): SVGElement {
    const e = document.createElementNS(Dom.SVGNS, tag) as SVGElement;
    if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  }
}

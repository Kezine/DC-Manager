/** Primitives DOM partagées (création d'éléments SVG/HTML). */
export class Dom {
  static readonly SVGNS = "http://www.w3.org/2000/svg";

  /** Crée un élément SVG `tag` avec un dictionnaire d'attributs. */
  static svg(tag: string, attrs?: Record<string, any>): SVGElement {
    const e = document.createElementNS(Dom.SVGNS, tag) as SVGElement;
    if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  }

  /** Parse un fragment de markup SVG (icône) en nœuds SVG réutilisables. */
  static parseSvgIcon(inner: string): DocumentFragment | null {
    if (!inner) return null;
    const doc = new DOMParser().parseFromString('<svg xmlns="' + Dom.SVGNS + '">' + inner + "</svg>", "image/svg+xml");
    if (doc.querySelector("parsererror")) return null;
    const frag = document.createDocumentFragment();
    Array.from(doc.documentElement.childNodes).forEach((n) => frag.appendChild(document.importNode(n, true)));
    return frag;
  }
}

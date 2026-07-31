/* =============================================================================
   DragList — GLISSER-DÉPOSER d'une liste VERTICALE à POIGNÉE, primitive
   RÉUTILISABLE (principe n°2 : classe + options injectées, aucun import de vue).

   Née pour l'éditeur de route en chaîne (`views/forms/RouteChainEditor`,
   maquette route-editor §05), mais AGNOSTIQUE : elle reçoit un conteneur, deux
   sélecteurs (ligne, poignée) et une dépose `onReorder(from, to)` — elle ne
   connaît ni la route, ni le brouillon, ni la validation. L'hôte recalcule ce
   qu'il veut au relâché (bandeaux, numéros, validation) : ici on ne fait que
   suivre le doigt.

   COMPORTEMENT (spec = maquette §05) :
     - la saisie ne part que de la POIGNÉE (le reste de la ligne garde ses clics
       — boutons ↑ ↓ ×, liens) et ne s'ACTIVE qu'après un petit seuil de
       déplacement (un tap ou un clic hésitant ne déclenchent rien) ;
     - pendant le glisser : curseur `grabbing` (classe sur <body> — le pointeur
       est CAPTURÉ par la poignée, le curseur doit valoir partout), ligne
       d'ORIGINE atténuée (`.dl-origin`, ~40 %), PLACEHOLDER pointillé accent
       (`.dl-placeholder`) à la position de dépôt ;
     - au relâché : nettoyage puis `onReorder(from, to)` si la position a changé
       — JAMAIS de mutation du DOM des lignes ici, l'hôte repeint.

   POINTER EVENTS (souris + tactile d'un seul tenant) : la poignée capture le
   pointeur (`setPointerCapture`), donc tous les move/up lui parviennent même
   hors de la liste. ⚠ Sur TACTILE, la poignée doit porter `touch-action: none`
   en CSS (cf. `.rc-grip`) — sans quoi le navigateur confisque le geste pour
   faire DÉFILER et coupe les pointermove.

   ACCESSIBILITÉ : le glisser-déposer est un CONFORT, pas la voie d'accès — le
   réordonnancement clavier reste l'affaire de l'hôte (boutons ↑/↓ nommés). La
   poignée est donc `aria-hidden` chez le consommateur.

   MOUVEMENT RÉDUIT : le composant n'ANIME rien par lui-même (le placeholder
   apparaît/disparaît sans transition) ; les transitions d'accompagnement vivent
   dans le CSS, sous `@media (prefers-reduced-motion: no-preference)`.

   CYCLE DE VIE : l'unique écouteur au repos est DÉLÉGUÉ sur `list` — une
   instance meurt avec le DOM qu'elle sert (cas RouteChainEditor, repeint à
   chaque mutation), sans rien à désabonner. `dispose()` existe pour les hôtes à
   liste LONGUE VIE qui rebranchent un autre mécanisme.
   ============================================================================= */

export interface DragListOptions {
  /** Conteneur des lignes — l'écouteur `pointerdown` y est DÉLÉGUÉ (une instance par rendu suffit). */
  list: HTMLElement;
  /** Sélecteur des LIGNES déplaçables. Ordre DOM = ordre visuel = indices de `onReorder`. */
  itemSelector: string;
  /** Sélecteur de la POIGNÉE (descendant d'une ligne) — SEUL point de saisie. */
  handleSelector: string;
  /** Dépose : la ligne d'index `from` doit occuper l'index `to` (indices dans la liste des lignes,
      `to` = position APRÈS déplacement). Jamais appelée quand rien ne change. */
  onReorder: (from: number, to: number) => void;
}

/** État d'un glisser en cours (null au repos). */
interface DragState {
  pointerId: number;
  handle: HTMLElement;
  item: HTMLElement;
  from: number;
  startY: number;
  /** Vrai une fois le seuil d'activation franchi (avant : simple clic potentiel, rien à montrer). */
  active: boolean;
  placeholder: HTMLElement;
  /** Dernier emplacement de dépôt calculé (= `from` tant qu'on n'a pas bougé). */
  to: number;
}

export class DragList {
  /** Seuil d'ACTIVATION (px) : en deçà, le geste reste un clic — pas de fantôme qui clignote. */
  private static readonly ACTIVATION_PX = 4;

  private drag: DragState | null = null;

  constructor(private readonly opts: DragListOptions) {
    opts.list.addEventListener("pointerdown", this.onDown);
  }

  /** Désabonne l'écouteur délégué (hôtes à liste longue vie uniquement — cf. en-tête). */
  dispose(): void {
    this.opts.list.removeEventListener("pointerdown", this.onDown);
    this.cleanup();
  }

  /** EMPLACEMENT DE DÉPOT : nombre de milieux de ligne (Y croissant vers le bas) situés AU-DESSUS du
      pointeur — les milieux sont ceux des lignes SANS la ligne saisie, l'emplacement est donc aussi
      l'index final (`to`) de la dépose. Seule décision GÉOMÉTRIQUE du composant, pure et testée
      (Tests/modules/test-ui-draglist.js) ; le reste n'est que du DOM. */
  static slotFor(midpoints: readonly number[], pointerY: number): number {
    let slot = 0;
    for (const midpoint of midpoints) { if (pointerY > midpoint) slot++; }
    return slot;
  }

  /** Les lignes déplaçables, dans l'ordre DOM (relues à chaque geste : l'hôte a pu repeindre). */
  private items(): HTMLElement[] {
    return Array.from(this.opts.list.querySelectorAll<HTMLElement>(this.opts.itemSelector));
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (this.drag) return;
    // Souris : bouton principal uniquement (un clic droit sur la poignée ne saisit rien).
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    const handle = target ? (target.closest(this.opts.handleSelector) as HTMLElement | null) : null;
    if (!handle || !this.opts.list.contains(handle)) return;
    const item = handle.closest(this.opts.itemSelector) as HTMLElement | null;
    if (!item) return;
    const items = this.items();
    const from = items.indexOf(item);
    if (from < 0 || items.length < 2) return;   // seul dans la liste : rien à réordonner

    // Empêche la sélection de texte (souris) — le défilement tactile, lui, est neutralisé par le
    // `touch-action: none` CSS de la poignée (un preventDefault ici ne suffirait pas partout).
    e.preventDefault();
    // Capture : les move/up parviennent à la poignée même quand le doigt sort de la liste.
    if (handle.setPointerCapture) { try { handle.setPointerCapture(e.pointerId); } catch (_) { /* pointeur déjà parti */ } }

    const placeholder = document.createElement("div");
    placeholder.className = "dl-placeholder";
    // La hauteur du placeholder = celle de la ligne saisie : le trou « fait la place » exacte.
    placeholder.style.height = item.getBoundingClientRect().height + "px";

    this.drag = { pointerId: e.pointerId, handle, item, from, startY: e.clientY, active: false, placeholder, to: from };
    handle.addEventListener("pointermove", this.onMove);
    handle.addEventListener("pointerup", this.onUp);
    handle.addEventListener("pointercancel", this.onCancel);
  };

  private readonly onMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < DragList.ACTIVATION_PX) return;
      drag.active = true;
      drag.item.classList.add("dl-origin");
      document.body.classList.add("dl-grabbing");
    }
    // Milieux mesurés EN DIRECT (le placeholder décale les lignes — le décalage fait hystérésis :
    // franchir un milieu pousse la ligne d'une hauteur de placeholder, pas d'oscillation).
    const others = this.items().filter((el) => el !== drag.item);
    const midpoints = others.map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const slot = DragList.slotFor(midpoints, e.clientY);
    drag.to = slot;
    if (slot === drag.from) {
      // Dépôt = position d'origine : la ligne atténuée montre déjà l'emplacement, pas de trou en plus.
      drag.placeholder.remove();
      return;
    }
    const before = slot < others.length ? others[slot] : null;
    if (before) before.parentElement?.insertBefore(drag.placeholder, before);
    else others[others.length - 1]?.after(drag.placeholder);
  };

  private readonly onUp = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = drag.active && drag.to !== drag.from;
    const from = drag.from, to = drag.to;
    this.cleanup();
    // La dépose part APRÈS le nettoyage : `onReorder` repeint généralement la liste (l'hôte), et le
    // nettoyage sur un DOM déjà remplacé ne retirerait rien.
    if (moved) this.opts.onReorder(from, to);
  };

  private readonly onCancel = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointerId) this.cleanup();
  };

  private cleanup(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.handle.removeEventListener("pointermove", this.onMove);
    drag.handle.removeEventListener("pointerup", this.onUp);
    drag.handle.removeEventListener("pointercancel", this.onCancel);
    drag.placeholder.remove();
    drag.item.classList.remove("dl-origin");
    document.body.classList.remove("dl-grabbing");
  }
}

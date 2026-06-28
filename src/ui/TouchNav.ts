/* Navigation TACTILE réutilisable pour une scène à transform pan/zoom (vues 2D SVG : Plan de salle, Plan d'étage,
   Netmap). Mapping : 1 doigt glissé = PAN · 2 doigts = PINCH-ZOOM (+ pan du centroïde). La vue 3D WebGL a sa
   propre gestion (orbite), cf. DcThreeCamera.

   RÈGLE « clic seulement à un seul doigt » : on NE preventDefault QUE lorsqu'un vrai geste de navigation démarre
   (glisser franc d'1 doigt depuis le FOND, ou 2 doigts). Un simple TAP d'1 doigt n'est pas intercepté → le
   navigateur synthétise alors les events souris de compatibilité (mousedown/up/click) APRÈS le touchend, et les
   handlers existants (sélection de baie/équipement/nœud) s'exécutent normalement. À 2 doigts (ou dès qu'un geste
   est en cours), on preventDefault → AUCUN clic synthétisé n'est émis. Le clic ne peut donc se produire qu'avec un
   seul doigt et sans déplacement. */
export interface TouchNavCallbacks {
  /** Translation incrémentale (pixels écran) depuis le dernier événement. */
  panBy(dx: number, dy: number): void;
  /** Zoom autour du point écran (clientX, clientY). `factor` > 1 = avant, < 1 = arrière. */
  zoomAt(factor: number, clientX: number, clientY: number): void;
  panStart?(): void;
  panEnd?(): void;
}

export class TouchNav {
  /** Seuil (px) au-delà duquel un glissé d'1 doigt devient une navigation (et non un tap). */
  private static readonly MOVE_THRESHOLD = 6;

  /** Branche la navigation tactile sur `el` (typiquement le `<svg>` de la scène). */
  static attach(el: Element, cb: TouchNavCallbacks): void {
    let mode: "none" | "pan" | "pinch" = "none";
    let lastX = 0, lastY = 0, lastDist = 0, navigating = false;

    const centroid = (t: TouchList): { x: number; y: number } => {
      const n = Math.min(2, t.length); let x = 0, y = 0;
      for (let i = 0; i < n; i++) { x += t[i].clientX; y += t[i].clientY; }
      return { x: x / n, y: y / n };
    };
    const spread = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    el.addEventListener("touchstart", (e: Event) => {
      const ev = e as TouchEvent;
      if (ev.touches.length >= 2) {                          // 2 doigts → pinch (jamais de clic)
        mode = "pinch"; const c = centroid(ev.touches); lastX = c.x; lastY = c.y; lastDist = spread(ev.touches);
        if (!navigating) { navigating = true; cb.panStart?.(); }
        ev.preventDefault();
      } else if (ev.touches.length === 1 && ev.target === el) {   // 1 doigt SUR LE FOND → pan potentiel
        mode = "pan"; const t = ev.touches[0]; lastX = t.clientX; lastY = t.clientY; navigating = false;
      } else {
        mode = "none";                                        // 1 doigt sur un élément → laissé aux events souris (tap/drag)
      }
    }, { passive: false });

    el.addEventListener("touchmove", (e: Event) => {
      const ev = e as TouchEvent;
      if (mode === "pinch") {
        if (ev.touches.length < 2) { const t = ev.touches[0]; if (t) { lastX = t.clientX; lastY = t.clientY; } return; }
        const c = centroid(ev.touches), d = spread(ev.touches);
        if (lastDist > 0 && d > 0) { const f = d / lastDist; if (Math.abs(f - 1) > 0.002) cb.zoomAt(f, c.x, c.y); }
        cb.panBy(c.x - lastX, c.y - lastY);                   // pan simultané (centroïde)
        lastX = c.x; lastY = c.y; lastDist = d;
        ev.preventDefault();
      } else if (mode === "pan") {
        const t = ev.touches[0]; if (!t) return;
        if (!navigating) {                                    // amorce : on n'intercepte qu'au-delà du seuil (sinon = tap)
          if (Math.hypot(t.clientX - lastX, t.clientY - lastY) <= TouchNav.MOVE_THRESHOLD) return;
          navigating = true; cb.panStart?.();
        }
        cb.panBy(t.clientX - lastX, t.clientY - lastY);
        lastX = t.clientX; lastY = t.clientY;
        ev.preventDefault();
      }
    }, { passive: false });

    const end = (e: Event) => {
      const ev = e as TouchEvent;
      if (ev.touches.length === 0) {
        if (navigating) { cb.panEnd?.(); ev.preventDefault(); }   // fin de navigation → supprime le clic synthétisé de fin
        mode = "none"; navigating = false; lastDist = 0;
      } else if (ev.touches.length === 1 && mode === "pinch") {    // 2→1 : continue en pan du doigt restant (jamais de clic)
        mode = "pan"; navigating = true; const t = ev.touches[0]; lastX = t.clientX; lastY = t.clientY; lastDist = 0;
        ev.preventDefault();
      }
    };
    el.addEventListener("touchend", end, { passive: false });
    el.addEventListener("touchcancel", end, { passive: false });
  }
}

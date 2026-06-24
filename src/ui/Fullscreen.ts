/* =============================================================================
   PLEIN ÉCRAN — re-parentage des overlays flottants (réplique de `fullscreenHost`/
   `homeInFullscreen`/`_rehomeFloatingUI` du monolithe).
   Un élément en plein écran (requestFullscreen) forme un « top layer » qui MASQUE tout
   ce qui n'est pas dans son sous-arbre. Les overlays attachés au <body> (modale, dialogues
   empilés, toasts, menus contextuels) deviennent invisibles → on les RE-PARENTE dans
   l'élément plein écran courant (à la création ET à chaque `fullscreenchange`) ; retour au
   <body> hors plein écran. (position:fixed reste relatif à l'écran dans un élément fullscreen.)
   ============================================================================= */
const FLOATING_SELECTOR = ".modal-overlay, .dialog-overlay, #toast-container, .graph-ctx";

export class Fullscreen {
  private static installed = false;

  /** Hôte courant des overlays : l'élément plein écran, sinon <body>. */
  static host(): HTMLElement { return (document.fullscreenElement as HTMLElement) || document.body; }

  /** Place/replace un overlay dans l'hôte courant (no-op s'il y est déjà). */
  static home(el: Element | null | undefined): void { const h = Fullscreen.host(); if (el && el.parentNode !== h) h.appendChild(el); }

  /** Re-parente TOUS les overlays flottants connus dans l'hôte courant. */
  static rehomeAll(): void { document.querySelectorAll(FLOATING_SELECTOR).forEach((el) => Fullscreen.home(el)); }

  /** Installe l'écoute `fullscreenchange` (idempotent). À appeler une fois au boot. */
  static install(): void {
    if (Fullscreen.installed || typeof document === "undefined") return;
    Fullscreen.installed = true;
    document.addEventListener("fullscreenchange", () => Fullscreen.rehomeAll());
  }
}

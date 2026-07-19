import { ScrollLock } from "./ScrollLock";

/* =============================================================================
   OverlayA11y — BOÎTE À OUTILS d'accessibilité des overlays (Modal + Dialog).

   Centralise les comportements ARIA / clavier / focus PARTAGÉS par la modale
   unique (`Modal`) et les dialogues empilables (`Dialog`), pour ne pas les
   dupliquer des deux côtés (principe n°3) :
     - `nextId` : identifiant STABLE et unique reliant un conteneur à son titre /
       message (`aria-labelledby` / `aria-describedby`). PUR (simple compteur).
     - `focusables` / `focusInitial` : quels éléments peuvent recevoir le focus,
       et où POSER le focus à l'ouverture (1er champ d'un formulaire, sinon 1er
       focusable, sinon le conteneur lui-même) ;
     - `trapTab` : PIÈGE de focus — Tab / Maj+Tab bouclent DANS l'overlay, jamais
       vers la page derrière (exigence des dialogues modaux) ;
     - `lockScroll` / `unlockScroll` : verrou de défilement de la page, via le
       compteur PUR `ScrollLock` (empilement dialogue-sur-modale géré).

   Les méthodes qui touchent au DOM ne référencent `document` QU'À L'APPEL (rien
   au chargement du module) : le module reste `require`-able côté tests Node.
   ============================================================================= */
export class OverlayA11y {
  /** Sélecteur des éléments naturellement focusables (hors `tabindex="-1"` explicite). */
  static readonly FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** Séquence des identifiants générés (monotone, jamais réinitialisée en prod). */
  private static idSeq = 0;

  /** Identifiant unique et stable `<prefix>-<n>` pour relier un conteneur à son titre/message.
      PUR (aucun DOM) : deux appels ne collisionnent jamais. */
  static nextId(prefix: string): string { return prefix + "-" + (++OverlayA11y.idSeq); }

  /** Éléments focusables VISIBLES contenus dans `root` (dans l'ordre du DOM). Un élément masqué
      (display:none / hors flux) a `offsetParent === null` → écarté ; on garde l'élément actif au
      cas où il serait momentanément « détaché » visuellement. */
  static focusables(root: HTMLElement): HTMLElement[] {
    const all = Array.from(root.querySelectorAll<HTMLElement>(OverlayA11y.FOCUSABLE_SELECTOR));
    return all.filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  /** Pose le focus À L'OUVERTURE. Ordre de préférence :
        1. un élément EXPLICITE fourni par l'appelant (ex. « Annuler » d'un dialogue danger) ;
        2. le 1er CHAMP de saisie (input/select/textarea) — cas d'un FORMULAIRE ;
        3. le 1er focusable quelconque (fiche en lecture : bouton/lien) ;
        4. à défaut, le conteneur lui-même (rendu focusable via tabindex=-1) — garantit que le
           piège de focus et Échap fonctionnent même sur un overlay sans contrôle. */
  static focusInitial(root: HTMLElement, explicit?: HTMLElement | null): void {
    if (explicit && typeof explicit.focus === "function") { try { explicit.focus(); return; } catch (_) { /* poursuit */ } }
    const all = OverlayA11y.focusables(root);
    const field = all.find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && (el as HTMLInputElement).type !== "hidden");
    const target = field || all[0] || null;
    if (target) { try { target.focus(); return; } catch (_) { /* poursuit */ } }
    root.setAttribute("tabindex", "-1");
    try { root.focus(); } catch (_) { /* sans effet */ }
  }

  /** PIÈGE de focus sur un événement `keydown` Tab : boucle le focus aux extrémités de `root`.
      À câbler dans le gestionnaire clavier de l'overlay (n'agit que sur la touche Tab). */
  static trapTab(root: HTMLElement, e: KeyboardEvent): void {
    if (e.key !== "Tab") return;
    const all = OverlayA11y.focusables(root);
    if (!all.length) { e.preventDefault(); return; }   // rien de focusable : on garde le focus « nulle part » plutôt qu'en dehors
    const first = all[0];
    const last = all[all.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !root.contains(active)) { e.preventDefault(); first.focus(); }
    }
  }

  /** Prend le verrou de défilement ; fige `<body>` à la 1re prise (cf. ScrollLock). */
  static lockScroll(): void {
    if (ScrollLock.acquire() && typeof document !== "undefined") document.body.style.overflow = "hidden";
  }

  /** Rend le verrou de défilement ; rétablit `<body>` à la dernière libération. */
  static unlockScroll(): void {
    if (ScrollLock.release() && typeof document !== "undefined") document.body.style.overflow = "";
  }
}

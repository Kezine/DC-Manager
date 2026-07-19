/* =============================================================================
   ScrollLock — COMPTEUR PUR du verrou de défilement de la page.

   POURQUOI un compteur (et pas un simple booléen) : plusieurs overlays peuvent
   se superposer (un `Dialog` de confirmation ouvert PAR-DESSUS une `Modal`, une
   pile de dialogues…). Chaque ouverture PREND le verrou, chaque fermeture le
   REND ; le défilement de la page (`<body>` figé) ne doit être rétabli qu'à la
   DERNIÈRE fermeture, sinon un dialogue refermé « débloquerait » le scroll alors
   qu'une modale reste ouverte dessous.

   Ce module ne contient QUE le comptage (aucun DOM) : `acquire()`/`release()`
   renvoient un booléen indiquant s'il faut APPLIQUER / RETIRER le verrou côté
   DOM — l'application effective (`document.body.style.overflow`) vit dans
   `OverlayA11y`, qui délègue ici la décision. Séparation → testable en isolation.
   ============================================================================= */
export class ScrollLock {
  /** Profondeur d'empilement des overlays qui tiennent le verrou (jamais négative). */
  private static count = 0;

  /** Prend le verrou. Renvoie `true` SEULEMENT à la 1re prise (0 → 1) : c'est alors
      qu'il faut réellement figer le défilement de la page. */
  static acquire(): boolean { return ++ScrollLock.count === 1; }

  /** Rend le verrou (borné à 0 : une libération en trop ne descend jamais négatif).
      Renvoie `true` SEULEMENT à la dernière libération (1 → 0) : c'est alors qu'il
      faut rétablir le défilement. */
  static release(): boolean {
    if (ScrollLock.count > 0) ScrollLock.count--;
    return ScrollLock.count === 0;
  }

  /** Profondeur courante (0 = aucun overlay ne tient le verrou). Lecture seule. */
  static get depth(): number { return ScrollLock.count; }

  /** Remet le compteur à zéro. Réservé aux TESTS (repart d'un état connu entre sections). */
  static reset(): void { ScrollLock.count = 0; }
}

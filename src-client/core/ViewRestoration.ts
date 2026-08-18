/* =============================================================================
   ViewRestoration — QUELLE VUE activer, et quand (correctif « droits partiels »,
   symptôme S3 : deep-link mort, cf. docs/auth.md § 10.6).

   POURQUOI CE MODULE. En mode API, le boot du client se déroule dans cet ordre,
   et l'ordre est TOUT :

     1. `applyAccess(AccessState.NONE)` — on ne sait pas encore ce qui est
        permis, donc AUCUNE vue n'est visible ;
     2. restauration du hash (`#equipements`) → `Shell.switchView` REFUSE : la
        vue existe mais n'est pas visible, et aucune autre ne l'est non plus.
        `shell.current` reste NUL ;
     3. `GET /me` répond → `applyAccess(grants réels)` → les onglets APPARAISSENT ;
     4. ouverture du document → `documentOpened()` → une vue est enfin activée.

   Rien, entre 3 et 4, ne rejoue l'activation. Tant que 4 arrive, le trou ne se
   voit pas ; qu'il n'arrive PAS — chargement du document en échec — et l'écran
   reste VIDE sous une barre d'onglets pourtant garnie : « rien ne s'affiche tant
   qu'on ne clique pas un onglet ». C'était le symptôme S3, mesuré.

   La décision « quelle vue » était en outre ÉCRITE DEUX FOIS (le repli d'après
   ouverture de document, et le choix du boot) avec des critères différents —
   l'une testant l'EXISTENCE d'une vue, l'autre sa VISIBILITÉ. Elle vit désormais
   ici, une fois, sous forme PURE : ni DOM, ni Shell, ni état d'autorisation —
   seulement des prédicats injectés. Testable headless
   (Tests/modules/test-access-partial.js).

   ⚠ Ce module ne décide QUE de la cible. Il n'active rien, et ne connaît pas la
   notion de droit : « visible » lui est fourni. C'est ce qui le rend juste dans
   les DEUX modes — en mode fichier tout est visible, et il rend alors exactement
   ce que rendait le code d'avant.
   ============================================================================= */

/** Ce que la décision a besoin de savoir. Tous les prédicats sont RELUS à l'appel : la cible dépend
    des droits de l'instant, jamais d'un instantané pris au boot. */
export interface ViewRestorationState {
  /** Vue actuellement active (`Shell.current`) — `null` quand aucune ne l'est. */
  current: string | null;
  /** Vue demandée par l'URL (`#nom`), telle quelle — chaîne vide si le hash est absent. */
  bookmarked: string;
  /** Vue par DÉFAUT de l'application (l'onglet d'accueil historique). */
  defaultView: string;
  /** Cette vue est-elle enregistrée ET accessible à l'utilisateur courant ? */
  isVisible(name: string): boolean;
  /** Première vue accessible dans l'ordre des onglets — `null` si plus rien ne l'est. */
  firstVisible(): string | null;
}

export class ViewRestoration {
  /** Vue à ACTIVER, ou `null` s'il n'y a rien à faire (ou rien à activer).

      Quatre candidats, dans cet ordre — du plus INTENTIONNEL au plus générique :

      1. **la vue déjà active**, si elle est toujours visible : on ne déplace jamais l'utilisateur
         sous ses pieds. C'est le cas nominal après une ouverture de document (« préserver l'onglet
         actif ») et, à ce titre, la raison d'être de l'ordre choisi ;
      2. **la vue BOOKMARKÉE** (`#equipements`) : c'est une intention EXPLICITE de l'utilisateur, elle
         prime donc sur le défaut de l'application. Ignorée si elle n'est pas visible — un lien profond
         vers une vue interdite se replie proprement (et `switchView` réécrira le hash sur la cible
         réellement activée, donc l'URL cesse de mentir) ;
      3. **la vue par défaut** de l'app, si elle est visible ;
      4. **la première vue visible**, quelle qu'elle soit : un utilisateur dont les droits ne couvrent
         qu'une sous-page doit tout de même la voir.

      `null` a DEUX sens, et ils appellent la même conduite (ne rien faire) : « tout va bien, la vue
      courante convient » et « aucune vue n'est accessible » — ce dernier étant l'écran « aucun
      accès », que l'overlay d'accueil couvre déjà. */
  static target(state: ViewRestorationState): string | null {
    if (state.current && state.isVisible(state.current)) return null;
    const bookmarked = String(state.bookmarked || "").trim();
    if (bookmarked && state.isVisible(bookmarked)) return bookmarked;
    if (state.defaultView && state.isVisible(state.defaultView)) return state.defaultView;
    return state.firstVisible();
  }

  /** Vue à activer APRÈS l'ouverture d'un document — même décision, mais la vue courante est ici une
      RÉPONSE, pas un « rien à faire » : l'appelant re-switche dessus pour la re-rendre avec les
      données fraîchement chargées. Écrit en termes de `target` (principe n°3 : une seule règle). */
  static afterDocumentOpened(state: ViewRestorationState): string | null {
    if (state.current && state.isVisible(state.current)) return state.current;
    return ViewRestoration.target(state);
  }
}

/* =============================================================================
   APPLINKROUTING — QUE FAIRE d'un lien direct (`src-shared/AppLink`) : agir tout
   de suite, ou ouvrir d'abord le document qu'il désigne.

   HISTORIQUE. Ce module s'appelait `EntityLinkRouting` et ne connaissait qu'une
   forme de lien : la fiche d'une entité, encodée sur une étiquette QR. Le chantier
   « liens directs » (2026-09-01) en a ajouté trois — intervention, certificat,
   recherche — et la règle « faut-il d'abord changer de document ? » leur vaut
   À L'IDENTIQUE : toutes les formes de la grammaire portent `doc/<docId>/`, y
   compris les deux familles hors document (leurs tables serveur sont indexées par
   `doc_id`). Il aurait donc fallu, soit dupliquer la règle par forme, soit la
   généraliser. C'est le second choix : la décision ne regarde QUE le document.

   POURQUOI CE MODULE. La question « qu'en fait-on ? » est une RÈGLE, pas de la
   plomberie : elle dépend du mode de données et du document courant, et elle doit
   valoir à l'identique pour tous les consommateurs (le hash au boot, le hash en
   vol, le greffon de scan). Elle vit donc ici, PURE (ni DOM, ni Store, ni réseau :
   mode et document courant sont INJECTÉS), testable headless
   (Tests/modules/test-app-link-routing.js), pendant que l'exécution vit dans
   `app/AppLinkOpener`.

   🚨 MODE FICHIER : le `docId` de la cible est DÉLIBÉRÉMENT IGNORÉ. Le mode
   fichier est mono-document par nature (« le document EST le fichier ») — il n'a
   aucun registre de documents où aller chercher `docId`, et refuser le lien parce
   qu'il vient d'une instance serveur serait exactement l'inverse de l'arbitrage
   n°1 du chantier QR : une étiquette imprimée reste utilisable sur l'export
   fichier du même parc. On tente donc l'action DANS le document ouvert ; si
   l'objet n'y est pas, l'appelant dira « introuvable » — un refus honnête, au lieu
   d'un refus par principe.
   ⚠ Ce module ne sait RIEN de la disponibilité des familles hors document en mode
   fichier (interventions, certificats — bases serveur). Ce n'est pas un oubli :
   cette indisponibilité-là se dit par INJECTION NULLE dans `AppLinkOpener`
   (patron `HydrationState`/`AccessState`), jamais par un test de mode ici.

   Deux actions, et deux seulement :
     · `open`       — agir dans le document déjà ouvert ;
     · `switch-doc` — mode API, le lien désigne un AUTRE document : il faut
                      l'ouvrir AVANT (sans quoi une fiche irait lire un cache qui
                      ne contient pas l'objet, et une recherche interrogerait le
                      mauvais parc).
   ============================================================================= */

import type { AppLinkTarget } from "../../src-shared/AppLink";

/** Ce que la décision a besoin de savoir. Tout est RELU à l'appel : un lien arrivé en vol (hash
    changé, code scanné) se décide avec le document de L'INSTANT, jamais avec celui du boot. */
export interface AppLinkRoutingState {
  /** Mode API (documents SERVEUR multiples) ? `false` = mode fichier/visualiseur, mono-document. */
  restMode: boolean;
  /** Document serveur courant (`RestDocumentController.docId`) — `null` si aucun n'est encore ouvert.
      IGNORÉ en mode fichier. */
  currentDocId: string | null;
  /** Cible lue par `AppLink.parse` — `null` quand le texte n'en portait pas (hash de vue, QR étranger). */
  target: AppLinkTarget | null;
}

/** Ce qu'il y a à FAIRE. `target` est reconduite dans la décision pour que l'appelant n'ait pas à la
    ré-extraire de l'état (et ne puisse pas exécuter une action avec une autre cible que celle jugée). */
export type AppLinkRoute =
  | { action: "open"; target: AppLinkTarget }
  | { action: "switch-doc"; docId: string; target: AppLinkTarget };

export class AppLinkRouting {
  /** Action à exécuter, ou `null` s'il n'y a RIEN à faire (pas de cible, ou cible dégénérée).

      `null` est la réponse NORMALE et fréquente : chaque `hashchange` de l'application passe par ici
      (`#equipements` n'est pas un lien direct), et le silence est alors exactement le comportement
      voulu — la navigation par onglet reste celle du Shell, inchangée. */
  static decide(state: AppLinkRoutingState): AppLinkRoute | null {
    const target = state.target;
    if (!target || !AppLinkRouting.isActionable(target)) return null;
    // MODE FICHIER : mono-document, `docId` ignoré (cf. en-tête — arbitrage n°1 du chantier QR).
    if (!state.restMode) return { action: "open", target };
    // MODE API. Un lien SANS document (ne peut pas venir d'`AppLink.build`) n'a rien vers quoi
    // basculer : on tente l'action dans le document courant plutôt que de ne rien faire.
    if (!target.docId) return { action: "open", target };
    if (target.docId === state.currentDocId) return { action: "open", target };
    // Document DIFFÉRENT — y compris `currentDocId === null` (aucun document ouvert) : dans les deux cas
    // le cache client ne contient pas ce que le lien vise, il faut charger le bon document d'abord.
    return { action: "switch-doc", docId: target.docId, target };
  }

  /** Une cible DÉGÉNÉRÉE ne mérite aucune action. `AppLink.parse` n'en rend jamais (liste blanche des
      collections, identifiants non vides, requête non vide), mais la décision est aussi appelable avec
      une cible construite ailleurs — on ne fait pas confiance à l'appelant pour une règle qui décide
      d'une NAVIGATION. */
  private static isActionable(target: AppLinkTarget): boolean {
    if (target.kind === "fiche") return !!target.collection && !!target.id;
    if (target.kind === "recherche") return !!target.query.trim();
    return !!target.id;
  }
}

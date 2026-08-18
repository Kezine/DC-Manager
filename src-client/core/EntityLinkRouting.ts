/* =============================================================================
   ENTITYLINKROUTING — QUE FAIRE d'un deep-link d'entité (`src-shared/EntityLink`) :
   ouvrir la fiche TOUT DE SUITE, ou ouvrir d'abord le document qu'elle désigne.

   POURQUOI CE MODULE (chantier étiquettes QR, lot « deep-link d'entité »).
   Une étiquette QR encode l'URL ABSOLUE d'une fiche
   (`<URL publique>#doc/<docId>/fiche/<collection>/<id>`). Quand ce lien arrive
   — au boot, sur `hashchange`, ou plus tard depuis le greffon de scan — la
   question « qu'en fait-on ? » est une RÈGLE, pas de la plomberie : elle dépend
   du mode de données et du document courant, et elle doit valoir à l'identique
   pour les deux consommateurs. Elle vit donc ici, PURE (ni DOM, ni Store, ni
   réseau : mode et document courant sont INJECTÉS), testable headless
   (Tests/modules/test-entity-link-routing.js), pendant que l'exécution vit dans
   `app/EntityLinkOpener`.

   🚨 MODE FICHIER : le `docId` de la cible est DÉLIBÉRÉMENT IGNORÉ. Le mode
   fichier est mono-document par nature (« le document EST le fichier ») — il n'a
   aucun registre de documents où aller chercher `docId`, et refuser le lien
   parce qu'il vient d'une instance serveur serait exactement l'inverse de
   l'arbitrage n°1 du chantier : une étiquette imprimée reste utilisable sur
   l'export fichier du même parc. On tente donc la fiche DANS le document ouvert ;
   si l'objet n'y est pas, l'appelant dira « introuvable » — un refus honnête,
   au lieu d'un refus par principe.

   Deux actions, et deux seulement :
     · `open`       — la fiche s'ouvre dans le document déjà ouvert ;
     · `switch-doc` — mode API, le lien désigne un AUTRE document : il faut
                      l'ouvrir AVANT la fiche (sans quoi la fiche irait lire un
                      cache qui ne contient pas l'objet).
   ============================================================================= */

import type { EntityLinkTarget } from "../../src-shared/EntityLink";

/** Ce que la décision a besoin de savoir. Tout est RELU à l'appel : un deep-link arrivé en vol
    (hash changé, code scanné) se décide avec le document de L'INSTANT, jamais avec celui du boot. */
export interface EntityLinkRoutingState {
  /** Mode API (documents SERVEUR multiples) ? `false` = mode fichier/visualiseur, mono-document. */
  restMode: boolean;
  /** Document serveur courant (`RestDocumentController.docId`) — `null` si aucun n'est encore ouvert.
      IGNORÉ en mode fichier. */
  currentDocId: string | null;
  /** Cible lue par `EntityLink.parse` — `null` quand le texte n'en portait pas (hash de vue, QR étranger). */
  target: EntityLinkTarget | null;
}

/** Ce qu'il y a à FAIRE. `target` est reconduite dans la décision pour que l'appelant n'ait pas à la
    ré-extraire de l'état (et ne puisse pas exécuter une action avec une autre cible que celle jugée). */
export type EntityLinkRoute =
  | { action: "open"; target: EntityLinkTarget }
  | { action: "switch-doc"; docId: string; target: EntityLinkTarget };

export class EntityLinkRouting {
  /** Action à exécuter, ou `null` s'il n'y a RIEN à faire (pas de cible, ou cible dégénérée).

      `null` est la réponse NORMALE et fréquente : chaque `hashchange` de l'application passe par ici
      (`#equipements` n'est pas un deep-link), et le silence est alors exactement le comportement
      voulu — la navigation par onglet reste celle du Shell, inchangée. */
  static decide(state: EntityLinkRoutingState): EntityLinkRoute | null {
    const target = state.target;
    // Cible DÉGÉNÉRÉE : `EntityLink.parse` ne rend jamais ça (collection en liste blanche, id non vide),
    // mais la décision est aussi appelable avec une cible construite ailleurs — on ne fait pas confiance
    // à l'appelant pour une règle qui décide d'une NAVIGATION.
    if (!target || !target.collection || !target.id) return null;
    // MODE FICHIER : mono-document, `docId` ignoré (cf. en-tête — arbitrage n°1 du chantier).
    if (!state.restMode) return { action: "open", target };
    // MODE API. Un lien SANS document (ne peut pas venir de `EntityLink.build`) n'a rien vers quoi
    // basculer : on tente la fiche dans le document courant plutôt que de ne rien faire.
    if (!target.docId) return { action: "open", target };
    if (target.docId === state.currentDocId) return { action: "open", target };
    // Document DIFFÉRENT — y compris `currentDocId === null` (aucun document ouvert) : dans les deux cas
    // le cache client ne contient pas l'objet visé, il faut charger le bon document d'abord.
    return { action: "switch-doc", docId: target.docId, target };
  }
}

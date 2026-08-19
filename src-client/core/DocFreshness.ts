/* ============================================================================
   DOC FRESHNESS — fraîcheur du cache client : décision PURE des vérifications
   de révision du document (mode API).

   LE CAS COUVERT. Le cache des collections HYDRATÉES n'est tenu à jour que par
   les événements SSE — et ceux-ci peuvent être MANQUÉS sans aucun signal :
   onglet endormi ou déchargé par le navigateur, machine en veille, coupure
   réseau. `EventSource` re-connecte tout seul (champ `retry`) mais ne REJOUE
   jamais les événements émis pendant la coupure : le serveur (`LiveBus`) ne
   garde AUCUN historique et n'émet pas d'`id:` SSE, donc `Last-Event-ID` ne
   peut rien rattraper. Résultat mesuré : une app laissée de côté propose un
   état ANCIEN (ex. la recherche de la modale de sélection 3D, locale par
   construction) sans qu'aucune erreur ne le trahisse.

   LA RÉPONSE (lot R3, cf. docs/hydratation.md § « Fraîcheur — SSE manqués ») :
   une vérification de révision LÉGÈRE (un GET du registre des documents, qui
   porte déjà `rev`) déclenchée au retour de visibilité, au focus fenêtre, à la
   RE-connexion SSE et par un heartbeat modeste. Ce module ne porte que les
   DÉCISIONS — quand une vérification a le droit de partir (anti-rafale : les
   déclencheurs se recouvrent, alt-tab = focus + visibilitychange), et le
   verdict de la comparaison des révisions. Le câblage (listeners, timer,
   requête, rattrapage) vit dans `app/RestDocuments.ts` — construit UNIQUEMENT
   en mode REST, donc le mode fichier/visualiseur est no-op PAR CONSTRUCTION
   (même garantie que tout le contrôleur, aucun test de mode nulle part).

   Module PUR (aucun DOM, aucune horloge implicite : `nowMs` est PASSÉ en
   paramètre — patron `core/AccessDenial`) → testé en isolation dans
   `Tests/modules/test-doc-freshness.js`.
   ============================================================================ */

/** Les quatre déclencheurs d'une vérification de fraîcheur (documentés ici, câblés dans RestDocuments). */
export type DocFreshnessTrigger = "visibility" | "focus" | "sse-reconnect" | "heartbeat";

export class DocFreshness {
  /** Période du HEARTBEAT (le « GET régulier » demandé) : attrape le cas qu'aucun événement ne signale —
      un flux SSE silencieusement MORT (socket zombie après reprise réseau, proxy qui a coupé sans FIN)
      alors que l'onglet reste visible. 5 minutes : assez court pour borner la fenêtre de péremption,
      assez long pour que le coût (un GET du registre) soit négligeable. */
  static readonly HEARTBEAT_MS = 5 * 60 * 1000;

  /** Fenêtre ANTI-RAFALE : pas deux vérifications à moins de cet écart. Les déclencheurs se recouvrent
      structurellement (un alt-tab produit focus + visibilitychange à quelques ms d'écart ; une
      re-connexion SSE suit souvent un retour de visibilité) — sans cette fenêtre, chaque retour au
      premier plan paierait deux ou trois GET pour la même réponse. */
  static readonly MIN_INTERVAL_MS = 15 * 1000;

  /** Dernier instant où une vérification a été ACCEPTÉE (ou le corpus déclaré frais). `null` = jamais. */
  private lastAcceptedMs: number | null = null;
  /** Une vérification est EN VOL (acceptée, pas encore `done()`) : jamais deux en parallèle. */
  private inFlight = false;

  /** Cette vérification a-t-elle le droit de partir ? Vrai si aucune n'est en vol ET que la fenêtre
      anti-rafale est écoulée. Effet de bord assumé : l'acceptation MÉMORISE l'instant et pose l'état
      « en vol » — c'est un guichet, pas un prédicat pur au sens strict, et le nommer `accept` plutôt
      que `shouldCheck` le dit à l'appel (même choix que `AccessDenial.accept`). L'appelant DOIT
      appeler `done()` à la fin (succès OU échec), typiquement dans un `finally`. */
  accept(nowMs: number): boolean {
    if (this.inFlight) return false;
    if (this.lastAcceptedMs != null && nowMs - this.lastAcceptedMs < DocFreshness.MIN_INTERVAL_MS) return false;
    this.lastAcceptedMs = nowMs;
    this.inFlight = true;
    return true;
  }

  /** La vérification en vol est TERMINÉE (réponse reçue ou échec avalé) : une suivante peut partir
      (sous réserve de la fenêtre anti-rafale, qui court depuis l'ACCEPTATION — pas depuis la fin). */
  done(): void { this.inFlight = false; }

  /** Le corpus vient d'être (re)chargé EN ENTIER (ouverture de document, rechargement total) : re-vérifier
      dans la foulée serait absurde — on repousse la fenêtre anti-rafale à l'instant présent. Ne touche
      PAS l'état « en vol » : une vérification déjà partie finira et appellera son `done()`. */
  noteFresh(nowMs: number): void { this.lastAcceptedMs = nowMs; }

  /** Révision du document `docId` extraite de la réponse du REGISTRE (`GET /documents` — les `DocMeta`
      portent `rev`). `null` si la liste est illisible, le document ABSENT (supprimé par un autre
      client ?) ou sa révision non numérique : autant de cas où AUCUN verdict n'est possible — le
      rattrapage ne doit jamais partir sur une donnée douteuse. */
  static revFromList(docs: unknown, docId: string): number | null {
    if (!Array.isArray(docs)) return null;
    const doc = docs.find((d) => d && typeof d === "object" && (d as { id?: unknown }).id === docId);
    if (!doc) return null;
    const rev = (doc as { rev?: unknown }).rev;
    return (typeof rev === "number" && Number.isFinite(rev) && rev >= 0) ? rev : null;
  }

  /** Verdict de la comparaison : `fresh` (rien à faire), `stale` (RATTRAPAGE), `unknown` (révision
      serveur illisible : rien à faire non plus, on retentera). ⚠ L'écart joue dans les DEUX sens —
      une révision serveur INFÉRIEURE est aussi un cache périmé (un backup du serveur restauré fait
      reculer `rev` ; l'événement SSE, lui, ne recharge que sur `rev` supérieure, mais la vérification
      délibérée n'a pas de raison d'hériter de cette asymétrie). */
  static verdict(serverRev: number | null, clientRev: number): "fresh" | "stale" | "unknown" {
    if (serverRev === null || !Number.isFinite(serverRev)) return "unknown";
    return serverRev === clientRev ? "fresh" : "stale";
  }
}

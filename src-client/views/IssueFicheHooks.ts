/* Contrat d'INTÉGRATION « fiches » de la feature TICKETS (AMOVIBLE) — DÉCOUPLAGE (principe n°2).

   Les fiches détail (équipement / VM / spare / sous-équipement) ne doivent importer NI la vue de
   l'onglet Tickets, NI le client HTTP (`IssueSyncClient`) : elles ne connaissent que ce petit
   contrat, injecté via `FormHost` (`host.issueHooks`) et implémenté dans `main.ts`. Retirer la
   feature = retirer l'implémentation dans `main.ts` + ce fichier + `IssueFicheRow`, sans toucher aux
   fiches (elles voient alors `issueHooks` à null → rien ne s'affiche).

   ── 🚨 LA DIFFÉRENCE ESSENTIELLE AVEC `InterventionFicheHooks` ────────────────────
   Là-bas, `countOpen` et `latestFor` sont ASYNCHRONES parce que les interventions vivent dans une
   base SERVEUR séparée, que le client n'a pas. Ici, `issues` est une COLLECTION DU DOCUMENT : le
   client la porte déjà en entier, et le comptage comme les « N derniers » sont un simple FILTRE EN
   MÉMOIRE (`core/IssueTargetSummary`, pur et testé). D'où :
   - `digestFor` est SYNCHRONE — aucune promesse, aucun clignotement, aucun état d'échec réseau ;
   - AUCUNE route de comptage n'a été ajoutée côté serveur ;
   - la rangée FONCTIONNE EN MODE FICHIER (principe n°15), contrairement à celle des interventions.
   Seule `createFor` parle au tracker : c'est donc la SEULE partie conditionnée au mode API.

   `digestFor` : ce que la rangée affiche — nombre d'OUVERTS (badge), TOTAL (décide du « Afficher
                 plus » : une cible dont tous les tickets sont clos a quand même quelque chose à
                 montrer) et les `latest` plus récents.
   `openDetail` : ouvre (EMPILE) la fiche d'un ticket PAR-DESSUS la fiche courante — on ne change
                  PAS de vue et on ne ferme RIEN, ← Retour ramène à l'objet (même sémantique que le
                  mini-listing des interventions, rendue structurelle par la pile de modales).
   `openListFor`: ouvre l'onglet « Tickets » FILTRÉ sur la cible (« Afficher plus ») — CHANGEMENT DE
                  VUE, donc l'appelant ferme d'abord la fiche courante. Le filtre est la dimension
                  « Cible » de la barre, qui RÉSOUT son libellé à chaque rendu (renommage suivi tout
                  seul), exactement comme pour les interventions.
   `createFor`  : ouvre la modale « Ouvrir un ticket » PRÉ-REMPLIE (titre suggéré depuis le nom de
                  l'objet, cible DÉJÀ liée). ⚠ ABSENTE (undefined) hors mode API ou en viewer : la
                  création appelle le tracker. Contrairement à `declareFor` des interventions, elle
                  ne ferme PAS la fiche — la modale de création s'EMPILE, et l'on revient à la fiche
                  en la validant comme en l'annulant. */

/** Item MINIMAL de ticket exposé aux fiches (mini-listing des N derniers). Type LOCAL au contrat —
    surtout PAS le modèle `Issue` : le découplage fiches ↛ vue/client est la raison d'être de ce
    fichier, on ne fait donc transiter que ce qui est AFFICHÉ. Miroir partiel, duplication assumée. */
export interface IssueFicheItem {
  id: string;
  /** Clé lisible (« INFRA-123 ») — le repère qu'on prononce, donc la tête de ligne. */
  key: string;
  summary: string;
  /** Libellé BRUT du statut, affiché tel quel et jamais traduit (décision D3). */
  status: string;
  /** Catégorie normalisée — la seule chose qui colore la pastille. */
  status_category: string;
  /** Ticket non résolu à la dernière passe = « introuvable » (pastille propre, dominante). */
  orphan: boolean;
}

/** Ce que la rangée affiche pour UNE cible — calculé SYNCHRONEMENT (cf. l'en-tête). */
export interface IssueFicheDigest {
  openCount: number;
  total: number;
  latest: IssueFicheItem[];
}

export interface IssueFicheHooks {
  /** SYNCHRONE : la collection `issues` est dans le document (cf. l'en-tête). */
  digestFor(kind: string, id: string, latest: number): IssueFicheDigest;
  /** EMPILE la fiche du ticket par-dessus la modale courante (ne ferme rien, ne navigue pas). */
  openDetail(issueId: string): void;
  /** Ouvre l'onglet « Tickets » FILTRÉ sur la cible (l'appelant a fermé la fiche : on change de vue). */
  openListFor(kind: string, id: string): void;
  /** Ouvre la modale de création pré-remplie. ABSENTE hors mode API / en viewer → bouton non rendu. */
  createFor?(kind: string, id: string, label: string): void;
}

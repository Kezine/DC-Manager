/* Contrat d'INTÉGRATION « fiches » de la feature interventions (AMOVIBLE) — DÉCOUPLAGE (principe n°2).

   Les fiches (détail équipement/VM/spare) ne doivent importer NI la vue (`InterventionsAdminView`) NI le
   client (`InterventionsClient`) : elles ne connaissent que ce petit contrat, injecté via `FormHost`
   (`host.interventionHooks`) et implémenté dans `main.ts`. Retirer la feature = retirer l'implémentation
   dans `main.ts` + ce fichier, sans toucher aux fiches (elles voient alors `interventionHooks` à null → rien).

   `countOpen`  : nombre d'interventions OUVERTES liées à une cible (badge de fiche, chargé async).
   `latestFor`  : les `n` dernières interventions liées à une cible (TOUTES, pas seulement les ouvertes ;
                  tri « activité récente » côté serveur), pour le mini-listing de la fiche — chargé async
                  comme le badge. Renvoie le type LOCAL `InterventionFicheItem` (voir plus bas), JAMAIS le
                  `InterventionRecord` du client : le contrat reste le SEUL point de contact fiches ⇄ vue.
   `openDetail` : ouvre (EMPILE) la fiche de détail d'une intervention PAR-DESSUS la modale courante (clic sur
                  une ligne du mini-listing). PREMIER hook du contrat qui EMPILE au lieu de naviguer : la pile
                  de modales (2026-07-30) a levé la réserve D1 du cadrage (« la cliquabilité viendra avec la
                  pile ») — on ne change PAS de vue et on ne ferme RIEN, ← Retour / Retour arrière ramènent à
                  la fiche de l'objet, ✕ ferme la file.
   `declareFor` : déclare une intervention DEPUIS la fiche — NAVIGUE vers l'onglet « Interventions » et ouvre
                  la modale de création PRÉ-LIÉE à la cible (l'appelant DÉPILE d'abord la fiche courante :
                  on change de VUE, elle n'a plus lieu d'être — cf. InterventionFicheRow). `label` = libellé
                  lisible de la cible (contexte affiché dans la modale de création).
   `openListFor`: ouvre la VUE « Interventions » FILTRÉE sur la cible (bouton « Afficher plus » du bloc fiche).
                  Le filtre est posé à l'arrivée (chip retirable dans la barre) — `label` = libellé lisible de
                  la cible (affiché par la chip). Poser le filtre reste réservé à la navigation : la barre ne
                  propose PAS de le saisir (différé). */

/** Item MINIMAL d'intervention exposé aux fiches (mini-listing « 3 dernières »). Type LOCAL au contrat —
    surtout PAS `InterventionRecord` (client) : le découplage fiches ↛ vue/client est la raison d'être de ce
    fichier, on ne fait donc transiter que les champs affichés. Miroir partiel, duplication assumée. */
export interface InterventionFicheItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  /** Date de dernière activité (ISO) — sert la date courte affichée en tête de ligne. */
  updated_date: string;
}

export interface InterventionFicheHooks {
  countOpen(kind: string, id: string): Promise<number>;
  latestFor(kind: string, id: string, n: number): Promise<InterventionFicheItem[]>;
  /** Ouvre (EMPILE) la fiche de détail de l'intervention par-dessus la modale courante ; ne change PAS de
      vue et ne ferme rien (cf. en-tête — D1 levé par la pile de modales, le retour est structurel). */
  openDetail(interventionId: string): void;
  declareFor(kind: string, id: string, label: string): void;
  openListFor(kind: string, id: string, label: string): void;
}

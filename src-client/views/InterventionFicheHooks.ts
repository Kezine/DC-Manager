/* Contrat d'INTÉGRATION « fiches » de la feature interventions (AMOVIBLE) — DÉCOUPLAGE (principe n°2).

   Les fiches (détail équipement/VM/spare) ne doivent importer NI la vue (`InterventionsAdminView`) NI le
   client (`InterventionsClient`) : elles ne connaissent que ce petit contrat, injecté via `FormHost`
   (`host.interventionHooks`) et implémenté dans `main.ts`. Retirer la feature = retirer l'implémentation
   dans `main.ts` + ce fichier, sans toucher aux fiches (elles voient alors `interventionHooks` à null → rien).

   `countOpen`  : nombre d'interventions OUVERTES liées à une cible (badge de fiche, chargé async).
   `declareFor` : déclare une intervention DEPUIS la fiche — NAVIGUE vers l'onglet « Interventions » et ouvre
                  la modale de création PRÉ-LIÉE à la cible (l'appelant ferme d'abord la fiche courante — la
                  modale de l'app est un overlay UNIQUE, pas d'empilement). `label` = libellé lisible de la
                  cible (contexte affiché dans la modale de création). */
export interface InterventionFicheHooks {
  countOpen(kind: string, id: string): Promise<number>;
  declareFor(kind: string, id: string, label: string): void;
}

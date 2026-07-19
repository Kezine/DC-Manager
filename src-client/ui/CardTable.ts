/* =============================================================================
   CardTable — repli des tables de LISTING en CARTES sous 560px (revue design lot D2).

   Sous 560px, une table ne tient plus en largeur : le CSS (`@media (max-width:560px)`, cf. dc-manager.css)
   masque le `thead`, transforme chaque `<tr>` en carte et affiche, DEVANT chaque cellule, le libellé de sa
   colonne via `td::before { content: attr(data-label) }`. Il faut donc poser ce `data-label` sur les cellules.

   La ListView écrit ce `data-label` directement dans son gabarit HTML (elle connaît `column.head`). Les vues
   CUSTOM (Certs, Interventions) construisent, elles, leurs `<td>` en DOM, avec des cellules HÉTÉROGÈNES bâties
   par des helpers partagés qui ignorent leur colonne — impossible d'étiqueter à la source sans plomberie. Cette
   classe pose donc le `data-label` APRÈS coup, en LISANT le libellé depuis la rangée d'en-tête DÉJÀ localisée
   (aucune nouvelle chaîne i18n, zéro duplication). L'alignement colonne↔cellule est celui, intrinsèque, des
   tables HTML : la n-ième cellule reçoit le libellé de la n-ième colonne.

   Cellules laissées MUETTES (pas de `data-label` → `::before` vide, donc aucun préfixe) :
     • la colonne d'ACTIONS (classe `cell-actions`) = rangée de boutons, jamais préfixée ;
     • toute colonne dont l'en-tête n'a pas de texte (ex. case à cocher de sélection).
   ============================================================================= */
export class CardTable {
  /** Libellés des colonnes, lus depuis la rangée d'en-tête (`<tr>` du `thead`). L'indicateur de tri (▲/▼,
      `.sort-ind`) est retiré d'une COPIE avant lecture pour ne pas polluer le libellé de la colonne triée. */
  static columnLabels(headerRow: HTMLElement): string[] {
    return Array.from(headerRow.children).map((th) => {
      const clone = th.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".sort-ind").forEach((ind) => ind.remove());
      return (clone.textContent || "").trim();
    });
  }

  /** Pose `data-label` sur chaque cellule d'une rangée de CORPS, depuis les libellés de colonnes (même ordre).
      Ignore la cellule d'actions (`cell-actions`) et les colonnes sans libellé — elles restent muettes. */
  static labelCells(bodyRow: HTMLElement, labels: string[]): void {
    const cells = bodyRow.children;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as HTMLElement;
      if (cell.classList.contains("cell-actions")) continue;   // rangée de boutons → pas de libellé
      const label = labels[i];
      if (label) cell.setAttribute("data-label", label);
    }
  }
}

/* =============================================================================
   StaleGate — garde de FRAÎCHEUR pour des réponses asynchrones concurrentes
   (module PUR : ni DOM, ni réseau — testable en isolation).

   Problème résolu : un champ qui déclenche des requêtes au fil de la frappe lance
   PLUSIEURS fetchs qui se résolvent dans le DÉSORDRE. La réponse d'une saisie
   ANCIENNE ne doit JAMAIS écraser l'affichage d'une saisie plus récente (course
   classique d'une recherche « au vol »). On associe à chaque requête un numéro de
   GÉNÉRATION croissant ; à la résolution, on vérifie que ce numéro est toujours le
   plus récent — sinon la réponse est périmée et l'appelant l'ignore.

   Pourquoi une classe dédiée (principes n°2/n°7) : ce mécanisme est réutilisable
   par tout composant à requêtes concurrentes (SearchPop et, à terme, d'autres) et
   se teste sans DOM (Tests/modules). Le composant qui l'emploie n'a plus qu'à
   capturer un jeton avant l'`await` puis à interroger `isCurrent`.
   ============================================================================= */
export class StaleGate {
  /** Génération courante (dernière requête ouverte). Monotone croissante. */
  private generation = 0;

  /** Ouvre une NOUVELLE génération et renvoie son jeton — à capturer AVANT l'`await` du fetch. */
  begin(): number {
    return ++this.generation;
  }

  /** Le jeton correspond-il à la génération courante ? `false` = une saisie plus récente est
      partie depuis, la réponse est PÉRIMÉE et doit être ignorée. */
  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  /** Invalide toute réponse EN VOL sans ouvrir de nouvelle génération (ex. fermeture du popover,
      champ vidé) : les jetons déjà distribués deviennent périmés. */
  bump(): void {
    this.generation++;
  }
}

import { Schema } from "../../shared/Schema";

/** Helpers texte. Remplace les fonctions libres par des méthodes statiques. */
export class Text {
  /** Normalise pour la recherche : minuscules, sans accents. DÉLÉGUÉ au schéma PARTAGÉ
      (`shared/Schema.ts`) → parité STRICTE garantie avec l'indexation serveur (fin de la
      double implémentation à « garder en phase »). */
  static normSearch(s: unknown): string {
    return Schema.normSearch(s);
  }
}

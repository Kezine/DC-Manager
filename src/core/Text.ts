/** Helpers texte. Remplace les fonctions libres par des méthodes statiques. */
export class Text {
  /** Normalise pour la recherche : minuscules, sans accents (NFD + suppression
      des diacritiques U+0300–U+036F). Utilisé par les filtres `query` de la
      couche données. */
  static normSearch(s: unknown): string {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
}

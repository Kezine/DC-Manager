/* Génération d'identifiants + horodatage. Remplace les helpers libres
   `uid()` / `nowIso()` par des méthodes statiques (pas de fonction « nue »). */
export class Id {
  private static seq = 0;

  /** Identifiant court, monotone au sein d'une session (base36). */
  static uid(): string {
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7) +
      (Id.seq++).toString(36)
    );
  }

  /** Horodatage ISO 8601 courant. */
  static nowIso(): string {
    return new Date().toISOString();
  }
}

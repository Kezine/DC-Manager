/** Formatage d'affichage (longueurs, dates). */
export class Format {
  /** mm → « x.xx m ». */
  static meters(mm: number): string {
    return (Math.round(mm / 10) / 100).toFixed(2) + " m";
  }

  /** ISO → date+heure locale (fr-BE) ; « — » si vide, l'entrée brute si invalide. */
  static dateTime(iso: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("fr-BE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /** ISO → heure locale (fr-BE) ; « — » si vide/invalide. */
  static time(iso: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  /** Taille en octets → chaîne lisible (« 2.4 Mo », « 512 o »). Unités FRANCOPHONES (o/Ko/Mo/Go/To),
      cohérentes avec le reste de `Format` (dates fr-BE, mètres) — le domaine de l'app est francophone,
      cette classe n'est pas i18n'isée à dessein. Base binaire (1024), comme la taille d'un fichier telle
      que la présentent les systèmes de fichiers ; une décimale au-delà du kilo, aucune sous le kilo
      (un compte d'octets exact n'a pas de fraction). Entrée non finie/négative → « 0 o » (défensif :
      `size` est posé par le serveur à l'upload, mais un enregistrement legacy pourrait être incomplet). */
  static bytes(n: number): string {
    const octets = Math.max(0, Math.round(Number(n) || 0));
    if (octets < 1024) return octets + " o";
    const units = ["Ko", "Mo", "Go", "To"];
    let value = octets / 1024;
    let unitIndex = 0;
    // On monte d'unité tant qu'on dépasse 1024 (et qu'il reste une unité plus grande) — « Po » et au-delà
    // sont hors de portée pour une pièce jointe plafonnée à 50 Mo, inutile de les lister.
    while (value >= 1024 && unitIndex < units.length - 1) { value /= 1024; unitIndex++; }
    // ≥ 100 dans l'unité courante → pas de décimale (« 512 Mo », pas « 512.0 Mo ») ; sinon une décimale.
    const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    return rounded + " " + units[unitIndex];
  }
}

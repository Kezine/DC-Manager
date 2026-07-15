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
}

/** Comparateur de tri générique (nuls en dernier ; numérique « naturel »). */
export class Sort {
  static compare(a: any, b: any): number {
    const na = (a == null || a === ""), nb = (b == null || b === "");
    if (na && nb) return 0; if (na) return 1; if (nb) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" });
  }
}

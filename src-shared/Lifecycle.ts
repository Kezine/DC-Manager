/* =============================================================================
   Lifecycle — règle PARTAGÉE front ⇄ back du CYCLE DE VIE matériel : jours
   jusqu'à une échéance + DÉCISION d'état de garantie (`ok`/`warn`/`err`).

   POURQUOI ce module existe (cadrage garantie-alerte 2026-08-15, § 4.2) : la
   règle vivait côté CLIENT (`core/LifecycleFormat`) — fiches, listings et filtre
   « garantie » l'affichent. Le VEILLEUR SERVEUR d'alertes de garantie
   (`src-server/src/lifecycle/WarrantyExpiryWatcher`) doit appliquer EXACTEMENT
   les mêmes frontières : re-dériver le seuil ou la borne J-0 côté serveur
   alerterait un jour trop tôt ou trop tard que ce que l'utilisateur VOIT en
   orange/rouge (principe n°3 — une règle, UNE source). La décision d'état
   déménage donc ici ; `LifecycleFormat` DÉLÈGUE et ne garde que la présentation
   (décomposition calendaire, libellés i18n).

   SÉMANTIQUE VERROUILLÉE (décisions des volets 1-2, testées côté client AVANT
   l'extraction — les assertions n'ont pas bougé d'une virgule) :
   - dates = chaînes ISO COURTES (« YYYY-MM-DD », `default: ""`), raisonnées en
     UTC (composantes getUTC*) — insensible au fuseau, fidèle à la nature
     « date seule » des champs `warranty_end`/`purchase_date` ;
   - frontière J-0 : le JOUR MÊME de l'échéance, la garantie couvre encore la
     journée → `warn`, PAS `err` ; seul un dépassement STRICT (jours < 0) expire ;
   - seuil de préavis `WARN_DAYS = 90` : ≤ 90 jours → `warn` (borne INCLUSIVE) ;
   - vide / chaîne illisible / `now` invalide → null (pas d'état — l'appelant
     décide : le filtre client mappe sur "none", le veilleur serveur résout).

   `now: Date` est TOUJOURS INJECTÉ (jamais de `new Date()` interne) :
   déterminisme des tests (frontières exactes, bissextiles) et parité avec les
   horloges injectées des veilleurs serveur.

   TS PUR (contrainte src-shared/) : aucun DOM, aucun Node, aucun import.
   ============================================================================= */

/** Statut d'une garantie : sous garantie / échéance proche (≤ WARN_DAYS) / expirée.
    Le client le mappe en couleur (var(--ok)/var(--warn)/var(--err)), le serveur en
    gravité de notification (warn → warning, err → error). */
export type WarrantyStatus = "ok" | "warn" | "err";

export class Lifecycle {
  /** Seuil de PRÉAVIS de garantie : une échéance à 90 jours ou moins passe en `warn`.
      Constante nommée UNIQUE (ex-`LifecycleFormat.WARN_DAYS`) : la valeur que l'utilisateur
      voit en orange dans les listings EST celle qui déclenche l'alerte serveur `warranty-expiring`. */
  static readonly WARN_DAYS = 90;

  /** Millisecondes par jour (constante nommée : évite les 86400000 magiques). */
  private static readonly DAY_MS = 24 * 60 * 60 * 1000;

  /** Parse une date ISO courte en `Date` (UTC), ou null si vide / non-chaîne / illisible.
      PUBLIC (≠ helper privé historique) : `LifecycleFormat` en a besoin pour composer ses
      libellés de durée — le dupliquer côté client recréerait la dérive que ce module ferme. */
  static parseDate(iso: string | null | undefined): Date | null {
    if (typeof iso !== "string" || iso.trim() === "") return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return new Date(t);
  }

  /** `now` est-il une `Date` valide ? (garde-fou : un appelant peut passer n'importe quoi).
      Public pour la même raison que `parseDate` (consommé par la présentation client). */
  static validNow(now: Date): boolean {
    return now instanceof Date && !Number.isNaN(now.getTime());
  }

  /** Jours ENTIERS de `now` vers l'échéance `iso` (négatif si déjà passée) ; null si date/`now`
      invalide. Différence de MINUITS UTC → entier exact (plancher), granularité « jour ». */
  static daysUntil(iso: string | null | undefined, now: Date): number | null {
    const d = Lifecycle.parseDate(iso);
    if (!d || !Lifecycle.validNow(now)) return null;
    const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor((b - a) / Lifecycle.DAY_MS);
  }

  /** DÉCISION d'état de garantie — la sémantique EXACTE de l'ex-`LifecycleFormat.warranty`
      SANS les libellés : `err` = dépassement STRICT (jours < 0), `warn` = J-0 à J-90 inclus
      (le jour de l'échéance est encore couvert), `ok` au-delà ; null si vide/illisible/`now`
      invalide. C'est LA frontière partagée : l'affichage client et le veilleur serveur la
      consomment tous deux — aucune re-dérivation ailleurs. */
  static warrantyStatus(iso: string | null | undefined, now: Date): WarrantyStatus | null {
    const days = Lifecycle.daysUntil(iso, now);
    if (days === null) return null;
    if (days < 0) return "err";
    return days <= Lifecycle.WARN_DAYS ? "warn" : "ok";
  }
}

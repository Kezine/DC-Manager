/* =============================================================================
   InterventionsFormat — logique PURE de la page « Interventions » (aucun DOM,
   aucun store, aucun réseau, AUCUNE dépendance i18n) : elle ne fait QUE renvoyer
   des CLÉS de traduction (que la vue passe à I18n.t) et mettre en forme des
   valeurs déjà chaînées. Rester i18n-agnostique la garde testable headless
   (Tests/modules/test-interventions.js) et réutilisable.

   POURQUOI des clés plutôt que des libellés (principes n°2/n°7) : le module reste
   pur (pas d'import de I18n), la vue localise au point d'affichage. Les slugs de
   kind/status/priority/target sont des MIROIRS des énumérations serveur
   (INTERVENTION_KINDS…, duplication assumée principe n°3 — préserve l'amovibilité).
   ============================================================================= */

/** Classe de couleur d'un badge (mappée en variable CSS par la vue). */
export type BadgeClass = "ok" | "warn" | "err" | "dim" | "neutral";

export class InterventionsFormat {
  /** Natures d'objet — MIROIR de INTERVENTION_KINDS (serveur). */
  static readonly KIND_SLUGS: readonly string[] = ["incident", "intervention"];
  /** Cycle de vie — MIROIR de INTERVENTION_STATUSES (serveur), dans l'ordre canonique. */
  static readonly STATUS_SLUGS: readonly string[] = ["declared", "planned", "in_progress", "closed", "cancelled"];
  /** Priorités (ordre de traitement) — MIROIR de INTERVENTION_PRIORITIES (serveur), du plus faible au plus fort. */
  static readonly PRIORITY_SLUGS: readonly string[] = ["low", "normal", "high", "critical"];
  /** Familles de cibles liables — MIROIR de INTERVENTION_TARGET_KINDS (serveur). */
  static readonly TARGET_KIND_SLUGS: readonly string[] = ["equipment", "vm", "spare"];

  /* ---- Clés i18n (la vue appelle I18n.t dessus) ---- */

  /** Clé du libellé d'une nature d'objet (ex. « interventions.kind.incident »). */
  static kindLabelKey(slug: string): string { return "interventions.kind." + slug; }
  /** Clé du libellé d'un statut (ex. « interventions.status.in_progress »). */
  static statusLabelKey(slug: string): string { return "interventions.status." + slug; }
  /** Clé du libellé d'une priorité (ex. « interventions.priority.critical »). */
  static priorityLabelKey(slug: string): string { return "interventions.priority." + slug; }
  /** Clé du libellé d'une famille de cible (ex. « interventions.target.equipment »). */
  static targetKindLabelKey(slug: string): string { return "interventions.target." + slug; }

  /* ---- Rangs & couleurs (pur — la vue mappe les classes en variables CSS) ---- */

  /** Rang SÉMANTIQUE d'une priorité (low 0 → critical 3) ; -1 si slug inconnu. Parité avec le tri serveur. */
  static priorityRank(slug: string): number {
    return InterventionsFormat.PRIORITY_SLUGS.indexOf(slug);
  }

  /** Classe de badge d'une priorité, d'intensité croissante avec le rang (low → dim, critical → err). */
  static priorityClass(slug: string): BadgeClass {
    switch (slug) {
      case "critical": return "err";
      case "high":     return "warn";
      case "normal":   return "neutral";
      case "low":      return "dim";
      default:         return "neutral";
    }
  }

  /** Classe de badge d'un statut : en cours = attention (warn), clos = ok, annulé = estompé, sinon neutre. */
  static statusClass(slug: string): BadgeClass {
    switch (slug) {
      case "in_progress": return "warn";
      case "closed":      return "ok";
      case "cancelled":   return "dim";
      default:            return "neutral";
    }
  }

  /* ---- Jira (simple RÉFÉRENCE : aucun appel réseau) ---- */

  /** URL cliquable d'une référence Jira, ou null si non affichable en lien :
      - `ref` vide/nul → null ;
      - `ref` DÉJÀ une URL (http(s)://…) → renvoyée telle quelle (la base est ignorée) ;
      - sinon `base` absente → null (la vue affiche la référence en texte) ;
      - sinon `base` + `ref` avec UN seul « / » de jointure (base sans slash final et ref sans slash initial). */
  static jiraUrl(base: string | null, ref: string | null): string | null {
    const r = typeof ref === "string" ? ref.trim() : "";
    if (r === "") return null;
    if (/^https?:\/\//i.test(r)) return r;
    const b = typeof base === "string" ? base.trim() : "";
    if (b === "") return null;
    return b.replace(/\/+$/, "") + "/" + r.replace(/^\/+/, "");
  }

  /* ---- Fenêtre planifiée + id court ---- */

  /** Fenêtre d'intervention lisible « AAAA-MM-JJ HH:MM → AAAA-MM-JJ HH:MM » (repli propre si `end` absent :
      seul le début). `start` absent → chaîne vide (la vue n'affiche rien). Les instants sont rendus TELS
      QUE STOCKÉS (portion ISO UTC tronquée) — déterministe (aucune dépendance au fuseau) et cohérent avec le
      veilleur serveur. */
  static formatWindow(start: string | null | undefined, end: string | null | undefined): string {
    const s = InterventionsFormat.trimIso(start);
    if (s === "") return "";
    const e = InterventionsFormat.trimIso(end);
    return e === "" ? s : s + " → " + e;
  }

  /** ISO 8601 → « AAAA-MM-JJ HH:MM » (portion tronquée) ; chaîne vide si absent/illisible. */
  private static trimIso(iso: string | null | undefined): string {
    if (typeof iso !== "string" || iso.trim() === "") return "";
    return iso.slice(0, 16).replace("T", " ");
  }

  /** Forme COURTE et lisible d'un identifiant : 8 premiers caractères + « … » au-delà de 10 (les ids plus
      courts sont laissés tels quels). Confort d'affichage (pattern CertsFormat.shortId). */
  static shortId(id: string): string {
    const s = String(id || "");
    return s.length > 10 ? s.slice(0, 8) + "…" : s;
  }
}

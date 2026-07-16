/* =============================================================================
   VALIDATION PURE du module `interventions/` (incidents & interventions) — même
   philosophie que CertsValidate/NotifyValidate : classe PURE (ni DB, ni réseau),
   griefs GROUPÉS (l'UI montre tout d'un coup), messages français uniques.

   Les identifiants de kind/status/priority/target sont des SLUGS ANGLAIS (comme
   les CERT_KINDS) : les libellés français/anglais viendront du CLIENT (i18n). Le
   serveur, lui, reste en français dans ses messages d'erreur (décision de cadrage).

   Les champs d'AUDIT (created_by/date, updated_by/date, closed_date) ne sont JAMAIS
   acceptés du client : c'est le SERVEUR qui les pose (InterventionsDb.save). Ce parseur les
   ignore purement et simplement — un client qui les enverrait n'a aucun effet.
   ============================================================================= */

/** Nature de l'objet suivi : un incident SUBI (panne, sinistre) ou une intervention
    PLANIFIÉE (maintenance, changement). Deux slugs — les libellés viennent du client. */
export const INTERVENTION_KINDS = ["incident", "intervention"] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

/** Cycle de vie. UN SEUL état terminal « closed » (décision de cadrage : pas de
    « résolu » distinct). `cancelled` = abandonné sans traitement ; `closed` = clos. */
export const INTERVENTION_STATUSES = ["declared", "planned", "in_progress", "closed", "cancelled"] as const;
export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number];

/** Priorité = ORDRE DE TRAITEMENT / complexité (PAS une gravité d'incident), du plus
    faible au plus fort. Sert notamment de rang de tri sémantique (cf. InterventionsDb). */
export const INTERVENTION_PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type InterventionPriority = (typeof INTERVENTION_PRIORITIES)[number];

/** Nature d'une cible LIÉE. Les cibles vivent dans les `.db` des DOCUMENTS (bases
    séparées) : aucune FK n'est possible ici — le lien est un simple couple (kind, id),
    les orphelins sont TOLÉRÉS (c'est le client qui affichera « introuvable »). */
export const INTERVENTION_TARGET_KINDS = ["equipment", "vm", "spare"] as const;
export type InterventionTargetKind = (typeof INTERVENTION_TARGET_KINDS)[number];

/** Bornes de texte — un titre/une réf. Jira tiennent en une ligne ; la description est du
    markdown (rendu côté client plus tard) et peut être longue, mais bornée (anti-abus). */
const MAX_TITLE_CHARS = 300;
const MAX_JIRA_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 100_000;
/** Un objet lie quelques équipements/VMs/spares ; 200 est une marge très large (anti-abus). */
const MAX_LINKS = 200;
const MAX_TARGET_ID_CHARS = 200;

/** Lien VALIDÉ vers une cible (l'ordre du tableau devient `position` en DB). */
export interface InterventionLinkCandidate {
  target_kind: InterventionTargetKind;
  target_id: string;
}

/** Intervention/incident VALIDÉ prêt à persister (SANS les champs d'audit : le serveur les pose). */
export interface InterventionCandidate {
  id: string;
  kind: InterventionKind;
  title: string;
  description: string;
  status: InterventionStatus;
  priority: InterventionPriority;
  planned_start: string | null;
  planned_end: string | null;
  jira_ref: string | null;
  links: InterventionLinkCandidate[];
}

/** Erreur de validation à N griefs — les routes la traduisent en 400 { issues }. */
export class InterventionsConfigError extends Error {
  constructor(readonly issues: string[]) {
    super("données d'intervention invalides : " + issues.join(" · "));
    this.name = "InterventionsConfigError";
  }
}

export class InterventionsValidate {
  /** Valide/normalise un candidat (id fourni par l'URL, immuable en édition). */
  static parse(id: string, candidate: Record<string, unknown>): InterventionCandidate {
    const issues: string[] = [];
    if (typeof id !== "string" || id.trim() === "") issues.push("id : requis (segment d'URL)");

    const kind = typeof candidate.kind === "string" ? candidate.kind.trim() : "";
    if (!(INTERVENTION_KINDS as readonly string[]).includes(kind)) issues.push("kind : requis, parmi " + INTERVENTION_KINDS.join(" | "));

    const status = typeof candidate.status === "string" ? candidate.status.trim() : "";
    if (!(INTERVENTION_STATUSES as readonly string[]).includes(status)) issues.push("status : requis, parmi " + INTERVENTION_STATUSES.join(" | "));

    const priority = typeof candidate.priority === "string" ? candidate.priority.trim() : "";
    if (!(INTERVENTION_PRIORITIES as readonly string[]).includes(priority)) issues.push("priority : requis, parmi " + INTERVENTION_PRIORITIES.join(" | "));

    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (title === "") issues.push("title : requis (non vide)");
    else if (title.length > MAX_TITLE_CHARS) issues.push("title : dépasse " + MAX_TITLE_CHARS + " caractères");

    // description : markdown OPTIONNEL (défaut chaîne vide), simplement borné. On NE trim PAS
    // (le markdown peut vouloir des espaces/retours en tête), mais on refuse ce qui n'est pas une chaîne.
    let description = "";
    if (candidate.description !== undefined && candidate.description !== null) {
      if (typeof candidate.description !== "string") issues.push("description : chaîne attendue");
      else if (candidate.description.length > MAX_DESCRIPTION_CHARS) issues.push("description : dépasse " + MAX_DESCRIPTION_CHARS + " caractères");
      else description = candidate.description;
    }

    // jira_ref : simple RÉFÉRENCE (clé INFRA-123 ou URL) — aucun appel Jira. null accepté.
    let jiraRef: string | null = null;
    if (candidate.jira_ref !== undefined && candidate.jira_ref !== null && candidate.jira_ref !== "") {
      if (typeof candidate.jira_ref !== "string") issues.push("jira_ref : chaîne attendue");
      else if (candidate.jira_ref.trim().length > MAX_JIRA_CHARS) issues.push("jira_ref : dépasse " + MAX_JIRA_CHARS + " caractères");
      else jiraRef = candidate.jira_ref.trim();
    }

    // Fenêtre d'intervention OPTIONNELLE : end EXIGE start, et end ≥ start (invariant chronologique).
    const plannedStart = InterventionsValidate.parseIso("planned_start", candidate.planned_start, issues);
    const plannedEnd = InterventionsValidate.parseIso("planned_end", candidate.planned_end, issues);
    if (plannedEnd !== null && plannedStart === null) issues.push("planned_end : exige planned_start (pas de fin sans début)");
    if (plannedStart !== null && plannedEnd !== null && Date.parse(plannedEnd) < Date.parse(plannedStart)) {
      issues.push("planned_end : antérieur à planned_start");
    }

    const links = InterventionsValidate.parseLinks(candidate.links, issues);

    if (issues.length) throw new InterventionsConfigError(issues);
    return {
      id: id.trim(), kind: kind as InterventionKind, title, description,
      status: status as InterventionStatus, priority: priority as InterventionPriority,
      planned_start: plannedStart, planned_end: plannedEnd, jira_ref: jiraRef, links,
    };
  }

  /** Base d'URL Jira pour fabriquer un lien depuis une clé (ex. « https://monorg.atlassian.net/browse/ »).
      Variable d'env JIRA_BASE_URL, trimmée ; vide/absente → null. `env` INJECTABLE (test). Vit ICI (module
      PUR, sans express) plutôt que sur InterventionsModule pour rester testable en isolation — la façade
      route ne fait que la RELAYER dans GET /meta. Simple RÉFÉRENCE : aucun appel Jira côté serveur. */
  static jiraBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = typeof env.JIRA_BASE_URL === "string" ? env.JIRA_BASE_URL.trim() : "";
    return raw !== "" ? raw : null;
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Date ISO 8601 optionnelle → chaîne normalisée ou null (grief si illisible). */
  private static parseIso(field: string, value: unknown, issues: string[]): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      issues.push(field + " : date ISO 8601 attendue");
      return null;
    }
    return value;
  }

  /** Liens : tableau ORDONNÉ (l'ordre devient `position`), types du cadrage, ids non vides bornés.
      Un lien malformé produit un grief mais n'interrompt pas l'examen des autres (griefs groupés). */
  private static parseLinks(value: unknown, issues: string[]): InterventionLinkCandidate[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) { issues.push("links : tableau attendu"); return []; }
    if (value.length > MAX_LINKS) issues.push("links : dépasse " + MAX_LINKS + " entrées");
    const out: InterventionLinkCandidate[] = [];
    value.slice(0, MAX_LINKS).forEach((entry, index) => {
      const kind = entry && typeof entry.target_kind === "string" ? entry.target_kind.trim() : "";
      const id = entry && typeof entry.target_id === "string" ? entry.target_id.trim() : "";
      if (!(INTERVENTION_TARGET_KINDS as readonly string[]).includes(kind)) { issues.push("links[" + index + "].target_kind : parmi " + INTERVENTION_TARGET_KINDS.join(" | ")); return; }
      if (id === "") { issues.push("links[" + index + "].target_id : requis"); return; }
      if (id.length > MAX_TARGET_ID_CHARS) { issues.push("links[" + index + "].target_id : dépasse " + MAX_TARGET_ID_CHARS + " caractères"); return; }
      out.push({ target_kind: kind as InterventionTargetKind, target_id: id });
    });
    return out;
  }
}

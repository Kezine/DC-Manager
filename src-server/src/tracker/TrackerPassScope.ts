/* =============================================================================
   PÉRIMÈTRE D'UNE PASSE DE SYNCHRO — plafond ROULANT (module PUR, sans dépendance).

   Extrait du service de synchro (chantier « remote issue tracker », lot L3) pour
   survivre au PIVOT du chantier vers la réplication des interventions dans Jira :
   la leçon qu'il porte est indépendante de ce qu'on synchronise, et elle a coûté
   assez cher pour ne pas être réapprise.

   ── POURQUOI UN ROULEMENT, ET PAS UN SIMPLE TRI ──────────────────────────────
   Une passe de synchro est PLAFONNÉE : l'assiette est pilotée par l'utilisateur
   (rien n'empêche de suivre des milliers d'objets), et une passe non bornée
   finirait par marteler le tracker (429) ou dépasser tout délai raisonnable.
   Le réflexe est alors de trier par « le moins récemment synchronisé d'abord » et
   de prendre les N premiers. ⚠ CE RÉFLEXE EST FAUX ICI, et le défaut est
   SILENCIEUX : la synchro est IDEMPOTENTE, donc elle n'écrit `last_sync` que sur
   un objet qui a CHANGÉ. Sur une assiette STABLE — le cas nominal, justement —
   aucun `last_sync` ne bouge, l'ordre reste donc identique d'une passe à l'autre,
   et la QUEUE de l'assiette n'est JAMAIS interrogée. Une zone morte permanente,
   qu'aucun log ne signale puisque chaque passe se termine « normalement ».
   D'où la FENÊTRE CIRCULAIRE : la passe part d'un curseur mémorisé et boucle sur
   la liste ; `nextStart` dit où reprendre. L'assiette entière défile en
   ⌈N/plafond⌉ passes, que quelque chose change ou non.

   Portée : module SERVEUR pur (ni Express, ni SQLite, ni réseau) — il ne connaît
   ni le tracker, ni le document, ni la collection interrogée. C'est ce qui le rend
   testable seul, et c'est là que se joue TOUT le comportement du plafond.
   ============================================================================= */

/** Enregistrement d'assiette, vu par le calcul de périmètre : on n'y lit que l'IDENTITÉ côté
    tracker et la date de dernière synchro. Forme volontairement LÂCHE (`any`) — l'entrée vient
    d'un dépôt, d'un document importé ou d'une base de module, jamais d'une source de confiance. */
export interface PassScopeItem { [field: string]: any }

/** Périmètre calculé d'UNE passe. */
export interface PassScope {
  /** Identités à interroger chez le tracker, dans l'ordre de priorité de la passe. */
  batch: string[];
  /** Combien d'objets de l'assiette sont REPORTÉS à une passe ultérieure (0 = assiette entière).
      ⚠ À JOURNALISER et à remonter au statut : un plafond silencieux se lirait « tout est à jour »
      alors que la moitié de l'assiette n'a pas été regardée. */
  skipped: number;
  /** RANG où la passe suivante doit reprendre (0 quand l'assiette tient sous le plafond). */
  nextStart: number;
}

export class TrackerPassScope {
  /** PÉRIMÈTRE D'UNE PASSE : quels identifiants interroger, combien sont reportés, et où reprendre
      à la passe suivante.

      ORDRE STABLE : `lastSyncField` CROISSANT (les jamais synchronisés d'abord, `""` triant avant
      tout horodatage ISO), départage par l'identité. Il donne une priorité SENSÉE au premier tour —
      on regarde d'abord ce qu'on n'a jamais regardé.

      ROULEMENT : quand l'assiette dépasse le plafond, la fenêtre part de `startAt` et boucle sur la
      liste ; `nextStart` dit où reprendre (cf. l'en-tête : un simple tri n'y suffirait PAS).
      Assiette sous le plafond → aucun roulement (`nextStart` remis à 0).

      Les DEUX noms de champ sont des paramètres et non des constantes : le module ne présume rien
      de la collection qu'il borne (tickets suivis hier, interventions répliquées demain). */
  static compute(
    items: readonly PassScopeItem[],
    max: number,
    startAt: number = 0,
    idField: string = "ext_id",
    lastSyncField: string = "last_sync",
  ): PassScope {
    const seen = new Set<string>();
    const candidates: { extId: string; lastSync: string }[] = [];
    for (const item of items) {
      const extId = item && typeof item[idField] === "string" ? item[idField].trim() : "";
      if (extId === "" || seen.has(extId)) continue;   // sans identité → inréconciliable ; doublon → une seule demande
      seen.add(extId);
      candidates.push({ extId, lastSync: typeof item[lastSyncField] === "string" ? item[lastSyncField] : "" });
    }
    candidates.sort((a, b) => (a.lastSync < b.lastSync ? -1 : a.lastSync > b.lastSync ? 1 : a.extId.localeCompare(b.extId)));
    const limit = max > 0 ? max : candidates.length;   // plafond absurde (0/négatif) → aucun plafond, plutôt qu'une passe morte
    if (candidates.length <= limit) return { batch: candidates.map((c) => c.extId), skipped: 0, nextStart: 0 };
    // Fenêtre CIRCULAIRE : `startAt` est ramené dans les bornes (un curseur mémorisé peut dépasser
    // après un retrait d'objets), puis on prend `limit` éléments en bouclant sur la liste.
    const start = ((startAt % candidates.length) + candidates.length) % candidates.length;
    const batch: string[] = [];
    for (let i = 0; i < limit; i++) batch.push(candidates[(start + i) % candidates.length].extId);
    return { batch, skipped: candidates.length - limit, nextStart: (start + limit) % candidates.length };
  }
}

/* =============================================================================
   CertsFormat — logique PURE de la page « Certificats » (aucun DOM, aucun store,
   aucun réseau) : calcul des jours restants avant échéance + classe de couleur,
   libellés lisibles des familles d'objets (kind), et résolution du libellé de
   l'ÉMETTEUR d'un dérivé depuis les items d'une page (colonne « Émetteur » de la
   vue B — le listing est paginé serveur, on résout depuis ce qui est affiché).

   Pourquoi une classe pure dédiée (principes n°2/n°7) : ces règles sont testables
   en isolation (Tests/modules/test-certs.js) et réutilisables par la vue sans la
   charger de calculs. La vue (CertsAdminView) ne fait qu'assembler le DOM ; toute
   arithmétique (échéance) ou mise en forme passe ICI.

   SEUILS D'ÉCHÉANCE (cadrage certs 2026-07-14 §5) : ok > 30 j · warn ≤ 30 j ·
   err ≤ 7 j OU expiré · « — » (none) sans date d'expiration. Les seuils sont des
   constantes nommées pour être ré-employés/testés sans les redécouvrir.
   ============================================================================= */

/** Classe de couleur d'une échéance (mappée en variable CSS par la vue). */
export type ExpiryClass = "ok" | "warn" | "err" | "none";

export class CertsFormat {
  /** Seuil d'AVERTISSEMENT (orange) : échéance à 30 jours ou moins (décision de cadrage §5). */
  static readonly WARN_DAYS = 30;
  /** Seuil CRITIQUE (rouge) : échéance à 7 jours ou moins — ou déjà expiré (jours < 0). */
  static readonly CRIT_DAYS = 7;

  /** Millisecondes par jour (constante nommée : évite les 86400000 magiques). */
  private static readonly DAY_MS = 24 * 60 * 60 * 1000;

  /** Libellés lisibles des familles d'objets (MIROIR des CERT_KINDS serveur). */
  static readonly KIND_LABELS: Record<string, string> = {
    "root-ca": "CA racine X.509",
    "leaf-tls": "Certificat TLS",
    "ssh-ca": "CA SSH",
    "ssh-keypair": "Paire SSH",
    "ssh-cert": "Certificat SSH",
  };

  /** Jours ENTIERS restants avant `not_after` (négatif si déjà expiré) ; null si pas de
      date ou date illisible. `nowMs` injectable pour des tests déterministes. Arrondi PLANCHER :
      « il reste 0 jour » couvre les dernières 24 h (⇒ « expire aujourd'hui »). */
  static daysUntil(notAfter: string | null | undefined, nowMs: number = Date.now()): number | null {
    if (typeof notAfter !== "string" || notAfter.trim() === "") return null;
    const t = Date.parse(notAfter);
    if (Number.isNaN(t)) return null;
    return Math.floor((t - nowMs) / CertsFormat.DAY_MS);
  }

  /** Classe de couleur d'une échéance selon les seuils du cadrage (§5). Sans date → « none »
      (l'appelant rend « — »). ≤ 7 j (ou expiré) → err ; ≤ 30 j → warn ; sinon → ok. */
  static expiryClass(notAfter: string | null | undefined, nowMs: number = Date.now()): ExpiryClass {
    const days = CertsFormat.daysUntil(notAfter, nowMs);
    if (days === null) return "none";
    if (days <= CertsFormat.CRIT_DAYS) return "err";   // couvre l'expiré (jours < 0)
    if (days <= CertsFormat.WARN_DAYS) return "warn";
    return "ok";
  }

  /** Libellé français lisible de l'échéance : « — » (sans date), « expiré (il y a N j) »,
      « expire aujourd'hui », « dans 1 jour », « dans N jours ». */
  static expiryLabel(notAfter: string | null | undefined, nowMs: number = Date.now()): string {
    const days = CertsFormat.daysUntil(notAfter, nowMs);
    if (days === null) return "—";
    if (days < 0) return "expiré (il y a " + (-days) + " j)";
    if (days === 0) return "expire aujourd'hui";
    if (days === 1) return "dans 1 jour";
    return "dans " + days + " jours";
  }

  /** Libellé lisible d'une famille d'objet — repli sur la valeur brute si inconnue. */
  static kindLabel(kind: string): string {
    return CertsFormat.KIND_LABELS[kind] || kind;
  }

  /** Libellé d'affichage de l'ÉMETTEUR d'un dérivé (colonne « Émetteur » de la vue B). Le listing étant
      paginé SERVEUR, on résout le libellé du parent DEPUIS les items de la page courante ; s'il n'y figure
      pas (émetteur sur une AUTRE page du sous-arbre), on retombe sur son id COURT (aucune requête par ligne —
      limite assumée, cadrage §3). Sans parent (parent_id nul/vide) → « — ». */
  static issuerLabel(parentId: string | null | undefined, items: Array<{ id: string; label: string }>): string {
    if (typeof parentId !== "string" || parentId === "") return "—";
    const found = (Array.isArray(items) ? items : []).find((it) => it.id === parentId);
    return found ? found.label : CertsFormat.shortId(parentId);
  }

  /** Forme COURTE et lisible d'un identifiant (id d'émetteur non résolu) : 8 premiers caractères + « … »
      au-delà de 10 (les ids plus courts sont laissés tels quels). Aucune donnée sensible — simple confort
      d'affichage quand le libellé n'est pas résoluble depuis la page. */
  static shortId(id: string): string {
    const s = String(id || "");
    return s.length > 10 ? s.slice(0, 8) + "…" : s;
  }
}

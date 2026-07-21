/* =============================================================================
   RevocationReasons — raisons de révocation NORMÉES (codes CRL X.509) + encodage
   de la valeur stockée. Module PUR (aucun DOM, aucun réseau) → testable headless.

   Le champ serveur `revocation_reason` est UNE chaîne ; on y encode le code standard
   éventuellement suivi d'une NOTE libre, au format « <code>: <note> » (ou « <code> »
   sans note). `decode` rétablit la paire pour l'affichage ; un contenu non reconnu
   (legacy / libre) est rendu ENTIÈREMENT comme note (code vide) — jamais perdu.

   Sous-ensemble PERTINENT des reason codes de la RFC 5280 (§5.3.1) pour une PKI
   interne : on écarte ceux sans usage ici (certificateHold/removeFromCRL — suspension
   temporaire ; aACompromise — attributs). Le renouvellement pré-sélectionne « superseded ».
   ============================================================================= */

/** Codes de raison proposés (ordre d'affichage). `unspecified` = défaut neutre. */
export const REVOCATION_REASON_CODES = [
  "unspecified",
  "superseded",
  "keyCompromise",
  "cessationOfOperation",
  "affiliationChanged",
  "privilegeWithdrawn",
] as const;

export type RevocationReasonCode = (typeof REVOCATION_REASON_CODES)[number];

/** Code posé automatiquement lors d'un RENOUVELLEMENT (le certificat est remplacé par un neuf). */
export const RENEWAL_REASON_CODE: RevocationReasonCode = "superseded";

export class RevocationReasons {
  /** Clés i18n des libellés lisibles (résolues par I18n.t AU POINT DE RENDU, jamais au chargement). */
  static readonly LABEL_KEY: Record<string, string> = {
    unspecified: "certs.admin.revoke.reason.unspecified",
    superseded: "certs.admin.revoke.reason.superseded",
    keyCompromise: "certs.admin.revoke.reason.keyCompromise",
    cessationOfOperation: "certs.admin.revoke.reason.cessationOfOperation",
    affiliationChanged: "certs.admin.revoke.reason.affiliationChanged",
    privilegeWithdrawn: "certs.admin.revoke.reason.privilegeWithdrawn",
  };

  /** Un code fait-il partie du jeu normé ? */
  static isKnown(code: string): code is RevocationReasonCode {
    return (REVOCATION_REASON_CODES as readonly string[]).includes(code);
  }

  /** Encode (code, note) en la chaîne stockée dans `revocation_reason`. Code vide → `unspecified`. */
  static encode(code: string, note: string): string {
    const c = RevocationReasons.isKnown((code || "").trim()) ? (code || "").trim() : "unspecified";
    const n = (note || "").trim();
    return n ? c + ": " + n : c;
  }

  /** Décode la valeur stockée → { code, note }. Séparateur = PREMIER « : ». Un préfixe non reconnu
      (ou une valeur libre historique) bascule ENTIÈREMENT en note (code = "") — aucun contenu perdu. */
  static decode(stored: string | null | undefined): { code: string; note: string } {
    const s = (stored || "").trim();
    if (s === "") return { code: "", note: "" };
    const idx = s.indexOf(":");
    if (idx > 0) {
      const code = s.slice(0, idx).trim();
      if (RevocationReasons.isKnown(code)) return { code, note: s.slice(idx + 1).trim() };
    }
    return RevocationReasons.isKnown(s) ? { code: s, note: "" } : { code: "", note: s };
  }
}

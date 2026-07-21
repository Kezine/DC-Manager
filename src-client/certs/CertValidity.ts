/* =============================================================================
   CertValidity — calculs PURS de validité relative CA ⇄ enfant (aucun DOM, aucun
   réseau) → testable headless comme les autres modules `certs/`.

   INVARIANT MÉTIER : un certificat enfant ne peut pas vivre AU-DELÀ de sa CA (sinon
   la chaîne présente un maillon dont la validité déborde l'ancre — rejeté par les
   vérificateurs). Ce module fournit l'arithmétique de dates qui sert deux usages :
   - le FORMULAIRE d'émission plafonne la durée saisie (`daysUntil`) ;
   - les renouvellements EN LOT rognent la durée demandée à ce qui reste sur la CA
     (`clampDays`).
   Le rejet dur de l'invariant vit, lui, dans X509Factory.issueLeaf (source de vérité).
   ============================================================================= */

export class CertValidity {
  static readonly MS_PER_DAY = 86_400_000;

  /** Jours ENTIERS restant jusqu'à `notAfterIso` depuis `now` (plancher 0, arrondi au jour inférieur).
      `null` si la CA n'a PAS d'échéance exploitable (absente/illisible) — ex. une CA SSH ed25519 n'a pas
      de `not_after`, donc aucun plafond ne s'applique à ses dérivés. */
  static daysUntil(notAfterIso: string | null | undefined, now: number): number | null {
    if (!notAfterIso) return null;
    const t = Date.parse(notAfterIso);
    if (!isFinite(t)) return null;
    return Math.max(0, Math.floor((t - now) / CertValidity.MS_PER_DAY));
  }

  /** Durée EFFECTIVE (jours) d'un enfant émis sous une CA : la durée DEMANDÉE, ROGNÉE à ce qui reste sur la
      CA. Si la CA n'a pas d'échéance (`daysUntil` null), la demande passe telle quelle. Plancher 1 jour :
      renvoyer < 1 n'aurait pas de sens (une CA déjà expirée sera de toute façon rejetée par le guard dur —
      les flux de renouvellement de CA renouvellent la CA AVANT ses enfants). */
  static clampDays(requestedDays: number, caNotAfterIso: string | null | undefined, now: number): number {
    const requested = Math.max(1, Math.floor(Number(requestedDays) || 0));
    const maxDays = CertValidity.daysUntil(caNotAfterIso, now);
    if (maxDays === null) return requested;
    return Math.max(1, Math.min(requested, maxDays));
  }

  /** La durée demandée dépasse-t-elle ce qui reste sur la CA ? (`false` si la CA n'a pas d'échéance.)
      Utilisé par le formulaire pour un message d'erreur explicite AVANT d'appeler la fabrique. */
  static exceedsCa(requestedDays: number, caNotAfterIso: string | null | undefined, now: number): boolean {
    const maxDays = CertValidity.daysUntil(caNotAfterIso, now);
    if (maxDays === null) return false;
    return Math.floor(Number(requestedDays) || 0) > maxDays;
  }

  /** Durée D'ORIGINE d'un certificat (jours entiers entre not_before et not_after) — sert à PRÉ-REMPLIR la
      durée d'un renouvellement à l'identique. Repli `fallback` si l'une des dates manque/est illisible
      (ex. objet SSH sans dates). Plancher 1. */
  static durationDays(notBeforeIso: string | null | undefined, notAfterIso: string | null | undefined, fallback: number): number {
    if (!notBeforeIso || !notAfterIso) return fallback;
    const before = Date.parse(notBeforeIso), after = Date.parse(notAfterIso);
    if (!isFinite(before) || !isFinite(after) || after <= before) return fallback;
    return Math.max(1, Math.round((after - before) / CertValidity.MS_PER_DAY));
  }
}

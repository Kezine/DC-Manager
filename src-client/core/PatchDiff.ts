/* =============================================================================
   PatchDiff — un patch change-t-il RÉELLEMENT quelque chose ? (module PUR,
   aucun DOM, aucun store — dans l'esprit de `core/OptionSearch`).

   POURQUOI : la réconciliation d'un formulaire ré-émet TOUS ses champs au save,
   à l'identique quand l'utilisateur n'a rien modifié. Sans filtre, chaque
   « Enregistrer » à blanc déclenchait un `Store.update` PAR enregistrement
   intact (l'équipement ET chacun de ses ports) — soit, en mode API, une rafale
   de PUT + broadcast SSE pour rien, et dans tous les modes un `touch()` qui
   polluait `updated_date`. `Store.update` consulte donc CE module (point
   d'étranglement unique : tous les formulaires sont corrigés d'un coup) et ne
   fait RIEN quand le patch est sans effet.
   ============================================================================= */

/** Champs EXCLUS de la comparaison — les inclure rendrait tout patch « changeant » :
    - `id` / `created_date` : jamais écrits par le patch (`Store._applyPatch` les ignore) ;
    - `updated_date` : posé par `touch()` À l'écriture — c'est une conséquence du save, pas une saisie ;
    - `created_by` / `updated_by` : audit posé par le SERVEUR, le client ne les émet jamais
      (cf. l'en-tête de `models/Entity.ts`). */
const IGNORED_FIELDS = new Set(["id", "created_date", "updated_date", "created_by", "updated_by"]);

export class PatchDiff {
  /** Vrai si AU MOINS un champ du patch diffère de la valeur courante (hors champs techniques
      ci-dessus). Un champ du patch ABSENT de `current` compte comme un changement — repli sûr :
      dans le doute, on écrit (comportement d'avant le filtre). */
  static changes(current: Record<string, any>, patch: Record<string, any>): boolean {
    for (const field of Object.keys(patch)) {
      if (IGNORED_FIELDS.has(field)) continue;
      if (!PatchDiff.same(current[field], patch[field])) return true;
    }
    return false;
  }

  /** Égalité PROFONDE : primitives par `===`, tableaux ORDONNÉS élément par élément (l'ordre
      porte du sens — ex. `waypoint_ids` est une route), objets par ensemble de clés + valeurs
      (récursif). ⚠ `null` vs `undefined` = DIFFÉRENTS : c'est le repli sûr — on écrit, comme
      avant le filtre, plutôt que d'avaler silencieusement une distinction qu'un normaliseur
      pourrait exploiter. */
  static same(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;   // l'un des deux nul/absent (et pas l'autre, sinon ===)
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) { if (!PatchDiff.same(a[i], b[i])) return false; }
      return true;
    }
    if (typeof a === "object" && typeof b === "object") {
      const keysA = Object.keys(a), keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || !PatchDiff.same(a[key], b[key])) return false;
      }
      return true;
    }
    return false;   // primitives inégales (NaN compris : différent → on écrit, repli sûr)
  }
}

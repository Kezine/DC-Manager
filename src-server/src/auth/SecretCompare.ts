import { createHash, timingSafeEqual } from "node:crypto";

/* =============================================================================
   COMPARAISON DE SECRETS À TEMPS CONSTANT — helper du dossier `auth/`.

   Extrait de `BasicAuthProvider` (où il vivait en privé) le jour où un SECOND
   consommateur est apparu : le secret partagé proxy↔app de
   `ForwardHeaderAuthProvider`. Le commentaire du lot 3 l'annonçait
   explicitement — « pas avant : un point d'extension que personne n'utilise
   coûte plus qu'il ne rend ». Il y a maintenant deux appelants, donc une
   duplication à éviter (principe n°3) et une règle de sécurité qu'on ne veut
   écrite qu'UNE fois.

   ── Pourquoi hacher AVANT de comparer ─────────────────────────────────────
   `timingSafeEqual` EXIGE deux buffers de même longueur (il jette sinon), et
   comparer les chaînes brutes ferait fuiter la LONGUEUR du secret par la durée.
   Hacher les deux entrées en SHA-256 donne deux buffers de 32 octets — même
   taille par construction, quelle que soit la longueur des secrets.

   Contrairement à `===` (court-circuit au premier caractère divergent), le
   temps ne dépend plus du nombre de caractères de tête corrects : un attaquant
   ne peut plus deviner le secret caractère par caractère au chronomètre.

   Aucune dépendance hors `node:crypto` → testable en isolation.
   ============================================================================= */
export class SecretCompare {
  /** Les deux chaînes sont-elles égales ? Réponse en temps CONSTANT (cf. l'en-tête).
      ⚠ Toujours évaluer les comparaisons d'un couple SANS court-circuit (`const a = …; const b = …;`
      puis `a && b`) : sinon le nombre de comparaisons effectuées distingue « premier champ faux »
      de « second champ faux », ce qui livre le premier à l'attaquant. */
  static equals(a: string, b: string): boolean {
    const hashedA = createHash("sha256").update(a).digest();
    const hashedB = createHash("sha256").update(b).digest();
    return timingSafeEqual(hashedA, hashedB);
  }
}

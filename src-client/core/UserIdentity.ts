/* ============================================================================
   USER IDENTITY — le NOM AFFICHABLE d'un utilisateur (session SSO / `/me`).

   POURQUOI CE MODULE. Le nom « humain » d'un utilisateur se déduit d'une session
   dont les champs varient selon le provider d'authentification (`name` composé,
   `prenom`/`nom` séparés, `login`, e-mail…). Cette coalescence était écrite une
   fois dans la pastille de la topbar ; la modale d'infos utilisateur en a besoin
   du MÊME résultat. Plutôt que de dupliquer la règle (elle divergerait), on la
   dit ICI, une seule fois — module PUR (aucun DOM, aucun réseau), donc testable.

   L'ORDRE de repli est intentionnel : le nom explicite d'abord (le plus lisible),
   puis prénom + nom, puis les identifiants techniques (login, e-mail), enfin le
   `fallback` fourni par l'appelant (une chaîne déjà localisée, ex. « utilisateur »)
   — la localisation reste à la charge de l'appelant, ce module ne connaît pas i18n.
   ============================================================================ */

/** Forme LÂCHE d'une identité de session (passthrough `/me` — champs selon provider). */
export interface UserLike {
  name?: string;
  prenom?: string;
  nom?: string;
  login?: string;
  email?: string;
  eMail?: string;
}

export class UserIdentity {
  /** Nom affichable de `user`, avec repli final sur `fallback` (déjà localisé). `null`/`undefined`
      → `fallback` directement (aucune session). */
  static displayName(user: UserLike | null | undefined, fallback: string): string {
    if (!user) return fallback;
    const full = [user.prenom, user.nom].filter(Boolean).join(" ").trim();
    return user.name || full || user.login || user.eMail || user.email || fallback;
  }
}

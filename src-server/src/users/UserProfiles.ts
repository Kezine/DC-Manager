import type { RawUserProfile, ResolvedUser } from "./UserResolver.js";

/* =============================================================================
   UserProfiles — logique PURE de l'annuaire (aucun état, aucune I/O) : dérivation
   de la clé canonique, normalisation d'un profil brut, profil « dummy », caviardage
   des coordonnées et lecture souple d'une liste d'ids. Extraite en classe sémantique
   à méthodes statiques (principe n°2) pour être testable en isolation et réutilisée
   à l'identique par la capture (resolver), l'estampillage d'audit (RequestAuthor) et
   l'endpoint batch (Api) — une SEULE définition de « clé canonique » et de la règle
   de confidentialité (principe n°3).
   ============================================================================= */

export class UserProfiles {
  /** Clé canonique d'un utilisateur = identifiant STABLE sous lequel il est stocké/résolu.
      RÈGLE (arbitrage Q1) : `String(id)` SSO si présent (0 compris — un id numérique valide),
      SINON le `login` (repli quand le SSO ne fournit pas d'id, ou en mode basic/dev). Chaîne
      VIDE si ni l'un ni l'autre (profil dégénéré : ne sera pas mémorisé). */
  static canonicalId(user: RawUserProfile | null | undefined): string {
    if (!user) return "";
    if (user.id !== undefined && user.id !== null) {
      const fromId = String(user.id).trim();
      if (fromId !== "") return fromId;
    }
    return UserProfiles.str(user.login);
  }

  /** Normalise un profil BRUT (forme SSO) en `ResolvedUser` : id = clé canonique, mapping des
      libellés SSO (prenom→firstname, nom→lastname, eMail→email), domain conservé. Tout champ
      manquant devient la chaîne VIDE. `phone` est vide en v1 (le SSO ne le fournit pas). */
  static fromSsoUser(user: RawUserProfile | null | undefined): ResolvedUser {
    const u: RawUserProfile = user || {};
    return {
      id: UserProfiles.canonicalId(user),
      login: UserProfiles.str(u.login),
      domain: UserProfiles.str(u.domain),
      firstname: UserProfiles.str(u.prenom),
      lastname: UserProfiles.str(u.nom),
      email: UserProfiles.str(u.eMail),
      phone: "",
    };
  }

  /** Profil « dummy » d'un id INCONNU du resolver : l'id est conservé (le client affichera au
      moins l'id brut — cf. valeurs d'audit héritées, arbitrage Q5), les autres champs sont vides. */
  static dummy(id: string): ResolvedUser {
    return { id, login: "", domain: "", firstname: "", lastname: "", email: "", phone: "" };
  }

  /** Caviardage de CONFIDENTIALITÉ (arbitrage Q4) : email et téléphone ne sont exposés QUE pour
      l'utilisateur COURANT (l'appelant voit SES propres coordonnées). Pour autrui, ces deux champs
      sont VIDÉS ; nom/prénom/login/domaine restent visibles. Fonction PURE (testée) — appliquée par
      l'endpoint batch juste avant la réponse. */
  static redactFor(callerId: string, user: ResolvedUser): ResolvedUser {
    const isSelf = user.id !== "" && user.id === callerId;
    return isSelf ? user : { ...user, email: "", phone: "" };
  }

  /** Lecture SOUPLE d'un paramètre d'ids RÉPÉTABLE (`?id=…&id=…`, Express donne string | string[]) :
      trim, ignore les vides, DÉDUPLIQUE, PRÉSERVE l'ordre de première apparition et PLAFONNE à `cap`
      (anti-abus). Jamais d'erreur : une entrée invalide est simplement écartée. */
  static parseIdList(raw: unknown, cap: number): string[] {
    const arr: unknown[] = raw === undefined || raw === null ? [] : (Array.isArray(raw) ? raw : [raw]);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of arr) {
      const id = UserProfiles.str(value);
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= cap) break;
    }
    return out;
  }

  /** Coercition en chaîne TRIMÉE (null/undefined → ""), pour normaliser des champs SSO hétérogènes. */
  private static str(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }
}

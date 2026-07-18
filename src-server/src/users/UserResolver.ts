/* =============================================================================
   ANNUAIRE UTILISATEURS — CONTRAT (service CORE, PAS un module amovible).

   Les entités du cœur et des modules ne mémorisent qu'un IDENTIFIANT d'utilisateur
   (clé canonique, cf. UserProfiles.canonicalId) ; ce service le résout en un profil
   affichable « Prénom Nom », login, coordonnées. L'endpoint batch `GET /users/resolve`
   (monté dans Api) s'appuie dessus.

   INTERFACE-DRIVEN (principe n°2) : les consommateurs (Api, futur client) ne
   dépendent QUE de `UserResolver`. Deux implémentations possibles, SÉLECTIONNÉES au
   câblage (index.ts) :
   - v1 `AuthCacheUserResolver` : capture les profils au fil des authentifications
     réussies (puits `ProfileSink` injecté dans Auth) + snapshot SQLite « dernier
     profil vu » réhydraté au boot. Aucune connexion sortante.
   - future `SsoUserResolver` (hors périmètre v1) : interroge le SSO PAR id pour
     obtenir le profil à jour (téléphone compris) ; sélectionnable par variable
     d'environnement, comme les modes d'auth. Procédure d'ajout : docs/user-resolver.md.

   Ce fichier ne contient QUE des types (aucun import) → il reste compilable en
   isolation et n'entraîne aucune dépendance (ni Express, ni auth.ts) chez ses
   consommateurs.
   ============================================================================= */

/** Profil utilisateur RÉSOLU, prêt à afficher. Tous les champs sont des chaînes :
    un renseignement INCONNU vaut la chaîne VIDE (jamais null/undefined), pour que le
    client formate sans garde. `phone` est au contrat mais TOUJOURS vide en v1 (le SSO
    ne le fournit pas — l'impl SSO future le remplira). */
export interface ResolvedUser {
  /** Clé canonique (String(id) SSO sinon login) — l'identifiant sous lequel l'utilisateur est stocké/résolu. */
  id: string;
  login: string;
  domain: string;
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
}

/** Contrat de résolution : d'une LISTE d'ids canoniques vers leurs profils, dans le MÊME
    ordre (correspondance positionnelle). Un id inconnu résout en profil « dummy » (id
    conservé, autres champs vides) — jamais d'absence dans le tableau de sortie. Asynchrone
    par contrat : l'impl v1 répond en mémoire, mais l'impl SSO future fera un appel réseau. */
export interface UserResolver {
  resolve(ids: string[]): Promise<ResolvedUser[]>;
}

/** Profil BRUT à normaliser — sous-ensemble STRUCTUREL de `SsoUser` (auth.ts), défini ICI
    volontairement : le service annuaire ne dépend PAS du type auth (découplage, principe n°2)
    et reste compilable sans Express. `SsoUser` (dont l'`id` est un `number`) reste assignable
    à ce type. Les noms de champs suivent la convention SSO (prenom/nom/eMail) — le mapping vers
    `ResolvedUser` est centralisé dans `UserProfiles.fromSsoUser`. */
export interface RawUserProfile {
  id?: number | string;
  login?: string;
  nom?: string;
  prenom?: string;
  eMail?: string;
  domain?: string;
}

/** Puits de profils : cible vers laquelle Auth POUSSE chaque profil authentifié (validation
    réussie), SANS connaître l'implémentation (injection — principe n°2). `AuthCacheUserResolver`
    l'implémente pour capturer le « dernier profil vu ». Auth n'importe QUE ce type (jamais le
    resolver en dur), condition du découplage. */
export interface ProfileSink {
  remember(user: RawUserProfile): void;
}

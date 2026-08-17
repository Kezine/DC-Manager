/* =============================================================================
   RÔLES — CONTRAT (service CORE du contrôle d'accès, PAS un module amovible).

   L'AUTHENTIFICATION dit QUI est l'appelant ; l'AUTORISATION dit CE QU'IL PEUT.
   Ce sont deux responsabilités orthogonales, et ce fichier tient la seconde
   moitié de la frontière : un `RoleProvider` POSSÈDE la politique
   (utilisateur → rôles) et ignore tout de la façon dont l'identité a été
   établie. On ne les fusionne pas — sans quoi changer de mode d'authentification
   obligerait à réécrire la politique, et inversement.

   INTERFACE-DRIVEN (principe n°2), sur le patron canonique de `UserResolver` :
   les consommateurs (`AccessControl`) ne dépendent QUE de ce contrat ;
   l'implémentation est SÉLECTIONNÉE au câblage (index.ts).
   - v1 `FileRoleProvider` : un `roles.json` relu à chaud, plus une liste
     d'administrateurs d'amorçage venue de l'environnement.
   - v2 (même implémentation) : mapping GROUPES de l'IdP → rôles, dès lors que
     l'identité apporte des groupes (mode forward, OIDC demain). Le contrat n'a
     bougé que d'un champ sur l'IDENTITÉ — la table `groups` de `roles.json` est
     une affaire de politique, invisible d'ici.
   - à venir : provider enfichable. Le contrat ne bouge pas.

   Ce fichier ne contient QUE des types (aucun import) → il reste compilable en
   isolation et n'entraîne aucune dépendance chez ses consommateurs.
   ============================================================================= */

/** IDENTITÉ soumise à la politique de rôles — vue MINIMALE, volontairement détachée du type
    d'authentification (`SsoResult`) : le provider de rôles ne doit pas dépendre du mode d'auth,
    exactement comme `RawUserProfile` (annuaire) est détaché de `SsoUser`.

    `adminRight` et `dev` n'y sont pas par nostalgie : ils portent la RÉTROCOMPATIBILITÉ (un
    déploiement existant continue de fonctionner à l'identique), et la politique est le seul
    endroit correct pour la tenir — un provider qui les ignore ne casse rien, il applique
    simplement l'opt-in strict. */
export interface AccessIdentity {
  /** Clé CANONIQUE (`UserProfiles.canonicalId` : `String(id)` SSO sinon login). "" si indéterminable. */
  id: string;
  /** Login BRUT tel que fourni par l'authentification — deuxième clé de recherche, car un
      exploitant écrit plus volontiers un login qu'un id numérique dans un fichier de politique. */
  login: string;
  /** GROUPES bruts de l'IdP, tels que l'authentification les a reçus (`SsoResult.groups`) — jamais
      calculés ici. C'est ce qui permet à la politique de mapper « groupe → rôles » et donc de
      laisser la gestion des utilisateurs vivre dans l'IdP : un nouvel arrivant du bon groupe a ses
      droits sans qu'on touche à `roles.json`. Vide en modes dev/basic (aucun annuaire). */
  groups: string[];
  /** Droit hérité du contrat SSO maison (`"SUPER_ADMIN"` = administrateur historique). */
  adminRight: string;
  /** Session issue d'un mode SANS véritable authentification (dev / basic) — cf. `SsoResult.dev`. */
  dev: boolean;
}

/** Politique d'autorisation : d'une identité vers ses NOMS de rôles.

    Asynchrone par contrat (l'implémentation v1 répond en mémoire, une future implémentation
    interrogera un annuaire). Retour VIDE = aucun rôle = aucune permission = refus partout :
    c'est le comportement NORMAL d'un utilisateur non déclaré, jamais une erreur. */
export interface RoleProvider {
  rolesOf(identity: AccessIdentity): Promise<string[]>;

  /** Définition d'un rôle CUSTOM propre au déploiement (grants bruts). `null`/absent = le rôle
      n'est pas défini par ce provider → le preset partagé du même nom s'applique, s'il existe.
      Optionnel : un provider qui ne sert que des presets n'a pas à l'implémenter. */
  grantsOfRole?(role: string): readonly string[] | null;

  /** GÉNÉRATION de la configuration : un entier qui CHANGE à chaque rechargement effectif.
      C'est la clé d'invalidation du cache de permissions d'`AccessControl` — sans elle, un
      rechargement à chaud n'aurait aucun effet sur les sessions déjà vues. Optionnel : un
      provider immuable peut s'en passer (l'absence vaut « génération constante »). */
  generation?(): number;
}

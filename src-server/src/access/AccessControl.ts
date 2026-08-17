import { Logger } from "../logger.js";
import { UserProfiles } from "../users/UserProfiles.js";   // clé canonique : MÊME règle que l'audit et l'annuaire (principe n°3)
import { Permissions, PermissionSet, type PermissionAction, type WriteBatchLike } from "../../../src-shared/Permissions.js";
import type { AccessIdentity, RoleProvider } from "./RoleProvider.js";

/* =============================================================================
   CONTRÔLE D'ACCÈS — le service qui transforme une politique en REFUS.

   Un point d'entrée unique (`requireAuth`, monté globalement) établit la
   session et calcule ses permissions ; des gardes par route vérifient ensuite
   UNE permission atomique. Le cœur et les modules consomment les mêmes gardes,
   les modules par INJECTION (aucun d'eux n'importe ce fichier).

   ── Pourquoi ce fichier n'importe PAS Express ─────────────────────────────
   Il déclare ses propres vues MINIMALES de la requête et de la réponse
   (`AccessRequest`, `AccessResponse`), dont les types Express sont des
   sur-ensembles structurels : une garde reste donc utilisable partout où un
   `RequestHandler` est attendu, sans qu'Express entre ici. Trois bénéfices
   concrets, et c'est le patron déjà tenu par `UserResolver`/`RawUserProfile` :
   1. la logique d'autorisation devient TESTABLE en isolation (aucun serveur à
      monter — cf. `Tests/modules/test-access.js`) ;
   2. elle ne dépend pas d'une VERSION d'Express (le programme de test du dépôt
      n'en résout pas la même que le serveur) ;
   3. la frontière est explicite : ce service lit `params`/`body` et écrit
      `authUser`/`authAccess`. Rien d'autre.
   L'ADAPTATION vers le vrai `Request` (validation de session) est INJECTÉE et
   vit au bootstrap, là où Express est déjà connu.

   ── Les invariants, et où ils sont tenus ──────────────────────────────────
   - « authentifié ≠ autorisé » : `requireAuth` REFUSE (403) un appelant dont
     l'ensemble de permissions est VIDE. Tenu en UN point, donc impossible à
     oublier route par route : une route nouvelle est au pire fermée à ceux qui
     n'ont aucun droit, jamais ouverte à tous.
   - 401 ≠ 403, sémantique CONSERVÉE : 401 = pas (ou plus) authentifié → le
     client coupe la session et renvoie au login (il a un verrou dessus,
     `SessionExpiry`) ; 403 = authentifié mais sans le droit → se reconnecter
     n'y changerait rien, le client ne doit PAS boucler sur le login.
   - Fail-closed : toute erreur de calcul de permissions rend l'ensemble VIDE.
   - Gardes TAGUÉES (`aclTag`) : cf. plus bas — c'est ce qui rend le « aucune
     route sans garde » VÉRIFIABLE par une machine, au lieu d'être juré.
   ============================================================================= */

/** Vue MINIMALE d'une requête HTTP pour le contrôle d'accès. Le `Request` d'Express en est un
    sur-ensemble structurel (c'est ce qui rend les gardes montables telles quelles). */
export interface AccessRequest {
  /** Paramètres de chemin — `:collection` pour les routes génériques. */
  params: Record<string, string>;
  /** Corps déjà désérialisé (`express.json`) — lu par les gardes qui portent sur une CHARGE
      (lot d'écriture, aperçu de cascade), jamais interprété au-delà du nom de collection. */
  body?: unknown;
  /** Session posée par `requireAuth` — les handlers et les modules la lisent (audit). */
  authUser?: AccessSession;
  /** Permissions EFFECTIVES posées par `requireAuth` — jamais absentes en aval de la garde. */
  authAccess?: PermissionSet;
}

/** Vue MINIMALE de la réponse : de quoi refuser, rien de plus. */
export interface AccessResponse {
  status(code: number): AccessResponse;
  json(body: unknown): unknown;
}

/** Passage au maillon suivant (`NextFunction` d'Express en est un sur-ensemble). */
export type AccessNext = (err?: unknown) => void;

/** Une GARDE : middleware HTTP porteur d'une ÉTIQUETTE.

    🚨 `aclTag` n'est pas décoratif. « Aucune route terminale sans garde » est le genre de
    convention qui tient six mois puis se perd sur une route ajoutée un vendredi. L'étiquette rend
    la garde RECONNAISSABLE, donc l'absence de garde DÉTECTABLE : un test parcourt les
    déclarations de routes et échoue en nommant celles qui n'en portent pas (même philosophie que
    le verrou d'isolement de `src-shared/` — une convention tenue par une machine). */
export interface AccessGuard {
  (req: AccessRequest, res: AccessResponse, next: AccessNext): void;
  /** Permission exigée, ou sentinelle (`authenticated`, `collection:read`, `any-doc-read`…). */
  aclTag?: string;
}

/** Session AUTHENTIFIÉE, vue MINIMALE — sous-ensemble structurel de `SsoResult` (`auth.ts`),
    déclaré ICI volontairement : le contrôle d'accès ne dépend pas du mode d'authentification
    (même découplage que `RawUserProfile` ⇄ `SsoUser` côté annuaire). */
export interface AccessSession {
  logged: boolean;
  adminRight?: string;
  /** Session issue d'un mode SANS authentification réelle (dev / basic). */
  dev?: boolean;
  /** GROUPES bruts de l'IdP (mode forward, passthrough SSO) — mappés vers des rôles par la
      politique. Absent = aucun groupe : les modes dev/basic n'ont pas d'annuaire. */
  groups?: string[];
  user?: { id?: number | string; login?: string };
}

/** Validation de session INJECTÉE : `Auth.validate` au bootstrap, un bouchon en test. Le service
    ignore comment l'identité est établie — il ne consomme que son résultat. */
export type SessionReader = (req: AccessRequest) => Promise<AccessSession>;

export interface AccessControlOptions {
  session: SessionReader;
  roles: RoleProvider;
  log?: Logger;
}

/** Entrée du cache de permissions : un ensemble n'est réutilisable que pour la GÉNÉRATION de
    configuration qui l'a produit (un rechargement à chaud doit se voir immédiatement). */
interface CachedAccess { generation: number; set: PermissionSet }

export class AccessControl {
  /** Plafond du cache de permissions. Le cache existe pour éviter de reconstruire un
      `PermissionSet` à chaque requête d'un même utilisateur ; il n'a pas vocation à mémoriser
      tout un annuaire. Au-delà, on VIDE (plutôt qu'une éviction fine : la reconstruction coûte
      quelques microsecondes, la complexité d'un LRU ne se justifie pas ici). */
  static readonly CACHE_CAP = 512;

  private readonly session: SessionReader;
  private readonly roles: RoleProvider;
  private readonly log: Logger;
  private readonly cache = new Map<string, CachedAccess>();
  /** Rôles inconnus DÉJÀ signalés (par génération) — sans cette mémoire, une coquille dans
      `roles.json` produirait une ligne de log par requête. */
  private readonly warnedRoles = new Set<string>();
  private warnedGeneration = -1;

  constructor(opts: AccessControlOptions) {
    this.session = opts.session;
    this.roles = opts.roles;
    this.log = opts.log || new Logger("error", "access");
  }

  /* --------------------------------------------------------------------------
     Calcul des permissions
     -------------------------------------------------------------------------- */

  /** Identité soumise à la politique — la clé canonique est celle de l'audit et de l'annuaire
      (`UserProfiles.canonicalId`), jamais une variante locale (principe n°3).

      Les GROUPES sont filtrés ici, et c'est le bon endroit : c'est la FRONTIÈRE par laquelle une
      donnée d'annuaire non maîtrisée (en-tête de proxy, passthrough d'un SSO qui rendrait
      `groups: [null, 42]`) entre dans la politique. On ne garde que des chaînes non vides — un
      groupe qui n'est pas un nom ne peut correspondre à aucune entrée écrite à la main, et laisser
      passer une valeur non textuelle ferait échouer le tri de la clé de cache plus bas. */
  static identityOf(session: AccessSession): AccessIdentity {
    const user = session.user || {};
    const groups = Array.isArray(session.groups)
      ? session.groups.filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim())
      : [];
    return {
      id: UserProfiles.canonicalId(user),
      login: String(user.login || ""),
      adminRight: String(session.adminRight || ""),
      dev: session.dev === true,
      groups,
    };
  }

  /** Permissions EFFECTIVES d'une session : rôles (politique) → grants (presets ou définitions
      locales) → union. Mémoïsé par (identité, génération de configuration).

      Une session NON authentifiée n'a rien à calculer : ensemble vide. Une ERREUR du provider
      donne, elle aussi, l'ensemble vide — jamais un repli permissif (fail-closed). */
  async setFor(session: AccessSession): Promise<PermissionSet> {
    if (!session || !session.logged) return PermissionSet.EMPTY;
    const identity = AccessControl.identityOf(session);
    const generation = this.roles.generation ? this.roles.generation() : 0;
    const key = AccessControl.cacheKeyOf(identity);
    const hit = this.cache.get(key);
    if (hit && hit.generation === generation) return hit.set;
    let set: PermissionSet;
    try {
      set = this.grantsFor(await this.roles.rolesOf(identity), generation);
    } catch (e) {
      // Politique injoignable/défaillante : on REFUSE. Un repli ouvert transformerait une panne
      // de configuration en escalade de privilèges — exactement ce que « fail-closed » interdit.
      this.log.error("politique de rôles en échec — aucune permission accordée (fail-closed)", identity.id || identity.login, e instanceof Error ? e.message : String(e));
      set = PermissionSet.EMPTY;
    }
    if (this.cache.size >= AccessControl.CACHE_CAP) this.cache.clear();
    this.cache.set(key, { generation, set });
    return set;
  }

  /** Clé de mémoïsation d'une identité — TOUT ce dont les rôles dépendent, et rien d'autre.

      🚨 Les GROUPES en font partie, et l'oubli serait une faille, pas une imprécision : deux
      requêtes du MÊME login avec des groupes DIFFÉRENTS (l'IdP a changé son appartenance entre-temps,
      ou un proxy mal configuré envoie des groupes variables) partageraient sinon la même entrée —
      la première réponse figerait les droits de l'autre, dans un sens comme dans l'autre. Ils sont
      TRIÉS (copie : `identity.groups` appartient à l'appelant) parce que l'ordre du proxy n'a aucune
      signification pour la politique, et que deux ordres du même ensemble doivent partager le cache.

      Le séparateur est le caractère NUL, y compris ENTRE les groupes : il ne peut apparaître ni dans
      un login ni dans un nom de groupe venus d'un en-tête HTTP, donc aucune concaténation ne peut se
      faire passer pour une autre — avec une virgule, l'identité aux groupes `["a,b"]` et celle aux
      groupes `["a", "b"]` produiraient la MÊME clé alors qu'elles n'ont pas les mêmes rôles.
      Il est écrit `\u0000` et non posé littéralement dans la source : un octet nul rend le fichier
      « binaire » pour les outils de recherche du dépôt, et se confond visuellement avec une espace. */
  private static cacheKeyOf(identity: AccessIdentity): string {
    const SEP = "\u0000";
    return [identity.id, identity.login, identity.adminRight, identity.dev ? "1" : "0", ...[...identity.groups].sort()].join(SEP);
  }

  /** Rôles → ensemble de permissions. Une définition LOCALE (section `roles` du fichier) l'emporte
      sur le preset de même nom : le fichier de politique est l'autorité du déploiement. Un rôle
      qui n'est ni l'un ni l'autre est ignoré et SIGNALÉ une fois — le silence ferait chercher
      longtemps pourquoi « cabliste » ne donne rien. */
  private grantsFor(roles: readonly string[], generation: number): PermissionSet {
    if (generation !== this.warnedGeneration) { this.warnedRoles.clear(); this.warnedGeneration = generation; }
    const grants: string[] = [];
    for (const role of roles) {
      const custom = this.roles.grantsOfRole ? this.roles.grantsOfRole(role) : null;
      const preset = Permissions.ROLE_PRESETS[role];
      if (custom && custom.length) grants.push(...custom);
      else if (preset) grants.push(...preset);
      else if (!this.warnedRoles.has(role)) {
        this.warnedRoles.add(role);
        this.log.warn("rôle inconnu ignoré : « " + role + " » (ni preset, ni défini dans roles.json)");
      }
    }
    return PermissionSet.of(grants);
  }

  /** Permissions posées sur la requête par `requireAuth`. Absentes (route montée hors garde) →
      ensemble VIDE : un appel hors du chemin nominal ne doit rien ouvrir. */
  static setOf(req: AccessRequest): PermissionSet {
    return req.authAccess || PermissionSet.EMPTY;
  }

  /* --------------------------------------------------------------------------
     Gardes
     -------------------------------------------------------------------------- */

  /** GARDE GLOBALE (remplace l'ancien `requireAdmin`) : valide la session, la pose sur la requête,
      calcule les permissions, et refuse d'emblée qui n'en a AUCUNE.

      C'est ce dernier point qui rend l'ensemble sûr : la question « cette route a-t-elle été
      gardée ? » ne se pose plus pour les utilisateurs sans droits — ils sont déjà dehors. Les
      gardes par route ne départagent donc que des utilisateurs LÉGITIMES entre eux. */
  readonly requireAuth: AccessGuard = AccessControl.tag(async (req, res, next) => {
    const session = await this.session(req);
    req.authUser = session;   // relu par `resolveRepo` (auteur de l'écriture) et par les modules (audit)
    if (!session.logged) {
      // 401 et non 403 : le client DOIT distinguer « session expirée » (retour au login) de
      // « pas le droit » (rester où l'on est). Forme du corps inchangée depuis l'ACL binaire.
      res.status(401).json({ error: "non authentifié", logged: false, adminRight: session.adminRight || "NONE" });
      return;
    }
    const set = await this.setFor(session);
    req.authAccess = set;
    if (set.isEmpty()) {
      res.status(403).json({ error: "accès refusé", logged: true, adminRight: session.adminRight || "NONE", permissions: [] });
      return;
    }
    next();
  }, "session");

  /** Garde des routes qui n'exigent RIEN de plus que d'être un utilisateur reconnu (≥ 1
      permission) : liste des documents, réglages, résolution de noms d'utilisateurs. Elle ne
      vérifie donc rien — `requireAuth` l'a déjà fait — mais elle porte une ÉTIQUETTE, et c'est
      tout son intérêt : « cette route est délibérément sans permission propre » devient une
      DÉCLARATION vérifiable, au lieu d'un oubli indiscernable. */
  readonly requireAuthenticated: AccessGuard = AccessControl.tag((_req, _res, next) => { next(); }, "authenticated");

  /** Garde d'UNE permission atomique. */
  require(permission: string): AccessGuard {
    return AccessControl.tag((req, res, next) => {
      if (AccessControl.setOf(req).has(permission)) { next(); return; }
      AccessControl.deny(req, res, permission);
    }, permission);
  }

  /** Garde des routes GÉNÉRIQUES de collection : le domaine se déduit de `:collection`.
      Collection INCONNUE → on laisse passer : le handler répondra 404 « collection inconnue »,
      comme avant l'ACL. Un 403 y serait faux (il n'y a rien à protéger) et renseignerait sur
      l'existence des collections. */
  requireCollection(action: PermissionAction): AccessGuard {
    return AccessControl.tag((req, res, next) => {
      const permission = Permissions.forCollection(String(req.params.collection || ""), action);
      if (!permission) { next(); return; }
      if (AccessControl.setOf(req).has(permission)) { next(); return; }
      AccessControl.deny(req, res, permission);
    }, "collection:" + action);
  }

  /** Garde d'une route dont la collection visée est dans le CORPS (aperçu de cascade : une liste
      d'ids ne tient pas dans une query string, cf. `Api.router`). Même carte, même refus — c'est
      la POSITION de la collection qui change, pas la règle. */
  requireCollectionInBody(action: PermissionAction): AccessGuard {
    return AccessControl.tag((req, res, next) => {
      const body = (req.body && typeof req.body === "object") ? (req.body as { collection?: unknown }) : {};
      const permission = Permissions.forCollection(String(body.collection ?? ""), action);
      if (!permission) { next(); return; }   // collection inconnue → 404 du handler (cf. requireCollection)
      if (AccessControl.setOf(req).has(permission)) { next(); return; }
      AccessControl.deny(req, res, permission);
    }, "body-collection:" + action);
  }

  /** Garde du LOT d'écriture (`POST /transact`) : CHAQUE opération est vérifiée AVANT que rien ne
      soit appliqué, et la première permission manquante refuse tout le lot — l'atomicité du refus
      répond à l'atomicité de la transaction (un lot à moitié écrit serait pire qu'un lot rejeté).
      Le calcul est PUR et partagé (`Permissions.forBatch`), la garde ne fait que l'appeler. */
  readonly requireBatch: AccessGuard = AccessControl.tag((req, res, next) => {
    const set = AccessControl.setOf(req);
    for (const permission of Permissions.forBatch(req.body as WriteBatchLike | null)) {
      if (!set.has(permission)) { AccessControl.deny(req, res, permission); return; }
    }
    next();
  }, "transact:batch");

  /** Garde « ≥ 1 lecture de donnée documentaire » : le flux SSE (des ids et des noms de
      collection, jamais du contenu) et la recherche transverse (dont l'assiette est de toute
      façon restreinte ensuite aux collections lisibles). */
  readonly requireAnyDocRead: AccessGuard = AccessControl.tag((req, res, next) => {
    if (Permissions.hasAnyDocumentRead(AccessControl.setOf(req))) { next(); return; }
    // Aucune permission atomique unique ne manque ici (la garde en accepte plusieurs) : on renvoie
    // la SENTINELLE de la règle, qui est aussi son étiquette — cf. `deny`.
    AccessControl.deny(req, res, "any-doc-read");
  }, "any-doc-read");

  /* --------------------------------------------------------------------------
     Helpers
     -------------------------------------------------------------------------- */

  /** Pose l'étiquette sur une garde (cf. `AccessGuard.aclTag`). */
  private static tag(handler: (req: AccessRequest, res: AccessResponse, next: AccessNext) => void, aclTag: string): AccessGuard {
    return Object.assign(handler, { aclTag });
  }

  /** Refus 403 NOMMANT la permission manquante — ou, quand la garde accepte PLUSIEURS permissions
      (`any-doc-read`), la sentinelle de la règle. Le champ `permission` est ADDITIF : la forme
      historique (`error`/`logged`/`adminRight`) est conservée telle quelle pour ne casser aucun
      appelant, mais un refus muet est indiagnostiquable — côté support comme côté client. */
  private static deny(req: AccessRequest, res: AccessResponse, permission: string): void {
    res.status(403).json({
      error: "accès refusé",
      logged: true,
      adminRight: (req.authUser && req.authUser.adminRight) || "NONE",
      permission,
    });
  }
}

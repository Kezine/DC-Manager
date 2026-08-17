import { SecretCompare } from "./SecretCompare.js";   // comparaison à TEMPS CONSTANT du secret partagé (helper du dossier)
import { GroupList } from "./GroupList.js";           // nettoyage des groupes — helper SORTI d'ici quand le mode oidc lui a donné un 2e consommateur
import type { AuthProvider, AuthRequestView, SsoResult, SsoUser } from "./AuthProvider.js";

/* =============================================================================
   MODE FORWARD — l'identité vient d'un REVERSE-PROXY *identity-aware*.

   Le proxy (Authelia, Authentik, oauth2-proxy, Pomerium, Cloudflare Access,
   Tailscale…) authentifie en amont — login, MFA, session, déconnexion — puis
   PASSE l'identité à l'application dans des en-têtes de confiance. L'app ne
   gère alors AUCUN flux OAuth, aucun cookie, aucune expiration : elle LIT.
   C'est le mode qui colle au déploiement réel (l'app est déjà derrière un
   proxy, cf. user-docs/reverse-proxy.md) et celui qui rend l'IdP maître des
   utilisateurs — la table `groups` de `roles.json` mappe ensuite ses GROUPES
   vers des rôles (cf. `access/RolesConfig`, docs/auth.md § 5).

   ── En-têtes CONFIGURABLES, défauts = famille Remote-* ────────────────────
   Les défauts couvrent Authelia et Authentik. Pour un autre outil, l'exploitant
   RENOMME les quatre en-têtes ; il n'y a volontairement PAS de « profils » par
   marque, qui vieilliraient mal et cacheraient la seule chose qui compte —
   quels en-têtes le proxy pose réellement.

   | Outil            | Utilisateur                     | Groupes                |
   |------------------|---------------------------------|------------------------|
   | Authelia/Authentik | `Remote-User`                 | `Remote-Groups`        |
   | oauth2-proxy     | `X-Forwarded-User`              | `X-Forwarded-Groups`   |
   | Cloudflare Access| `Cf-Access-Authenticated-User-Email` | *(néant)*         |
   | Tailscale        | `Tailscale-User-Login`          | *(néant)*              |

   ── 🚨 MODÈLE DE CONFIANCE — le cœur du sujet ─────────────────────────────
   Un en-tête est TRIVIAL à forger. Qui peut joindre l'application directement
   peut donc se déclarer n'importe qui, ADMINISTRATEUR compris. Deux protections,
   et la première n'est pas optionnelle :
   1. l'application n'est joignable QUE par le proxy (bind sur localhost, réseau
      Docker privé, règle de pare-feu) — c'est une consigne de DÉPLOIEMENT, que
      le code ne peut pas vérifier : d'où le WARN de boot de l'orchestrateur
      quand aucun secret n'est configuré ;
   2. un SECRET PARTAGÉ proxy↔app (`AUTH_FORWARD_SECRET`), que le proxy pose
      dans un en-tête. Configuré, il est EXIGÉ : toute requête dont l'en-tête ne
      correspond pas est ANONYME, et ce provider ne lit alors AUCUN autre
      en-tête — pas même le nom d'utilisateur (cf. `authenticate`). La
      comparaison est à TEMPS CONSTANT (`SecretCompare`), comme celle du mode
      basic : c'est un secret, pas un identifiant.
   Même discipline que `X-Forwarded-Prefix` (user-docs/reverse-proxy.md) : un en-tête
   n'est cru que dans la mesure où l'on sait d'où il vient.

   ── Ce que ce provider ne fait PAS, et pourquoi ───────────────────────────
   - AUCUN `sessionKey` : lire des en-têtes ne coûte aucune E/S, un cache
     n'économiserait rien et n'ajouterait qu'une fenêtre de rémanence après une
     déconnexion côté proxy. Même raisonnement que pour dev et basic (cf. la
     doctrine du contrat `AuthProvider.sessionKey`).
   - AUCUN `adminRight` : l'autorisation passe par les RÔLES (`roles.json`,
     `BOOTSTRAP_ADMIN_IDS`). Poser `SUPER_ADMIN` ferait de tout utilisateur du
     proxy un administrateur — la rétrocompatibilité du SSO maison est une
     règle de POLITIQUE (`access/FileRoleProvider`), pas un modèle à copier.
   - AUCUN `expireDate` : la session appartient au proxy, qui la coupe quand il
     veut ; annoncer une échéance que nous ne tenons pas serait mentir au client.
   ============================================================================= */

/** Configuration du provider — tout est optionnel, les défauts sont ceux de la famille Remote-*. */
export interface ForwardHeaderOptions {
  /** En-tête du LOGIN (requis à l'exécution : absent/vide ⇒ appelant anonyme). */
  userHeader?: string | null;
  /** En-tête de l'adresse e-mail. */
  emailHeader?: string | null;
  /** En-tête du nom d'AFFICHAGE (nom complet — cf. `authenticate`). */
  nameHeader?: string | null;
  /** En-tête des groupes, séparés par des virgules. */
  groupsHeader?: string | null;
  /** SECRET partagé proxy↔app. Vide/absent = non configuré (le boot le signale en WARN). */
  secret?: string | null;
  /** En-tête portant le secret partagé. */
  secretHeader?: string | null;
}

export class ForwardHeaderAuthProvider implements AuthProvider {
  /* -- Défauts (famille Remote-* : Authelia, Authentik) -- */
  static readonly DEFAULT_USER_HEADER = "Remote-User";
  static readonly DEFAULT_EMAIL_HEADER = "Remote-Email";
  static readonly DEFAULT_NAME_HEADER = "Remote-Name";
  static readonly DEFAULT_GROUPS_HEADER = "Remote-Groups";
  static readonly DEFAULT_SECRET_HEADER = "X-Auth-Secret";

  /* -- Variables d'environnement (nommées ICI : le provider possède sa configuration, cf.
        `BasicAuthProvider.fromSpec` et `FileRoleProvider.fromEnv`) -- */
  static readonly ENV_USER_HEADER = "AUTH_FORWARD_USER_HEADER";
  static readonly ENV_EMAIL_HEADER = "AUTH_FORWARD_EMAIL_HEADER";
  static readonly ENV_NAME_HEADER = "AUTH_FORWARD_NAME_HEADER";
  static readonly ENV_GROUPS_HEADER = "AUTH_FORWARD_GROUPS_HEADER";
  static readonly ENV_SECRET = "AUTH_FORWARD_SECRET";
  static readonly ENV_SECRET_HEADER = "AUTH_FORWARD_SECRET_HEADER";

  /** Domaine posé sur l'utilisateur : d'où vient cette identité, en un mot. Il n'y a pas d'annuaire
      à nommer (le proxy ne nous dit pas lequel il a interrogé) — « forward » est donc exact, et
      distingue une session de proxy d'une session SSO maison dans les logs comme dans `/me`. */
  static readonly DOMAIN = "forward";

  readonly userHeader: string;
  readonly emailHeader: string;
  readonly nameHeader: string;
  readonly groupsHeader: string;
  readonly secretHeader: string;
  /** Le secret partagé est-il configuré ? Lu par l'orchestrateur pour son WARN de boot (le secret
      lui-même reste privé — il ne sort jamais de cette classe, journaux compris). */
  readonly secretConfigured: boolean;
  private readonly secret: string;

  constructor(opts: ForwardHeaderOptions = {}) {
    // Rognage systématique : une variable d'environnement recopiée traîne souvent un blanc, et un
    // nom d'en-tête à espace ne correspondrait à rien (tolérance de forme, cf. `BasicAuthProvider`).
    this.userHeader = ForwardHeaderAuthProvider.orDefault(opts.userHeader, ForwardHeaderAuthProvider.DEFAULT_USER_HEADER);
    this.emailHeader = ForwardHeaderAuthProvider.orDefault(opts.emailHeader, ForwardHeaderAuthProvider.DEFAULT_EMAIL_HEADER);
    this.nameHeader = ForwardHeaderAuthProvider.orDefault(opts.nameHeader, ForwardHeaderAuthProvider.DEFAULT_NAME_HEADER);
    this.groupsHeader = ForwardHeaderAuthProvider.orDefault(opts.groupsHeader, ForwardHeaderAuthProvider.DEFAULT_GROUPS_HEADER);
    this.secretHeader = ForwardHeaderAuthProvider.orDefault(opts.secretHeader, ForwardHeaderAuthProvider.DEFAULT_SECRET_HEADER);
    this.secret = String(opts.secret ?? "").trim();
    this.secretConfigured = this.secret !== "";
  }

  /** Options lues dans l'environnement. Le bootstrap (`index.ts`) n'a ainsi AUCUN nom de variable à
      connaître, et les six noms n'existent qu'ici (principe n°3) — patron `FileRoleProvider.fromEnv`. */
  static optionsFromEnv(env: NodeJS.ProcessEnv): ForwardHeaderOptions {
    return {
      userHeader: env[ForwardHeaderAuthProvider.ENV_USER_HEADER],
      emailHeader: env[ForwardHeaderAuthProvider.ENV_EMAIL_HEADER],
      nameHeader: env[ForwardHeaderAuthProvider.ENV_NAME_HEADER],
      groupsHeader: env[ForwardHeaderAuthProvider.ENV_GROUPS_HEADER],
      secret: env[ForwardHeaderAuthProvider.ENV_SECRET],
      secretHeader: env[ForwardHeaderAuthProvider.ENV_SECRET_HEADER],
    };
  }

  /** Identité présentée par le proxy, ou `null` (anonyme).

      ORDRE VOLONTAIRE, et c'est une propriété de SÉCURITÉ : le secret partagé est vérifié AVANT
      tout autre en-tête. Une requête non fiable ressort donc anonyme sans qu'on ait même LU le nom
      d'utilisateur qu'elle prétend porter — ce qui ferme la porte à toute lecture « au cas où » qui
      s'ajouterait un jour en dessous (journalisation, métrique, tolérance).

      `user.nom` reçoit le nom d'AFFICHAGE COMPLET tel quel : le contrat maison sépare `nom` et
      `prenom` (héritage du SSO), mais un proxy ne fournit qu'un seul libellé (« Alice Martin ») et
      le découper à l'espace inventerait une structure fausse pour tous les noms composés. `prenom`
      reste donc absent, et l'annuaire affiche le nom complet — arbitrage documenté (docs/auth.md). */
  async authenticate(req: AuthRequestView): Promise<SsoResult | null> {
    if (!this.trusted(req)) return null;
    const login = this.headerValue(req, this.userHeader);
    if (login === "") return null;   // aucune identité présentée → anonyme (jamais d'utilisateur par défaut)
    const user: SsoUser = { login, domain: ForwardHeaderAuthProvider.DOMAIN };
    const email = this.headerValue(req, this.emailHeader);
    if (email !== "") user.eMail = email;
    const name = this.headerValue(req, this.nameHeader);
    if (name !== "") user.nom = name;
    // `groups` est TOUJOURS présent (tableau, éventuellement vide) : « ce provider fournit des
    // groupes, et l'IdP n'en a donné aucun » n'est pas la même information qu'un champ absent.
    return { user, logged: true, groups: this.groupsOf(req) };
  }

  /* Pas de `sessionKey` : rien à mettre en cache (cf. l'en-tête). L'absence de la méthode SUFFIT —
     le contrat la déclare optionnelle précisément pour ça. */

  /** La requête est-elle FIABLE ? Sans secret configuré, on fait confiance au réseau (et le boot
      l'a crié). Avec un secret, l'en-tête doit correspondre EXACTEMENT — comparaison à temps
      constant, en-tête absent compris (la chaîne vide ne peut égaler un secret non vide). */
  private trusted(req: AuthRequestView): boolean {
    if (!this.secretConfigured) return true;
    return SecretCompare.equals(this.headerValue(req, this.secretHeader), this.secret);
  }

  /** Groupes bruts de l'IdP, nettoyés par le helper PARTAGÉ `GroupList` (découpe sur la virgule,
      rognage, vides écartées, doublons fondus, ordre conservé).

      ⚠ La règle vivait ICI jusqu'à ce que le mode `oidc` en devienne le SECOND consommateur —
      exactement le geste qui avait sorti `SecretCompare` du provider basic quand ce mode-ci est
      arrivé. Elle ne pouvait pas rester dupliquée : les groupes deviennent des rôles par une
      correspondance EXACTE et sensible à la casse (cf. `access/RolesConfig`), et deux nettoyages
      qui divergeraient d'un rognage donneraient des droits différents selon le mode
      d'authentification, sans que rien ne l'affiche. */
  private groupsOf(req: AuthRequestView): string[] {
    return GroupList.normalize(this.headerValue(req, this.groupsHeader));
  }

  /** Lecture d'un en-tête par son nom CONFIGURÉ — le SEUL point qui touche `req.headers`.

      Deux normalisations, et une seule ligne pour les deux :
      1. la CASSE — Node met les noms d'en-têtes reçus en minuscules, alors que la configuration
         s'écrit `Remote-User` (forme canonique, celle des documentations des proxys). On cherche
         donc en minuscules, puis, à défaut, sous le nom exact : la vue minimale du contrat ne
         GARANTIT pas des clés en minuscules, et un appelant non-Express (test, futur adaptateur)
         ne doit pas échouer silencieusement là-dessus ;
      2. la RÉPÉTITION — un en-tête posé deux fois arrive en `string[]` ; on retient la PREMIÈRE
         valeur. Choix explicite : concaténer mélangerait deux affirmations contradictoires, et
         refuser ferait dépendre l'authentification d'une bizarrerie de chaîne de proxys. */
  private headerValue(req: AuthRequestView, name: string): string {
    const headers = req.headers || {};
    const raw = headers[name.toLowerCase()] ?? headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value.trim() : "";
  }

  /** Valeur rognée, ou le défaut quand elle est absente/vide. */
  private static orDefault(value: string | null | undefined, fallback: string): string {
    const trimmed = String(value ?? "").trim();
    return trimmed !== "" ? trimmed : fallback;
  }
}

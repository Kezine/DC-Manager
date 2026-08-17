import { createHash } from "node:crypto";
import { Logger } from "./logger.js";
import type { ProfileSink } from "./users/UserResolver.js";   // TYPE seul (annuaire) — Auth ignore l'impl : injection (principe n°2)
import { ANONYMOUS_SESSION, type AuthProvider, type AuthRequestView, type SsoResult } from "./auth/AuthProvider.js";
import { AuthModeResolution, type AuthMode } from "./auth/AuthModeResolution.js";   // décision de CONFIGURATION, pure et testée
import { DevAuthProvider } from "./auth/DevAuthProvider.js";
import { BasicAuthProvider } from "./auth/BasicAuthProvider.js";
import { LegacySsoAuthProvider } from "./auth/LegacySsoAuthProvider.js";
import { ForwardHeaderAuthProvider, type ForwardHeaderOptions } from "./auth/ForwardHeaderAuthProvider.js";

/* AUTHENTIFICATION — ORCHESTRATEUR.

   Cette classe ne SAIT PAS authentifier : elle CHOISIT au boot le provider qui sait
   (`auth/AuthProvider` — dev, basic, SSO maison, en-têtes de proxy, et demain OIDC), puis lui
   ajoute les trois services transverses qui ne dépendent d'AUCUN mode :
   1. le CACHE de session (clé = hash du jeton présenté, durée = `expireDate`), qui évite un
      appel sortant par requête HTTP ;
   2. la CAPTURE d'annuaire (`ProfileSink`), invariant : jamais un profil non authentifié ;
   3. l'ANNONCE du mode au démarrage, WARN bien visible quand aucun contrôle n'est configuré.
   Tout ce qui est SPÉCIFIQUE à un mode vit dans son provider, un fichier par classe (principe n°2).

   ⚠ PÉRIMÈTRE : on répond ici à « QUI est l'appelant ? », et à rien d'autre. « Ce qu'il PEUT »
   relève de l'AUTORISATION, service distinct et orthogonal (`access/AccessControl`, politique de
   rôles `access/RoleProvider` — cf. docs/auth.md). La session rendue y entre comme une simple
   donnée d'entrée : `adminRight === "SUPER_ADMIN"` et `dev` y valent le rôle `admin` (rétrocompat).

   ⚠ Express n'entre PAS ici : les providers déclarent leur propre vue de la requête
   (`AuthRequestView`), dont le `Request` d'Express est un sur-ensemble structurel. */

/** Le type de session (et sa forme anonyme) vit avec le CONTRAT (`auth/AuthProvider`) : c'est ce que
    tout provider produit, pas une propriété de l'orchestrateur. Les DEUX types sont RÉ-EXPORTÉS ici
    parce que les consommateurs historiques (`api.ts`) les importent depuis ce module, et qu'il n'y a
    aucune raison de leur faire changer de chemin. */
export type { SsoUser, SsoResult } from "./auth/AuthProvider.js";

/** Le type de MODE vit avec la logique qui le décide (`auth/AuthModeResolution`) ; il est ré-exporté
    ici pour la même raison que `SsoResult` — les consommateurs historiques l'importent de ce module. */
export type { AuthMode } from "./auth/AuthModeResolution.js";

export interface AuthOptions {
  /** Mode EXPLICITE (`AUTH_MODE`) : `dev` | `basic` | `sso` | `forward`. Absent/vide → INFÉRENCE
      historique (basic > sso > dev). Une valeur inconnue ou incohérente fait JETER le constructeur
      — jamais de repli silencieux sur le mode dev (cf. `auth/AuthModeResolution`). */
  authMode?: string | null;
  ssoUrl?: string;
  cookieName?: string;
  devUser?: string | null;
  basicAuth?: string | null;
  /** Configuration du mode `forward` (noms d'en-têtes + secret partagé) — lue de l'environnement par
      `ForwardHeaderAuthProvider.optionsFromEnv`, qui possède les noms de variables. */
  forward?: ForwardHeaderOptions;
  /** `fetch` du provider SSO — point d'injection de TEST (aucune variable d'environnement ne le
      pilote), patron `notify/WebhookNotifier`. Absent = le `fetch` global. */
  ssoFetch?: typeof fetch;
}

export class Auth {
  /** Sessions mémorisées par hash de jeton. Ne sert QU'aux providers qui nomment la session
      présentée (`sessionKey`) — donc au seul SSO aujourd'hui : dev et basic répondent de mémoire,
      les mettre en cache n'économiserait rien et retarderait la prise en compte d'un changement. */
  private readonly cache = new Map<string, { result: SsoResult; expireAt: number }>();
  private readonly provider: AuthProvider;
  /** Le provider basic, TYPÉ, quand c'est le mode retenu — `null` sinon. Le gate de transport de
      `server.ts` a besoin de lui poser une question que le contrat général n'a pas à porter
      (« ces identifiants sont-ils bons ? », sans construire de session), cf. `checkBasic`.
      ⚠ Conditionné au MODE, et pas à la simple présence de `BASIC_AUTH` : depuis `AUTH_MODE`, un
      déploiement peut demander `forward` alors qu'un vieux `BASIC_AUTH` traîne dans son
      environnement — le gate ne doit alors challenger personne. Sous l'inférence, les deux
      conditions coïncident (mode basic ⇔ identifiants exploitables) : rien ne change. */
  private readonly basicProvider: BasicAuthProvider | null;
  readonly mode: AuthMode;

  /** @param sink  Puits de profils OPTIONNEL (annuaire) : Auth y pousse chaque profil authentifié
      (`remember`) sans connaître l'implémentation, câblée au bootstrap (index.ts). Découplage
      total — cf. ProfileSink.
      @throws Error  Quand `AUTH_MODE` est inconnue ou incohérente. 🚨 Un objet `Auth` ne peut PAS
      exister dans un état de configuration douteux : le seul repli possible serait le mode dev, qui
      n'authentifie personne — le bootstrap (`index.ts`) journalise et ARRÊTE le process. */
  constructor(private readonly log: Logger, opts: AuthOptions = {}, private readonly sink: ProfileSink | null = null) {
    const ssoUrl = (opts.ssoUrl || "").trim();
    const cookieName = (opts.cookieName || "").trim();
    // La règle de FORMAT de `BASIC_AUTH` appartient au provider qui la connaît — « la valeur ne
    // décrit pas un couple » et « pas de mode basic » sont la même réponse.
    const basic = BasicAuthProvider.fromSpec(opts.basicAuth);
    // MODE : `AUTH_MODE` si elle est renseignée, sinon l'inférence historique (basic > sso > dev).
    // La décision est PURE et testée à part ; ici on ne fait qu'en tirer les conséquences.
    const decision = AuthModeResolution.resolve({ authMode: opts.authMode, hasBasicCredentials: basic !== null, hasSsoUrl: ssoUrl !== "" });
    if (!decision.mode) throw new Error(decision.error || "mode d'authentification indéterminable");
    this.mode = decision.mode;
    this.basicProvider = this.mode === "basic" ? basic : null;
    switch (this.mode) {
      case "basic":
        // INATTEIGNABLE : la résolution refuse « basic » sans identifiants exploitables. On le dit
        // tout de même, plutôt que d'écrire un `!` de complaisance ou de retomber sur le mode dev.
        if (!basic) throw new Error("mode basic sélectionné sans identifiants exploitables (BASIC_AUTH)");
        this.provider = basic;
        this.log.info("auth", "Basic Auth dev (user " + basic.login + ")");
        break;
      case "sso":
        this.provider = new LegacySsoAuthProvider(log, ssoUrl, cookieName, opts.ssoFetch);
        this.log.info("auth", "SSO " + ssoUrl + (cookieName ? " (cookie " + cookieName + ")" : " (Cookie complet)"));
        break;
      case "forward": {
        const forward = new ForwardHeaderAuthProvider(opts.forward || {});
        this.provider = forward;
        this.log.info("auth", "Forward auth : en-têtes " + forward.userHeader + " / " + forward.groupsHeader
          + (forward.secretConfigured ? " (secret partagé attendu dans " + forward.secretHeader + ")" : ""));
        // 🚨 Sans secret partagé, la SEULE protection est le réseau — et le code ne peut pas la
        // vérifier. Un déploiement qui expose l'app en direct laisse alors n'importe qui forger son
        // identité : même ton que le WARN du mode dev, parce que c'est le même genre de trou.
        if (!forward.secretConfigured) {
          this.log.warn("auth", "⚠ mode FORWARD sans " + ForwardHeaderAuthProvider.ENV_SECRET
            + " : les en-têtes d'identité sont crus SANS preuve — l'application doit être joignable UNIQUEMENT par le proxy"
            + " (bind localhost / réseau privé), sinon tout client direct peut se déclarer administrateur.");
        }
        break;
      }
      default:
        // Mode dev = AUCUNE authentification (tout appelant est SUPER_ADMIN, lecture/écriture/suppression comprises).
        // C'est le DÉFAUT quand ni SSO_URL ni BASIC_AUTH ne sont configurés → un déploiement réel démarré sans ces
        // variables serait grand ouvert : on le signale en WARN bien visible au boot, pas en simple info.
        this.provider = new DevAuthProvider(opts.devUser ?? null);
        this.log.warn("auth", "⚠ mode DEV : AUCUNE authentification — tout appelant est SUPER_ADMIN. Configurer SSO_URL ou BASIC_AUTH pour un déploiement réel.");
    }
  }

  /** Vérifie l'en-tête `Authorization: Basic` pour le GATE DE TRANSPORT (`server.ts`) — hors mode
      basic, il n'y a pas de challenge à opposer, donc `true` (« rien à objecter »).
      ⚠ Ce n'est PAS une identification : le gate ne veut savoir que s'il doit renvoyer un 401
      `WWW-Authenticate`. L'identité, elle, passe par `validate` comme dans tous les modes. */
  checkBasic(req: AuthRequestView): boolean {
    return this.basicProvider ? this.basicProvider.accepts(req) : true;
  }

  /** Session de l'appelant. Le provider identifie ; l'orchestrateur mémorise et capture.

      Deux chemins, et c'est le provider qui décide duquel il relève :
      - il ne nomme PAS la session présentée (`sessionKey` absente, ou aucun jeton) → réponse
        directe, sans cache. Dev et basic sont ici, ainsi que le SSO sans cookie (rien à valider) ;
      - il la nomme → cache par HASH du jeton (le jeton lui-même ne devient jamais une clé en
        clair), jusqu'à `expireDate`. */
  async validate(req: AuthRequestView): Promise<SsoResult> {
    const presented = this.provider.sessionKey ? this.provider.sessionKey(req) : null;
    if (!presented) {
      const result = await this.identify(req);
      this.capture(result);
      return result;
    }
    const key = createHash("sha256").update(presented).digest("hex");
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now < hit.expireAt) return hit.result;          // même jeton, non expiré → cache (PAS de re-capture)
    const result = await this.identify(req);
    this.cache.set(key, { result, expireAt: Auth.expiryOf(result, now) });
    this.prune(now);
    // Capture SEULEMENT sur défaut de cache jeton : le cache par jeton borne déjà la fréquence (le
    // resolver throttle en plus ses écritures snapshot). Sur un hit ci-dessus, on a déjà remonté ce profil.
    this.capture(result);
    return result;
  }

  /** Appel du provider, avec la substitution du `null` du contrat par la session anonyme. */
  private async identify(req: AuthRequestView): Promise<SsoResult> {
    const result = await this.provider.authenticate(req);
    return result ?? ANONYMOUS_SESSION;
  }

  /** Pousse un profil AUTHENTIFIÉ vers le puits injecté (annuaire), le cas échéant.
      INVARIANT (arbitrage) : on ne capture JAMAIS un profil non loggé (anonyme / échec d'auth) —
      seul un utilisateur réellement authentifié alimente l'annuaire. */
  private capture(r: SsoResult): void {
    if (this.sink && r.logged && r.user) this.sink.remember(r.user);
  }

  /** Échéance de la session en cache. Une session AUTHENTIFIÉE vaut jusqu'à son `expireDate` ;
      tout le reste (anonyme, SSO en panne, `expireDate` absente ou déjà passée) tient une minute —
      assez pour absorber une rafale de requêtes, trop peu pour qu'une identité rétablie attende. */
  private static expiryOf(r: SsoResult, now: number): number {
    const exp = Number(r.expireDate);
    if (r.logged && exp && exp > now) return exp;
    return now + 60_000;
  }

  private prune(now: number): void { for (const [k, v] of this.cache) if (now >= v.expireAt) this.cache.delete(k); }
}

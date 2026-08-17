import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type SqliteCtor } from "./db.js";
import { DocumentStore } from "./documents.js";
import { Auth } from "./auth.js";
import { ForwardHeaderAuthProvider } from "./auth/ForwardHeaderAuthProvider.js";   // mode forward : le provider POSSÈDE les noms de ses variables (optionsFromEnv)
import { OidcConfig } from "./auth/OidcConfig.js";   // mode oidc : idem — les SIX noms de variables OIDC n'existent que là
import { OidcRoutes } from "./auth/OidcRoutes.js";   // POUR SA VALEUR DE `loginUrl` par défaut (le module possède ses chemins)
import { OpenIdClientAdapter } from "./auth/OpenIdClientAdapter.js";   // SEUL importeur d'`openid-client` — injecté dans Auth, jamais importé par elle
import { LiveBus } from "./live.js";
import { Server } from "./server.js";
import { Logger } from "./logger.js";
import { UsersDb } from "./users/UsersDb.js";   // snapshot de l'annuaire (users.db) — service CORE
import { AuthCacheUserResolver } from "./users/AuthCacheUserResolver.js";   // impl v1 de l'annuaire (cache d'auth + snapshot)
import { AccessControl } from "./access/AccessControl.js";   // contrôle d'accès (service CORE) — gardes de permission, cf. docs/auth.md
import { FileRoleProvider } from "./access/FileRoleProvider.js";   // politique de rôles v1 : roles.json relu à chaud, fail-closed
import { VmModule } from "./vm/VmModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de vm/
import { WifiModule } from "./wifi/WifiModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de wifi/
import { NotifyModule } from "./notify/NotifyModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de notify/
import { CertsModule } from "./certs/CertsModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de certs/
import { InterventionsModule } from "./interventions/InterventionsModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de interventions/
import { TrackerModule } from "./tracker/TrackerModule.js";   // module OPTIONNEL (feature amovible) — PONT interventions ⇄ tracker distant
import { LifecycleModule } from "./lifecycle/LifecycleModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de lifecycle/
import { Schema } from "./constants.js";   // pageSize « tout » du balayage des garanties (pont lifecycle ci-dessous)

/* Bootstrap : lit l'environnement, ouvre le registre multi-documents (driver better-sqlite3) et démarre le serveur. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, "..", "data", "documents");
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, "..", "..", "dist");   // sortie webpack (dist/dc-manager.html)
const API_BASE = process.env.API_BASE || "/api";
// URL de connexion SSO injectée au client (bouton « Connexion » du welcome quand non authentifié). Vide = pas de
// bouton. La macro ${clbkUrl} y est remplacée côté client par l'URL courante encodée (retour après connexion).
const SSO_LOGIN_URL = process.env.SSO_LOGIN_URL || "";
// MODE d'authentification EXPLICITE : dev | basic | sso | forward. ABSENTE → inférence historique
// (BASIC_AUTH → basic, sinon SSO_URL → sso, sinon dev + WARN). 🚨 Une valeur inconnue ou incohérente
// ARRÊTE le démarrage (cf. le try/catch plus bas) : un repli silencieux sur le mode dev, qui
// n'authentifie personne, ouvrirait l'instance. Cf. auth/AuthModeResolution et docs/auth.md.
const AUTH_MODE = process.env.AUTH_MODE ?? "";
// SSO externe : configurer SSO_URL (+ COOKIE_NAME) via l'environnement. Défaut VIDE → mode dev (utilisateur factice SUPER_ADMIN).
const SSO_URL = process.env.SSO_URL ?? "";
const COOKIE_NAME = process.env.COOKIE_NAME ?? "";   // cookie du jeton à proxifier au SSO ("" = en-tête Cookie complet)
const DEV_USER = process.env.DEV_USER ?? null;
const BASIC_AUTH = process.env.BASIC_AUTH || null;                // "user:pass" → gate Basic Auth (dev), PRIORITAIRE sur le SSO
// Mode FORWARD (reverse-proxy identity-aware : Authelia, Authentik, oauth2-proxy, Cloudflare Access,
// Tailscale…) : noms d'en-têtes AUTH_FORWARD_USER_HEADER / _EMAIL_HEADER / _NAME_HEADER /
// _GROUPS_HEADER (défauts Remote-*) + secret partagé AUTH_FORWARD_SECRET (+ _SECRET_HEADER). Les six
// noms vivent DANS le provider (source unique) : le bootstrap ne fait que lui passer l'environnement.
const FORWARD_OPTIONS = ForwardHeaderAuthProvider.optionsFromEnv(process.env);
// Mode OIDC (AUTH_MODE=oidc) : l'application est elle-même le RP d'un OP (Keycloak, Entra ID,
// Authelia en mode OP…) en flux Authorization Code + PKCE. OIDC_ISSUER / OIDC_CLIENT_ID /
// OIDC_REDIRECT_URL sont REQUIS (refus de démarrer sinon) ; OIDC_CLIENT_SECRET est optionnel
// (client public + PKCE) ; OIDC_SCOPES et OIDC_COOKIE_SECURE ont des défauts. Les six noms vivent
// DANS OidcConfig (source unique) : le bootstrap ne fait que lui passer l'environnement.
const OIDC_OPTIONS = OidcConfig.optionsFromEnv(process.env);

const log = Logger.fromEnv();
// Annuaire utilisateurs (service CORE, aucune clé d'environnement requise) : snapshot « dernier profil vu »
// (users.db, même dossier data + driver injecté que DocumentStore) RÉHYDRATÉ au boot ; le resolver capture
// les profils authentifiés (puits injecté dans Auth ci-dessous) et sert la résolution batch (GET /users/resolve).
// Si users.db est indisponible, l'annuaire vit en MÉMOIRE seule (dummy après un redémarrage, jusqu'à reconnexion).
let usersDb: UsersDb | null = null;
try { usersDb = new UsersDb(DOCS_DIR, Database as unknown as SqliteCtor, log.child("users")); }
catch (e) { log.child("users").error("snapshot users.db indisponible — annuaire en mémoire seule", (e as any) && (e as any).message); }
const userResolver = new AuthCacheUserResolver(usersDb, log.child("users"));
// Auth reçoit l'annuaire comme PUITS de profils (ProfileSink) : chaque authentification réussie y est capturée,
// sans qu'Auth connaisse l'implémentation (découplage — principe n°2).
// 🚨 REFUS DE DÉMARRER sur configuration d'authentification douteuse (AUTH_MODE inconnue, mode
// explicite dont la configuration manque) : le constructeur JETTE, et le seul repli possible serait
// le mode dev — qui n'authentifie personne. Mieux vaut un service qui ne monte pas qu'un service
// grand ouvert que l'exploitant croit protégé (anti fail-open). Le message est ACTIONNABLE : il
// nomme la variable et la correction attendue.
// La couche `openid-client` est CONSTRUITE ICI et injectée : `auth.ts` n'importe donc jamais le
// paquet (ESM pur, absent des node_modules de la racine où le programme de test compile en
// CommonJS) et reste testable. La fabrique n'est appelée QUE dans la branche `oidc` d'`Auth` — un
// déploiement dans les quatre autres modes ne construit rien et ne touche aucun réseau.
// La référence est retenue pour l'ARRÊT PROPRE (minuteurs de réessai de découverte, plus bas).
let oidcAdapter: OpenIdClientAdapter | null = null;
function buildAuth(): Auth {
  try {
    return new Auth(log.child("auth"), {
      authMode: AUTH_MODE, ssoUrl: SSO_URL, cookieName: COOKIE_NAME, devUser: DEV_USER, basicAuth: BASIC_AUTH,
      forward: FORWARD_OPTIONS, oidc: OIDC_OPTIONS,
      oidcClientFactory: (options) => (oidcAdapter = new OpenIdClientAdapter(options, log.child("auth"))),
    }, userResolver);
  } catch (e) {
    log.child("auth").error("configuration d'AUTHENTIFICATION invalide — le serveur NE DÉMARRE PAS", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
const auth = buildAuth();
// AUTORISATION (service CORE, cf. docs/auth.md) — orthogonale à l'authentification ci-dessus :
// `Auth` dit QUI est l'appelant, `AccessControl` dit CE QU'IL PEUT. La POLITIQUE (utilisateur →
// rôles) vit dans un provider sélectionné ici : v1 = un `roles.json` relu à chaud (ROLES_FILE,
// défaut <DOCS_DIR>/roles.json) + les administrateurs d'amorçage de BOOTSTRAP_ADMIN_IDS.
// Fail-closed : fichier absent/illisible → personne n'a de rôle, jamais de repli ouvert.
const roleProvider = FileRoleProvider.fromEnv(process.env, DOCS_DIR, log.child("access"));
roleProvider.start();   // veille de rechargement à chaud (sondage, `persistent: false` — ne retient pas l'arrêt)
// PONT vers l'authentification : `AccessControl` ne connaît PAS Express (il déclare ses propres
// vues minimales de la requête, cf. AccessControl) ni `Auth`. C'est ici, au bootstrap — le seul
// endroit qui connaît déjà les deux — que la validation de session lui est INJECTÉE. Le cast
// traverse cette frontière de types volontairement étroite ; il ne masque aucune conversion.
const access = new AccessControl({
  session: (req) => auth.validate(req as any),
  roles: roleProvider,
  log: log.child("access"),
});
const docs = new DocumentStore(DOCS_DIR, Database as unknown as SqliteCtor, log.child("docs"));
const live = new LiveBus(log.child("live"));
// Notifications (alertes persistantes + rappels) : mêmes prérequis que vm/ (DCMANAGER_SECRETS_KEY
// pour chiffrer les jetons des webhooks — module inactif en 503 explicite sans clé, cf. NotifyModule).
// CRÉÉ AVANT vm : le module VM lui SIGNALE ses échecs de synchro (producteur vm-sync-failure, S4).
const notify = NotifyModule.create({ docs, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, access, log: log.child("notify") });
// Inventaire VM (Proxmox…) : providers PAR DOCUMENT. Clé DCMANAGER_SECRETS_KEY présente (SecretBox
// partagé — clé UNIQUE, sans repli depuis le 2026-07-20) → stockage DB chiffré (DOCS_DIR/vm-providers.db,
// même driver better-sqlite3 injecté que DocumentStore) + CRUD, seule source de config ;
// absente → module inactif (toutes les routes en 503 « définir DCMANAGER_SECRETS_KEY… », cf. VmModule).
// PONT vers notify (typage STRUCTUREL — vm/ n'importe RIEN de notify/, les deux features restent
// amovibles) : chaque échec de synchro persistant est signalé (raise) au module notifications, chaque
// retour à la normale le clôt (resolve). L'anti-spam/rappels vit ENTIÈREMENT côté notify (no-op si
// le module est inactif, faute de clé).
const vm = VmModule.create({ docs, live, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, access, log: log.child("vm"),
  problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) } });
// Inventaire des CLIENTS WIFI (contrôleur UniFi en 1re implémentation — la marque n'est qu'un adaptateur,
// cf. docs/wifi-unifi.md § « Ajouter un provider d'une autre marque ») : providers PAR DOCUMENT, dans
// DOCS_DIR/wifi-providers.db (même driver better-sqlite3 injecté que DocumentStore). Prérequis IDENTIQUE
// à vm/ et notify/ : DCMANAGER_SECRETS_KEY (SecretBox PARTAGÉ — une seule clé d'infrastructure, c'est VOULU) ;
// absente → module inactif (toutes les routes en 503 actionnable, cf. WifiModule).
// PONT vers notify (typage STRUCTUREL — wifi/ n'importe RIEN de notify/, les deux features restent
// amovibles) : chaque échec de synchro persistant est signalé (raise), chaque retour à la normale le clôt.
const wifi = WifiModule.create({ docs, live, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, access, log: log.child("wifi"),
  problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) } });
// Certificats (PKI interne, ZÉRO-CONNAISSANCE : crypto côté navigateur, le serveur ne stocke que des
// métadonnées + blobs chiffrés client — aucune clé d'environnement requise, cf. CertsModule).
// PONT vers notify (typage structurel, comme vm) : le veilleur d'échéances signale cert-expiry
// (seuils 30/14/7 j) et clôt au renouvellement/révocation/suppression.
const certs = CertsModule.create({ docs, live, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, access, log: log.child("certs"),
  problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) } });
// Cycle de vie matériel (veilleur de GARANTIES — cadrage garantie-alerte 2026-08-15) : signale les
// échéances de garantie (warranty-expiring ≤ 90 j / warranty-expired) des équipements ET sous-équipements
// de TOUS les documents. PREMIER veilleur à balayer les documents via DocumentStore — la source est un
// contrat de LECTURE réduit (WarrantySource), rempli ICI : lifecycle/ n'importe rien de documents.ts.
// ⚠ COÛT ASSUMÉ du balayage : `docs.repo(id)` OUVRE chaque document (migration legacy comprise au premier
// accès) — passe QUOTIDIENNE sur un parc de documents PETIT, et les dépôts ouverts restent en cache
// (DocumentStore.repos) : le coût réel est une lecture de deux collections par document et par jour.
// PONT vers notify (typage STRUCTUREL, comme vm/certs) : l'option `silent` (anti-bruit du premier
// balayage d'un document — cf. docs/lifecycle.md) est RELAYÉE au moteur.
const lifecycle = LifecycleModule.create({ dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, log: log.child("lifecycle"),
  source: {
    documentIds: () => docs.list().map((d) => d.id),
    sweep: () => {
      const items: Array<{ doc_id: string; collection: "equipments" | "subEquipments"; id: string; label: string; warranty_end: string }> = [];
      for (const meta of docs.list()) {
        const repo = docs.repo(meta.id);
        if (!repo) continue;   // document supprimé entre list() et repo() — course bénigne, passe suivante
        for (const collection of ["equipments", "subEquipments"] as const) {
          for (const row of repo.list(collection, { page: 1, pageSize: Schema.PAGE_SIZE_ALL }).rows) {
            // Seuls les porteurs d'une échéance intéressent le veilleur (l'immense majorité n'en a pas).
            const warrantyEnd = typeof row.warranty_end === "string" ? row.warranty_end : "";
            if (warrantyEnd === "") continue;
            items.push({ doc_id: meta.id, collection, id: String(row.id), label: String(row.name || row.id), warranty_end: warrantyEnd });
          }
        }
      }
      return items;
    },
  },
  problems: { raise: (k, e, o) => notify.raise(k, e, o), resolve: (k) => notify.resolve(k) } });
// Interventions/incidents (objets liés aux équipements/VMs/spares — aucune clé d'environnement requise,
// base interventions.db dédiée, cf. InterventionsModule). PONT vers notify (typage structurel, comme
// vm/certs) : le veilleur de rappels signale intervention-reminder (paliers 24 h/1 h/heure H) et clôt
// dès qu'un objet démarre/se clôt/s'annule ou est supprimé.
// ⚠ Les modules `interventions/` et `tracker/` se POINTENT L'UN L'AUTRE — chacun par une INTERFACE
// déclarée CHEZ LUI, jamais par un import : interventions ANNONCE ses écritures (`onWrite`), tracker
// LIT et ÉCRIT l'état de réplication (`listTracked`/`listPushDue`/`getOne`/`applyTrackerState`, que
// la façade InterventionsModule satisfait structurellement). Chacun reste donc supprimable seul.
// La boucle de construction se dénoue par une FERMETURE : le rappel lit la variable AU MOMENT de
// l'appel — donc après l'affectation trois lignes plus bas. Pont absent ⇒ `null` ⇒ rappel inerte.
let tracker: TrackerModule | null = null;
const interventions = InterventionsModule.create({ docs, live, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, access, log: log.child("interventions"),
  problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) },
  onWrite: (docId, interventionId, kind) => tracker?.onInterventionWrite(docId, interventionId, kind) });
// Réplication des interventions/incidents dans un tracker distant (Atlassian Jira Cloud en 1re
// implémentation — la marque n'est qu'un adaptateur derrière `kind`). Providers PAR DOCUMENT dans
// DOCS_DIR/tracker-providers.db. Prérequis IDENTIQUE à vm//wifi//notify/ : DCMANAGER_SECRETS_KEY
// (SecretBox PARTAGÉ) ; absente → module inactif, routes en 503 actionnable et hook inerte — les
// interventions, elles, restent PLEINEMENT fonctionnelles. PONT vers notify (typage structurel) :
// chaque passe en échec est signalée, chaque retour à la normale la clôt.
const trackerModule = TrackerModule.create({ docs, interventions, live, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, access, log: log.child("tracker"),
  problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) } });
tracker = trackerModule;
// BOUTON « Connexion » de l'écran d'accueil : le client l'affiche dès qu'une `loginUrl` lui est
// injectée. En mode OIDC, l'application SAIT où est sa propre route de connexion — exiger en plus
// que l'exploitant recopie SSO_LOGIN_URL serait une configuration redondante, et une occasion de
// se tromper. On défaut donc sur la route servie, en valeur RELATIVE (« auth/login », sans slash
// initial) : les URLs du client sont ancrées sur le <base> du HTML, exactement comme `apiBaseUrl`
// que server.ts dérive de la même façon — c'est ce qui fait marcher le déploiement en sous-dossier
// (cf. docs/reverse-proxy.md). SSO_LOGIN_URL, si elle est renseignée, reste PRIORITAIRE : un
// exploitant qui veut passer par une page intermédiaire garde la main.
const LOGIN_URL = SSO_LOGIN_URL || (auth.mode === "oidc" ? OidcRoutes.DEFAULT_CLIENT_LOGIN_URL : "");
new Server({ docs, auth, live, resolver: userResolver, access, clientDir: CLIENT_DIR, apiBase: API_BASE, loginUrl: LOGIN_URL, log, extensions: [vm.extension(), wifi.extension(), notify.extension(), certs.extension(), interventions.extension(), trackerModule.extension()] }).listen(PORT);
vm.start();   // synchros périodiques (interval_sec > 0) — après l'écoute : le serveur répond pendant une 1re synchro lente
wifi.start();   // synchros périodiques des clients wifi — même raison que vm.start()
notify.start();   // timer de rappels (tick 60 s, unref) — après l'écoute, comme vm
certs.start();    // suivi d'échéances (passe immédiate + tick horaire, unref)
lifecycle.start();   // veilleur de garanties (passe immédiate + tick QUOTIDIEN, unref — granularité jour assumée)
interventions.start();   // veilleur de rappels (passe immédiate + tick 5 min, unref)
trackerModule.start();   // ramassage des poussées laissées en plan (non bloquant) + passes périodiques (interval_sec > 0, unref)

// ARRÊT PROPRE (SIGINT = Ctrl-C · SIGTERM = docker stop / systemd) : ferme les dépôts SQLite et le registre
// (optimize + checkpoint des -wal — cf. DocumentStore.closeAll) avant de quitter. Sans ça, l'OS ferme les fd
// mais laisse des -wal non checkpointés (recouvrés à la réouverture, jamais corrompus, juste volumineux).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("signal reçu, arrêt propre", sig);
    // Modules optionnels d'abord (timers + bases dédiées vm-providers.db / wifi-providers.db / notify.db /
    // certs.db / lifecycle.db / interventions.db / tracker-providers.db), cœur ensuite.
    try { vm.stop(); } catch (e) { log.warn("vm.stop a échoué", (e as any) && (e as any).message); }
    try { wifi.stop(); } catch (e) { log.warn("wifi.stop a échoué", (e as any) && (e as any).message); }
    try { notify.stop(); } catch (e) { log.warn("notify.stop a échoué", (e as any) && (e as any).message); }
    try { certs.stop(); } catch (e) { log.warn("certs.stop a échoué", (e as any) && (e as any).message); }
    try { lifecycle.stop(); } catch (e) { log.warn("lifecycle.stop a échoué", (e as any) && (e as any).message); }
    try { interventions.stop(); } catch (e) { log.warn("interventions.stop a échoué", (e as any) && (e as any).message); }
    try { trackerModule.stop(); } catch (e) { log.warn("tracker.stop a échoué", (e as any) && (e as any).message); }
    try { roleProvider.stop(); } catch (e) { log.warn("roleProvider.stop a échoué", (e as any) && (e as any).message); }
    // Minuteurs de réessai de la découverte OIDC (déjà `unref`és — ceinture et bretelles, comme
    // pour les autres modules : l'arrêt propre ne doit dépendre d'aucun réglage de minuteur).
    try { oidcAdapter?.stop(); } catch (e) { log.warn("oidcAdapter.stop a échoué", (e as any) && (e as any).message); }
    try { usersDb?.close(); } catch (e) { log.warn("usersDb.close a échoué", (e as any) && (e as any).message); }
    try { docs.closeAll(); } catch (e) { log.warn("closeAll a échoué", (e as any) && (e as any).message); }
    process.exit(0);
  });
}

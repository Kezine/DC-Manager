import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type SqliteCtor } from "./db.js";
import { DocumentStore } from "./documents.js";
import { Auth } from "./auth.js";
import { LiveBus } from "./live.js";
import { Server } from "./server.js";
import { Logger } from "./logger.js";
import { VmModule } from "./vm/VmModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de vm/
import { NotifyModule } from "./notify/NotifyModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de notify/
import { CertsModule } from "./certs/CertsModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de certs/
import { InterventionsModule } from "./interventions/InterventionsModule.js";   // module OPTIONNEL (feature amovible) — seul câblage hors de interventions/

/* Bootstrap : lit l'environnement, ouvre le registre multi-documents (driver better-sqlite3) et démarre le serveur. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, "..", "data", "documents");
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, "..", "..", "dist");   // sortie webpack (dist/dc-manager.html)
const API_BASE = process.env.API_BASE || "/api";
// URL de connexion SSO injectée au client (bouton « Connexion » du welcome quand non authentifié). Vide = pas de
// bouton. La macro ${clbkUrl} y est remplacée côté client par l'URL courante encodée (retour après connexion).
const SSO_LOGIN_URL = process.env.SSO_LOGIN_URL || "";
// SSO externe : configurer SSO_URL (+ COOKIE_NAME) via l'environnement. Défaut VIDE → mode dev (utilisateur factice SUPER_ADMIN).
const SSO_URL = process.env.SSO_URL ?? "";
const COOKIE_NAME = process.env.COOKIE_NAME ?? "";   // cookie du jeton à proxifier au SSO ("" = en-tête Cookie complet)
const DEV_USER = process.env.DEV_USER ?? null;
const BASIC_AUTH = process.env.BASIC_AUTH || null;                // "user:pass" → gate Basic Auth (dev), PRIORITAIRE sur le SSO

const log = Logger.fromEnv();
const auth = new Auth(log.child("auth"), { ssoUrl: SSO_URL, cookieName: COOKIE_NAME, devUser: DEV_USER, basicAuth: BASIC_AUTH });
const docs = new DocumentStore(DOCS_DIR, Database as unknown as SqliteCtor, log.child("docs"));
const live = new LiveBus(log.child("live"));
// Notifications (alertes persistantes + rappels) : mêmes prérequis que vm/ (DCMANAGER_SECRETS_KEY
// pour chiffrer les jetons des webhooks — module inactif en 503 explicite sans clé, cf. NotifyModule).
// CRÉÉ AVANT vm : le module VM lui SIGNALE ses échecs de synchro (producteur vm-sync-failure, S4).
const notify = NotifyModule.create({ docs, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, log: log.child("notify") });
// Inventaire VM (Proxmox…) : providers PAR DOCUMENT. Clé DCMANAGER_SECRETS_KEY présente (SecretBox
// partagé — legacy VM_PROVIDERS_KEY lue en repli) → stockage DB chiffré (DOCS_DIR/vm-providers.db,
// même driver better-sqlite3 injecté que DocumentStore) + CRUD ;
// absente → fichier legacy DOCS_DIR/vm-providers.json en lecture seule (cf. VmModule).
// PONT vers notify (typage STRUCTUREL — vm/ n'importe RIEN de notify/, les deux features restent
// amovibles) : chaque échec de synchro persistant est signalé (raise) au module notifications, chaque
// retour à la normale le clôt (resolve). L'anti-spam/rappels vit ENTIÈREMENT côté notify (no-op si
// le module est inactif, faute de clé).
const vm = VmModule.create({ docs, live, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, log: log.child("vm"),
  problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) } });
// Certificats (PKI interne, ZÉRO-CONNAISSANCE : crypto côté navigateur, le serveur ne stocke que des
// métadonnées + blobs chiffrés client — aucune clé d'environnement requise, cf. CertsModule).
// PONT vers notify (typage structurel, comme vm) : le veilleur d'échéances signale cert-expiry
// (seuils 30/14/7 j) et clôt au renouvellement/révocation/suppression.
const certs = CertsModule.create({ docs, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, log: log.child("certs"),
  problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) } });
// Interventions/incidents (objets liés aux équipements/VMs/spares — aucune clé d'environnement requise,
// base interventions.db dédiée, cf. InterventionsModule). PONT vers notify (typage structurel, comme
// vm/certs) : le veilleur de rappels signale intervention-reminder (paliers 24 h/1 h/heure H) et clôt
// dès qu'un objet démarre/se clôt/s'annule ou est supprimé.
const interventions = InterventionsModule.create({ docs, dataDir: DOCS_DIR, sqlite: Database as unknown as SqliteCtor, log: log.child("interventions"),
  problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) } });
new Server({ docs, auth, live, clientDir: CLIENT_DIR, apiBase: API_BASE, loginUrl: SSO_LOGIN_URL, log, extensions: [vm.extension(), notify.extension(), certs.extension(), interventions.extension()] }).listen(PORT);
vm.start();   // synchros périodiques (interval_sec > 0) — après l'écoute : le serveur répond pendant une 1re synchro lente
notify.start();   // timer de rappels (tick 60 s, unref) — après l'écoute, comme vm
certs.start();    // suivi d'échéances (passe immédiate + tick horaire, unref)
interventions.start();   // veilleur de rappels (passe immédiate + tick 5 min, unref)

// ARRÊT PROPRE (SIGINT = Ctrl-C · SIGTERM = docker stop / systemd) : ferme les dépôts SQLite et le registre
// (optimize + checkpoint des -wal — cf. DocumentStore.closeAll) avant de quitter. Sans ça, l'OS ferme les fd
// mais laisse des -wal non checkpointés (recouvrés à la réouverture, jamais corrompus, juste volumineux).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("signal reçu, arrêt propre", sig);
    // Modules optionnels d'abord (timers + bases dédiées vm-providers.db / notify.db), cœur ensuite.
    try { vm.stop(); } catch (e) { log.warn("vm.stop a échoué", (e as any) && (e as any).message); }
    try { notify.stop(); } catch (e) { log.warn("notify.stop a échoué", (e as any) && (e as any).message); }
    try { certs.stop(); } catch (e) { log.warn("certs.stop a échoué", (e as any) && (e as any).message); }
    try { interventions.stop(); } catch (e) { log.warn("interventions.stop a échoué", (e as any) && (e as any).message); }
    try { docs.closeAll(); } catch (e) { log.warn("closeAll a échoué", (e as any) && (e as any).message); }
    process.exit(0);
  });
}

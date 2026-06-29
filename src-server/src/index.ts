import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type SqliteCtor } from "./db.js";
import { DocumentStore } from "./documents.js";
import { Auth } from "./auth.js";
import { LiveBus } from "./live.js";
import { Server } from "./server.js";
import { Logger } from "./logger.js";

/* Bootstrap : lit l'environnement, ouvre le registre multi-documents (driver better-sqlite3) et démarre le serveur. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, "..", "data", "documents");
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, "..", "..", "dist");   // sortie webpack (dist/dc-manager.html)
const API_BASE = process.env.API_BASE || "/api";
// URL de connexion SSO injectée au client (bouton « Connexion » du welcome quand non authentifié). Vide = pas de
// bouton. La macro ${clbkUrl} y est remplacée côté client par l'URL courante encodée (retour après connexion).
const LOGIN_URL = process.env.LOGIN_URL || "";
// SSO externe : configurer SSO_URL (+ COOKIE_NAME) via l'environnement. Défaut VIDE → mode dev (utilisateur factice SUPER_ADMIN).
const SSO_URL = process.env.SSO_URL ?? "";
const COOKIE_NAME = process.env.COOKIE_NAME ?? "";   // cookie du jeton à proxifier au SSO ("" = en-tête Cookie complet)
const DEV_USER = process.env.DEV_USER ?? null;
const BASIC_AUTH = process.env.BASIC_AUTH || null;                // "user:pass" → gate Basic Auth (dev), PRIORITAIRE sur le SSO

const log = Logger.fromEnv();
const auth = new Auth(log.child("auth"), { ssoUrl: SSO_URL, cookieName: COOKIE_NAME, devUser: DEV_USER, basicAuth: BASIC_AUTH });
const docs = new DocumentStore(DOCS_DIR, Database as unknown as SqliteCtor, log.child("docs"));
const live = new LiveBus(log.child("live"));
new Server({ docs, auth, live, clientDir: CLIENT_DIR, apiBase: API_BASE, loginUrl: LOGIN_URL, log }).listen(PORT);

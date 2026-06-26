import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type SqliteCtor } from "./db.js";
import { DocumentStore } from "./documents.js";
import { Auth } from "./auth.js";
import { Server } from "./server.js";
import { Logger } from "./logger.js";

/* Bootstrap : lit l'environnement, ouvre le registre multi-documents (driver better-sqlite3) et démarre le serveur. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, "..", "data", "documents");
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, "..", "..", "dist");   // sortie webpack (dist/netmap.html)
const API_BASE = process.env.API_BASE || "/api";
// SSO : URL par défaut = SSO externe. SSO_URL="" (vide) → mode dev (utilisateur factice SUPER_ADMIN).
const SSO_URL = process.env.SSO_URL ?? "https://sso.example.com/validate";
const COOKIE_NAME = process.env.COOKIE_NAME ?? "SsoJWT";   // cookie du jeton à proxifier (défaut SSO externe ; "" = en-tête Cookie complet)
const DEV_USER = process.env.DEV_USER ?? null;

const log = Logger.fromEnv();
const auth = new Auth(log.child("auth"), { ssoUrl: SSO_URL, cookieName: COOKIE_NAME, devUser: DEV_USER });
const docs = new DocumentStore(DOCS_DIR, Database as unknown as SqliteCtor, log.child("docs"));
new Server({ docs, auth, clientDir: CLIENT_DIR, apiBase: API_BASE, log }).listen(PORT);

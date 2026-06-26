import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type SqliteCtor } from "./db.js";
import { DocumentStore } from "./documents.js";
import { Server } from "./server.js";
import { Logger } from "./logger.js";

/* Bootstrap : lit l'environnement, ouvre le registre multi-documents (driver better-sqlite3) et démarre le serveur. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, "..", "data", "documents");
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, "..", "..", "dist");   // sortie webpack (dist/netmap.html)
const API_BASE = process.env.API_BASE || "/api";

const log = Logger.fromEnv();
const docs = new DocumentStore(DOCS_DIR, Database as unknown as SqliteCtor, log.child("docs"));
new Server({ docs, clientDir: CLIENT_DIR, apiBase: API_BASE, log }).listen(PORT);

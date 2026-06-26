import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Repository, type SqliteCtor } from "./db.js";
import { Server } from "./server.js";

/* Bootstrap : lit l'environnement, ouvre le dépôt (driver better-sqlite3) et démarre le serveur. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "netmap.db");
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, "..", "..", "dist");   // sortie webpack (dist/netmap.html)
const API_BASE = process.env.API_BASE || "/api";

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const repo = Repository.open(DB_FILE, Database as unknown as SqliteCtor);
new Server({ repo, clientDir: CLIENT_DIR, apiBase: API_BASE }).listen(PORT);

import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApi } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "netmap.db");
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, "..", "..", "dist");   // sortie webpack (dist/netmap.html)
const API_BASE = process.env.API_BASE || "/api";

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "128mb" }));   // /snapshot et /transact peuvent être volumineux

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.use(API_BASE, createApi(db));
app.use(API_BASE, (req, res) => res.status(404).json({ error: "endpoint inconnu" }));   // 404 API (avant le fallback HTML)

/* --- service du CLIENT (HTML autonome) avec injection de window.__NETMAP_CONFIG__ ---
   La prod webpack produit un seul fichier dist/netmap.html (JS+CSS inlinés) : on injecte
   la config dans <head> AVANT le bundle pour activer le mode API sans configuration utilisateur. */
const HTML_FILE = path.join(CLIENT_DIR, "netmap.html");
function serveClient(req, res) {
  let html;
  try { html = fs.readFileSync(HTML_FILE, "utf8"); }
  catch (_) { return res.status(503).send("Client introuvable (" + HTML_FILE + "). Lancez `npm run build` dans NetMap/."); }
  const cfg = `<script>window.__NETMAP_CONFIG__=${JSON.stringify({ mode: "api", apiBaseUrl: API_BASE })};</script>`;
  html = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${cfg}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}
app.get(["/", "/netmap.html", "/index.html"], serveClient);
app.use(express.static(CLIENT_DIR, { index: false }));   // assets éventuels (build multi-fichiers en dev)
app.get("*", serveClient);                               // fallback SPA → HTML client

app.listen(PORT, () => console.log(`NetMap server → http://localhost:${PORT}  (api ${API_BASE}, db ${DB_FILE})`));

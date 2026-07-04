import express, { type Express, type RequestHandler, type ErrorRequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import { Api } from "./api.js";
import { DocumentStore } from "./documents.js";
import { Auth } from "./auth.js";
import { LiveBus } from "./live.js";
import { Logger } from "./logger.js";

export interface ServerOptions { docs: DocumentStore; auth: Auth; live: LiveBus; clientDir: string; apiBase: string; loginUrl?: string; log?: Logger }

/** Application HTTP : API REST sous `apiBase` + service du client (HTML autonome) avec injection de config. */
export class Server {
  private readonly app: Express;
  private readonly log: Logger;
  private readonly httpLog: Logger;

  constructor(private readonly opts: ServerOptions) {
    this.log = opts.log || new Logger();
    this.httpLog = this.log.child("http");
    this.app = express();
    this.app.disable("x-powered-by");
    // Anti MIME-sniffing : le navigateur ne doit jamais « deviner » un type exécutable sur une réponse
    // (ex. un blob d'image au Content-Type fourni par le client) — défense en profondeur contre le XSS stocké.
    this.app.use((_req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); next(); });
    this.app.use(this.requestLogger);                 // trace de chaque requête (niveau selon le code)
    if (opts.auth.mode === "basic") this.app.use(this.basicGate);   // gate Basic Auth (dev) sur TOUT (sauf /healthz)
    this.app.use(express.json({ limit: "128mb" }));   // /snapshot et /transact peuvent être volumineux
    this.app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
    this.app.use(opts.apiBase, new Api(opts.docs, opts.auth, opts.live).router());
    this.app.use(opts.apiBase, (_req, res) => { res.status(404).json({ error: "endpoint inconnu" }); });   // 404 API
    this.app.get(["/", "/dc-manager.html", "/index.html"], this.serveClient);
    this.app.use(express.static(opts.clientDir, { index: false }));   // assets éventuels (build multi-fichiers en dev)
    this.app.get("*", this.serveClient);                              // fallback SPA → HTML client
    this.app.use(this.errorHandler);                                  // exceptions non gérées → 500 + log
  }

  /** Log une ligne par requête à la fin (méthode, URL, code, durée). Niveau selon le statut ; healthcheck en trace. */
  private requestLogger: RequestHandler = (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start, code = res.statusCode;
      const msg = `${req.method} ${req.originalUrl} → ${code} (${ms}ms)`;
      if (req.path === "/healthz") this.httpLog.trace(msg);
      else if (code >= 500) this.httpLog.error(msg);
      else if (code >= 400) this.httpLog.warn(msg);
      else this.httpLog.info(msg);
    });
    next();
  };

  /** Gate Basic Auth (dev) : challenge sur tout sauf /healthz. Le navigateur demande user/mdp une fois,
      puis renvoie l'en-tête Authorization sur TOUTES les requêtes (y compris les fetch de l'app). */
  private basicGate: RequestHandler = (req, res, next) => {
    if (req.path === "/healthz" || this.opts.auth.checkBasic(req)) { next(); return; }
    res.setHeader("WWW-Authenticate", 'Basic realm="DC Manager (dev)"');
    res.status(401).send("Authentification requise (dev).");
  };

  private errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    // `err.status` est posé par les middlewares Express (ex. express.json → 400 sur JSON malformé, 413 sur corps
    // trop gros) : l'honorer évite de requalifier une erreur CLIENT en 500. Sans statut → vraie erreur interne.
    const code = (err && (err.status || err.statusCode)) || 500;
    if (code >= 500) this.log.error("exception", req.method, req.originalUrl, (err && err.stack) || err);
    else this.log.warn("requête invalide", req.method, req.originalUrl, code, (err && err.message) || "");
    if (!res.headersSent) res.status(code).json({ error: code >= 500 ? "erreur interne" : "requête invalide" });
  };

  /* Sert dist/dc-manager.html (JS+CSS inlinés) en injectant window.__DCMANAGER_CONFIG__ dans <head> AVANT le bundle :
     le client passe en mode API sans configuration utilisateur.
     SOUS-DOSSIER / REVERSE-PROXY : toutes les URLs du client (API, manifest, icônes, SW) sont RELATIVES et ancrées
     sur le <base> du HTML. apiBaseUrl est donc injecté SANS slash initial ("/api" → "api"). Si le proxy annonce le
     préfixe réel via l'en-tête X-Forwarded-Prefix (ex. "/dc-manager"), on fixe <base href="/dc-manager/"> — ce qui
     couvre l'URL sans slash final et le proxy qui NE retire PAS le préfixe. Sans en-tête, on garde le <base href="./">
     du template (le cas nominal = proxy qui retire le préfixe + URL avec slash final fonctionne tel quel). */
  private serveClient: RequestHandler = (req, res) => {
    const htmlFile = path.join(this.opts.clientDir, "dc-manager.html");
    let html: string;
    try { html = fs.readFileSync(htmlFile, "utf8"); }
    catch { res.status(503).send("Client introuvable (" + htmlFile + "). Lancez `npm run build` dans NetMap/."); return; }
    // En-tête réfléchi dans le HTML → on n'accepte qu'un chemin absolu au charset sûr (pas de quote/chevron) :
    // un X-Forwarded-Prefix malveillant ne peut pas s'évader de l'attribut href (anti-XSS). Sinon, ignoré.
    const rawPrefix = String(req.headers["x-forwarded-prefix"] || "");
    const prefix = /^\/[A-Za-z0-9._~/-]*$/.test(rawPrefix) ? rawPrefix.replace(/\/+$/, "") : "";   // ex. "/dc-manager"
    if (prefix) html = html.replace(/<base\b[^>]*>/i, `<base href="${prefix}/">`);          // ancre absolue ; sinon on garde <base href="./">
    const apiBaseUrl = this.opts.apiBase.replace(/^\/+/, "");                               // "/api" → "api" : relatif, résolu contre <base>
    const cfg = `<script>window.__DCMANAGER_CONFIG__=${JSON.stringify({ mode: "api", apiBaseUrl, loginUrl: this.opts.loginUrl || "" })};</script>`;
    html = html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${cfg}`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  };

  listen(port: number): void {
    this.app.listen(port, () => this.log.info(`écoute sur http://localhost:${port} (api ${this.opts.apiBase}, logs niveau ${this.log.level})`));
  }
}

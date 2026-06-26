import express, { type Express, type RequestHandler, type ErrorRequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import { Api } from "./api.js";
import { DocumentStore } from "./documents.js";
import { Logger } from "./logger.js";

export interface ServerOptions { docs: DocumentStore; clientDir: string; apiBase: string; log?: Logger }

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
    this.app.use(this.requestLogger);                 // trace de chaque requête (niveau selon le code)
    this.app.use(express.json({ limit: "128mb" }));   // /snapshot et /transact peuvent être volumineux
    this.app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
    this.app.use(opts.apiBase, new Api(opts.docs).router());
    this.app.use(opts.apiBase, (_req, res) => { res.status(404).json({ error: "endpoint inconnu" }); });   // 404 API
    this.app.get(["/", "/netmap.html", "/index.html"], this.serveClient);
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

  private errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    this.log.error("exception", req.method, req.originalUrl, (err && err.stack) || err);
    if (!res.headersSent) res.status(500).json({ error: "erreur interne" });
  };

  /* Sert dist/netmap.html (JS+CSS inlinés) en injectant window.__NETMAP_CONFIG__ dans <head> AVANT le bundle :
     le client passe en mode API sans configuration utilisateur. */
  private serveClient: RequestHandler = (_req, res) => {
    const htmlFile = path.join(this.opts.clientDir, "netmap.html");
    let html: string;
    try { html = fs.readFileSync(htmlFile, "utf8"); }
    catch { res.status(503).send("Client introuvable (" + htmlFile + "). Lancez `npm run build` dans NetMap/."); return; }
    const cfg = `<script>window.__NETMAP_CONFIG__=${JSON.stringify({ mode: "api", apiBaseUrl: this.opts.apiBase })};</script>`;
    html = html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${cfg}`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  };

  listen(port: number): void {
    this.app.listen(port, () => this.log.info(`écoute sur http://localhost:${port} (api ${this.opts.apiBase}, logs niveau ${this.log.level})`));
  }
}

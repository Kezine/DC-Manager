import express, { type Express, type RequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import { Api } from "./api.js";
import { Repository } from "./db.js";

export interface ServerOptions { repo: Repository; clientDir: string; apiBase: string }

/** Application HTTP : API REST sous `apiBase` + service du client (HTML autonome) avec injection de config. */
export class Server {
  private readonly app: Express;

  constructor(private readonly opts: ServerOptions) {
    this.app = express();
    this.app.disable("x-powered-by");
    this.app.use(express.json({ limit: "128mb" }));   // /snapshot et /transact peuvent être volumineux
    this.app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
    this.app.use(opts.apiBase, new Api(opts.repo).router());
    this.app.use(opts.apiBase, (_req, res) => { res.status(404).json({ error: "endpoint inconnu" }); });   // 404 API
    this.app.get(["/", "/netmap.html", "/index.html"], this.serveClient);
    this.app.use(express.static(opts.clientDir, { index: false }));   // assets éventuels (build multi-fichiers en dev)
    this.app.get("*", this.serveClient);                              // fallback SPA → HTML client
  }

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
    this.app.listen(port, () => console.log(`NetMap server → http://localhost:${port}  (api ${this.opts.apiBase})`));
  }
}

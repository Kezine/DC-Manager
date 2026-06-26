import express, { type Router, type RequestHandler, type Request } from "express";
import multer from "multer";
import { Schema } from "./constants.js";
import { type Repository, type Rec, type ListOpts } from "./db.js";
import { DocumentStore } from "./documents.js";
import { Auth } from "./auth.js";
import { LiveBus } from "./live.js";

/** Requête dont le Repository du document a été résolu par le middleware `resolveRepo`. */
type RepoRequest = Request & { repo?: Repository };

/** Couche HTTP : registre de documents + données SCOPÉES par document, déléguées au `Repository`. */
export class Api {
  private readonly upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

  constructor(private readonly docs: DocumentStore, private readonly auth: Auth, private readonly live: LiveBus) {}

  router(): Router {
    const r = express.Router();
    r.get("/me", this.me);                 // état d'auth (accessible sans être autorisé)
    r.use(this.requireAdmin);              // tout le reste exige une session SSO valide + SUPER_ADMIN

    // -- registre des documents --
    r.get("/documents", this.listDocs);
    r.post("/documents", this.createDoc);
    r.put("/documents/:docId", this.renameDoc);
    r.delete("/documents/:docId", this.deleteDoc);

    // -- données SCOPÉES par document (/documents/:docId/...) --
    const data = express.Router({ mergeParams: true });
    data.use(this.resolveRepo);
    data.get("/events", this.events);      // canal live (SSE) — notifie les changements du document
    data.get("/meta", this.getMeta);
    data.put("/meta", this.putMeta);
    data.post("/transact", this.transact);
    data.put("/snapshot", this.snapshot);
    data.get("/images", this.listImages);
    data.get("/images/:id", this.getImage);
    data.get("/images/:id/blob", this.getImageBlob);
    data.put("/images/:id", this.upload.single("blob"), this.putImage);
    data.delete("/images/:id", this.deleteImage);
    data.get("/:collection", this.list);
    data.get("/:collection/:id", this.getOne);
    data.post("/:collection", this.create);
    data.put("/:collection/:id", this.update);
    data.delete("/:collection/:id", this.remove);
    r.use("/documents/:docId", data);
    return r;
  }

  private repoOf(req: Request): Repository { return (req as RepoRequest).repo!; }
  private parseList(q: Record<string, any>): ListOpts {
    const { page, pageSize, q: query, ids, ...rest } = q;
    const where: Rec = {};
    for (const [k, v] of Object.entries(rest)) where[k] = v;
    return {
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || Schema.PAGE_SIZE_DEFAULT,
      query: query || "",
      where: Object.keys(where).length ? where : null,
      ids: ids ? String(ids).split(",").filter(Boolean) : null,
    };
  }

  /* -- auth (proxy SSO) : état de session, toujours accessible (le client adapte son UI) -- */
  private me: RequestHandler = async (req, res) => { res.json(await this.auth.validate(req)); };

  /** Garde d'accès : session SSO valide + SUPER_ADMIN, sinon 403 (le client affiche « accès refusé »). */
  private requireAdmin: RequestHandler = async (req, res, next) => {
    const r = await this.auth.validate(req);
    if (this.auth.isAuthorized(r)) { next(); return; }
    res.status(403).json({ error: "accès refusé", logged: !!r.logged, adminRight: r.adminRight || "NONE" });
  };

  /* -- registre des documents -- */
  private listDocs: RequestHandler = (_req, res) => { res.json(this.docs.list()); };
  private createDoc: RequestHandler = (req, res) => { res.status(201).json(this.docs.create((req.body && req.body.name) || "")); };
  private renameDoc: RequestHandler = (req, res) => {
    const m = this.docs.rename(req.params.docId, (req.body && req.body.name) || "");
    if (m) res.json(m); else res.status(404).json({ error: "document inconnu" });
  };
  private deleteDoc: RequestHandler = (req, res) => {
    if (this.docs.delete(req.params.docId)) res.status(204).end(); else res.status(404).json({ error: "document inconnu" });
  };

  /** Résout le Repository du document (404 si inconnu). En écriture : incrémente la révision (entête X-Doc-Rev)
      et publie l'événement live aux autres clients à la fin de la requête (si succès). En lecture : expose la rev. */
  private resolveRepo: RequestHandler = (req, res, next) => {
    const id = (req.params as any).docId;
    const repo = this.docs.repo(id);
    if (!repo) { res.status(404).json({ error: "document inconnu" }); return; }
    (req as RepoRequest).repo = repo;
    if (req.method === "GET") {
      res.setHeader("X-Doc-Rev", String(this.docs.getRev(id)));
    } else {
      const rev = this.docs.markChanged(id);
      res.setHeader("X-Doc-Rev", String(rev));
      const origin = (req.headers["x-client-id"] as string) || "";   // qui a écrit → le client source ignore son propre event
      res.on("finish", () => { if (res.statusCode < 300) this.live.publish(id, { rev, origin }); });
    }
    next();
  };

  /** SSE : flux d'événements du document (un message `{ rev }` à chaque écriture par un autre client). */
  private events: RequestHandler = (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    (res as any).flushHeaders?.();
    res.write("retry: 5000\n\n");
    this.live.subscribe(req.params.docId, res);
  };

  /* -- meta -- */
  private getMeta: RequestHandler = (req, res) => { res.json(this.repoOf(req).getMeta()); };
  private putMeta: RequestHandler = (req, res) => { this.repoOf(req).setMeta(req.body || {}); res.status(204).end(); };

  /* -- lot atomique / import -- */
  private transact: RequestHandler = (req, res) => {
    try { this.repoOf(req).transact(req.body || {}); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private snapshot: RequestHandler = (req, res) => {
    try { this.repoOf(req).replaceSnapshot(req.body || {}); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };

  /* -- images -- */
  private listImages: RequestHandler = (req, res) => { res.json(this.repoOf(req).listImages()); };
  private getImage: RequestHandler = (req, res) => {
    const m = this.repoOf(req).getImageMeta(req.params.id);
    if (m) res.json(m); else res.status(404).json({ error: "introuvable" });
  };
  private getImageBlob: RequestHandler = (req, res) => {
    const b = this.repoOf(req).getImageBlob(req.params.id);
    if (!b) { res.status(404).end(); return; }
    res.setHeader("Content-Type", b.type);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.end(b.blob);
  };
  private putImage: RequestHandler = (req, res) => {
    let meta: Rec = {};
    try { meta = req.body && req.body.meta ? JSON.parse(req.body.meta) : {}; } catch { /* ignore */ }
    const file = (req as { file?: { buffer: Buffer; mimetype: string } }).file;   // posé par multer.single("blob")
    const buf = file ? file.buffer : null;
    if (buf) meta.type = meta.type || file!.mimetype || "application/octet-stream";
    this.repoOf(req).putImage(req.params.id, meta, buf);
    res.status(204).end();
  };
  private deleteImage: RequestHandler = (req, res) => { this.repoOf(req).deleteImage(req.params.id); res.status(204).end(); };

  /* -- CRUD générique par collection -- */
  private list: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    res.json(this.repoOf(req).list(req.params.collection, this.parseList(req.query)));
  };
  private getOne: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const rec = this.repoOf(req).getOne(req.params.collection, req.params.id);
    if (rec) res.json(rec); else res.status(404).json({ error: "introuvable" });
  };
  private create: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    try { this.repoOf(req).upsert(req.params.collection, req.body); res.status(201).json(req.body); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private update: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const rec = { ...(req.body || {}), id: req.params.id };
    try { this.repoOf(req).upsert(req.params.collection, rec); res.json(rec); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private remove: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    try { this.repoOf(req).delete(req.params.collection, req.params.id); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
}

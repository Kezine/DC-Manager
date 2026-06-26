import express, { type Router, type RequestHandler, type Request } from "express";
import multer from "multer";
import { Schema } from "./constants.js";
import { type Repository, type Rec, type ListOpts } from "./db.js";
import { DocumentStore } from "./documents.js";

/** Requête dont le Repository du document a été résolu par le middleware `resolveRepo`. */
type RepoRequest = Request & { repo?: Repository };

/** Couche HTTP : registre de documents + données SCOPÉES par document, déléguées au `Repository`. */
export class Api {
  private readonly upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

  constructor(private readonly docs: DocumentStore) {}

  router(): Router {
    const r = express.Router();
    r.get("/me", this.me);

    // -- registre des documents --
    r.get("/documents", this.listDocs);
    r.post("/documents", this.createDoc);
    r.put("/documents/:docId", this.renameDoc);
    r.delete("/documents/:docId", this.deleteDoc);

    // -- données SCOPÉES par document (/documents/:docId/...) --
    const data = express.Router({ mergeParams: true });
    data.use(this.resolveRepo);
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

  /* -- auth (proxy SSO) -- */
  private me: RequestHandler = async (req, res) => {
    const ssoUrl = process.env.SSO_URL;
    if (!ssoUrl) {   // pas de SSO → mode dev (DEV_USER="" pour simuler un 401)
      if (process.env.DEV_USER === "") { res.status(401).json({ error: "non connecté" }); return; }
      res.json({ name: process.env.DEV_USER || "dev", dev: true }); return;
    }
    try {
      const r = await fetch(ssoUrl, { headers: { cookie: req.headers.cookie || "", authorization: req.headers.authorization || "" } });
      if (!r.ok) { res.status(r.status === 401 ? 401 : 502).json({ error: "SSO " + r.status }); return; }
      res.json(await r.json());
    } catch (e: any) { res.status(502).json({ error: "SSO injoignable: " + e.message }); }
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

  /** Résout le Repository du document (404 si inconnu) ; toute écriture met à jour son updated_date. */
  private resolveRepo: RequestHandler = (req, res, next) => {
    const id = (req.params as any).docId;
    const repo = this.docs.repo(id);
    if (!repo) { res.status(404).json({ error: "document inconnu" }); return; }
    (req as RepoRequest).repo = repo;
    if (req.method !== "GET") this.docs.touch(id);
    next();
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

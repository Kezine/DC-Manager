import express, { type Router, type RequestHandler } from "express";
import multer from "multer";
import { Schema } from "./constants.js";
import { Repository, type Rec, type ListOpts } from "./db.js";

/** Couche HTTP : traduit les requêtes REST vers le `Repository`. Handlers = propriétés fléchées (this lié). */
export class Api {
  private readonly upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

  constructor(private readonly repo: Repository) {}

  /** Router Express monté sous `/api`. Routes spécifiques AVANT le générique `/:collection`. */
  router(): Router {
    const r = express.Router();
    r.get("/me", this.me);
    r.get("/meta", this.getMeta);
    r.put("/meta", this.putMeta);
    r.post("/transact", this.transact);
    r.put("/snapshot", this.snapshot);
    r.get("/images", this.listImages);
    r.get("/images/:id", this.getImage);
    r.get("/images/:id/blob", this.getImageBlob);
    r.put("/images/:id", this.upload.single("blob"), this.putImage);
    r.delete("/images/:id", this.deleteImage);
    r.get("/:collection", this.list);
    r.get("/:collection/:id", this.getOne);
    r.post("/:collection", this.create);
    r.put("/:collection/:id", this.update);
    r.delete("/:collection/:id", this.remove);
    return r;
  }

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

  /* -- auth (proxy SSO ; l'app NE gère PAS l'auth, le SSO valide) -- */
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

  /* -- meta -- */
  private getMeta: RequestHandler = (_req, res) => { res.json(this.repo.getMeta()); };
  private putMeta: RequestHandler = (req, res) => { this.repo.setMeta(req.body || {}); res.status(204).end(); };

  /* -- lot atomique / import -- */
  private transact: RequestHandler = (req, res) => {
    try { this.repo.transact(req.body || {}); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private snapshot: RequestHandler = (req, res) => {
    try { this.repo.replaceSnapshot(req.body || {}); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };

  /* -- images -- */
  private listImages: RequestHandler = (_req, res) => { res.json(this.repo.listImages()); };
  private getImage: RequestHandler = (req, res) => {
    const m = this.repo.getImageMeta(req.params.id);
    if (m) res.json(m); else res.status(404).json({ error: "introuvable" });
  };
  private getImageBlob: RequestHandler = (req, res) => {
    const b = this.repo.getImageBlob(req.params.id);
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
    this.repo.putImage(req.params.id, meta, buf);
    res.status(204).end();
  };
  private deleteImage: RequestHandler = (req, res) => { this.repo.deleteImage(req.params.id); res.status(204).end(); };

  /* -- CRUD générique par collection -- */
  private list: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    res.json(this.repo.list(req.params.collection, this.parseList(req.query)));
  };
  private getOne: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const rec = this.repo.getOne(req.params.collection, req.params.id);
    if (rec) res.json(rec); else res.status(404).json({ error: "introuvable" });
  };
  private create: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    try { this.repo.upsert(req.params.collection, req.body); res.status(201).json(req.body); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private update: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const rec = { ...(req.body || {}), id: req.params.id };
    try { this.repo.upsert(req.params.collection, rec); res.json(rec); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private remove: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    try { this.repo.delete(req.params.collection, req.params.id); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
}

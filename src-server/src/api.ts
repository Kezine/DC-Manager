import express, { type Request, type Response, type Router } from "express";
import multer from "multer";
import { PAGE_SIZE_DEFAULT, isCollection } from "./constants.js";
import {
  listRecords, getOne, upsertRecord, deleteRecord, getMeta, setMeta,
  applyTransaction, replaceSnapshot, type SqliteDb, type ListOpts, type Rec,
} from "./db.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

/** Utilisateur courant — proxy SSO (l'app NE gère PAS l'auth ; le SSO valide). */
async function me(req: Request, res: Response): Promise<void> {
  const ssoUrl = process.env.SSO_URL;
  if (!ssoUrl) {   // pas de SSO configuré → mode dev (DEV_USER="" pour simuler un 401)
    if (process.env.DEV_USER === "") { res.status(401).json({ error: "non connecté" }); return; }
    res.json({ name: process.env.DEV_USER || "dev", dev: true }); return;
  }
  try {
    const r = await fetch(ssoUrl, { headers: { cookie: req.headers.cookie || "", authorization: req.headers.authorization || "" } });
    if (!r.ok) { res.status(r.status === 401 ? 401 : 502).json({ error: "SSO " + r.status }); return; }
    res.json(await r.json());
  } catch (e: any) { res.status(502).json({ error: "SSO injoignable: " + e.message }); }
}

function parseList(q: Record<string, any>): ListOpts {
  const { page, pageSize, q: query, ids, ...rest } = q;
  const where: Rec = {};
  for (const [k, v] of Object.entries(rest)) where[k] = v;
  return {
    page: parseInt(page, 10) || 1,
    pageSize: parseInt(pageSize, 10) || PAGE_SIZE_DEFAULT,
    query: query || "",
    where: Object.keys(where).length ? where : null,
    ids: ids ? String(ids).split(",").filter(Boolean) : null,
  };
}

export function createApi(db: SqliteDb): Router {
  const r = express.Router();

  // -- auth (proxy SSO) --
  r.get("/me", me);

  // -- meta --
  r.get("/meta", (_req, res) => res.json(getMeta(db)));
  r.put("/meta", (req, res) => { setMeta(db, req.body || {}); res.status(204).end(); });

  // -- lot atomique (1 transaction SQLite) --
  r.post("/transact", (req, res) => {
    try { applyTransaction(db, req.body || {}); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // -- import complet (réservé : écrase le workspace) --
  r.put("/snapshot", (req, res) => {
    try { replaceSnapshot(db, req.body || {}); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // -- images (blobs) : routes AVANT le générique /:collection --
  r.get("/images", (_req, res) => {
    const rows = db.prepare("SELECT id, meta, bytes FROM images").all();
    res.json(rows.map((x: any) => ({ ...JSON.parse(x.meta), id: x.id, bytes: x.bytes })));
  });
  r.get("/images/:id", (req, res) => {
    const x = db.prepare("SELECT id, meta, bytes FROM images WHERE id = ?").get(req.params.id);
    if (!x) { res.status(404).json({ error: "introuvable" }); return; }
    res.json({ ...JSON.parse(x.meta), id: x.id, bytes: x.bytes });
  });
  r.get("/images/:id/blob", (req, res) => {
    const x = db.prepare("SELECT meta, blob FROM images WHERE id = ?").get(req.params.id);
    if (!x || !x.blob) { res.status(404).end(); return; }
    const m = JSON.parse(x.meta);
    res.setHeader("Content-Type", m.type || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.end(Buffer.from(x.blob));
  });
  r.put("/images/:id", upload.single("blob"), (req, res) => {
    let meta: Rec = {};
    try { meta = req.body && req.body.meta ? JSON.parse(req.body.meta) : {}; } catch { /* ignore */ }
    meta.id = req.params.id;
    const buf = req.file ? req.file.buffer : null;
    if (buf) meta.type = meta.type || req.file!.mimetype || "application/octet-stream";
    const cur = db.prepare("SELECT blob, bytes FROM images WHERE id = ?").get(req.params.id);
    const blob = buf || (cur ? cur.blob : null);
    const bytes = buf ? buf.length : (cur ? cur.bytes : 0);
    db.prepare(`INSERT INTO images (id, meta, blob, bytes) VALUES (@id, @meta, @blob, @bytes)
                ON CONFLICT(id) DO UPDATE SET meta = @meta, blob = @blob, bytes = @bytes`)
      .run({ id: req.params.id, meta: JSON.stringify(meta), blob, bytes });
    res.status(204).end();
  });
  r.delete("/images/:id", (req, res) => { db.prepare("DELETE FROM images WHERE id = ?").run(req.params.id); res.status(204).end(); });

  // -- CRUD générique par collection --
  r.get("/:collection", (req, res) => {
    if (!isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    res.json(listRecords(db, req.params.collection, parseList(req.query)));
  });
  r.get("/:collection/:id", (req, res) => {
    if (!isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const rec = getOne(db, req.params.collection, req.params.id);
    if (rec) res.json(rec); else res.status(404).json({ error: "introuvable" });
  });
  r.post("/:collection", (req, res) => {
    if (!isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    try { upsertRecord(db, req.params.collection, req.body); res.status(201).json(req.body); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  r.put("/:collection/:id", (req, res) => {
    if (!isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const rec = { ...(req.body || {}), id: req.params.id };
    try { upsertRecord(db, req.params.collection, rec); res.json(rec); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  r.delete("/:collection/:id", (req, res) => {
    if (!isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    try { deleteRecord(db, req.params.collection, req.params.id); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  return r;
}

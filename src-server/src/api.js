import express from "express";
import multer from "multer";
import { PAGE_SIZE_DEFAULT, isCollection } from "./constants.js";
import {
  listRecords, getOne, upsertRecord, deleteRecord, getMeta, setMeta,
  applyTransaction, replaceSnapshot,
} from "./db.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

/** Utilisateur courant — proxy SSO (l'app NE gère PAS l'auth ; le SSO valide). */
async function me(req, res) {
  const ssoUrl = process.env.SSO_URL;
  if (!ssoUrl) {   // pas de SSO configuré → mode dev (DEV_USER="" pour simuler un 401)
    if (process.env.DEV_USER === "") return res.status(401).json({ error: "non connecté" });
    return res.json({ name: process.env.DEV_USER || "dev", dev: true });
  }
  try {
    const r = await fetch(ssoUrl, { headers: { cookie: req.headers.cookie || "", authorization: req.headers.authorization || "" } });
    if (!r.ok) return res.status(r.status === 401 ? 401 : 502).json({ error: "SSO " + r.status });
    res.json(await r.json());
  } catch (e) { res.status(502).json({ error: "SSO injoignable: " + e.message }); }
}

function parseList(q) {
  const { page, pageSize, q: query, ids, ...rest } = q;
  const where = {};
  for (const [k, v] of Object.entries(rest)) where[k] = v;
  return {
    page: parseInt(page, 10) || 1,
    pageSize: parseInt(pageSize, 10) || PAGE_SIZE_DEFAULT,
    query: query || "",
    where: Object.keys(where).length ? where : null,
    ids: ids ? String(ids).split(",").filter(Boolean) : null,
  };
}

export function createApi(db) {
  const r = express.Router();

  // -- auth (proxy SSO) --
  r.get("/me", me);

  // -- meta --
  r.get("/meta", (req, res) => res.json(getMeta(db)));
  r.put("/meta", (req, res) => { setMeta(db, req.body || {}); res.status(204).end(); });

  // -- lot atomique (1 transaction SQLite) --
  r.post("/transact", (req, res) => {
    try { applyTransaction(db, req.body || {}); res.status(204).end(); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // -- import complet (réservé : écrase le workspace) --
  r.put("/snapshot", (req, res) => {
    try { replaceSnapshot(db, req.body || {}); res.status(204).end(); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // -- images (blobs) : routes AVANT le générique /:collection --
  r.get("/images", (req, res) => {
    const rows = db.prepare("SELECT id, meta, bytes FROM images").all();
    res.json(rows.map((x) => ({ ...JSON.parse(x.meta), id: x.id, bytes: x.bytes })));
  });
  r.get("/images/:id", (req, res) => {
    const x = db.prepare("SELECT id, meta, bytes FROM images WHERE id = ?").get(req.params.id);
    if (!x) return res.status(404).json({ error: "introuvable" });
    res.json({ ...JSON.parse(x.meta), id: x.id, bytes: x.bytes });
  });
  r.get("/images/:id/blob", (req, res) => {
    const x = db.prepare("SELECT meta, blob FROM images WHERE id = ?").get(req.params.id);
    if (!x || !x.blob) return res.status(404).end();
    const m = JSON.parse(x.meta);
    res.setHeader("Content-Type", m.type || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.end(x.blob);
  });
  r.put("/images/:id", upload.single("blob"), (req, res) => {
    let meta = {};
    try { meta = req.body && req.body.meta ? JSON.parse(req.body.meta) : {}; } catch (_) { /* ignore */ }
    meta.id = req.params.id;
    const buf = req.file ? req.file.buffer : null;
    if (buf) meta.type = meta.type || req.file.mimetype || "application/octet-stream";
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
    if (!isCollection(req.params.collection)) return res.status(404).json({ error: "collection inconnue" });
    res.json(listRecords(db, req.params.collection, parseList(req.query)));
  });
  r.get("/:collection/:id", (req, res) => {
    if (!isCollection(req.params.collection)) return res.status(404).json({ error: "collection inconnue" });
    const rec = getOne(db, req.params.collection, req.params.id);
    return rec ? res.json(rec) : res.status(404).json({ error: "introuvable" });
  });
  r.post("/:collection", (req, res) => {
    if (!isCollection(req.params.collection)) return res.status(404).json({ error: "collection inconnue" });
    try { upsertRecord(db, req.params.collection, req.body); res.status(201).json(req.body); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.put("/:collection/:id", (req, res) => {
    if (!isCollection(req.params.collection)) return res.status(404).json({ error: "collection inconnue" });
    const rec = { ...(req.body || {}), id: req.params.id };
    try { upsertRecord(db, req.params.collection, rec); res.json(rec); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.delete("/:collection/:id", (req, res) => {
    if (!isCollection(req.params.collection)) return res.status(404).json({ error: "collection inconnue" });
    try { deleteRecord(db, req.params.collection, req.params.id); res.status(204).end(); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  return r;
}

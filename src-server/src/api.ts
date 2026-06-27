import express, { type Router, type RequestHandler, type Request } from "express";
import multer from "multer";
import { Schema } from "./constants.js";
import { type Repository, type Rec, type ListOpts } from "./db.js";
import { DocumentStore } from "./documents.js";
import { Auth, type SsoResult } from "./auth.js";
import { LiveBus } from "./live.js";

/** Requête dont le Repository du document a été résolu + l'utilisateur SSO validé (par `requireAdmin`). */
type RepoRequest = Request & { repo?: Repository; authUser?: SsoResult; docRev?: number };

/** Périmètre d'une écriture, diffusé aux autres clients pour un rechargement granulaire.
    DUPLIQUÉ côté front (`src/sync/Changeset.ts`) — garder les deux formes synchronisées. */
interface DocumentChangeset {
  full: boolean;          // périmètre indéterminé (import/snapshot/inconnu) → le client recharge tout
  collections: string[];  // collections touchées (créations + màj + suppressions)
  meta: boolean;          // méta-document modifiée
  images: boolean;        // image(s) de façade modifiée(s)
}

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
  /** Révision portée par l'écriture courante (posée par `resolveRepo`) → estampillée sur les lignes (`updated_rev`). */
  private revOf(req: Request): number { return (req as RepoRequest).docRev || 0; }
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
    (req as RepoRequest).authUser = r;   // réutilisé par resolveRepo (qui a écrit, pour le live)
    if (this.auth.isAuthorized(r)) { next(); return; }
    res.status(403).json({ error: "accès refusé", logged: !!r.logged, adminRight: r.adminRight || "NONE" });
  };

  /** Identité de l'auteur d'une écriture (pour la notif live) : nom (SSO) + IP. */
  private writerInfo(req: Request): { name: string; ip: string } {
    const r = (req as RepoRequest).authUser;
    const u = (r && r.user) || {};
    const name = [u.prenom, u.nom].filter(Boolean).join(" ") || u.login || "?";
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = (r && (r as any).ip) || fwd || req.ip || "";
    return { name, ip };
  }

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

  /** Entités VISÉES par une écriture (pour le verrou optimiste) : lot `/transact` (updates + deletes) ou CRUD
      unitaire `/:collection/:id`. Les créations (id neuf) et les écritures globales (meta / snapshot / images)
      ne ciblent aucune ligne existante → liste vide → pas de garde. */
  private writeTargets(req: Request): Array<{ collection: string; id: string }> {
    const out: Array<{ collection: string; id: string }> = [];
    const body: any = req.body || {};
    if (Array.isArray(body.updates) || Array.isArray(body.deletes)) {
      for (const u of body.updates || []) if (u && u.collection && u.record && u.record.id) out.push({ collection: u.collection, id: u.record.id });
      for (const d of body.deletes || []) if (d && d.collection && d.id) out.push({ collection: d.collection, id: d.id });
      return out;
    }
    const { collection, id } = req.params as any;
    if (collection && id) out.push({ collection, id });
    return out;
  }

  /** Périmètre d'une écriture, pour le rechargement granulaire des autres clients. Déduit du corps (`/transact`),
      des paramètres de route (CRUD `/:collection/:id`) ou du chemin (`/meta`, `/snapshot`, `/images`). Périmètre
      non reconnu → `full` (repli sûr : le client recharge tout). */
  private buildChangeset(req: Request): DocumentChangeset {
    const body: any = req.body || {};
    // Lot atomique : union des collections de creates + updates + deletes.
    if (Array.isArray(body.creates) || Array.isArray(body.updates) || Array.isArray(body.deletes)) {
      const collections = new Set<string>();
      for (const entry of [...(body.creates || []), ...(body.updates || []), ...(body.deletes || [])]) {
        if (entry && entry.collection) collections.add(entry.collection);
      }
      return { full: false, collections: [...collections], meta: !!body.meta, images: false };
    }
    // CRUD unitaire : la collection est dans les paramètres de route.
    const collection = (req.params as any).collection as string | undefined;
    if (collection) return { full: false, collections: [collection], meta: false, images: false };
    // Routes globales (sans paramètre de collection) — reconnues par le chemin (relatif au sous-routeur du document).
    const path = req.path || "";
    if (path.startsWith("/snapshot")) return { full: true, collections: [], meta: true, images: true };
    if (path.startsWith("/meta")) return { full: false, collections: [], meta: true, images: false };
    if (path.startsWith("/images")) return { full: false, collections: [], meta: false, images: true };
    return { full: true, collections: [], meta: true, images: true };   // inconnu → repli sûr
  }

  /** Résout le Repository du document (404 si inconnu). En écriture : VERROU OPTIMISTE par entité (409 si une entité
      visée a été modifiée après la révision de base du client, en-tête `X-Base-Rev`), sinon incrémente la révision
      (entête `X-Doc-Rev`), estampille `docRev` pour les handlers, et publie l'événement live (si succès).
      En lecture : expose la rev. */
  private resolveRepo: RequestHandler = (req, res, next) => {
    const id = (req.params as any).docId;
    const repo = this.docs.repo(id);
    if (!repo) { res.status(404).json({ error: "document inconnu" }); return; }
    (req as RepoRequest).repo = repo;
    if (req.method === "GET") { res.setHeader("X-Doc-Rev", String(this.docs.getRev(id))); next(); return; }
    // verrou optimiste : `baseRev` = snapshot sur lequel le client s'appuie. Rejet AVANT toute mutation /
    // incrément de rev / publication SSE → l'écriture refusée ne consomme pas de révision et ne réveille personne.
    const baseRev = parseInt(String(req.headers["x-base-rev"] ?? ""), 10);
    const targets = this.writeTargets(req);
    if (Number.isFinite(baseRev) && targets.length) {
      const conflicts = repo.conflicts(targets, baseRev);
      if (conflicts.length) {
        res.setHeader("X-Doc-Rev", String(this.docs.getRev(id)));
        res.status(409).json({ error: "conflit de version", conflicts });
        return;
      }
    }
    const rev = this.docs.markChanged(id);
    (req as RepoRequest).docRev = rev;   // les handlers estampillent `updated_rev = rev` sur les lignes écrites
    res.setHeader("X-Doc-Rev", String(rev));
    const origin = (req.headers["x-client-id"] as string) || "";   // qui a écrit → le client source ignore son propre event
    const by = this.writerInfo(req);                               // nom (SSO) + IP de l'auteur, pour la notif live
    const changeset = this.buildChangeset(req);                    // périmètre → rechargement granulaire chez les autres clients
    res.on("finish", () => { if (res.statusCode < 300) this.live.publish(id, { rev, origin, by, changeset }); });
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
    try { this.repoOf(req).transact(req.body || {}, this.revOf(req)); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private snapshot: RequestHandler = (req, res) => {
    try { this.repoOf(req).replaceSnapshot(req.body || {}, this.revOf(req)); res.status(204).end(); }
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
    try { this.repoOf(req).upsert(req.params.collection, req.body, this.revOf(req)); res.status(201).json(req.body); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private update: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const rec = { ...(req.body || {}), id: req.params.id };
    try { this.repoOf(req).upsert(req.params.collection, rec, this.revOf(req)); res.json(rec); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private remove: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    try { this.repoOf(req).delete(req.params.collection, req.params.id); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
}

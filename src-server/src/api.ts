import express, { type Router, type RequestHandler, type Request, type Response } from "express";
import multer from "multer";
import { Schema } from "./constants.js";
import { type Repository, type Rec, type ListOpts } from "./db.js";
import { DocumentStore } from "./documents.js";
import { Auth, type SsoResult } from "./auth.js";
import { LiveBus } from "./live.js";
import type { DocumentChangeset } from "../../src-shared/DocumentChangeset.js";   // type PARTAGÉ front ⇄ back (source unique)
import { DataValidator, type ValidationError, type EntityFetcher, type ChildFinder } from "../../src-shared/DataValidation.js";   // normalisation + validation PARTAGÉES
import { Cascade } from "../../src-shared/Cascade.js";   // cascade de suppression PARTAGÉE (intégrité référentielle en DELETE)
import { ApiRules } from "./ApiRules.js";             // règles PURES de la couche HTTP (verrou, changeset, lot) — testables sans Express

/** Requête dont le Repository du document a été résolu + l'utilisateur SSO validé (par `requireAdmin`).
    `changeset` : périmètre SSE, posé par défaut par `resolveRepo` et ÉLARGISSABLE par un handler (ex. la cascade
    de suppression touche plusieurs collections) — la publication live le lit au moment du `finish`. */
type RepoRequest = Request & { repo?: Repository; authUser?: SsoResult; docRev?: number; changeset?: DocumentChangeset };

/** Point d'EXTENSION générique de l'API : routeur additionnel monté sous la même garde d'accès
    (requireAdmin), déclaré par un module OPTIONNEL (ex. `vm/`) et câblé au bootstrap (index.ts).
    Dépendance INVERSÉE : le cœur ne connaît que ce contrat, jamais les modules — condition de
    leur amovibilité (supprimer un module = retirer son câblage au bootstrap, rien ici). */
export interface ApiExtension {
  /** Chemin de montage SOUS la racine API (ex. "/documents/:docId/vm") — le routeur voit les
      params du chemin s'il est créé avec `mergeParams: true`. */
  path: string;
  router: Router;
}

/** Identité de l'AUTEUR d'une requête, dérivée de la session SSO validée par la garde d'accès
    (`requireAdmin` pose `authUser`). Extrait en helper RÉUTILISABLE (principe n°3) : le cœur (notif
    live) ET les modules d'extension qui estampillent un audit « qui a écrit ? » (ex. interventions/)
    appliquent la MÊME règle sans la dupliquer. Les modules importent déjà `ApiExtension` d'ici — pas
    de couplage nouveau. */
export class RequestAuthor {
  /** Nom d'affichage de l'utilisateur authentifié : « Prénom Nom » si connu, sinon le login, sinon « ? ». */
  static name(req: Request): string {
    const r = (req as RepoRequest).authUser;
    const u = (r && r.user) || {};
    return [u.prenom, u.nom].filter(Boolean).join(" ") || u.login || "?";
  }
}

/** Couche HTTP : registre de documents + données SCOPÉES par document, déléguées au `Repository`. */
export class Api {
  private readonly upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

  constructor(private readonly docs: DocumentStore, private readonly auth: Auth, private readonly live: LiveBus,
              private readonly extensions: ApiExtension[] = []) {}

  router(): Router {
    const r = express.Router();
    r.get("/me", this.me);                 // état d'auth (accessible sans être autorisé)
    r.use(this.requireAdmin);              // tout le reste exige une session SSO valide + SUPER_ADMIN

    // -- extensions (modules optionnels) : montées TÔT — avant le routeur de données, dont la
    // route générique `/:collection` capterait sinon leurs segments (ex. « vm » lu comme collection).
    for (const ext of this.extensions) r.use(ext.path, ext.router);

    // -- réglages globaux (doc par défaut…) --
    r.get("/settings", this.getSettings);
    r.put("/settings", this.putSettings);

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
    data.post("/maintenance", this.maintenance);   // AVANT /:collection (sinon « maintenance » serait une collection)
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

  /** Identité de l'auteur d'une écriture (pour la notif live) : nom (SSO) + IP. Le nom passe par le
      helper PARTAGÉ `RequestAuthor` (même règle que les modules d'extension — cf. interventions/). */
  private writerInfo(req: Request): { name: string; ip: string } {
    const r = (req as RepoRequest).authUser;
    const name = RequestAuthor.name(req);
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = (r && (r as any).ip) || fwd || req.ip || "";
    return { name, ip };
  }

  /* -- réglages globaux -- */
  /** Réglages globaux partagés (aujourd'hui : `defaultDocId`, document ouvert au boot d'un client sans « dernier
      doc ouvert » mémorisé). `defaultDocId` est null si non défini OU si le document a été supprimé entre-temps. */
  private getSettings: RequestHandler = (_req, res) => { res.json({ defaultDocId: this.docs.getDefaultDocId() }); };
  /** Met à jour les réglages globaux. Corps : `{ defaultDocId: string | null }` (id inconnu → 400). */
  private putSettings: RequestHandler = (req, res) => {
    const body: any = req.body || {};
    if ("defaultDocId" in body) {
      const id = body.defaultDocId;
      if (id !== null && typeof id !== "string") { res.status(400).json({ error: "defaultDocId invalide" }); return; }
      if (!this.docs.setDefaultDocId(id)) { res.status(400).json({ error: "document inconnu" }); return; }
    }
    res.json({ defaultDocId: this.docs.getDefaultDocId() });
  };

  /* -- registre des documents -- */
  private listDocs: RequestHandler = (_req, res) => { res.json(this.docs.list()); };
  private createDoc: RequestHandler = (req, res) => { res.status(201).json(this.docs.create((req.body && req.body.name) || "")); };
  /** Met à jour la méta-registre d'un document : renommage et/ou (dé)verrouillage. Corps : `{ name?, locked? }`. */
  private renameDoc: RequestHandler = (req, res) => {
    const body: any = req.body || {};
    if (!this.docs.get(req.params.docId)) { res.status(404).json({ error: "document inconnu" }); return; }
    if (typeof body.name === "string") this.docs.rename(req.params.docId, body.name);
    if (typeof body.locked === "boolean") this.docs.setLocked(req.params.docId, body.locked);
    res.json(this.docs.get(req.params.docId));
  };
  private deleteDoc: RequestHandler = (req, res) => {
    const doc = this.docs.get(req.params.docId);
    if (!doc) { res.status(404).json({ error: "document inconnu" }); return; }
    // Document VERROUILLÉ → suppression conventionnelle refusée (423 Locked). L'échappatoire est explicite :
    // déverrouiller d'abord (PUT { locked: false }), puis re-supprimer.
    if (doc.locked) { res.status(423).json({ error: "document verrouillé", locked: true }); return; }
    if (this.docs.delete(req.params.docId)) res.status(204).end(); else res.status(404).json({ error: "document inconnu" });
  };

  /** Entités VISÉES par une écriture (verrou optimiste) — logique pure dans `ApiRules.writeTargets`. */
  private writeTargets(req: Request): Array<{ collection: string; id: string }> {
    return ApiRules.writeTargets(req.body, req.params as any);
  }

  /** Périmètre d'une écriture (rechargement granulaire) — logique pure dans `ApiRules.buildChangeset`. */
  private buildChangeset(req: Request): DocumentChangeset {
    return ApiRules.buildChangeset(req.body, (req.params as any).collection, req.path || "");
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
    // DÉCISION (audit P5) : l'en-tête `X-Base-Rev` reste FACULTATIF — le client de l'app l'envoie toujours
    // (RestProtocol.writeHeaders), mais l'exiger (400 si absent) casserait les écritures scriptées (curl,
    // imports) et la première écriture d'un client sans lecture préalable. Sans en-tête : dernier-écrit-gagne,
    // assumé pour ces usages hors app.
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
    (req as RepoRequest).changeset = this.buildChangeset(req);     // périmètre par défaut → rechargement granulaire ; un handler peut l'élargir (cascade DELETE)
    res.on("finish", () => { if (res.statusCode < 300) this.live.publish(id, { rev, origin, by, changeset: (req as RepoRequest).changeset! }); });
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
  private putMeta: RequestHandler = (req, res) => {
    // validation minimale : la méta est un OBJET JSON simple (options du document). Un scalaire / tableau
    // stocké tel quel serait resservi par GET /meta et casserait les consommateurs (`meta.xxx`).
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) { res.status(400).json({ error: "meta invalide (objet JSON attendu)" }); return; }
    this.repoOf(req).setMeta(body); res.status(204).end();
  };

  /* -- lot atomique / import -- */
  private transact: RequestHandler = (req, res) => {
    const body: any = req.body || {};
    // Lecteur d'intégrité CONSCIENT DU LOT : une FK / règle cross-entité peut viser une entité créée ou modifiée
    // dans le même lot (ex. une adresse rattachée à un réseau dont le CIDR change dans ce lot), ou supprimée.
    const fetch = DataValidator.buildBatchFetcher(this.repoFetcher(req), body);
    // Lecteur par champ CONSCIENT DU LOT : pour la portée (V6, ex. unicité d'adresse incluant les creates du lot)
    // et la dépendance inverse (V5b).
    const childFinder = DataValidator.buildBatchChildFinder(this.repoChildFinder(req), body);
    // Normalise + valide CHAQUE création/mise à jour ; le moindre échec rejette TOUT le lot (atomicité).
    const errors: ValidationError[] = [];
    const acceptEntry = (entry: any) => {
      if (!entry || !entry.collection || !entry.record) return entry;
      const { record, errors: entryErrors } = DataValidator.normalizeAndValidate(entry.collection, entry.record, fetch, childFinder);
      errors.push(...entryErrors);
      return { ...entry, record };
    };
    const creates = (body.creates || []).map(acceptEntry);
    const updates = (body.updates || []).map(acceptEntry);
    // V5b dans le lot : re-valider les ENFANTS des parents créés/modifiés (ex. un réseau dont le CIDR change),
    // avec un lecteur d'enfants CONSCIENT DU LOT (enfants créés/déplacés/supprimés dans ce même lot).
    for (const entry of [...creates, ...updates]) {
      if (entry && entry.collection && entry.record) errors.push(...DataValidator.validateDependents(entry.collection, entry.record, childFinder, fetch));
    }
    if (errors.length) { res.status(400).json({ error: "données invalides", errors }); return; }
    // CRÉATION STRICTE dans le lot (logique pure : ApiRules.createConflicts) : un `create` dont l'id existe DÉJÀ
    // en base écraserait l'enregistrement HORS verrou optimiste (`writeTargets` ne cible pas les créations). → 409.
    // Le lecteur passé est l'état PERSISTÉ (repoFetcher), pas le lecteur conscient du lot qui masquerait la ligne.
    const clashes = ApiRules.createConflicts(creates, body.deletes, this.repoFetcher(req));
    if (clashes.length) { res.status(409).json({ error: "création refusée : l'id existe déjà", conflicts: clashes }); return; }
    // CASCADE RÉSIDUELLE (autorité serveur — logique pure : ApiRules.residualCascade) : fusionne au lot le travail
    // de cascade MANQUANT (document modifié entre l'instantané du client et cette écriture), avec garde
    // anti-résurrection. Les lecteurs CONSCIENTS DU LOT reflètent l'état post-lot → seul le résidu est produit.
    const residual = ApiRules.residualCascade(body.deletes, childFinder, fetch);
    if (residual.deletes.length || residual.updates.length) {
      // Périmètre SSE ÉLARGI : la cascade résiduelle touche d'autres collections → les autres clients les rechargent.
      const cs = (req as RepoRequest).changeset;
      if (cs && !cs.full) {
        const touched = new Set<string>(cs.collections);
        residual.deletes.forEach((x) => touched.add(x.collection));
        residual.updates.forEach((u) => touched.add(u.collection));
        cs.collections = [...touched];
      }
    }
    try {
      this.repoOf(req).transact({ ...body, creates, updates: [...updates, ...residual.updates], deletes: [...(body.deletes || []), ...residual.deletes] }, this.revOf(req));
      res.status(204).end();
    }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  /** Remplacement COMPLET du document (import `.json`). Comme `/transact` et le CRUD, le serveur fait AUTORITÉ :
      on normalise + valide CHAQUE enregistrement avant d'écrire, sinon un export corrompu/forgé injecterait des
      données invalides. Particularité du snapshot : c'est un remplacement TOTAL → les FK doivent se résoudre DANS
      le snapshot lui-même (la base courante va être écrasée), pas dans le dépôt. On adosse donc lecteur d'entité
      et chercheur d'enfants au CONTENU du snapshot. Le moindre échec rejette TOUT l'import (atomicité). */
  private snapshot: RequestHandler = (req, res) => {
    const snap: any = req.body || {};
    // Index par id (par collection) → lecteur d'entité O(1) sur le snapshot (intégrité référentielle V2 + V5).
    const byId = new Map<string, Map<string, Record<string, any>>>();
    for (const c of Schema.COLLECTIONS) {
      if (!Array.isArray(snap[c])) continue;
      const m = new Map<string, Record<string, any>>();
      for (const r of snap[c]) if (r && r.id) m.set(String(r.id), r);
      byId.set(c, m);
    }
    const fetch: EntityFetcher = (collection, id) => byId.get(collection)?.get(String(id)) || null;
    // Chercheur d'enfants (dépendance inverse V5b / portée V6) : scan du snapshot, appartenance pour les champs tableaux.
    const find: ChildFinder = (collection, fkField, parentId) => (Array.isArray(snap[collection]) ? snap[collection] : []).filter((r: any) => {
      const v = r ? r[fkField] : undefined;
      return Array.isArray(v) ? v.includes(parentId) : v === parentId;
    });
    const errors: ValidationError[] = [];
    const out: Record<string, any> = {};
    if (snap.meta) out.meta = snap.meta;
    for (const c of Schema.COLLECTIONS) {
      if (!Array.isArray(snap[c])) continue;
      out[c] = snap[c].map((rec: any) => {
        const { record, errors: errs } = DataValidator.normalizeAndValidate(c, rec || {}, fetch, find);
        errors.push(...errs);
        return record;
      });
    }
    // V5b : cohérence enfants ⇄ parent AU SEIN du snapshot normalisé (ex. adresse ∈ CIDR de son réseau).
    for (const c of Schema.COLLECTIONS) for (const rec of (out[c] || [])) errors.push(...DataValidator.validateDependents(c, rec, find, fetch));
    if (errors.length) { res.status(400).json({ error: "données invalides", errors }); return; }
    try { this.repoOf(req).replaceSnapshot(out, this.revOf(req)); res.status(204).end(); }
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
    // meta malformée → 400 : l'ignorer silencieusement écraserait la méta existante par `{ id }` seul.
    try { meta = req.body && req.body.meta ? JSON.parse(req.body.meta) : {}; }
    catch { res.status(400).json({ error: "meta invalide (JSON attendu)" }); return; }
    const file = (req as { file?: { buffer: Buffer; mimetype: string } }).file;   // posé par multer.single("blob")
    const buf = file ? file.buffer : null;
    if (buf) meta.type = meta.type || file!.mimetype || "application/octet-stream";
    // liste blanche PARTAGÉE (Schema.IMAGE_MIME_TYPES, même filtre que le front) : le blob est resservi avec
    // son Content-Type stocké — accepter un type arbitraire (text/html, image/svg+xml scripté…) ouvrirait un
    // XSS stocké servi par l'origine de l'app. Vaut pour le blob ET pour une méta déclarant un `type` seule.
    if ((buf || meta.type !== undefined) && !Schema.isImageMime(meta.type)) { res.status(400).json({ error: "type d'image non supporté (" + Schema.IMAGE_MIME_TYPES.join(", ") + ")" }); return; }
    this.repoOf(req).putImage(req.params.id, meta, buf);
    res.status(204).end();
  };
  private deleteImage: RequestHandler = (req, res) => { this.repoOf(req).deleteImage(req.params.id); res.status(204).end(); };

  /* -- MAINTENANCE (admin — tout ce routeur l'est) : purge des images orphelines + VACUUM/checkpoint/optimize.
        Comme les autres routes d'images : pas de notification SSE ni d'incrément de révision (les images sont
        HORS modèle ; les autres clients rechargent leur miroir à l'ouverture de document). -- */
  private maintenance: RequestHandler = (req, res) => {
    const r = this.docs.maintenance((req.params as any).docId);
    if (!r) { res.status(404).json({ error: "document inconnu" }); return; }
    res.json(r);
  };

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
  /** Normalise + valide un enregistrement avant écriture (autorité serveur). Renvoie le record NORMALISÉ à
      persister, ou `null` après avoir répondu `400 { errors }` — le handler doit alors s'arrêter. Collection
      sans spécification (V1 : non pilote) → record inchangé, aucune erreur. */
  /** Lecteur d'entité adossé au Repository du document (intégrité référentielle V2 + cross-entité V5). */
  private repoFetcher(req: Request): EntityFetcher {
    const repo = this.repoOf(req);
    return (collection, id) => repo.getOne(collection, id);
  }
  /** Recherche d'enfants par clé étrangère (dépendance inverse V5b) adossée au Repository. */
  private repoChildFinder(req: Request): ChildFinder {
    const repo = this.repoOf(req);
    return (collection, fkField, parentId) => repo.findBy(collection, fkField, parentId);   // LEAN : pas de COUNT/tri/pagination (chemin CHAUD des find V6/dependents)
  }

  private accept(res: Response, collection: string, record: Record<string, any>, fetch?: EntityFetcher, find?: ChildFinder): Record<string, any> | null {
    const { record: normalized, errors } = DataValidator.normalizeAndValidate(collection, record, fetch, find);
    if (errors.length) { res.status(400).json({ error: "données invalides", errors }); return null; }
    return normalized;
  }

  private create: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const record = this.accept(res, req.params.collection, req.body || {}, this.repoFetcher(req), this.repoChildFinder(req)); if (!record) return;
    // CRÉATION STRICTE (pas d'upsert silencieux) : un POST avec un id EXISTANT écraserait l'enregistrement en
    // CONTOURNANT le verrou optimiste (`writeTargets` ne cible pas les créations — un id neuf n'a pas de ligne
    // à protéger). Réécrire une entité existante = PUT /:collection/:id, gardé par X-Base-Rev. → 409.
    if (record.id && this.repoOf(req).getOne(req.params.collection, record.id)) {
      res.status(409).json({ error: "création refusée : l'id existe déjà", collection: req.params.collection, id: record.id });
      return;
    }
    try { this.repoOf(req).upsert(req.params.collection, record, this.revOf(req)); res.status(201).json(record); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private update: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    // PATCH PARTIEL (V3) : on fusionne le corps SUR l'enregistrement existant avant de normaliser/valider, sinon
    // les valeurs par défaut écraseraient les champs absents. (Le client packagé envoie des records complets ;
    // ce merge protège les interfaces tierces qui posteraient un patch partiel.)
    const existing = this.repoOf(req).getOne(req.params.collection, req.params.id) || {};
    const record = this.accept(res, req.params.collection, { ...existing, ...(req.body || {}), id: req.params.id }, this.repoFetcher(req), this.repoChildFinder(req)); if (!record) return;
    // V5b : si ce changement invalide des enfants (ex. CIDR d'un réseau → adresses hors sous-réseau), on rejette.
    const dependentErrors = DataValidator.validateDependents(req.params.collection, record, this.repoChildFinder(req), this.repoFetcher(req));
    if (dependentErrors.length) { res.status(400).json({ error: "données invalides", errors: dependentErrors }); return; }
    try { this.repoOf(req).upsert(req.params.collection, record, this.revOf(req)); res.json(record); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private remove: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const repo = this.repoOf(req);
    const collection = req.params.collection, id = req.params.id;
    // CASCADE DE SUPPRESSION (intégrité référentielle, autorité serveur) : on calcule via la logique PARTAGÉE
    // `Cascade.plan` — la même qu'en mode fichier — les entités à supprimer (enfants) et les FK à détacher.
    // Sans ça, un `DELETE` naïf laisserait des FK pendantes (orphelins) que rien ne rattraperait côté serveur.
    const find = this.repoChildFinder(req);
    const fetch = this.repoFetcher(req);
    const plan = Cascade.plan(collection, id, find, fetch);
    // Détachements : FUSIONNÉS par enregistrement (un même record peut recevoir plusieurs clés — ex. spares :
    // `assigned_free` + `assigned_equipment_id`) pour produire UN seul update complet (sinon le dernier upsert
    // écraserait les clés des précédents, chacun étant bâti sur l'original).
    const patched = new Map<string, { collection: string; record: Record<string, any> }>();
    for (const d of plan.detaches) {
      const mapKey = d.c + "\u0000" + d.id;
      let entry = patched.get(mapKey);
      if (!entry) { const rec = fetch(d.c, d.id); if (!rec) continue; entry = { collection: d.c, record: { ...rec } }; patched.set(mapKey, entry); }
      entry.record[d.key] = d.value;
    }
    const updates = [...patched.values()];
    const deletes = [...plan.deletes.map((x) => ({ collection: x.c, id: x.id })), { collection, id }];
    // Périmètre SSE ÉLARGI : la cascade touche d'autres collections → les autres clients doivent les recharger.
    const touched = new Set<string>([collection]);
    updates.forEach((u) => touched.add(u.collection));
    deletes.forEach((x) => touched.add(x.collection));
    (req as RepoRequest).changeset = { full: false, collections: [...touched], meta: false, images: false };
    // UNE transaction atomique : détachements (updates) + suppressions enfants + cible (transact applique deletes
    // puis updates → les enregistrements détachés survivent et voient leur FK nettoyée).
    try { repo.transact({ updates, deletes }, this.revOf(req)); res.status(204).end(); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
}

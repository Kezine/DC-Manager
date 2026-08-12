import express, { type Router, type RequestHandler, type Request, type Response } from "express";
import multer from "multer";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Schema } from "./constants.js";
import { AttachmentFiles } from "./AttachmentFiles.js";   // binaires des pièces jointes : chemins sûrs + I/O disque (instance UNIQUE portée par DocumentStore)
import { ContentDisposition } from "./ContentDisposition.js";   // en-tête de téléchargement assaini (D6 — nom d'origine = donnée utilisateur)
import { type RepositoryContract, type Rec, type ListOpts } from "./db.js";   // le CONTRAT (surface publique) — l'implémentation servie est relationnelle depuis la bascule L4
import { DocumentStore } from "./documents.js";
import { Auth, type SsoResult } from "./auth.js";
import { LiveBus } from "./live.js";
import type { DocumentChangeset } from "../../src-shared/DocumentChangeset.js";   // type PARTAGÉ front ⇄ back (source unique)
import { DataValidator, type ValidationError, type EntityFetcher, type ChildFinder } from "../../src-shared/DataValidation.js";   // normalisation + validation PARTAGÉES
import { Cascade } from "../../src-shared/Cascade.js";   // cascade de suppression PARTAGÉE (intégrité référentielle en DELETE)
import { ListOrder } from "../../src-shared/ListOrder.js";   // liste blanche PARTAGÉE des colonnes triables (tri serveur de la route paginée)
import { ApiRules } from "./ApiRules.js";             // règles PURES de la couche HTTP (verrou, changeset, lot) — testables sans Express
import { AuditStamp } from "./AuditStamp.js";         // règles PURES d'estampillage « qui a écrit, quand » (created_by/updated_by + dates serveur)
import { UserProfiles } from "./users/UserProfiles.js";   // logique PURE de l'annuaire (clé canonique, caviardage, parsing d'ids)
import type { UserResolver } from "./users/UserResolver.js";   // contrat de résolution d'utilisateurs (service CORE injecté)

/** Requête dont le dépôt du document a été résolu + l'utilisateur SSO validé (par `requireAdmin`).
    `changeset` : périmètre SSE, posé par défaut par `resolveRepo` et ÉLARGISSABLE par un handler (ex. la cascade
    de suppression touche plusieurs collections) — la publication live le lit au moment du `finish`. */
type RepoRequest = Request & { repo?: RepositoryContract; authUser?: SsoResult; docRev?: number; changeset?: DocumentChangeset };

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

  /** Identité STABLE de l'auteur : id CANONIQUE (clé de stockage/résolution, cf. UserProfiles.canonicalId
      — String(id) SSO sinon login) + nom d'affichage. Destinée à l'estampillage d'audit « qui a écrit ? »
      par un id RÉSOLUBLE a posteriori (annuaire) ; `name` reste le libellé lisible et le repli si l'id
      n'est pas résolu. Livrée ET testée ici ; sa consommation par les écritures est le lot 2.
      Voir docs/user-resolver.md. */
  static identity(req: Request): { id: string; name: string } {
    const r = (req as RepoRequest).authUser;
    return { id: UserProfiles.canonicalId(r && r.user), name: RequestAuthor.name(req) };
  }
}

/** Couche HTTP : registre de documents + données SCOPÉES par document, déléguées au `Repository`. */
export class Api {
  private readonly upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

  /** Upload des PIÈCES JOINTES : multer SÉPARÉ en **diskStorage** — jamais le memoryStorage des images
      (50 Mo en RAM par upload concurrent gèleraient le serveur ; sur disque, l'écriture est STREAMÉE et le
      thread Node ne porte jamais le binaire entier — la raison d'être de D4, cf. AttachmentFiles). Le
      fichier atterrit en `.tmp-…` DANS le dossier cible du document : le rename final (`promote`) reste
      atomique (même volume). Plafond D6 : 50 Mo par pièce. Callbacks en fléchées → `this` est l'Api au
      moment de la requête (les params du routeur document, dont docId, sont fusionnés — mergeParams). */
  private readonly attachmentUpload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        try { cb(null, this.docs.attachmentFiles.ensureDir((req.params as { docId?: string }).docId || "")); }
        catch (e: any) { cb(e, ""); }
      },
      filename: (_req, _file, cb) => cb(null, AttachmentFiles.tempName()),
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  /** Plafond d'ids par appel à `GET /users/resolve` (anti-abus — parité avec les autres endpoints batch). */
  private static readonly USERS_RESOLVE_CAP = 200;

  /** Plafond de racines par appel à `POST /cascade-preview` (anti-abus, même esprit que ci-dessus).
      Dimensionné sur le plus gros geste réel — la purge de masse des VMs orphelines, qui en prévisualise
      quelques dizaines (cf. docs/vm-proxmox.md) : 1000 laisse une marge confortable sans ouvrir un
      calcul de cascade illimité à une requête unique. */
  private static readonly CASCADE_PREVIEW_CAP = 1000;

  constructor(private readonly docs: DocumentStore, private readonly auth: Auth, private readonly live: LiveBus,
              private readonly resolver: UserResolver, private readonly extensions: ApiExtension[] = []) {}

  router(): Router {
    const r = express.Router();
    r.get("/me", this.me);                 // état d'auth (accessible sans être autorisé)
    r.use(this.requireAdmin);              // tout le reste exige une session SSO valide + SUPER_ADMIN

    // -- extensions (modules optionnels) : montées TÔT — avant le routeur de données, dont la
    // route générique `/:collection` capterait sinon leurs segments (ex. « vm » lu comme collection).
    for (const ext of this.extensions) r.use(ext.path, ext.router);

    // -- annuaire utilisateurs (service CORE, PAS un module amovible) : résolution BATCH d'ids
    // canoniques en profils affichables, derrière la même garde d'accès. Voir docs/user-resolver.md.
    r.get("/users/resolve", this.usersResolve);

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
    // 🚨 APERÇU DE CASCADE — monté AVANT `resolveRepo`, et c'est TOUT l'intérêt : la route est un POST
    // par sa CHARGE (une liste d'ids ne tient pas dans une query string sur une purge de masse), mais
    // c'est une LECTURE PURE. Passée par `resolveRepo`, elle consommerait une révision et réveillerait
    // tous les clients par SSE à chaque ouverture de modale de confirmation. Elle résout donc le dépôt
    // par la moitié LECTURE de ce middleware (`resolveRepoRead`). Cf. docs/hydratation.md § G5.
    data.post("/cascade-preview", this.resolveRepoRead, this.cascadePreview);
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
    // -- pièces jointes : SEULES les deux routes du BINAIRE sont dédiées (création multipart streamée +
    // download streamé). Tout le reste — listing, lecture, ÉDITION de métadonnées, SUPPRESSION — passe par
    // les routes GÉNÉRIQUES de collection ci-dessous (`attachments` est une collection ordinaire du
    // document : rev++, changeset, SSE, cascade). ⚠ Le POST doit précéder `POST /:collection` (sinon la
    // route générique capterait « attachments » et créerait des métadonnées sans binaire) ; le GET blob
    // (3 segments) ne peut pas être capté par `GET /:collection/:id` (2 segments). D5 : la suppression
    // d'un enregistrement ne fait AUCUN unlink — la purge des binaires est le travail de la maintenance.
    data.post("/attachments", this.attachmentUpload.single("blob"), this.createAttachment);
    data.get("/attachments/:id/blob", this.getAttachmentBlob);
    data.post("/maintenance", this.maintenance);   // AVANT /:collection (sinon « maintenance » serait une collection)
    data.get("/search", this.searchAll);           // AVANT /:collection aussi — recherche TRANSVERSE (palette Ctrl+K, cf. docs/recherche.md)
    data.get("/:collection", this.list);
    data.get("/:collection/:id", this.getOne);
    data.post("/:collection", this.create);
    data.put("/:collection/:id", this.update);
    data.delete("/:collection/:id", this.remove);
    r.use("/documents/:docId", data);
    return r;
  }

  private repoOf(req: Request): RepositoryContract { return (req as RepoRequest).repo!; }
  /** Révision portée par l'écriture courante (posée par `resolveRepo`) → estampillée sur les lignes (`updated_rev`). */
  private revOf(req: Request): number { return (req as RepoRequest).docRev || 0; }
  /** Id CANONIQUE de l'auteur de l'écriture courante — estampillé en audit `created_by`/`updated_by`
      par `AuditStamp` (cf. RequestAuthor.identity). "" = pas d'identité résoluble (les `_by` restent non posés). */
  private authorId(req: Request): string { return RequestAuthor.identity(req).id; }
  /** Traduit la query string de la route paginée en `ListOpts`. `sort`/`dir` sont EXTRAITS du reste
      (sinon ils tomberaient dans `where` et deviendraient des filtres fantômes « aucune ligne ») ;
      leur VALIDATION vit dans le handler `list` (400 explicite — parseList n'a pas accès à la réponse). */
  private parseList(q: Record<string, any>): ListOpts {
    const { page, pageSize, q: query, ids, sort, dir, ...rest } = q;
    const where: Rec = {};
    for (const [k, v] of Object.entries(rest)) where[k] = v;
    return {
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || Schema.PAGE_SIZE_DEFAULT,
      query: query || "",
      where: Object.keys(where).length ? where : null,
      ids: ids ? String(ids).split(",").filter(Boolean) : null,
      sort: sort !== undefined ? String(sort) : null,
      dir: dir !== undefined ? String(dir) : null,
    };
  }

  /* -- auth (proxy SSO) : état de session, toujours accessible (le client adapte son UI) -- */
  private me: RequestHandler = async (req, res) => { res.json(await this.auth.validate(req)); };

  /** Garde d'accès : session SSO valide + SUPER_ADMIN. Le refus est distingué par le code HTTP, car le
      client AGIT différemment selon le cas :
        - **401 « non authentifié »** quand `!r.logged` (session absente ou EXPIRÉE) → le client coupe la
          session locale et RENVOIE au login. Sans cette distinction, une expiration en cours de session
          se traduisait par un 403 indiscernable, donc en erreurs éparses sans jamais ramener à la connexion
          (cf. RestDocumentController.sessionExpired côté client).
        - **403 « accès refusé »** quand la session est VALIDE mais sans le droit SUPER_ADMIN → le client
          reste sur l'écran « accès refusé » (pas de boucle de reconnexion : se reconnecter n'y changerait rien).
      Le corps JSON portait DÉJÀ `logged`/`adminRight` — seul le CODE HTTP résumait mal les deux cas. */
  private requireAdmin: RequestHandler = async (req, res, next) => {
    const r = await this.auth.validate(req);
    (req as RepoRequest).authUser = r;   // réutilisé par resolveRepo (qui a écrit, pour le live)
    if (this.auth.isAuthorized(r)) { next(); return; }
    if (!r.logged) { res.status(401).json({ error: "non authentifié", logged: false, adminRight: r.adminRight || "NONE" }); return; }
    res.status(403).json({ error: "accès refusé", logged: true, adminRight: r.adminRight || "NONE" });
  };

  /** Résolution BATCH d'utilisateurs par id canonique : `GET /users/resolve?id=…&id=…`.
      Param `id` RÉPÉTABLE, dédupliqué, plafonné (USERS_RESOLVE_CAP), ORDRE de la requête préservé
      dans la réponse `{ users: ResolvedUser[] }`. RESTRICTION de confidentialité (arbitrage Q4) :
      email et téléphone sont renvoyés VIDES pour autrui — renseignés UNIQUEMENT quand l'id résolu
      est celui de l'APPELANT (il voit ses propres coordonnées). Caviardage PUR : UserProfiles.redactFor.
      Voir docs/user-resolver.md. */
  private usersResolve: RequestHandler = async (req, res) => {
    const ids = UserProfiles.parseIdList((req.query as Record<string, any>).id, Api.USERS_RESOLVE_CAP);
    const caller = (req as RepoRequest).authUser;
    const callerId = UserProfiles.canonicalId(caller && caller.user);
    const resolved = await this.resolver.resolve(ids);
    res.json({ users: resolved.map((u) => UserProfiles.redactFor(callerId, u)) });
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

  /** Résolution du dépôt en LECTURE SEULE : 404 si le document est inconnu, dépôt posé sur la requête,
      révision exposée — RIEN d'autre. Aucun verrou, aucune révision consommée, aucun SSE. Middleware
      DISTINCT parce que certaines LECTURES ne peuvent pas être des GET : leur charge (une liste d'ids)
      ne tient pas dans une query string. Seul cas à ce jour : l'aperçu de cascade (cf. `router()`). */
  private resolveRepoRead: RequestHandler = (req, res, next) => {
    const id = (req.params as any).docId;
    const repo = this.docs.repo(id);
    if (!repo) { res.status(404).json({ error: "document inconnu" }); return; }
    (req as RepoRequest).repo = repo;
    res.setHeader("X-Doc-Rev", String(this.docs.getRev(id)));
    next();
  };

  /** Résout le Repository du document (404 si inconnu). En écriture : VERROU OPTIMISTE par entité (409 si une entité
      visée a été modifiée après la révision de base du client, en-tête `X-Base-Rev`), sinon incrémente la révision
      (entête `X-Doc-Rev`), estampille `docRev` pour les handlers, et publie l'événement live (si succès).
      En lecture : expose la rev. */
  private resolveRepo: RequestHandler = (req, res, next) => {
    // LECTURE : exactement le traitement des routes de lecture pure — délégué plutôt que recopié
    // (principe n°3 : deux copies de la résolution/404/rev finiraient par diverger).
    if (req.method === "GET") { this.resolveRepoRead(req, res, next); return; }
    const id = (req.params as any).docId;
    const repo = this.docs.repo(id);
    if (!repo) { res.status(404).json({ error: "document inconnu" }); return; }
    (req as RepoRequest).repo = repo;
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
    // Reverse proxy (nginx) : DÉSACTIVE le buffering de réponse POUR CE FLUX. Sans ce header, nginx (buffering
    // activé PAR DÉFAUT) met le flux SSE en tampon → les événements n'atteignent jamais le navigateur et l'UI
    // ne se met pas à jour sur un changement POUSSÉ par le serveur (synchro VM, écriture d'un autre client) :
    // il faut recharger la page. Le header est ignoré sans proxy (connexion directe) — cf. docs/reverse-proxy.md.
    res.setHeader("X-Accel-Buffering", "no");
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

  /* -- APERÇU de cascade (lecture pure — cf. le montage dans `router()`) -- */
  /** Plan de cascade d'une suppression, calculé sur le corpus SERVEUR. Corps :
      `{ collection: string, ids: string[] }` → réponse `{ deletes: [{c,id}], detaches: [{c,id,key,value}] }`,
      c'est-à-dire le `CascadePlan` PARTAGÉ tel quel — l'aperçu serveur et l'aperçu local rendent le MÊME
      objet, ce qui permet à l'appelant de les employer indifféremment (cf. `Store.cascadePreviewAsync`).
      Le moteur est celui de la SUPPRESSION (`Cascade.planMany`, partagé) : l'aperçu ne peut pas diverger
      de ce que `DELETE` / `/transact` feront. AUCUNE écriture : ni mutation, ni révision, ni SSE.
      Plafond d'ids par appel (parité avec les autres endpoints batch) ; ids inconnus simplement ignorés
      par le moteur (une racine déjà supprimée n'entraîne rien). */
  private cascadePreview: RequestHandler = (req, res) => {
    const body: any = req.body || {};
    const collection = String(body.collection || "");
    if (!Schema.isCollection(collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    if (!Array.isArray(body.ids)) { res.status(400).json({ error: "ids invalides (tableau attendu)" }); return; }
    const ids = [...new Set(body.ids.filter((id: any) => typeof id === "string" && id))] as string[];
    if (ids.length > Api.CASCADE_PREVIEW_CAP) { res.status(400).json({ error: "trop d'ids (max " + Api.CASCADE_PREVIEW_CAP + ")" }); return; }
    if (!ids.length) { res.json({ deletes: [], detaches: [] }); return; }
    // MULTI-RACINES en UN plan (`planMany`) : c'est une exigence de CORRECTION, pas une optimisation
    // (composition des retraits de liste, garde anti-résurrection — cf. src-shared/Cascade.ts) ; c'est
    // aussi ce que la purge de masse demande, elle qui prévisualise des dizaines de VMs d'un coup.
    const plan = Cascade.planMany(ids.map((id) => ({ collection, id })), this.repoChildFinder(req), this.repoFetcher(req));
    res.json(plan);
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
    // AUDIT posé PAR LE SERVEUR sur CHAQUE opération du lot (créations comme mises à jour, y compris les
    // updates de cascade résiduelle : ce sont des modifications par l'auteur du lot) — cf. AuditStamp. Les
    // champs d'audit envoyés par le client sont écrasés ; le `created_*` d'une mise à jour est repris de l'existant.
    const nowIso = new Date().toISOString();
    const authorId = this.authorId(req);
    const repo = this.repoOf(req);
    const stampCreate = (entry: any) => (entry && entry.collection && entry.record)
      ? { ...entry, record: AuditStamp.apply(entry.record, null, authorId, nowIso) } : entry;
    const stampUpdate = (entry: any) => {
      if (!entry || !entry.collection || !entry.record) return entry;
      // On ne lit l'existant (created_* immuables) que si l'id est présent — sinon `repo.transact`
      // rejettera l'entrée sans id (« record sans id ») ; on ne veut pas planter avant, sur getOne(undefined).
      const existing = entry.record.id ? repo.getOne(entry.collection, entry.record.id) : null;
      return { ...entry, record: AuditStamp.apply(entry.record, existing, authorId, nowIso) };
    };
    const stampedCreates = creates.map(stampCreate);
    const stampedUpdates = [...updates, ...residual.updates].map(stampUpdate);
    try {
      repo.transact({ ...body, creates: stampedCreates, updates: stampedUpdates, deletes: [...(body.deletes || []), ...residual.deletes] }, this.revOf(req));
      // COMPTE RENDU du lot (garde M4 du chantier lazy-load, cf. docs/hydratation.md) : le client
      // IGNORE l'événement SSE de sa PROPRE écriture — sans ce corps, rien ne lui apprendrait que le
      // serveur a supprimé PLUS que son plan (cascade résiduelle sur des enregistrements qu'il n'avait
      // pas en cache, ou dont sa copie était périmée). Il en purge son cache et invalide les compteurs
      // des collections touchées. Le corps remplace le 204 historique : additif, aucun appelant ne le
      // lisait (le client n'en lit toujours que `residual`).
      res.json({
        residual: {
          deletes: residual.deletes.map((d: any) => ({ collection: d.collection, id: d.id })),
          updates: residual.updates.map((u: any) => ({ collection: u.collection, id: u.record && u.record.id })),
        },
      });
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
    // AUDIT : la restauration N'ESTAMPILLE PAS (arbitrage Q7) — l'audit contenu dans le snapshot est restauré
    // TEL QUEL (fidélité historique). C'est le SEUL chemin d'écriture qui ne passe pas par AuditStamp ; la
    // normalisation partagée préserve created_by/updated_by/created_date/updated_date (champs non déclarés → ils traversent).
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

  /* -- pièces jointes (binaire) — cf. docs/attachments.md -- */
  /** CRÉATION d'une pièce jointe : multipart `{ meta: JSON, blob: file }`. Discipline D5 : le FICHIER
      d'abord (multer a déjà streamé un `.tmp-…` dans le dossier du document ; `promote` = rename atomique
      vers l'id définitif), l'ENREGISTREMENT ensuite (upsert de la collection `attachments`, via le dépôt
      standard : rev++/verrou/SSE sont portés par `resolveRepo` comme pour toute écriture, et le changeset
      cible la collection — cf. ApiRules.buildChangeset, chemin `/attachments`). Un crash entre les deux
      laisse au pire un binaire orphelin, rattrapé par la maintenance ; un échec d'insertion déclenche le
      SEUL unlink « en ligne » légitime (l'enregistrement n'a jamais existé, D5 ne protège rien).
      Le serveur fait AUTORITÉ sur `size` (taille RÉELLE du fichier reçu — jamais crue du client) et
      rejoue la liste blanche MIME partagée (même doctrine anti-XSS-stocké que `putImage`). */
  private createAttachment: RequestHandler = (req, res) => {
    const docId = (req.params as { docId?: string }).docId || "";
    const file = (req as { file?: { path: string; size: number } }).file;   // posé par attachmentUpload.single("blob") — diskStorage, jamais en mémoire
    const dropTemp = () => { if (file) { try { fs.unlinkSync(file.path); } catch { /* déjà retiré */ } } };
    // meta malformée → 400 (l'ignorer créerait un enregistrement vide) ; le temp est nettoyé au passage.
    let meta: Rec = {};
    try { meta = req.body && req.body.meta ? JSON.parse(req.body.meta) : {}; }
    catch { dropTemp(); res.status(400).json({ error: "meta invalide (JSON attendu)" }); return; }
    if (!file) { res.status(400).json({ error: "fichier manquant (multipart { meta, blob } attendu)" }); return; }
    // Liste blanche PARTAGÉE (Schema.ATTACHMENT_MIME_TYPES) : le binaire est resservi avec le Content-Type
    // stocké — accepter text/html ou image/svg+xml ouvrirait un XSS stocké (cf. Schema, décision D6).
    if (!Schema.isAttachmentMime(meta.mime)) { dropTemp(); res.status(400).json({ error: "type de fichier non supporté (" + Schema.ATTACHMENT_MIME_TYPES.join(", ") + ")" }); return; }
    meta.size = file.size;   // AUTORITÉ SERVEUR : la taille déclarée par le client est écrasée
    // Id fourni par le client (parité mode fichier : Id.uid) OU généré ici — dans les deux cas VALIDÉ comme
    // nom de fichier SÛR (aucune entrée libre dans un chemin — anti-traversal D4, cf. AttachmentFiles).
    const id = (typeof meta.id === "string" && meta.id) ? meta.id : "att-" + randomUUID();
    if (!AttachmentFiles.isSafeId(id)) { dropTemp(); res.status(400).json({ error: "id de pièce jointe invalide" }); return; }
    const record = this.accept(res, "attachments", { ...meta, id }, this.repoFetcher(req), this.repoChildFinder(req));
    if (!record) { dropTemp(); return; }
    // CRÉATION STRICTE (parité `create`) : un id existant écraserait l'enregistrement hors verrou → 409.
    if (this.repoOf(req).getOne("attachments", id)) { dropTemp(); res.status(409).json({ error: "création refusée : l'id existe déjà", collection: "attachments", id }); return; }
    try { this.docs.attachmentFiles.promote(file.path, docId, id); }
    catch (e: any) { dropTemp(); res.status(500).json({ error: "écriture du fichier impossible : " + (e && e.message) }); return; }
    const stamped = AuditStamp.apply(record, null, this.authorId(req), new Date().toISOString());
    try { this.repoOf(req).upsert("attachments", stamped, this.revOf(req)); res.status(201).json(stamped); }
    catch (e: any) { this.docs.attachmentFiles.remove(docId, id); res.status(400).json({ error: e.message }); }
  };

  /** DOWNLOAD du binaire — STREAMÉ (fs.createReadStream → res : le serveur ne porte jamais le fichier
      entier en mémoire, cf. D4). `Content-Disposition: attachment` TOUJOURS (D6 : jamais inline — même
      un PDF bénin reste un téléchargement, et le nom d'origine est assaini par ContentDisposition,
      CRLF/guillemets/non-ASCII compris). 404 si l'enregistrement OU le fichier manque. */
  private getAttachmentBlob: RequestHandler = (req, res) => {
    const docId = (req.params as { docId?: string }).docId || "";
    const id = req.params.id;
    const record = AttachmentFiles.isSafeId(id) ? this.repoOf(req).getOne("attachments", id) : null;
    if (!record) { res.status(404).json({ error: "introuvable" }); return; }
    const stat = this.docs.attachmentFiles.statOf(docId, id);
    if (!stat) { res.status(404).json({ error: "binaire introuvable" }); return; }
    res.setHeader("Content-Type", String(record.mime || "application/octet-stream"));
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", ContentDisposition.attachment(String(record.file_name || "")));
    res.setHeader("Cache-Control", "private, max-age=60");   // parité images ; `nosniff` est global (Server)
    const stream = this.docs.attachmentFiles.readStream(docId, id);
    // Fichier disparu ENTRE le stat et l'ouverture (maintenance concurrente) : 404 si rien n'est parti,
    // sinon on coupe la connexion (le client verra un download tronqué — mieux qu'un fichier silencieusement faux).
    stream.on("error", () => { if (!res.headersSent) { res.status(404).json({ error: "binaire introuvable" }); } else { res.destroy(); } });
    stream.pipe(res);
  };

  /* -- MAINTENANCE (admin — tout ce routeur l'est) : purge des images orphelines ET des binaires de pièces
        jointes orphelins + VACUUM/checkpoint/optimize. Comme TOUTE écriture du routeur document, ce POST
        traverse `resolveRepo` : il consomme une révision et publie un SSE (chemin non listé par
        `ApiRules.buildChangeset` → changeset `full`, repli sûr — les autres clients rechargent, ce qui est
        au pire un rafraîchissement inutile après une purge). ⚠ Un commentaire historique affirmait ici que
        les routes d'IMAGES ne produisaient « ni SSE ni rev » — FAUX (rectifié, principe n°13) : elles
        traversent `resolveRepo` comme les autres, avec un changeset `images: true` (cf. buildChangeset). -- */
  private maintenance: RequestHandler = (req, res) => {
    const r = this.docs.maintenance((req.params as any).docId);
    if (!r) { res.status(404).json({ error: "document inconnu" }); return; }
    res.json(r);
  };

  /** Recherche GLOBALE transverse (`GET …/search?q=…&collections=a,b`) : UN aller-retour pour la palette
      Ctrl+K en mode API — jamais ~20 `list()` par frappe. Même garde d'accès que toute lecture du document
      (`requireAdmin` global + `resolveRepo`), délégation au dépôt (`searchAll` : LIKE par collection sur la
      colonne `search`, plafond par collection SEARCH_ALL_LIMIT signalé par `truncated` — cap assumé v1).
      `collections` (CSV, facultatif) restreint la recherche — les noms inconnus sont ignorés par le dépôt.
      Cf. docs/recherche.md. */
  private searchAll: RequestHandler = (req, res) => {
    const q = req.query as Record<string, any>;
    const collections = q.collections ? String(q.collections).split(",").filter(Boolean) : null;
    res.json(this.repoOf(req).searchAll(String(q.q || ""), { collections }));
  };

  /* -- CRUD générique par collection -- */
  /** Liste paginée. `sort`/`dir` (tri SERVEUR — pagination ordonnée complète, cf. docs/recherche.md) :
      validés contre la liste blanche PARTAGÉE `ListOrder` → **400 explicite** si invalides, JAMAIS
      ignorés en silence — un tri demandé et non appliqué serait un mensonge d'UI (la page paraîtrait
      triée alors que la découpe suivrait un autre ordre). Le dépôt re-refuse de toute façon (défense
      en profondeur : ce 400 est le SEUL chemin utilisateur, le throw du dépôt garde les internes). */
  private list: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const opts = this.parseList(req.query);
    if (opts.sort != null && !ListOrder.isSortable(req.params.collection, opts.sort)) {
      res.status(400).json({ error: "colonne de tri invalide : " + opts.sort }); return;
    }
    if (opts.dir != null && !ListOrder.isDirection(opts.dir)) {
      res.status(400).json({ error: "direction de tri invalide (asc|desc attendu) : " + opts.dir }); return;
    }
    res.json(this.repoOf(req).list(req.params.collection, opts));
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
    // AUDIT posé PAR LE SERVEUR (création) : created_by/updated_by = id de l'auteur, dates = maintenant
    // (les champs d'audit envoyés par le client sont écrasés — cf. AuditStamp). La ligne renvoyée les porte.
    const stamped = AuditStamp.apply(record, null, this.authorId(req), new Date().toISOString());
    try { this.repoOf(req).upsert(req.params.collection, stamped, this.revOf(req)); res.status(201).json(stamped); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private update: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    // PATCH PARTIEL (V3) : on fusionne le corps SUR l'enregistrement existant avant de normaliser/valider, sinon
    // les valeurs par défaut écraseraient les champs absents. (Le client packagé envoie des records complets ;
    // ce merge protège les interfaces tierces qui posteraient un patch partiel.)
    // `existing` peut être null (PUT sur un id inconnu = création) → AuditStamp le traite alors comme une création.
    const existing = this.repoOf(req).getOne(req.params.collection, req.params.id);
    const record = this.accept(res, req.params.collection, { ...(existing || {}), ...(req.body || {}), id: req.params.id }, this.repoFetcher(req), this.repoChildFinder(req)); if (!record) return;
    // V5b : si ce changement invalide des enfants (ex. CIDR d'un réseau → adresses hors sous-réseau), on rejette.
    const dependentErrors = DataValidator.validateDependents(req.params.collection, record, this.repoChildFinder(req), this.repoFetcher(req));
    if (dependentErrors.length) { res.status(400).json({ error: "données invalides", errors: dependentErrors }); return; }
    // AUDIT posé PAR LE SERVEUR (mise à jour) : created_by/created_date REPRIS de l'existant (immuables),
    // updated_by/updated_date rafraîchis. Une valeur d'audit envoyée par le client est écrasée (cf. AuditStamp).
    const stamped = AuditStamp.apply(record, existing, this.authorId(req), new Date().toISOString());
    try { this.repoOf(req).upsert(req.params.collection, stamped, this.revOf(req)); res.json(stamped); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  private remove: RequestHandler = (req, res) => {
    if (!Schema.isCollection(req.params.collection)) { res.status(404).json({ error: "collection inconnue" }); return; }
    const repo = this.repoOf(req);
    const collection = req.params.collection, id = req.params.id;
    // CASCADE DE SUPPRESSION (intégrité référentielle, autorité serveur) : on calcule via la logique PARTAGÉE
    // `Cascade.plan` — la même qu'en mode fichier — les entités à supprimer (enfants) et les FK à détacher.
    // Sans ça, un `DELETE` naïf laisserait des FK pendantes (orphelins) que rien ne rattraperait côté serveur.
    // Le plan est RÉCURSIF (chaîne complète, jusqu'au point fixe) : il peut donc être bien plus profond qu'une
    // liste d'enfants directs. Rien à adapter ici — l'ordre d'application ne compte pas (les suppressions sont
    // un ENSEMBLE) et le plan GARANTIT qu'aucun détachement ne vise une entité qu'il supprime, ce qui serait
    // fatal en aval : `Repository.transact` applique les deletes PUIS les updates, donc un update sur une ligne
    // supprimée la RESSUSCITE par upsert (cf. la garde jumelle d'`ApiRules.residualCascade`).
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
    // AUDIT posé PAR LE SERVEUR : un détachement de cascade est une MODIFICATION de l'entité par l'auteur de
    // la suppression → updated_by/updated_date rafraîchis (created_* repris de l'existant) — cf. AuditStamp.
    const nowIso = new Date().toISOString();
    const authorId = this.authorId(req);
    const updates = [...patched.values()].map((u) => ({ ...u, record: AuditStamp.apply(u.record, fetch(u.collection, u.record.id), authorId, nowIso) }));
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

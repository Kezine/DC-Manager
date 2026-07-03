/* =============================================================================
   DOCUMENTS FICHIER — contrôleur du cycle de vie fichier local, EXTRAIT de
   `boot()` (main.ts, découpage P4) : File System Access (ouvrir / enregistrer /
   rouvrir, mode « accès dossier »), fichier COMPAGNON d'images `.nmfb`
   (appariement par clé meta.facesKey), exports (JSON autonome, visualiseur
   HTML, bibliothèque d'images) et import de bibliothèque.

   L'ÉTAT fichier (handles, nom) vit ICI ; l'adhérence à la boucle applicative
   (chrome, vues, welcome, auto-save, timeline d'undo) passe par l'interface
   hôte `FileDocumentsHost` (couplage par interface — principe n°2). Les
   dépendances stables (store, images, session, prefs, handles, verrou
   inter-onglets) sont injectées au constructeur.
   ============================================================================= */
import type { Store } from "../store";
import type { ImageStore } from "../data/ImageStore";
import type { SaveState } from "./SaveState";
import type { Prefs } from "../core/Prefs";
import { HandleStore } from "./HandleStore";
import type { TabChannel } from "./TabChannel";
import { Notify } from "../ui/Notify";
import { Dialog } from "../ui/Dialog";
import { Download } from "../core/Download";
import { Id } from "../core/Id";
import { Log } from "../core/Log";

const W = window as any;
const JSON_TYPES = [{ description: "DC Manager JSON", accept: { "application/json": [".json"] } }];
const FACES_TYPES = [{ description: "DC Manager Faces (images)", accept: { "application/octet-stream": [".nmfb"] } }];   // fichier compagnon d'images

/** Adhérence à la boucle applicative, injectée. */
export interface FileDocumentsHost {
  refreshChrome(): void;
  refreshActive(): void;                       // re-render de la vue active (images chargées…)
  /** Post-chargement d'un document : masque le welcome, bascule la vue, (ré)arme l'auto-save, rafraîchit. */
  documentOpened(): void;
  applyTheme(): void;
  applyAutosave(): void;
  setReopen(name: string | null): void;   // renseigne/efface le bouton « Rouvrir » du welcome
  resetUndo(): void;                           // nouveau document chargé → timeline d'undo repart de zéro
}

export interface FileDocumentsDeps {
  store: Store; imageStore: ImageStore; session: SaveState; prefs: Prefs;
  handleStore: HandleStore; tabChannel: TabChannel; hasFsApi: boolean; host: FileDocumentsHost;
}

export class FileDocumentController {
  /** FileSystemFileHandle lié (FS API) — null = download/mémoire. */
  handle: any = null;
  /** Handle du fichier compagnon d'images (.nmfb) du document courant. */
  facesHandle: any = null;
  /** Mode « accès dossier » : handle du DOSSIER courant (couvre .json + .nmfb). */
  dirHandle: any = null;
  /** Nom du fichier lié (aussi utilisé comme nom d'affichage par le mode REST). */
  name = "";

  private lastRec: { handle: any; name: string } | null = null;   // dernier fichier mémorisé (réouverture)
  private readonly fileInput: HTMLInputElement;                    // import caché (navigateurs sans FS API)
  private readonly flog = Log.scope("fs");                         // trace fichier/compagnon (flag de débogage)
  private readonly store: Store; private readonly imageStore: ImageStore; private readonly session: SaveState;
  private readonly prefs: Prefs; private readonly handleStore: HandleStore; private readonly tabChannel: TabChannel;
  private readonly hasFsApi: boolean; private readonly host: FileDocumentsHost;

  constructor(deps: FileDocumentsDeps) {
    this.store = deps.store; this.imageStore = deps.imageStore; this.session = deps.session; this.prefs = deps.prefs;
    this.handleStore = deps.handleStore; this.tabChannel = deps.tabChannel; this.hasFsApi = deps.hasFsApi; this.host = deps.host;
    // ---- caché : input d'import (navigateurs sans File System Access API) ----
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file"; this.fileInput.accept = ".json,application/json"; this.fileInput.style.display = "none";
    document.body.appendChild(this.fileInput);
    this.fileInput.addEventListener("change", async () => {
      const f = this.fileInput.files && this.fileInput.files[0]; this.fileInput.value = "";
      if (!f) return;
      try { await this.loadFromText(await f.text(), f.name, null); Notify.toast("Fichier « " + f.name + " » chargé"); }
      catch (e: any) { if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err"); else Notify.toast("Fichier invalide (JSON attendu).", "err"); }
    });
  }

  /* ---- petits états dérivés ---- */
  /** Un fichier est-il lié (avec FS API) ? — alimente session.setFile / l'auto-save. */
  get hasLinkedFile(): boolean { return !!(this.handle && this.hasFsApi); }
  /** Mode « accès dossier » actif (réglage + FS API) : un seul grant couvre le .json et son compagnon .nmfb. */
  dirMode(): boolean { return this.prefs.fileAccessMode === "directory" && this.hasFsApi; }
  /** Nom de fichier proposé pour le document courant. */
  docFileName(): string { return Download.safeName(this.store.meta.docName || "dc-manager") + ".json"; }
  /** Détache tout fichier (nouveau document) : handles + nom remis à zéro. */
  detach(): void { this.handle = null; this.facesHandle = null; this.dirHandle = null; this.name = ""; this.session.setFile(false); }
  /** Nom du dernier fichier/document mémorisé (bouton « Rouvrir » du welcome), ou null. */
  async lastOpenName(): Promise<string | null> {
    try {
      if (this.dirMode()) { const d = await this.handleStore.getDir(); if (d && d.handle && d.name) return d.name; }
      this.lastRec = await this.handleStore.getLast();
      return this.lastRec ? (this.lastRec.name || "fichier") : null;
    } catch (_) { this.lastRec = null; return null; }
  }

  private ensureFileId(): string { if (!this.store.meta.fileId) { this.store.meta.fileId = Id.uid(); void this.store.persistMeta(); } return this.store.meta.fileId; }
  private rememberHandle(handle: any, name: string): void { if (!handle) return; this.lastRec = { handle, name: name || handle.name || "" }; void this.handleStore.putLast(handle, this.lastRec.name); }
  private async rememberDir(dir: any, jsonName: string): Promise<void> { this.dirHandle = dir; await this.handleStore.putDir(dir, jsonName); this.flog("rememberDir → dossier mémorisé", { dir: dir && dir.name, json: jsonName }); }

  /* ---- chargement d'un document depuis du texte JSON (revendique le verrou AVANT mutation) ---- */
  async loadFromText(text: string, name: string | null, handle: any): Promise<void> {
    const raw = JSON.parse(text);
    this.flog("loadFromText", { name, handle: handle && handle.name, inlineImages: Array.isArray(raw.faceImages), facesKey: raw && raw.meta && raw.meta.facesKey, dirMode: this.dirMode() });
    const incomingFileId = (raw && raw.meta && typeof raw.meta.fileId === "string" && raw.meta.fileId) ? raw.meta.fileId : null;
    await this.tabChannel.claimIncoming(incomingFileId, this.store.meta.fileId || null);   // throw FILE_ALREADY_OPEN si occupé
    await this.store.replaceAll(raw);
    // images de façade : embarquées inline (faceImages) → import dans l'ImageStore ; sinon document sans images
    if (Array.isArray(raw.faceImages)) await this.imageStore.replaceAllFromLegacy(raw.faceImages);
    else await this.imageStore.clearAll();
    this.host.resetUndo();   // nouveau document chargé → timeline d'undo unifiée repart de zéro
    this.handle = handle || null; this.facesHandle = null; this.name = name || "";
    if (!this.store.meta.docName && name) { this.store.meta.docName = name.replace(/\.json$/i, ""); await this.store.persistMeta(); }
    this.tabChannel.claim(this.store.meta.fileId || null);
    if (handle) this.rememberHandle(handle, name || handle.name || "");
    this.host.applyTheme(); this.session.setFile(this.hasLinkedFile); this.session.markLoaded(this.store.histIndex());
    if (!Array.isArray(raw.faceImages)) await this.loadCompanionFacesOnOpen(handle);   // .json sans images inline → recharge le compagnon .nmfb (auto si mémorisé)
    this.host.documentOpened();
  }

  /* ---- File System Access : permission, écriture, ouverture, enregistrement ---- */
  async ensureWritePermission(handle: any): Promise<boolean> {
    if (!handle || !handle.queryPermission) return true;
    if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  }
  /** Permission d'écriture sur le fichier COURANT (pont pour l'auto-save). */
  ensureCurrentWritePermission(): Promise<boolean> { return this.ensureWritePermission(this.handle); }
  /** Sérialisation FS : `.json` SANS images (les images vivent dans le compagnon `.nmfb` à côté). */
  private serializeJson(): string { return JSON.stringify(this.store.toJSON(), null, 2); }
  /** Repli DOWNLOAD (navigateur sans File System Access API) : fichier AUTONOME, images embarquées inline
      (aucun compagnon n'est possible sans handle FS → on ne perd rien). */
  async snapshotWithImages(): Promise<string> {
    const obj: any = this.store.toJSON();
    if (this.imageStore.count() > 0) obj.faceImages = await this.imageStore.toLegacyArray();
    return JSON.stringify(obj, null, 2);
  }
  /** EXPORT du document en JSON autonome (images inline) — disponible dans TOUS les modes (y compris API : version offline). */
  async exportJsonDownload(): Promise<void> {
    Download.text(this.docFileName(), await this.snapshotWithImages(), "application/json");
    Notify.toast("Document exporté (" + this.docFileName() + ")");
  }
  /** EXPORT VISUALISEUR AUTONOME : récupère l'app (HTML mono-fichier inliné) et y EMBARQUE le document courant →
      fichier .html LECTURE SEULE, consultable hors-ligne sans serveur (ouverture en file://). On retire la config
      API et on injecte `window.__DCMANAGER_EMBED__` (le bundle bascule alors en mode viewer, cf. EMBED/VIEWER). */
  async exportStandalone(): Promise<void> {
    let html: string;
    try { html = await (await fetch(location.href, { cache: "no-store" })).text(); }
    catch (e: any) { Notify.toast("Export HTML impossible (récupération de l'app) : " + ((e && e.message) || e), "err"); return; }
    if (!/__DCMANAGER_EMBED__|<script/i.test(html)) { Notify.toast("Export HTML indisponible : l'app n'est pas en build autonome.", "err"); return; }
    const json = (await this.snapshotWithImages()).split("</").join("<\\/");           // neutralise un éventuel </script> dans les données
    html = html.replace(/<script>\s*window\.__DCMANAGER_CONFIG__[\s\S]*?<\/script>/i, "");   // retire la config API injectée par le serveur
    const embed = "<script>window.__DCMANAGER_EMBED__=" + json + ";</script>";
    html = html.replace(/<head([^>]*)>/i, (_m, a) => `<head${a}>${embed}`);
    const fname = Download.safeName(this.store.meta.docName || "dc-manager") + "-viewer.html";
    Download.text(fname, html, "text/html");
    Notify.toast("Visualiseur autonome exporté (" + fname + ")");
  }
  async writeToHandle(handle: any): Promise<void> {
    this.ensureFileId();
    const w = await handle.createWritable(); await w.write(this.serializeJson()); await w.close();
    this.session.markSaved(); this.rememberHandle(handle, handle.name || this.name);
  }
  /** Écrit le fichier COURANT (pont pour l'auto-save). */
  async writeCurrent(): Promise<void> { await this.writeToHandle(this.handle); }

  /* ---- FICHIER COMPAGNON d'images (.nmfb) — dissocié du modèle, apparié au .json par meta.facesKey ---- */
  private facesNameFor(jsonName: string): string { return String(jsonName || "dc-manager.json").replace(/\.json$/i, "") + ".nmfb"; }
  private rememberFacesHandle(handle: any): void { if (handle) void this.handleStore.putFaces(handle, handle.name || ""); }
  private async writeFacesToHandle(handle: any): Promise<void> {
    if (!(await this.ensureWritePermission(handle))) throw new Error("permission-refusée");
    const blob = await this.imageStore.serializeBundle(this.store.meta.facesKey || null);
    const w = await handle.createWritable(); await w.write(blob); await w.close();
  }
  /** Clé d'appariement json↔compagnon : générée dès qu'un document a des images ; gravée dans meta.facesKey
      (sérialisée dans le .json) ET dans le manifeste du .nmfb. */
  private ensureFacesKey(): string { if (!this.store.meta.facesKey) { this.store.meta.facesKey = "fk-" + Id.uid(); void this.store.persistMeta(); } return this.store.meta.facesKey; }
  /** Le document a-t-il des images (bibliothèque chargée OU références d'équipement) ? Justifie un compagnon + une clé. */
  private docHasFaceImages(): boolean { return this.imageStore.count() > 0 || this.store.faceImageRefIds().size > 0; }
  /** Associe un compagnon sélectionné au document : charge ses images, puis (si demandé ou clé non concordante)
      génère une NOUVELLE clé et la ré-écrit dans le .nmfb ET le .json (appariement durable). */
  private async associateCompanion(fh: any, opts: { regenKey?: boolean } = {}): Promise<void> {
    const f = await fh.getFile();
    await this.imageStore.loadBundle(await f.arrayBuffer());
    this.facesHandle = fh; this.rememberFacesHandle(fh);
    const docKey = this.store.meta.facesKey || null, bundleKey = this.imageStore.lastLoadedKey || null;
    const alreadyPaired = !!(docKey && bundleKey && docKey === bundleKey);
    const nameChanged = (this.store.meta.facesFile || null) !== fh.name;
    this.store.meta.facesFile = fh.name;   // MÉMORISE le nom du compagnon → réouverture auto même si nom ≠ <json>.nmfb
    this.flog("associateCompanion", { file: fh.name, docKey, bundleKey, alreadyPaired, nameChanged, regenKey: !!opts.regenKey, images: this.imageStore.count() });
    if (opts.regenKey || !alreadyPaired) {
      this.store.meta.facesKey = "fk-" + Id.uid(); await this.store.persistMeta();
      try { await this.writeFacesToHandle(fh); } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Clé non écrite dans le compagnon : " + (e.message || e), "err"); }
      if (this.handle) { try { await this.writeToHandle(this.handle); } catch (e: any) { this.session.markDirty(); if (e && e.message !== "permission-refusée" && e.name !== "AbortError") Notify.toast("Clé non écrite dans le .json : " + (e.message || e), "err"); } }
      else this.session.markDirty();
    } else if (nameChanged) {   // déjà apparié (clé OK), seul le NOM du compagnon change → on persiste le nom dans le .json
      await this.store.persistMeta();
      if (this.handle) { try { await this.writeToHandle(this.handle); } catch (e: any) { this.session.markDirty(); if (e && e.message !== "permission-refusée" && e.name !== "AbortError") Notify.toast("Nom du compagnon non écrit dans le .json : " + (e.message || e), "err"); } }
      else this.session.markDirty();
    }
    this.imageStore.setLoadedKey(this.store.meta.facesKey || null);   // la bibliothèque en IndexedDB = ce document
    this.host.refreshChrome(); this.host.refreshActive(); Notify.toast("Images chargées → " + fh.name);
  }
  /** Charge interactivement un compagnon pour le document courant (génère toujours une nouvelle clé). */
  private async loadCompanionFileInteractive(): Promise<void> {
    if (!this.hasFsApi) return;
    try { const [fh] = await W.showOpenFilePicker({ startIn: this.handle || undefined, types: FACES_TYPES }); await this.associateCompanion(fh, { regenKey: true }); }
    catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Images non chargées : " + (e.message || e), "err"); }
  }
  /** « Ouvrir un fichier de faces » (onglet Images) : mode FICHIER → picker natif ; mode DOSSIER → liste les .nmfb du dossier. */
  async openFacesFile(): Promise<void> {
    this.flog("openFacesFile", { dirMode: this.dirMode(), dir: this.dirHandle && this.dirHandle.name });
    if (!this.hasFsApi) { Notify.toast("Indisponible : navigateur sans File System Access API.", "err"); return; }
    if (!this.dirMode()) { await this.loadCompanionFileInteractive(); return; }   // mode fichier → sélecteur de fichier
    let dir = this.dirHandle;
    if (!dir) { try { dir = await W.showDirectoryPicker({ id: "dc-manager-dir", mode: "readwrite", startIn: await this.startDirHandle() }); this.dirHandle = dir; } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Dossier non ouvert : " + (e.message || e), "err"); return; } }
    const names: string[] = [];
    try { for await (const entry of dir.values()) { if (entry.kind === "file" && /\.nmfb$/i.test(entry.name)) names.push(entry.name); } } catch (_) { /* énumération impossible */ }
    this.flog("openFacesFile: .nmfb du dossier", names);
    if (!names.length) { Notify.toast("Aucun fichier de faces (.nmfb) dans ce dossier.", "err"); return; }
    names.sort((a, b) => a.localeCompare(b));
    const name = (names.length === 1) ? names[0] : await this.chooseFileInDir(names, "Choisir un fichier de faces", "🖼");
    if (!name) return;
    try { const fh = await dir.getFileHandle(name); await this.associateCompanion(fh); }
    catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Images non chargées : " + (e.message || e), "err"); }
  }

  /* ---- IMPORT / EXPORT EXPLICITE de la BIBLIOTHÈQUE d'images (.nmfb) — portage manuel, disponible dans TOUS les
         modes (fichier ET API). Distinct du compagnon (mode fichier) qui, lui, s'apparie au document et s'enregistre
         automatiquement à côté du .json. Ici : un export téléchargeable + un import qui ÉCRASE la bibliothèque. ---- */
  /** EXPORT : télécharge toute la bibliothèque au format `.nmfb` (blobs hydratés, donc fonctionne aussi en REST). */
  async exportFacesLibrary(): Promise<void> {
    if (this.imageStore.count() === 0) { Notify.toast("Aucune image de façade à exporter.", "err"); return; }
    try {
      const blob = await this.imageStore.serializeBundle(this.store.meta.facesKey || null);
      const base = Download.safeName(this.store.meta.docName || "dc-manager");
      Download.blob(base + "-faces.nmfb", blob);
      Notify.toast(this.imageStore.count() + " image(s) exportée(s) → " + base + "-faces.nmfb");
    } catch (e: any) { Notify.toast("Export des images impossible : " + ((e && e.message) || e), "err"); }
  }
  /** IMPORT : ÉCRASE la bibliothèque par le contenu d'un `.nmfb` (ids conservés). Avertit AVANT : les références
      d'équipement vers des images absentes du fichier importé deviennent orphelines → faces à ré-assigner. */
  async importFacesLibrary(): Promise<void> {
    const existing = this.imageStore.count();
    const ok = await Dialog.confirm({
      title: "Importer des images (écrase la bibliothèque) ?",
      message: (existing ? `La bibliothèque actuelle (${existing} image(s)) sera ENTIÈREMENT REMPLACÉE par le contenu du fichier. ` : "")
        + "Les équipements dont l'image n'existe pas dans le fichier importé perdront leur face : il faudra RÉ-ASSIGNER ces faces ensuite. Continuer ?",
      confirmLabel: "Importer et écraser", cancelLabel: "Annuler", danger: true,
    });
    if (!ok) return;
    let buf: ArrayBuffer | null = null;
    if (this.hasFsApi) {
      try { const [fh] = await W.showOpenFilePicker({ startIn: this.handle || undefined, types: FACES_TYPES }); buf = await (await fh.getFile()).arrayBuffer(); }
      catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Fichier non ouvert : " + (e.message || e), "err"); return; }
    } else {
      const file = await new Promise<File | null>((resolve) => {
        const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".nmfb,application/octet-stream";
        inp.onchange = () => resolve((inp.files && inp.files[0]) || null); inp.click();
      });
      if (!file) return; buf = await file.arrayBuffer();
    }
    if (!buf) return;
    try {
      const n = await this.imageStore.importBundle(buf);   // remplace + conserve les ids + marque modifié
      this.host.refreshActive();
      Notify.toast(n + " image(s) importée(s). Ré-assignez les faces des équipements concernés.");
    } catch (e: any) { Notify.toast("Import des images impossible : " + ((e && e.message) || e), "err"); }
  }
  /** (Ré)écrit le compagnon. Sans handle connu, en demande un (suggéré à côté du .json). */
  private async saveCompanionFaces(jsonHandle: any): Promise<void> {
    if (!this.hasFsApi) return;
    if (!this.docHasFaceImages() && !this.facesHandle) return;   // rien à écrire
    this.ensureFacesKey();
    // nom cible = compagnon ASSOCIÉ (meta.facesFile) si présent, sinon convention <json>.nmfb
    const wantName = (this.store.meta.facesFile as string) || this.facesNameFor(jsonHandle ? jsonHandle.name : this.name);
    this.flog("saveCompanionFaces", { wantName, dirMode: this.dirMode(), dir: this.dirHandle && this.dirHandle.name, facesKey: this.store.meta.facesKey });
    try {
      if (this.dirMode() && this.dirHandle) this.facesHandle = await this.dirHandle.getFileHandle(wantName, { create: true });   // dans le dossier, sans picker
      else if (!this.facesHandle) this.facesHandle = await W.showSaveFilePicker({ suggestedName: wantName, startIn: jsonHandle || undefined, types: FACES_TYPES });
      await this.writeFacesToHandle(this.facesHandle); this.rememberFacesHandle(this.facesHandle);
      if (this.facesHandle && this.facesHandle.name) this.store.meta.facesFile = this.facesHandle.name;   // garde le nom à jour
      this.imageStore.setLoadedKey(this.store.meta.facesKey || null);
      this.flog("saveCompanionFaces → écrit", this.facesHandle && this.facesHandle.name);
    } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Images non enregistrées : " + (e.message || e), "err"); this.flog("saveCompanionFaces → échec", e && e.message); }
  }
  /** Charge le compagnon depuis `handle`. `interactive` autorise la (re)demande de permission (geste utilisateur) ;
      à false, ne charge QUE si la permission est DÉJÀ accordée (queryPermission → aucune question). Renvoie true si
      les images correspondant au document ont bien été chargées. */
  private async tryLoadCompanion(handle: any, interactive: boolean, docKey: string | null, stillMissing: () => boolean): Promise<boolean> {
    if (!handle) return false;
    const perm = await HandleStore.ensureReadPermission(handle, interactive);
    this.flog("tryLoadCompanion", { file: handle.name, interactive, perm, docKey });
    if (perm !== true) return false;   // null (= « prompt », non accordé) ou false (refusé) → pas de chargement
    try {
      const f = await handle.getFile(); await this.imageStore.loadBundle(await f.arrayBuffer());
      const bundleKey = this.imageStore.lastLoadedKey || null;
      const keyMatch = !!(docKey && bundleKey && docKey === bundleKey), legacyNoKey = (!docKey && !bundleKey);
      this.flog("tryLoadCompanion → bundle lu", { file: handle.name, bundleKey, keyMatch, legacyNoKey, images: this.imageStore.count() });
      if (keyMatch || (legacyNoKey && !stillMissing())) { this.facesHandle = handle; this.host.refreshActive(); return true; }
    } catch (e: any) { this.flog("tryLoadCompanion → illisible", handle.name, e && e.message); }
    return false;
  }
  /** À l'ouverture : recharge le compagnon SI le .json n'embarquait pas d'images inline. Ne POSE la question que si
      on ne peut PAS le faire automatiquement (permission déjà accordée). Si une interaction est requise (le navigateur
      exige un geste pour (re)donner l'accès), on réutilise le compagnon mémorisé (un simple « Recharger », sans
      re-sélection) ; sinon on propose de le choisir. */
  private async loadCompanionFacesOnOpen(jsonHandle: any): Promise<void> {
    const refIds = this.store.faceImageRefIds(), docKey = this.store.meta.facesKey || null;
    const stillMissing = () => [...refIds].some((id) => !this.imageStore.has(id));
    this.flog("loadCompanionFacesOnOpen", { docKey, refs: refIds.size, lastLoadedKey: this.imageStore.lastLoadedKey, images: this.imageStore.count(), dirMode: this.dirMode(), dir: this.dirHandle && this.dirHandle.name });
    if (!docKey && !refIds.size) { this.facesHandle = null; this.flog("compagnon: rien attendu"); return; }   // rien attendu
    if (docKey && this.imageStore.lastLoadedKey === docKey && this.imageStore.count() > 0 && !stillMissing()) { this.flog("compagnon: déjà à jour"); this.host.refreshActive(); return; }   // déjà à jour pour CE doc
    if (!docKey && !stillMissing()) { this.host.refreshActive(); return; }     // legacy : refs déjà présentes (inline)
    if (!this.hasFsApi) { this.host.refreshActive(); return; }
    // MODE DOSSIER : le grant du dossier couvre déjà le compagnon → lecture directe, sans permission ni question.
    if (this.dirMode() && this.dirHandle) {
      const savedName = (this.store.meta.facesFile as string) || null;   // nom mémorisé d'un compagnon associé (≠ convention)
      const wantName = this.facesNameFor(jsonHandle ? jsonHandle.name : this.name);
      // 1) essai par NOM : d'abord le nom mémorisé (meta.facesFile), puis la convention <json>.nmfb.
      const byName = [savedName, wantName].filter((n, i, a) => !!n && a.indexOf(n) === i) as string[];
      for (const nm of byName) {
        try {
          const fh = await this.dirHandle.getFileHandle(nm);
          this.flog("compagnon[dossier]: essai par nom", nm);
          if (await this.tryLoadCompanion(fh, false, docKey, stillMissing)) { this.flog("compagnon[dossier]: chargé par nom", nm); return; }
        } catch (_) { this.flog("compagnon[dossier]: pas de fichier nommé", nm); }
      }
      // 2) sinon, on SCANNE les .nmfb du dossier et on apparie par SIGNATURE (facesKey du manifeste == docKey).
      if (docKey) {
        try {
          for await (const entry of this.dirHandle.values()) {
            if (entry.kind !== "file" || !/\.nmfb$/i.test(entry.name) || byName.includes(entry.name)) continue;
            this.flog("compagnon[dossier]: essai par signature", entry.name);
            if (await this.tryLoadCompanion(entry, false, docKey, stillMissing)) {
              this.flog("compagnon[dossier]: apparié par signature", entry.name);
              this.store.meta.facesFile = entry.name; await this.store.persistMeta();   // mémorise le nom trouvé pour la prochaine fois
              return;
            }
          }
        } catch (e: any) { this.flog("compagnon[dossier]: scan échoué", e && e.message); }
      }
      this.flog("compagnon[dossier]: AUCUN compagnon correspondant trouvé dans", this.dirHandle.name);
      if (docKey && this.imageStore.lastLoadedKey && this.imageStore.lastLoadedKey !== docKey) { await this.imageStore.keepOnly(this.store.faceImageRefIds()); this.imageStore.setLoadedKey(null); }
      this.facesHandle = null; this.host.refreshActive(); return;
    }
    const rememberedMatches = docKey ? (this.imageStore.lastLoadedKey === docKey) : true;
    let remembered = rememberedMatches ? await this.handleStore.getFaces() : null;
    remembered = (remembered && remembered.handle) ? remembered : null;
    // 1) AUTOMATIQUE : permission DÉJÀ accordée (aucune (re)demande) → charge sans rien demander
    if (remembered && await this.tryLoadCompanion(remembered.handle, false, docKey, stillMissing)) return;
    // 2) compagnon mémorisé mais permission non accordée → on tente DIRECTEMENT le popup natif d'autorisation
    //    (si le geste d'ouverture est encore actif, c'est le SEUL prompt). On n'affiche notre confirmation
    //    « Recharger » QUE si le navigateur refuse de demander sans geste frais (perm indéterminée).
    if (remembered) {
      const dropStale = () => { if (docKey && this.imageStore.lastLoadedKey && this.imageStore.lastLoadedKey !== docKey) { void this.imageStore.keepOnly(this.store.faceImageRefIds()); this.imageStore.setLoadedKey(null); } };
      const perm = await HandleStore.ensureReadPermission(remembered.handle, true);   // popup natif direct (geste encore actif)
      if (perm === true) { if (await this.tryLoadCompanion(remembered.handle, false, docKey, stillMissing)) return; }   // accordée → charge sans re-demander
      else if (perm === null) {   // le navigateur exige un geste FRAIS → notre confirmation le fournit, puis on re-demande
        const ok = await Dialog.confirm({ title: "Images de façade", message: "Recharger les images de façade de ce document depuis « " + (remembered.name || this.facesNameFor(jsonHandle ? jsonHandle.name : this.name)) + " » ?", confirmLabel: "Recharger", cancelLabel: "Plus tard" });
        if (ok && await this.tryLoadCompanion(remembered.handle, true, docKey, stillMissing)) return;
        if (ok) Notify.toast("Images non rechargées (accès refusé).", "err");
      } else Notify.toast("Images non rechargées (accès refusé).", "err");   // perm === false : refus explicite → ne pas insister
      dropStale(); this.facesHandle = null; this.host.refreshActive(); return;
    }
    // 3) aucun compagnon mémorisé → proposer de le sélectionner (un seul picker)
    const ok = await Dialog.confirm({ title: "Images de façade", message: "Ce document est associé à un fichier compagnon d'images « " + this.facesNameFor(jsonHandle ? jsonHandle.name : this.name) + " ». Le sélectionner maintenant ?", confirmLabel: "Choisir le fichier…", cancelLabel: "Plus tard" });
    if (!ok) {
      if (docKey && this.imageStore.lastLoadedKey && this.imageStore.lastLoadedKey !== docKey) { await this.imageStore.keepOnly(this.store.faceImageRefIds()); this.imageStore.setLoadedKey(null); }
      this.facesHandle = null; this.host.refreshActive(); return;
    }
    try { const [fh] = await W.showOpenFilePicker({ startIn: jsonHandle || undefined, types: FACES_TYPES }); await this.associateCompanion(fh); }
    catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Images non chargées : " + (e.message || e), "err"); }
  }

  /* ---- réouverture / ouverture / enregistrement ---- */
  /** Réouverture en MODE DOSSIER : re-demande l'accès au dossier (un seul geste) puis relit le .json mémorisé. */
  private async reopenLastDir(dirRec: { handle: any; name: string }): Promise<void> {
    this.flog("reopenLastDir", { dir: dirRec.handle && dirRec.handle.name, json: dirRec.name });
    try {
      const granted = await this.ensureWritePermission(dirRec.handle);
      this.flog("reopenLastDir: permission dossier", granted);
      if (!granted) { Notify.toast("Autorisation du dossier refusée.", "err"); return; }
      const fh = await dirRec.handle.getFileHandle(dirRec.name);
      this.dirHandle = dirRec.handle;   // avant loadFromText → le compagnon est relu via le dossier
      await this.loadFromText(await (await fh.getFile()).text(), dirRec.name, fh);
      await this.rememberDir(dirRec.handle, dirRec.name);
      Notify.toast("Rouvert → " + dirRec.name);
    } catch (e: any) {
      if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err");
      else if (e && e.name === "NotFoundError") { await this.handleStore.clearDir(); this.host.setReopen(null); Notify.toast("Document introuvable dans le dossier — déplacé ou supprimé.", "err"); }
      else if (e && e.name !== "AbortError") Notify.toast("Erreur de réouverture : " + (e.message || e), "err");
    }
  }
  async reopenLast(): Promise<void> {
    if (this.dirMode()) { const d = await this.handleStore.getDir(); this.flog("reopenLast: mode dossier", { found: !!(d && d.handle), json: d && d.name }); if (d && d.handle && d.name) { await this.reopenLastDir(d as any); return; } }   // dossier mémorisé → réouverture dossier
    let rec = this.lastRec; if (!rec) rec = await this.handleStore.getLast();
    if (!rec || !rec.handle) { Notify.toast("Aucun fichier récent à rouvrir.", "err"); this.host.setReopen(null); return; }
    const handle = rec.handle;
    try {
      const perm = await HandleStore.ensureReadPermission(handle, true);
      if (perm === false) { Notify.toast("Autorisation de lecture refusée.", "err"); return; }
      const file = await handle.getFile();
      await this.loadFromText(await file.text(), handle.name, handle);   // revendique le fileId, raccroche le handle
      Notify.toast("Rouvert → " + handle.name);
    } catch (e: any) {
      if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err");
      else if (e && e.name === "NotFoundError") { await this.handleStore.clearLast(); this.lastRec = null; this.host.setReopen(null); Notify.toast("Fichier introuvable — déplacé ou supprimé.", "err"); }
      else if (e && e.name !== "AbortError") Notify.toast("Erreur de réouverture : " + (e.message || e), "err");
    }
  }
  /** En mode fichier (un .json est ouvert), « Ouvrir » propose : autre document JSON OU compagnon d'images. */
  private chooseOpenKind(): Promise<"json" | "companion" | null> {
    return Dialog.custom({
      title: "Ouvrir un fichier", cancelLabel: "Annuler",
      build: (root: HTMLElement) => {
        let chosen: string | null = null;
        const confirmBtn = root.closest(".dialog-box")?.querySelector('[data-dlg="confirm"]') as HTMLElement | null;
        if (confirmBtn) confirmBtn.style.display = "none";   // les choix résolvent eux-mêmes
        const wrap = document.createElement("div"); wrap.className = "open-kind-choices";
        const mk = (val: string, icon: string, label: string, desc: string) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "open-kind-btn";
          const ic = document.createElement("span"); ic.className = "ok-ic"; ic.textContent = icon;
          const tx = document.createElement("span"); tx.className = "ok-tx";
          const ti = document.createElement("span"); ti.className = "ok-title"; ti.textContent = label;
          const de = document.createElement("span"); de.className = "ok-desc"; de.textContent = desc;
          tx.append(ti, de); b.append(ic, tx);
          b.onclick = () => { chosen = val; confirmBtn?.click(); };
          wrap.appendChild(b);
        };
        mk("json", "📄", "Document JSON", "Ouvrir un autre document (remplace le document courant).");
        mk("companion", "🖼", "Fichier compagnon d'images", "Charger un .nmfb et l'associer au document courant.");
        root.appendChild(wrap);
        return { collect: () => chosen, validate: () => true };
      },
    });
  }
  /** Sélection d'un nom de fichier parmi une liste (mode dossier) — listing du contenu pertinent du dossier. */
  private chooseFileInDir(names: string[], title: string, icon: string): Promise<string | null> {
    return Dialog.custom({
      title, cancelLabel: "Annuler",
      build: (root: HTMLElement) => {
        let chosen: string | null = null;
        const confirmBtn = root.closest(".dialog-box")?.querySelector('[data-dlg="confirm"]') as HTMLElement | null;
        if (confirmBtn) confirmBtn.style.display = "none";
        const wrap = document.createElement("div"); wrap.className = "open-kind-choices";
        names.forEach((n) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "open-kind-btn";
          const ic = document.createElement("span"); ic.className = "ok-ic"; ic.textContent = icon;
          const tx = document.createElement("span"); tx.className = "ok-tx";
          const ti = document.createElement("span"); ti.className = "ok-title"; ti.textContent = n; tx.appendChild(ti);
          b.append(ic, tx); b.onclick = () => { chosen = n; confirmBtn?.click(); }; wrap.appendChild(b);
        });
        root.appendChild(wrap);
        return { collect: () => chosen, validate: () => true };
      },
    });
  }
  /** Dossier de DÉPART du sélecteur : dossier courant, sinon le dernier mémorisé (le navigateur y rouvre le picker). */
  private async startDirHandle(): Promise<any> {
    if (this.dirHandle) return this.dirHandle;
    try { const d = await this.handleStore.getDir(); return (d && d.handle) ? d.handle : undefined; } catch (_) { return undefined; }
  }
  /** Ouverture en MODE DOSSIER : un seul grant (lecture+écriture) couvre le .json choisi ET son compagnon .nmfb. */
  private async doOpenDir(): Promise<void> {
    let dir: any;
    const startIn = await this.startDirHandle();
    this.flog("doOpenDir: ouverture du sélecteur de dossier", { startIn: startIn && startIn.name });
    try { dir = await W.showDirectoryPicker({ id: "dc-manager-dir", mode: "readwrite", startIn }); }   // id + startIn → le navigateur rouvre dans le DERNIER dossier
    catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Dossier non ouvert : " + (e.message || e), "err"); this.flog("doOpenDir: annulé/erreur", e && e.name); return; }
    const names: string[] = [];
    try { for await (const entry of dir.values()) { if (entry.kind === "file" && /\.json$/i.test(entry.name)) names.push(entry.name); } }
    catch (_) { /* énumération impossible */ }
    this.flog("doOpenDir: dossier choisi", { dir: dir && dir.name, jsons: names });
    if (!names.length) { Notify.toast("Aucun fichier .json dans ce dossier.", "err"); return; }
    names.sort((a, b) => a.localeCompare(b));
    const name = (names.length === 1) ? names[0] : await this.chooseFileInDir(names, "Choisir un document", "📄");
    if (!name) return;
    try {
      const fh = await dir.getFileHandle(name);
      this.dirHandle = dir;   // posé AVANT loadFromText → loadCompanionFacesOnOpen lit le .nmfb via le dossier
      await this.loadFromText(await (await fh.getFile()).text(), name, fh);
      await this.rememberDir(dir, name);
      Notify.toast("Fichier « " + name + " » ouvert");
    } catch (e: any) {
      if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err");
      else if (e && e.name !== "AbortError") Notify.toast("Ouverture impossible : " + (e.message || e), "err");
    }
  }
  async doOpen(): Promise<void> {
    this.flog("doOpen", { hasFsApi: this.hasFsApi, dirMode: this.dirMode(), fileAccessMode: this.prefs.fileAccessMode });
    if (!this.hasFsApi) { this.fileInput.click(); return; }
    if (this.dirMode()) { await this.doOpenDir(); return; }
    if (this.handle) {   // un document est ouvert → choisir document JSON ou compagnon d'images
      const kind = await this.chooseOpenKind();
      if (!kind) return;
      if (kind === "companion") { await this.loadCompanionFileInteractive(); return; }
    }
    try {
      const [h] = await W.showOpenFilePicker({ types: JSON_TYPES, multiple: false });
      const f = await h.getFile();
      await this.loadFromText(await f.text(), f.name, h);
      Notify.toast("Fichier « " + f.name + " » ouvert");
    } catch (e: any) {
      if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err");
      else if (e && e.name !== "AbortError") Notify.toast("Ouverture impossible : " + (e.message || e), "err");
    }
  }
  async doSave(): Promise<void> {
    if (!this.handle) { await this.doSaveAs(); return; }
    if (this.docHasFaceImages()) this.ensureFacesKey();   // la clé d'appariement doit être dans le .json AVANT son écriture
    if (!(await this.ensureWritePermission(this.handle))) { Notify.toast("Permission d'écriture refusée.", "err"); return; }
    try { await this.writeToHandle(this.handle); await this.saveCompanionFaces(this.handle); this.host.refreshChrome(); Notify.toast("Document enregistré (" + this.name + ")"); }
    catch (e: any) { Notify.toast("Enregistrement échoué : " + (e.message || e), "err"); }
  }
  /** « Enregistrer sous » en MODE DOSSIER : choisit le dossier (s'il manque) + un nom, écrit .json et .nmfb dedans. */
  private async doSaveAsDir(): Promise<void> {
    let dir = this.dirHandle;
    if (!dir) { try { dir = await W.showDirectoryPicker({ id: "dc-manager-dir", mode: "readwrite", startIn: await this.startDirHandle() }); } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Dossier non choisi : " + (e.message || e), "err"); return; } }
    const raw = await Dialog.prompt("Nom du fichier", this.docFileName()); if (!raw) return;
    const name = /\.json$/i.test(raw) ? raw : raw + ".json";
    try {
      const h = await dir.getFileHandle(name, { create: true });
      if (this.docHasFaceImages()) this.ensureFacesKey();
      this.dirHandle = dir; this.handle = h; this.name = h.name || name; this.facesHandle = null; this.session.setFile(true);
      await this.writeToHandle(h);
      await this.saveCompanionFaces(h);
      await this.rememberDir(dir, name);
      this.tabChannel.claim(this.store.meta.fileId || null);
      this.host.applyAutosave(); this.host.refreshChrome(); Notify.toast("Enregistré sous « " + this.name + " »");
    } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Enregistrement échoué : " + (e.message || e), "err"); }
  }
  async doSaveAs(): Promise<void> {
    this.ensureFileId();
    if (!this.hasFsApi) { Download.text(this.docFileName(), await this.snapshotWithImages(), "application/json"); Notify.toast("Copie téléchargée (" + this.docFileName() + ")"); return; }
    if (this.dirMode()) { await this.doSaveAsDir(); return; }
    try {
      const h = await W.showSaveFilePicker({ suggestedName: this.docFileName(), types: JSON_TYPES });
      if (this.docHasFaceImages()) this.ensureFacesKey();   // clé d'appariement dans le .json
      this.handle = h; this.name = h.name || this.docFileName(); this.facesHandle = null; this.session.setFile(true);   // nouveau fichier → nouveau compagnon
      await this.writeToHandle(h);
      await this.saveCompanionFaces(h);   // choisit/écrit le fichier compagnon d'images à côté
      this.tabChannel.claim(this.store.meta.fileId || null);
      this.host.applyAutosave(); this.host.refreshChrome(); Notify.toast("Enregistré sous « " + this.name + " »");
    } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Enregistrement échoué : " + (e.message || e), "err"); }
  }
}

/* Point d'entrée. Monte le SHELL (topbar fichier/réglages + barre de statut + onglets +
   en-têtes de domaine), câble les vues de liste (ListView + ListConfigs + Forms), la
   topologie (GraphView) et un emplacement Datacenters (à porter). Bootstrap GLOBAL :
   préférences (thème / source de données / auto-save) via `Prefs`, opérations FICHIER
   (File System Access API quand dispo, sinon download/upload), auto-save périodique, et
   verrou d'ouverture exclusive multi-onglets (`TabChannel` sur BroadcastChannel). */
import "../styles/netmap.css";
import { EntityRegistry } from "../models";
import { BrowserStorageAdapter, RestAdapter } from "../data";
import { Store } from "../store";
import { readRuntimeConfig } from "./RuntimeConfig";
import { GraphView, ListView, ListConfigs, Forms, DatacenterView } from "../views";
import { ImageStore, IdbImageBackend, RestImageBackend } from "../data";
import type { ListOptions, FormHost } from "../views";
import { Modal, Notify, FormControls, Dialog, Fullscreen } from "../ui";
import { Html } from "../core/Html";
import { Id } from "../core/Id";
import { Prefs } from "../core/Prefs";
import { Log } from "../core/Log";
import { APP_RELEASE, EQUIP_FACE_IMG_FIELD } from "../domain/constants";
import { Shell } from "./Shell";
import type { ShellHost } from "./Shell";
import { SaveState, shouldAutosave } from "./SaveState";
import { TabChannel } from "./TabChannel";
import { HandleStore } from "./HandleStore";

// Timeline d'undo UNIFIÉE : le modèle (snapshots, adapter) et les images (ImageStore, opérations inverses) ont
// chacun leur pile, mais UN SEUL geste (bouton / Ctrl+Z) défait dans l'ordre chronologique. `undoOrder` mémorise la
// pile concernée par action ("model" | "image") ; toute NOUVELLE action vide le redo unifié. doUndo/doRedo (boot)
// dépilent la timeline et délèguent à la bonne pile (en sautant les jetons dont la pile est épuisée par le plafond).
const undoOrder: string[] = [];
const redoOrder: string[] = [];
let onTimelineChange: () => void = () => { /* posé au boot → refreshChrome */ };
function noteUndoable(kind: string): void { undoOrder.push(kind); if (undoOrder.length > 400) undoOrder.shift(); redoOrder.length = 0; try { onTimelineChange(); } catch (_) { /* noop */ } }
function resetUndoTimeline(): void { undoOrder.length = 0; redoOrder.length = 0; try { onTimelineChange(); } catch (_) { /* noop */ } }

// MODE D'EXÉCUTION : injecté par le backend (config) ou fichier par défaut (cf. docs/rest-migration.md).
const RUNTIME = readRuntimeConfig();
const REST_MODE = RUNTIME.mode === "api";
// API même origine, cookies SSO transmis (l'app NE gère PAS l'auth — le SSO valide).
const adapter = REST_MODE
  ? new RestAdapter({ baseUrl: RUNTIME.apiBaseUrl })
  : new BrowserStorageAdapter({ persistent: false, onUndoable: noteUndoable });
const store = new Store(adapter);
const prefs = new Prefs();
const W = window as any;
const HAS_FS_API = typeof W.showSaveFilePicker === "function" && typeof W.showOpenFilePicker === "function";
const JSON_TYPES = [{ description: "NetMap JSON", accept: { "application/json": [".json"] } }];
const FACES_TYPES = [{ description: "NetMap Faces (images)", accept: { "application/octet-stream": [".nmfb"] } }];   // fichier compagnon d'images

/** Le document est-il « non vide » (au-delà des seuls catalogues fermés réinjectés) ? */
function hasUserData(): boolean { return store.totalCount() > store.all("portTypes").length + store.all("cableTypes").length; }

function applyTheme(theme: string): void {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}
function docFileName(): string { return (store.meta.docName || "netmap").replace(/[\\/:*?"<>|]+/g, "_") + ".json"; }
function downloadJson(filename: string, content: string): void {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function boot(): Promise<void> {
  await store.init();
  // En mode API, le SERVEUR fait autorité : on N'ENSEMENCE PAS (un newDocument pousserait un /snapshot
  // qui écraserait la base). En mode fichier, on sème le document par défaut si rien n'a été restauré.
  if (!store.restored && !REST_MODE) await store.newDocument();
  applyTheme(prefs.theme);

  const root = document.getElementById("app");
  if (!root) return;

  // ---- état FICHIER / session ----
  let currentHandle: any = null;        // FileSystemFileHandle lié (FS API) — null = download/mémoire
  let currentFacesHandle: any = null;   // handle du fichier compagnon d'images (.nmfb) du document courant
  let currentDirHandle: any = null;     // mode « accès dossier » : handle du DOSSIER courant (couvre .json + .nmfb)
  let currentName = "";                 // nom du fichier lié
  const session = new SaveState();      // suivi dirty/save (révision modèle vs dernière sauvegarde + meta/images)
  let booted = false;                   // garde : ne suit pas la révision pendant le chargement initial
  let autosaveTimer: any = null;

  const tabChannel = new TabChannel({
    enabled: HAS_FS_API && !REST_MODE,   // verrou inter-onglets = concept FICHIER ; en mode API le serveur arbitre (cf. P3)
    onConflict: () => Notify.toast("Ce fichier est aussi ouvert dans un autre onglet.", "err"),
  });
  const handleStore = new HandleStore();
  let lastRec: { handle: any; name: string } | null = null;   // dernier fichier mémorisé (réouverture)
  const ensureFileId = (): string => { if (!store.meta.fileId) { store.meta.fileId = Id.uid(); store.persistMeta(); } return store.meta.fileId; };
  const rememberHandle = (handle: any, name: string) => { if (!handle) return; lastRec = { handle, name: name || handle.name || "" }; void handleStore.putLast(handle, lastRec.name); };
  /** Mode « accès dossier » actif (réglage + FS API) : un seul grant de dossier couvre le .json et son compagnon .nmfb. */
  const dirMode = (): boolean => prefs.fileAccessMode === "directory" && HAS_FS_API;
  /** Trace des opérations fichier / compagnon — gated par le flag de débogage (Log). */
  const flog = Log.scope("fs");
  const rememberDir = async (dir: any, jsonName: string): Promise<void> => { currentDirHandle = dir; await handleStore.putDir(dir, jsonName); flog("rememberDir → dossier mémorisé", { dir: dir && dir.name, json: jsonName }); };

  const modal = new Modal();
  const formHost: FormHost = { openModal: (o) => modal.open(o), setDirty: () => { refreshChrome(); } };   // mutation modèle déjà suivie par la révision (store.onChange)
  // bibliothèque d'images de façade (hors modèle : IndexedDB + miroir mémoire)
  // backend d'images selon le mode : IndexedDB (fichier, + compagnon .nmfb) · endpoints blob (REST). Cf. P2.
  const imageBackend = REST_MODE ? new RestImageBackend(RUNTIME.apiBaseUrl) : new IdbImageBackend();
  const imageStore = new ImageStore({ onDirty: () => { session.markDirty(); refreshChrome(); shell.refreshActive(); }, onUndoable: noteUndoable, backend: imageBackend });   // images HORS historique modèle, undo intégré à la timeline unifiée
  Forms.images = imageStore;   // singleton pour le picker d'image (faceEditor)
  imageStore.restoreLoadedKey();   // clé du bundle .nmfb actuellement en IndexedDB (persistée) — appariement json↔compagnon
  if (!REST_MODE) await imageStore.ready();   // en REST, le miroir est chargé à l'ouverture d'un document
  let restDocId: string | null = null;   // document serveur courant (mode API)
  Fullscreen.install();   // re-parente les overlays (modale/dialogues/toasts/menus) dans l'élément plein écran

  // ---- caché : input d'import (navigateurs sans File System Access API) ----
  const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.accept = ".json,application/json"; fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0]; fileInput.value = "";
    if (!f) return;
    try { await loadFromText(await f.text(), f.name, null); Notify.toast("Fichier « " + f.name + " » chargé"); }
    catch (e: any) { if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err"); else Notify.toast("Fichier invalide (JSON attendu).", "err"); }
  });

  // ---- chargement d'un document depuis du texte JSON (revendique le verrou AVANT mutation) ----
  async function loadFromText(text: string, name: string | null, handle: any): Promise<void> {
    const raw = JSON.parse(text);
    flog("loadFromText", { name, handle: handle && handle.name, inlineImages: Array.isArray(raw.faceImages), facesKey: raw && raw.meta && raw.meta.facesKey, dirMode: dirMode() });
    const incomingFileId = (raw && raw.meta && typeof raw.meta.fileId === "string" && raw.meta.fileId) ? raw.meta.fileId : null;
    await tabChannel.claimIncoming(incomingFileId, store.meta.fileId || null);   // throw FILE_ALREADY_OPEN si occupé
    await store.replaceAll(raw);
    // images de façade : embarquées inline (faceImages) → import dans l'ImageStore ; sinon document sans images
    if (Array.isArray(raw.faceImages)) await imageStore.replaceAllFromLegacy(raw.faceImages);
    else await imageStore.clearAll();
    resetUndoTimeline();   // nouveau document chargé → timeline d'undo unifiée repart de zéro
    currentHandle = handle || null; currentFacesHandle = null; currentName = name || "";
    if (!store.meta.docName && name) { store.meta.docName = name.replace(/\.json$/i, ""); await store.persistMeta(); }
    tabChannel.claim(store.meta.fileId || null);
    if (handle) rememberHandle(handle, name || handle.name || "");
    applyTheme(prefs.theme); session.setFile(!!(currentHandle && HAS_FS_API)); session.markLoaded(store.histIndex());
    if (!Array.isArray(raw.faceImages)) await loadCompanionFacesOnOpen(handle);   // .json sans images inline → recharge le compagnon .nmfb (auto si mémorisé)
    shell.hideWelcome(); shell.switchView("equipements"); applyAutosave(); refreshChrome();
  }

  /* ---- File System Access : permission, écriture, ouverture, enregistrement ---- */
  async function ensureWritePermission(handle: any): Promise<boolean> {
    if (!handle || !handle.queryPermission) return true;
    if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  }
  /** Sérialisation AVEC images de façade inline (document AUTONOME : survit au save/load et au transfert).
      Les images vivent hors modèle (IndexedDB) ; on les embarque dans le `.json` pour ne rien perdre.
      (Le compagnon `.nmfb` séparé — optimisation de taille — reste différé ; `ImageStore` est prêt.) */
  /** Sérialisation FS : `.json` SANS images (les images vivent dans le compagnon `.nmfb` à côté). */
  function serializeJson(): string { return JSON.stringify(store.toJSON(), null, 2); }
  /** Repli DOWNLOAD (navigateur sans File System Access API) : fichier AUTONOME, images embarquées inline
      (aucun compagnon n'est possible sans handle FS → on ne perd rien). */
  async function snapshotWithImages(): Promise<string> {
    const obj: any = store.toJSON();
    if (imageStore.count() > 0) obj.faceImages = await imageStore.toLegacyArray();
    return JSON.stringify(obj, null, 2);
  }
  async function writeToHandle(handle: any): Promise<void> {
    ensureFileId();
    const w = await handle.createWritable(); await w.write(serializeJson()); await w.close();
    session.markSaved(); rememberHandle(handle, handle.name || currentName);
  }

  /* ---- FICHIER COMPAGNON d'images (.nmfb) — dissocié du modèle, apparié au .json par meta.facesKey ---- */
  const facesNameFor = (jsonName: string): string => String(jsonName || "netmap.json").replace(/\.json$/i, "") + ".nmfb";
  const rememberFacesHandle = (handle: any) => { if (handle) void handleStore.putFaces(handle, handle.name || ""); };
  async function writeFacesToHandle(handle: any): Promise<void> {
    if (!(await ensureWritePermission(handle))) throw new Error("permission-refusée");
    const blob = await imageStore.serializeBundle(store.meta.facesKey || null);
    const w = await handle.createWritable(); await w.write(blob); await w.close();
  }
  /** Clé d'appariement json↔compagnon : générée dès qu'un document a des images ; gravée dans meta.facesKey
      (sérialisée dans le .json) ET dans le manifeste du .nmfb. */
  function ensureFacesKey(): string { if (!store.meta.facesKey) { store.meta.facesKey = "fk-" + Id.uid(); void store.persistMeta(); } return store.meta.facesKey; }
  /** Le document a-t-il des images (bibliothèque chargée OU références d'équipement) ? Justifie un compagnon + une clé. */
  const docHasFaceImages = (): boolean => imageStore.count() > 0 || store.faceImageRefIds().size > 0;
  /** Associe un compagnon sélectionné au document : charge ses images, puis (si demandé ou clé non concordante)
      génère une NOUVELLE clé et la ré-écrit dans le .nmfb ET le .json (appariement durable). */
  async function associateCompanion(fh: any, opts: { regenKey?: boolean } = {}): Promise<void> {
    const f = await fh.getFile();
    await imageStore.loadBundle(await f.arrayBuffer());
    currentFacesHandle = fh; rememberFacesHandle(fh);
    const docKey = store.meta.facesKey || null, bundleKey = imageStore.lastLoadedKey || null;
    const alreadyPaired = !!(docKey && bundleKey && docKey === bundleKey);
    const nameChanged = (store.meta.facesFile || null) !== fh.name;
    store.meta.facesFile = fh.name;   // MÉMORISE le nom du compagnon → réouverture auto même si nom ≠ <json>.nmfb
    flog("associateCompanion", { file: fh.name, docKey, bundleKey, alreadyPaired, nameChanged, regenKey: !!opts.regenKey, images: imageStore.count() });
    if (opts.regenKey || !alreadyPaired) {
      store.meta.facesKey = "fk-" + Id.uid(); await store.persistMeta();
      try { await writeFacesToHandle(fh); } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Clé non écrite dans le compagnon : " + (e.message || e), "err"); }
      if (currentHandle) { try { await writeToHandle(currentHandle); } catch (e: any) { session.markDirty(); if (e && e.message !== "permission-refusée" && e.name !== "AbortError") Notify.toast("Clé non écrite dans le .json : " + (e.message || e), "err"); } }
      else session.markDirty();
    } else if (nameChanged) {   // déjà apparié (clé OK), seul le NOM du compagnon change → on persiste le nom dans le .json
      await store.persistMeta();
      if (currentHandle) { try { await writeToHandle(currentHandle); } catch (e: any) { session.markDirty(); if (e && e.message !== "permission-refusée" && e.name !== "AbortError") Notify.toast("Nom du compagnon non écrit dans le .json : " + (e.message || e), "err"); } }
      else session.markDirty();
    }
    imageStore.setLoadedKey(store.meta.facesKey || null);   // la bibliothèque en IndexedDB = ce document
    refreshChrome(); shell.refreshActive(); Notify.toast("Images chargées → " + fh.name);
  }
  /** Charge interactivement un compagnon pour le document courant (génère toujours une nouvelle clé). */
  async function loadCompanionFileInteractive(): Promise<void> {
    if (!HAS_FS_API) return;
    try { const [fh] = await W.showOpenFilePicker({ startIn: currentHandle || undefined, types: FACES_TYPES }); await associateCompanion(fh, { regenKey: true }); }
    catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Images non chargées : " + (e.message || e), "err"); }
  }
  /** « Ouvrir un fichier de faces » (onglet Images) : mode FICHIER → picker natif ; mode DOSSIER → liste les .nmfb du dossier. */
  async function openFacesFile(): Promise<void> {
    flog("openFacesFile", { dirMode: dirMode(), dir: currentDirHandle && currentDirHandle.name });
    if (!HAS_FS_API) { Notify.toast("Indisponible : navigateur sans File System Access API.", "err"); return; }
    if (!dirMode()) { await loadCompanionFileInteractive(); return; }   // mode fichier → sélecteur de fichier
    let dir = currentDirHandle;
    if (!dir) { try { dir = await W.showDirectoryPicker({ id: "netmap-dir", mode: "readwrite", startIn: await startDirHandle() }); currentDirHandle = dir; } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Dossier non ouvert : " + (e.message || e), "err"); return; } }
    const names: string[] = [];
    try { for await (const entry of dir.values()) { if (entry.kind === "file" && /\.nmfb$/i.test(entry.name)) names.push(entry.name); } } catch (_) { /* énumération impossible */ }
    flog("openFacesFile: .nmfb du dossier", names);
    if (!names.length) { Notify.toast("Aucun fichier de faces (.nmfb) dans ce dossier.", "err"); return; }
    names.sort((a, b) => a.localeCompare(b));
    const name = (names.length === 1) ? names[0] : await chooseFileInDir(names, "Choisir un fichier de faces", "🖼");
    if (!name) return;
    try { const fh = await dir.getFileHandle(name); await associateCompanion(fh); }
    catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Images non chargées : " + (e.message || e), "err"); }
  }
  /** (Ré)écrit le compagnon. Sans handle connu, en demande un (suggéré à côté du .json). */
  async function saveCompanionFaces(jsonHandle: any): Promise<void> {
    if (!HAS_FS_API) return;
    if (!docHasFaceImages() && !currentFacesHandle) return;   // rien à écrire
    ensureFacesKey();
    // nom cible = compagnon ASSOCIÉ (meta.facesFile) si présent, sinon convention <json>.nmfb
    const wantName = (store.meta.facesFile as string) || facesNameFor(jsonHandle ? jsonHandle.name : currentName);
    flog("saveCompanionFaces", { wantName, dirMode: dirMode(), dir: currentDirHandle && currentDirHandle.name, facesKey: store.meta.facesKey });
    try {
      if (dirMode() && currentDirHandle) currentFacesHandle = await currentDirHandle.getFileHandle(wantName, { create: true });   // dans le dossier, sans picker
      else if (!currentFacesHandle) currentFacesHandle = await W.showSaveFilePicker({ suggestedName: wantName, startIn: jsonHandle || undefined, types: FACES_TYPES });
      await writeFacesToHandle(currentFacesHandle); rememberFacesHandle(currentFacesHandle);
      if (currentFacesHandle && currentFacesHandle.name) store.meta.facesFile = currentFacesHandle.name;   // garde le nom à jour
      imageStore.setLoadedKey(store.meta.facesKey || null);
      flog("saveCompanionFaces → écrit", currentFacesHandle && currentFacesHandle.name);
    } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Images non enregistrées : " + (e.message || e), "err"); flog("saveCompanionFaces → échec", e && e.message); }
  }
  /** Charge le compagnon depuis `handle`. `interactive` autorise la (re)demande de permission (geste utilisateur) ;
      à false, ne charge QUE si la permission est DÉJÀ accordée (queryPermission → aucune question). Renvoie true si
      les images correspondant au document ont bien été chargées. */
  async function tryLoadCompanion(handle: any, interactive: boolean, docKey: string | null, stillMissing: () => boolean): Promise<boolean> {
    if (!handle) return false;
    const perm = await HandleStore.ensureReadPermission(handle, interactive);
    flog("tryLoadCompanion", { file: handle.name, interactive, perm, docKey });
    if (perm !== true) return false;   // null (= « prompt », non accordé) ou false (refusé) → pas de chargement
    try {
      const f = await handle.getFile(); await imageStore.loadBundle(await f.arrayBuffer());
      const bundleKey = imageStore.lastLoadedKey || null;
      const keyMatch = !!(docKey && bundleKey && docKey === bundleKey), legacyNoKey = (!docKey && !bundleKey);
      flog("tryLoadCompanion → bundle lu", { file: handle.name, bundleKey, keyMatch, legacyNoKey, images: imageStore.count() });
      if (keyMatch || (legacyNoKey && !stillMissing())) { currentFacesHandle = handle; shell.refreshActive(); return true; }
    } catch (e: any) { flog("tryLoadCompanion → illisible", handle.name, e && e.message); }
    return false;
  }
  /** À l'ouverture : recharge le compagnon SI le .json n'embarquait pas d'images inline. Ne POSE la question que si
      on ne peut PAS le faire automatiquement (permission déjà accordée). Si une interaction est requise (le navigateur
      exige un geste pour (re)donner l'accès), on réutilise le compagnon mémorisé (un simple « Recharger », sans
      re-sélection) ; sinon on propose de le choisir. */
  async function loadCompanionFacesOnOpen(jsonHandle: any): Promise<void> {
    const refIds = store.faceImageRefIds(), docKey = store.meta.facesKey || null;
    const stillMissing = () => [...refIds].some((id) => !imageStore.has(id));
    flog("loadCompanionFacesOnOpen", { docKey, refs: refIds.size, lastLoadedKey: imageStore.lastLoadedKey, images: imageStore.count(), dirMode: dirMode(), dir: currentDirHandle && currentDirHandle.name });
    if (!docKey && !refIds.size) { currentFacesHandle = null; flog("compagnon: rien attendu"); return; }   // rien attendu
    if (docKey && imageStore.lastLoadedKey === docKey && imageStore.count() > 0 && !stillMissing()) { flog("compagnon: déjà à jour"); shell.refreshActive(); return; }   // déjà à jour pour CE doc
    if (!docKey && !stillMissing()) { shell.refreshActive(); return; }     // legacy : refs déjà présentes (inline)
    if (!HAS_FS_API) { shell.refreshActive(); return; }
    // MODE DOSSIER : le grant du dossier couvre déjà le compagnon → lecture directe, sans permission ni question.
    if (dirMode() && currentDirHandle) {
      const savedName = (store.meta.facesFile as string) || null;   // nom mémorisé d'un compagnon associé (≠ convention)
      const wantName = facesNameFor(jsonHandle ? jsonHandle.name : currentName);
      // 1) essai par NOM : d'abord le nom mémorisé (meta.facesFile), puis la convention <json>.nmfb.
      const byName = [savedName, wantName].filter((n, i, a) => !!n && a.indexOf(n) === i) as string[];
      for (const nm of byName) {
        try {
          const fh = await currentDirHandle.getFileHandle(nm);
          flog("compagnon[dossier]: essai par nom", nm);
          if (await tryLoadCompanion(fh, false, docKey, stillMissing)) { flog("compagnon[dossier]: chargé par nom", nm); return; }
        } catch (_) { flog("compagnon[dossier]: pas de fichier nommé", nm); }
      }
      // 2) sinon, on SCANNE les .nmfb du dossier et on apparie par SIGNATURE (facesKey du manifeste == docKey).
      if (docKey) {
        try {
          for await (const entry of currentDirHandle.values()) {
            if (entry.kind !== "file" || !/\.nmfb$/i.test(entry.name) || byName.includes(entry.name)) continue;
            flog("compagnon[dossier]: essai par signature", entry.name);
            if (await tryLoadCompanion(entry, false, docKey, stillMissing)) {
              flog("compagnon[dossier]: apparié par signature", entry.name);
              store.meta.facesFile = entry.name; await store.persistMeta();   // mémorise le nom trouvé pour la prochaine fois
              return;
            }
          }
        } catch (e: any) { flog("compagnon[dossier]: scan échoué", e && e.message); }
      }
      flog("compagnon[dossier]: AUCUN compagnon correspondant trouvé dans", currentDirHandle.name);
      if (docKey && imageStore.lastLoadedKey && imageStore.lastLoadedKey !== docKey) { await imageStore.keepOnly(store.faceImageRefIds()); imageStore.setLoadedKey(null); }
      currentFacesHandle = null; shell.refreshActive(); return;
    }
    const rememberedMatches = docKey ? (imageStore.lastLoadedKey === docKey) : true;
    let remembered = rememberedMatches ? await handleStore.getFaces() : null;
    remembered = (remembered && remembered.handle) ? remembered : null;
    // 1) AUTOMATIQUE : permission DÉJÀ accordée (aucune (re)demande) → charge sans rien demander
    if (remembered && await tryLoadCompanion(remembered.handle, false, docKey, stillMissing)) return;
    // 2) compagnon mémorisé mais permission non accordée → on tente DIRECTEMENT le popup natif d'autorisation
    //    (si le geste d'ouverture est encore actif, c'est le SEUL prompt). On n'affiche notre confirmation
    //    « Recharger » QUE si le navigateur refuse de demander sans geste frais (perm indéterminée).
    if (remembered) {
      const dropStale = () => { if (docKey && imageStore.lastLoadedKey && imageStore.lastLoadedKey !== docKey) { void imageStore.keepOnly(store.faceImageRefIds()); imageStore.setLoadedKey(null); } };
      const perm = await HandleStore.ensureReadPermission(remembered.handle, true);   // popup natif direct (geste encore actif)
      if (perm === true) { if (await tryLoadCompanion(remembered.handle, false, docKey, stillMissing)) return; }   // accordée → charge sans re-demander
      else if (perm === null) {   // le navigateur exige un geste FRAIS → notre confirmation le fournit, puis on re-demande
        const ok = await Dialog.confirm({ title: "Images de façade", message: "Recharger les images de façade de ce document depuis « " + (remembered.name || facesNameFor(jsonHandle ? jsonHandle.name : currentName)) + " » ?", confirmLabel: "Recharger", cancelLabel: "Plus tard" });
        if (ok && await tryLoadCompanion(remembered.handle, true, docKey, stillMissing)) return;
        if (ok) Notify.toast("Images non rechargées (accès refusé).", "err");
      } else Notify.toast("Images non rechargées (accès refusé).", "err");   // perm === false : refus explicite → ne pas insister
      dropStale(); currentFacesHandle = null; shell.refreshActive(); return;
    }
    // 3) aucun compagnon mémorisé → proposer de le sélectionner (un seul picker)
    const ok = await Dialog.confirm({ title: "Images de façade", message: "Ce document est associé à un fichier compagnon d'images « " + facesNameFor(jsonHandle ? jsonHandle.name : currentName) + " ». Le sélectionner maintenant ?", confirmLabel: "Choisir le fichier…", cancelLabel: "Plus tard" });
    if (!ok) {
      if (docKey && imageStore.lastLoadedKey && imageStore.lastLoadedKey !== docKey) { await imageStore.keepOnly(store.faceImageRefIds()); imageStore.setLoadedKey(null); }
      currentFacesHandle = null; shell.refreshActive(); return;
    }
    try { const [fh] = await W.showOpenFilePicker({ startIn: jsonHandle || undefined, types: FACES_TYPES }); await associateCompanion(fh); }
    catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Images non chargées : " + (e.message || e), "err"); }
  }
  /** Réouverture en MODE DOSSIER : re-demande l'accès au dossier (un seul geste) puis relit le .json mémorisé. */
  async function reopenLastDir(dirRec: { handle: any; name: string }): Promise<void> {
    flog("reopenLastDir", { dir: dirRec.handle && dirRec.handle.name, json: dirRec.name });
    try {
      const granted = await ensureWritePermission(dirRec.handle);
      flog("reopenLastDir: permission dossier", granted);
      if (!granted) { Notify.toast("Autorisation du dossier refusée.", "err"); return; }
      const fh = await dirRec.handle.getFileHandle(dirRec.name);
      currentDirHandle = dirRec.handle;   // avant loadFromText → le compagnon est relu via le dossier
      await loadFromText(await (await fh.getFile()).text(), dirRec.name, fh);
      await rememberDir(dirRec.handle, dirRec.name);
      Notify.toast("Rouvert → " + dirRec.name);
    } catch (e: any) {
      if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err");
      else if (e && e.name === "NotFoundError") { await handleStore.clearDir(); shell.setReopen(null); Notify.toast("Document introuvable dans le dossier — déplacé ou supprimé.", "err"); }
      else if (e && e.name !== "AbortError") Notify.toast("Erreur de réouverture : " + (e.message || e), "err");
    }
  }
  async function reopenLast(): Promise<void> {
    if (dirMode()) { const d = await handleStore.getDir(); flog("reopenLast: mode dossier", { found: !!(d && d.handle), json: d && d.name }); if (d && d.handle && d.name) { await reopenLastDir(d as any); return; } }   // dossier mémorisé → réouverture dossier
    let rec = lastRec; if (!rec) rec = await handleStore.getLast();
    if (!rec || !rec.handle) { Notify.toast("Aucun fichier récent à rouvrir.", "err"); shell.setReopen(null); return; }
    const handle = rec.handle;
    try {
      const perm = await HandleStore.ensureReadPermission(handle, true);
      if (perm === false) { Notify.toast("Autorisation de lecture refusée.", "err"); return; }
      const file = await handle.getFile();
      await loadFromText(await file.text(), handle.name, handle);   // revendique le fileId, raccroche le handle
      Notify.toast("Rouvert → " + handle.name);
    } catch (e: any) {
      if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err");
      else if (e && e.name === "NotFoundError") { await handleStore.clearLast(); lastRec = null; shell.setReopen(null); Notify.toast("Fichier introuvable — déplacé ou supprimé.", "err"); }
      else if (e && e.name !== "AbortError") Notify.toast("Erreur de réouverture : " + (e.message || e), "err");
    }
  }
  /** En mode fichier (un .json est ouvert), « Ouvrir » propose : autre document JSON OU compagnon d'images. */
  function chooseOpenKind(): Promise<"json" | "companion" | null> {
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
  function chooseFileInDir(names: string[], title: string, icon: string): Promise<string | null> {
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
  async function startDirHandle(): Promise<any> {
    if (currentDirHandle) return currentDirHandle;
    try { const d = await handleStore.getDir(); return (d && d.handle) ? d.handle : undefined; } catch (_) { return undefined; }
  }
  /** Ouverture en MODE DOSSIER : un seul grant (lecture+écriture) couvre le .json choisi ET son compagnon .nmfb. */
  async function doOpenDir(): Promise<void> {
    let dir: any;
    const startIn = await startDirHandle();
    flog("doOpenDir: ouverture du sélecteur de dossier", { startIn: startIn && startIn.name });
    try { dir = await W.showDirectoryPicker({ id: "netmap-dir", mode: "readwrite", startIn }); }   // id + startIn → le navigateur rouvre dans le DERNIER dossier
    catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Dossier non ouvert : " + (e.message || e), "err"); flog("doOpenDir: annulé/erreur", e && e.name); return; }
    const names: string[] = [];
    try { for await (const entry of dir.values()) { if (entry.kind === "file" && /\.json$/i.test(entry.name)) names.push(entry.name); } }
    catch (_) { /* énumération impossible */ }
    flog("doOpenDir: dossier choisi", { dir: dir && dir.name, jsons: names });
    if (!names.length) { Notify.toast("Aucun fichier .json dans ce dossier.", "err"); return; }
    names.sort((a, b) => a.localeCompare(b));
    const name = (names.length === 1) ? names[0] : await chooseFileInDir(names, "Choisir un document", "📄");
    if (!name) return;
    try {
      const fh = await dir.getFileHandle(name);
      currentDirHandle = dir;   // posé AVANT loadFromText → loadCompanionFacesOnOpen lit le .nmfb via le dossier
      await loadFromText(await (await fh.getFile()).text(), name, fh);
      await rememberDir(dir, name);
      Notify.toast("Fichier « " + name + " » ouvert");
    } catch (e: any) {
      if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err");
      else if (e && e.name !== "AbortError") Notify.toast("Ouverture impossible : " + (e.message || e), "err");
    }
  }
  async function doOpen(): Promise<void> {
    flog("doOpen", { hasFsApi: HAS_FS_API, dirMode: dirMode(), fileAccessMode: prefs.fileAccessMode });
    if (!HAS_FS_API) { fileInput.click(); return; }
    if (dirMode()) { await doOpenDir(); return; }
    if (currentHandle) {   // un document est ouvert → choisir document JSON ou compagnon d'images
      const kind = await chooseOpenKind();
      if (!kind) return;
      if (kind === "companion") { await loadCompanionFileInteractive(); return; }
    }
    try {
      const [h] = await W.showOpenFilePicker({ types: JSON_TYPES, multiple: false });
      const f = await h.getFile();
      await loadFromText(await f.text(), f.name, h);
      Notify.toast("Fichier « " + f.name + " » ouvert");
    } catch (e: any) {
      if (e && e.code === "FILE_ALREADY_OPEN") Notify.toast(e.message, "err");
      else if (e && e.name !== "AbortError") Notify.toast("Ouverture impossible : " + (e.message || e), "err");
    }
  }
  async function doSave(): Promise<void> {
    if (!currentHandle) { await doSaveAs(); return; }
    if (docHasFaceImages()) ensureFacesKey();   // la clé d'appariement doit être dans le .json AVANT son écriture
    if (!(await ensureWritePermission(currentHandle))) { Notify.toast("Permission d'écriture refusée.", "err"); return; }
    try { await writeToHandle(currentHandle); await saveCompanionFaces(currentHandle); refreshChrome(); Notify.toast("Document enregistré (" + currentName + ")"); }
    catch (e: any) { Notify.toast("Enregistrement échoué : " + (e.message || e), "err"); }
  }
  /** « Enregistrer sous » en MODE DOSSIER : choisit le dossier (s'il manque) + un nom, écrit .json et .nmfb dedans. */
  async function doSaveAsDir(): Promise<void> {
    let dir = currentDirHandle;
    if (!dir) { try { dir = await W.showDirectoryPicker({ id: "netmap-dir", mode: "readwrite", startIn: await startDirHandle() }); } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Dossier non choisi : " + (e.message || e), "err"); return; } }
    const raw = await Dialog.prompt("Nom du fichier", docFileName()); if (!raw) return;
    const name = /\.json$/i.test(raw) ? raw : raw + ".json";
    try {
      const h = await dir.getFileHandle(name, { create: true });
      if (docHasFaceImages()) ensureFacesKey();
      currentDirHandle = dir; currentHandle = h; currentName = h.name || name; currentFacesHandle = null; session.setFile(true);
      await writeToHandle(h);
      await saveCompanionFaces(h);
      await rememberDir(dir, name);
      tabChannel.claim(store.meta.fileId || null);
      applyAutosave(); refreshChrome(); Notify.toast("Enregistré sous « " + currentName + " »");
    } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Enregistrement échoué : " + (e.message || e), "err"); }
  }
  async function doSaveAs(): Promise<void> {
    ensureFileId();
    if (!HAS_FS_API) { downloadJson(docFileName(), await snapshotWithImages()); Notify.toast("Copie téléchargée (" + docFileName() + ")"); return; }
    if (dirMode()) { await doSaveAsDir(); return; }
    try {
      const h = await W.showSaveFilePicker({ suggestedName: docFileName(), types: JSON_TYPES });
      if (docHasFaceImages()) ensureFacesKey();   // clé d'appariement dans le .json
      currentHandle = h; currentName = h.name || docFileName(); currentFacesHandle = null; session.setFile(true);   // nouveau fichier → nouveau compagnon
      await writeToHandle(h);
      await saveCompanionFaces(h);   // choisit/écrit le fichier compagnon d'images à côté
      tabChannel.claim(store.meta.fileId || null);
      applyAutosave(); refreshChrome(); Notify.toast("Enregistré sous « " + currentName + " »");
    } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Enregistrement échoué : " + (e.message || e), "err"); }
  }

  /* ---- auto-save : timer d'écriture silencieuse (FS API + fichier lié requis) ---- */
  function autosaveStatusHtml(): string {
    if (!HAS_FS_API) return "Indisponible — navigateur sans <strong>File System Access API</strong>.";
    if (!prefs.autosave) return "État : <strong>off</strong>.";
    if (!currentHandle) return "État : <strong>en attente d'un fichier</strong> — démarrera à la prochaine (ré)ouverture.";
    return "État : <strong>actif</strong> · toutes les <strong>" + prefs.autosaveInterval + "s</strong>.";
  }
  function applyAutosave(): void {
    if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
    if (prefs.autosave && currentHandle && HAS_FS_API) {
      autosaveTimer = setInterval(async () => {
        if (!shouldAutosave({ dirty: session.dirty, hasFile: !!currentHandle })) return;
        try {
          if (!(await ensureWritePermission(currentHandle))) { prefs.autosave = false; applyAutosave(); Notify.toast("Auto-save désactivé : permission révoquée", "err"); return; }
          await writeToHandle(currentHandle); refreshChrome();
        } catch (e) { console.warn("autosave a échoué", e); }
      }, prefs.autosaveInterval * 1000);
    }
    shell.setAutosave(prefs.autosave, prefs.autosaveInterval);
    shell.setAutosaveStatus(autosaveStatusHtml());
    refreshChrome();
  }
  async function setAutosave(on: boolean): Promise<void> {
    if (on) {
      if (!HAS_FS_API) { Notify.toast("Auto-save indisponible : navigateur sans File System Access API (Chrome/Edge/Brave/Opera).", "err"); shell.setAutosave(false, prefs.autosaveInterval); return; }
      if (!currentHandle) {
        const go = await Dialog.confirm({ title: "Activer l'auto-save", message: "Pour l'auto-save, le document doit être lié à un fichier. Choisir maintenant ?", confirmLabel: "Choisir un fichier" });
        if (!go) { shell.setAutosave(false, prefs.autosaveInterval); return; }
        await doSaveAs();
        if (!currentHandle) { shell.setAutosave(false, prefs.autosaveInterval); return; }
      }
      prefs.autosave = true; applyAutosave(); Notify.toast("Auto-save activé (toutes les " + prefs.autosaveInterval + "s)");
    } else { prefs.autosave = false; applyAutosave(); Notify.toast("Auto-save désactivé"); }
  }

  /* ---- MODE API : documents serveur (workspaces) ---- */
  /** Ouvre un document serveur : scope l'adapter + le backend d'images, recharge données & images. */
  let restEvents: EventSource | null = null;   // flux SSE du document courant (concurrence multi-client)
  let restReloadTO: any = 0;
  /** Recharge le document courant depuis le serveur (suite à un changement externe signalé par SSE). */
  async function restReloadDocument(): Promise<void> {
    if (!restDocId) return;
    flog("reload document (changement externe)");
    await store.init(); await imageStore.reloadFromBackend();
    session.markLoaded(store.histIndex());
    shell.refreshActive(); refreshChrome();
    Notify.toast("Document mis à jour (modifié ailleurs)");
  }
  /** Abonnement SSE : recharge si une révision PLUS RÉCENTE que la nôtre arrive (changement d'un autre client). */
  function restSubscribeLive(): void {
    if (restEvents) { restEvents.close(); restEvents = null; }
    const url = (adapter as RestAdapter).eventsUrl; if (!url || typeof EventSource === "undefined") return;
    try {
      const es = new EventSource(url, { withCredentials: true }); restEvents = es;
      es.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d && typeof d.rev === "number" && d.rev > (adapter as RestAdapter).docRev) { clearTimeout(restReloadTO); restReloadTO = setTimeout(() => void restReloadDocument(), 250); } } catch (_) { /* ignore */ } };
      es.onerror = () => { /* reconnexion auto du navigateur (champ retry) */ };
    } catch (e) { flog("SSE indisponible", e); }
  }
  async function restOpenDocument(docId: string, name?: string): Promise<void> {
    const ra = adapter as RestAdapter;
    ra.setDocument(docId);
    if (imageBackend instanceof RestImageBackend) imageBackend.setBaseUrl(ra.dataBase);
    restDocId = docId;
    await store.init();                       // charge les collections du document
    if (name) store.meta.docName = store.meta.docName || name;
    await imageStore.reloadFromBackend();     // miroir d'images du document
    resetUndoTimeline();
    currentName = name || store.meta.docName || "Document";
    session.setFile(true); session.markLoaded(store.histIndex());
    shell.hideWelcome(); shell.switchView("equipements"); refreshChrome(); shell.refreshActive();
    restSubscribeLive();
    Notify.toast("Document « " + currentName + " » ouvert");
  }
  /** Crée un nouveau document serveur (catalogues semés) puis l'ouvre. */
  async function restNewDocument(name: string): Promise<void> {
    const ra = adapter as RestAdapter;
    let d: any; try { d = await ra.createDocument(name); } catch (e: any) { Notify.toast("Création impossible : " + (e.message || e), "err"); return; }
    ra.setDocument(d.id);
    if (imageBackend instanceof RestImageBackend) imageBackend.setBaseUrl(ra.dataBase);
    restDocId = d.id;
    await store.newDocument();                // sème les catalogues + pousse le snapshot DANS le nouveau document
    store.meta.docName = d.name; await store.persistMeta();
    await imageStore.reloadFromBackend();
    resetUndoTimeline();
    currentName = d.name; session.setFile(true); session.markLoaded(store.histIndex());
    shell.hideWelcome(); shell.switchView("equipements"); refreshChrome(); shell.refreshActive();
    restSubscribeLive();
    Notify.toast("Document « " + d.name + " » créé");
  }
  /** Sélecteur de documents (mode API) : liste serveur, ouverture / création / suppression. */
  async function restOpenChooser(): Promise<void> {
    const ra = adapter as RestAdapter;
    let docs: any[]; try { docs = await ra.listDocuments(); } catch { Notify.toast("Serveur injoignable.", "err"); return; }
    const action = await Dialog.custom({
      title: "Documents", cancelLabel: "Fermer",
      build: (root: HTMLElement) => {
        let chosen: string | null = null;
        const confirmBtn = root.closest(".dialog-box")?.querySelector('[data-dlg="confirm"]') as HTMLElement | null;
        if (confirmBtn) confirmBtn.style.display = "none";
        const wrap = document.createElement("div"); wrap.className = "open-kind-choices";
        docs.forEach((d) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "open-kind-btn";
          const ic = document.createElement("span"); ic.className = "ok-ic"; ic.textContent = "🗂";
          const tx = document.createElement("span"); tx.className = "ok-tx";
          const ti = document.createElement("span"); ti.className = "ok-title"; ti.textContent = d.name + (d.id === restDocId ? "  ◀ ouvert" : "");
          const de = document.createElement("span"); de.className = "ok-desc"; de.textContent = "maj " + String(d.updated_date || "").slice(0, 10);
          tx.append(ti, de); b.append(ic, tx);
          b.onmousedown = (e) => { e.preventDefault(); chosen = d.id; confirmBtn?.click(); };
          const del = document.createElement("span"); del.textContent = "✕"; del.title = "Supprimer ce document"; del.style.cssText = "margin-left:auto;padding:0 8px;cursor:pointer;color:var(--fg-dimmer)";
          del.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); chosen = "__del__:" + d.id; confirmBtn?.click(); };
          b.appendChild(del); wrap.appendChild(b);
        });
        const nb = document.createElement("button"); nb.type = "button"; nb.className = "open-kind-btn";
        const ni = document.createElement("span"); ni.className = "ok-ic"; ni.textContent = "＋"; const nt = document.createElement("span"); nt.className = "ok-tx";
        const nti = document.createElement("span"); nti.className = "ok-title"; nti.textContent = "Nouveau document"; nt.appendChild(nti);
        nb.append(ni, nt); nb.onmousedown = (e) => { e.preventDefault(); chosen = "__new__"; confirmBtn?.click(); }; wrap.appendChild(nb);
        root.appendChild(wrap);
        return { collect: () => chosen, validate: () => true };
      },
    });
    if (!action) return;
    if (action === "__new__") { const n = await Dialog.prompt("Nom du document", "Document"); if (n) await restNewDocument(n); return; }
    if (action.startsWith("__del__:")) {
      const id = action.slice(8), d = docs.find((x) => x.id === id);
      const ok = await Dialog.confirm({ title: "Supprimer le document ?", message: "Supprimer « " + (d?.name || id) + " » et toutes ses données ? Irréversible.", confirmLabel: "Supprimer", danger: true });
      if (ok) { try { await ra.deleteDocument(id); } catch (e: any) { Notify.toast("Suppression impossible : " + (e.message || e), "err"); } if (id === restDocId) restDocId = null; }
      await restOpenChooser(); return;   // rouvre le sélecteur rafraîchi
    }
    if (action !== restDocId) { const d = docs.find((x) => x.id === action); await restOpenDocument(action, d?.name); }
  }
  /** Au boot (mode API) : valide l'auth SSO, puis ouvre le document le plus récent (ou en crée un). */
  async function restBootstrap(): Promise<void> {
    const ra = adapter as RestAdapter;
    const me = await ra.me().catch(() => null);
    shell.setUser(me && me.logged ? me.user : null);
    const authorized = !!(me && me.logged && me.adminRight === "SUPER_ADMIN");
    flog("auth", { logged: me && me.logged, adminRight: me && me.adminRight, authorized });
    if (!authorized) {
      // pas une app noire : on AFFICHE l'état sur l'écran d'accueil, avec un bouton Réessayer.
      const who = (me && me.user && (me.user.login || [me.user.prenom, me.user.nom].filter(Boolean).join(" "))) || "";
      shell.showAccessDenied({ connected: !!(me && me.logged), user: who, onRetry: () => { void restBootstrap(); } });
      return;   // n'ouvre aucun document tant que l'accès n'est pas autorisé
    }
    let docs: any[] = []; try { docs = await ra.listDocuments(); } catch { /* serveur injoignable */ }
    if (docs.length) await restOpenDocument(docs[0].id, docs[0].name);
    else await restNewDocument("Document 1");
  }

  // ---- services FICHIER / GLOBAUX (topbar) ----
  const shellHost: ShellHost = {
    onNew: async () => {
      if (REST_MODE) { const n = await Dialog.prompt("Nom du nouveau document", "Document"); if (n) await restNewDocument(n); return; }
      if (hasUserData()) {
        const ok = await Dialog.confirm({ title: "Nouveau document ?", message: "Le document courant (non enregistré) sera remplacé. Continuer ?", confirmLabel: "Nouveau", danger: true });
        if (!ok) return;
      }
      tabChannel.release(store.meta.fileId || null);
      await store.newDocument(); await imageStore.clearAll(); resetUndoTimeline(); currentHandle = null; currentFacesHandle = null; currentDirHandle = null; currentName = ""; session.setFile(false); session.markLoaded(store.histIndex());
      applyTheme(prefs.theme); shell.hideWelcome(); shell.switchView("equipements"); applyAutosave(); refreshChrome(); Notify.toast("Nouveau document");
    },
    onOpen: () => { if (REST_MODE) restOpenChooser(); else doOpen(); },
    onSave: () => { doSave(); },
    onSaveAs: () => { doSaveAs(); },
    onUndo: () => { void doUndo(); },   // timeline unifiée (modèle + images) ; révision suivie via onChange → dirty recalculé
    onRedo: () => { void doRedo(); },
    onToggleTheme: () => { prefs.theme = (prefs.theme === "light") ? "dark" : "light"; applyTheme(prefs.theme); dcView.onThemeChanged(); },
    onResetViewPrefs: () => {
      try { Object.keys(window.localStorage).filter((k) => k.startsWith("netmap.view3d")).forEach((k) => window.localStorage.removeItem(k)); } catch (_) { /* noop */ }
      dcView.resetView(); shell.refreshActive();   // force une restauration aux défauts à la prochaine activation
      Notify.toast("Préférences d'affichage 3D réinitialisées");
    },
    onRenameDoc: async (name) => {
      store.meta.docName = name; await store.persistMeta(); session.markDirty(); refreshChrome();   // meta HORS historique
      if (REST_MODE && restDocId) { currentName = name; try { await (adapter as RestAdapter).renameDocument(restDocId, name); } catch (_) { /* registre best-effort */ } refreshChrome(); }
    },
    onDataSource: (value) => {
      if (value === "api") { Notify.toast("Source « API » pas encore disponible.", "err"); shell.setDataSource("local"); return; }
      prefs.dataSource = "local"; refreshChrome();
    },
    onFileAccessMode: (value) => {
      if (value === "directory" && !HAS_FS_API) { Notify.toast("Mode dossier indisponible : navigateur sans File System Access API (Chrome/Edge/Brave/Opera).", "err"); shell.setFileAccessMode("file"); return; }
      prefs.fileAccessMode = (value === "directory") ? "directory" : "file";
      if (prefs.fileAccessMode === "file") currentDirHandle = null;   // repasse en mode fichier → on oublie le dossier courant
      shell.setWelcomeMode(prefs.fileAccessMode, HAS_FS_API); refreshChrome();
      Notify.toast(prefs.fileAccessMode === "directory" ? "Mode dossier : une seule autorisation couvre le document et ses images." : "Mode fichier : autorisation par fichier.");
    },
    onOpenMode: (mode) => {
      const m = (mode === "directory") ? "directory" : "file";
      if (m === "directory" && !HAS_FS_API) { Notify.toast("Mode dossier indisponible : navigateur sans File System Access API (Chrome/Edge/Brave/Opera).", "err"); return; }
      prefs.fileAccessMode = m;
      if (m === "file") currentDirHandle = null;
      shell.setFileAccessMode(m); shell.setWelcomeMode(m, HAS_FS_API);
      doOpen();
    },
    onAutosaveToggle: (on) => { setAutosave(on); },
    onAutosaveInterval: (sec) => { prefs.autosaveInterval = sec; applyAutosave(); },
    onReopenLast: () => { reopenLast(); },
    onDebugLog: (on) => { prefs.debugLog = on; Log.setEnabled(on); Notify.toast(on ? "Logs de débogage activés (console)" : "Logs de débogage désactivés"); },
  };

  const shell = new Shell(root, shellHost);

  // ---- fiche détail générique (lecture seule) ----
  const openDetail = (coll: string, id: string) => {
    const o: any = store.get(coll, id);
    if (!o) return;
    const body = document.createElement("div");
    const skip = new Set(["id", "created_date", "updated_date"]);
    Object.keys(o).forEach((k) => {
      if (skip.has(k)) return;
      const v = o[k];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
      const row = FormControls.text(Array.isArray(v) ? v.join(", ") : String(v));
      row.readOnly = true;
      body.appendChild(FormControls.fieldRow(k, row));
    });
    modal.open({ title: Html.escape(o.name || o.label || "(détail)"), subtitle: coll, body, hideFooter: true });
  };

  // ---- onglets de LISTE (ListView paramétré par ListConfigs) ----
  type FormFn = (id: string | null, onSaved: () => void) => void;
  interface TabOpts { title?: string; subtitle?: string; form?: FormFn; addLabel?: string; kind?: "primary" | "secondary"; parent?: string; links?: string[]; onAdd?: () => void; onDel?: (id: string, reRender: () => void) => void; locate?: "equipment" | "rack" | "cable"; }
  const addListTab = (name: string, label: string, configFn: (s: typeof store) => ListOptions, opts: TabOpts = {}) => {
    const cfg = configFn(store);
    const formFn = opts.form;
    let view: ListView | null = null;
    const container = shell.addView({
      name, label, title: opts.title, subtitle: opts.subtitle, kind: opts.kind || "primary", parent: opts.parent, links: opts.links,
      count: () => store.all(cfg.collection).length,
      addLabel: opts.addLabel, onAdd: opts.onAdd || (formFn ? () => formFn(null, () => shell.refreshActive()) : undefined),
      onShow: () => {
        if (!view) {
          const reRender = () => view!.render();
          view = new ListView(store, container, {
            ...cfg,
            actions: { ...(cfg.actions || { view: true, edit: !!formFn, clone: true, del: true }), ...(opts.locate ? { locate: true } : {}) },
            onAction: async (act, id) => {
              if (act === "locate" && opts.locate) { shell.switchView("datacenter"); dcView.locate(opts.locate, id); dcView.setReturnAction(() => shell.switchView(name)); return; }
              if (act === "view") { if (cfg.collection === "equipments") Forms.equipmentDetail(store, formHost, id, reRender); else openDetail(cfg.collection, id); return; }
              if (act === "edit") { formFn?.(id, reRender); return; }
              if (act === "clone") {
                const c = cfg.collection === "equipments" ? await store.cloneEquipment(id) : await store.cloneSimple(cfg.collection, id);
                if (c) { reRender(); Notify.toast("Élément cloné"); }
                return;
              }
              if (act === "del") {
                if (opts.onDel) { opts.onDel(id, reRender); return; }   // suppression spécifique (ex. site → décommissionnement)
                const o: any = store.get(cfg.collection, id);
                const ok = await Dialog.confirm({ title: "Supprimer ?", message: `Supprimer « ${o?.name || o?.label || "cet élément"} » ?`, confirmLabel: "Supprimer", danger: true });
                if (!ok) return;
                await store.remove(cfg.collection, id);
                reRender(); Notify.toast("Supprimé");
              }
            },
          });
        }
        view.render();
      },
    });
  };

  // === ONGLETS PRINCIPAUX (ordre de l'original) ===
  addListTab("equipements", "Équipements", ListConfigs.equipments, {
    subtitle: "Switchs, serveurs, caissons, modems… avec leurs ports, rôles et agrégats.",
    form: (id, done) => Forms.equipment(store, formHost, id, done), addLabel: "+ Équipement",
    links: ["groupes", "faceimages", "spares"], locate: "equipment",
  });
  addListTab("racks", "Racks", ListConfigs.racks, {
    subtitle: "Baies : emplacement, taille (U), profondeur, faces, portes et capots.",
    form: (id, done) => Forms.rack(store, formHost, id, done), addLabel: "+ Rack", locate: "rack",
  });
  addListTab("cables", "Câbles", ListConfigs.cables, {
    subtitle: "Lien nommé entre deux ports — type compatible avec les ports, réseau optionnel.",
    form: (id, done) => Forms.cable(store, formHost, id, done), addLabel: "+ Câble",
    links: ["reseaux", "porttypes", "cabletypes", "faisceaux"], locate: "cable",
  });
  addListTab("ipam", "IPAM", ListConfigs.ipNetworks, {
    title: "IPAM — Réseaux IP", subtitle: "Registre d'attribution d'IP statiques. Déclarez des sous-réseaux (CIDR IPv4), puis attribuez-y des adresses et réservez des plages DHCP.",
    form: (id, done) => Forms.ipNetwork(store, formHost, id, done), addLabel: "+ Réseau IP",
    links: ["ipaddresses", "dhcpranges"],
  });

  // Netmap (GraphView)
  let graph: GraphView;
  const graphContainer = shell.addView({ name: "graph", label: "Netmap", subtitle: "Rendu filtré par équipements, réseaux et/ou types de port. Zoom, recentrage, surbrillance.", onShow: () => graph.show() });
  const stage = document.createElement("div");
  stage.className = "graph-stage";
  stage.style.cssText = "position:relative;flex:1 1 auto;min-height:560px;background:var(--bg-2);overflow:hidden";
  graphContainer.appendChild(stage);
  graph = new GraphView(store, stage, {
    setDirty: () => { refreshChrome(); },
    openEquipmentDetail: (id) => Forms.equipmentDetail(store, formHost, id, () => shell.refreshActive()),
    deleteEquipment: async (id) => {
      const eq = store.get("equipments", id);
      const ok = await Dialog.confirm({ title: "Supprimer ?", message: `Supprimer « ${eq?.name || "équipement"} » et ses câbles ?`, confirmLabel: "Supprimer", danger: true });
      if (!ok) return;
      await store.remove("equipments", id);
      Notify.toast("Équipement supprimé");
    },
    openModal: (opts) => modal.open(opts),
  });

  // Datacenters (vue 3D — tranche-pilote : caméra orbitale + salle/baies)
  let dcView: DatacenterView;
  const dcContainer = shell.addView({ name: "datacenter", label: "Datacenters", subtitle: "Disposition physique des salles : baies en 3D. Glisser = déplacer · Maj/clic droit = orbiter · molette = zoom.", links: ["salles", "etages", "sites"], onShow: () => dcView.show() });
  const dcStage = document.createElement("div");
  dcStage.className = "dc-stage";
  dcStage.style.cssText = "position:relative;flex:1 1 auto;min-height:560px;background:var(--bg-2);overflow:hidden";
  dcContainer.appendChild(dcStage);
  dcView = new DatacenterView(store, dcStage, {
    setDirty: () => { refreshChrome(); },
    openRackForm: (id) => Forms.rack(store, formHost, id, () => shell.refreshActive()),
    openEquipmentDetail: (id) => Forms.equipmentDetail(store, formHost, id, () => shell.refreshActive()),
    openCableForm: (id, opts) => Forms.cable(store, formHost, id, () => shell.refreshActive(), opts),
    assignSlot: (rackId, u, side, height, onDone) => Forms.assignSlot(store, formHost, rackId, u, side, height, onDone),
    assignSideSlot: (rackId, face, lr, col, uTop, onDone) => Forms.assignSideSlot(store, formHost, rackId, face, lr, col, uTop, onDone),
    assignWallSlot: (rackId, wall, margin, col, uTop, onDone) => Forms.assignWallSlot(store, formHost, rackId, wall, margin, col, uTop, onDone),
    assignCapSlot: (rackId, face, cx, cy, onDone) => Forms.assignCapSlot(store, formHost, rackId, face, cx, cy, onDone),
    openDatacenterForm: (id) => Forms.datacenter(store, formHost, id, () => shell.refreshActive()),
    openWaypointForm: (id, opts) => Forms.waypoint(store, formHost, id, opts),
    openFloorForm: (loc, fl, opts) => Forms.floor(store, formHost, loc, fl, opts),
    openSiteForm: (id) => Forms.site(store, formHost, id, () => { dcView.buildToolbar(); dcView.render(); }),
    faceImageUrl: (eqId, face) => { const e: any = store.get("equipments", eqId); const fld = (EQUIP_FACE_IMG_FIELD as any)[face]; const im: any = e && fld && e[fld] ? imageStore.get(e[fld]) : null; return im ? im.url : null; },
  });
  // « Localiser » depuis une fiche (modale) : ferme la modale, bascule en 3D, centre la caméra ; « Retour » rouvre la fiche.
  formHost.locate = (kind, id, ret) => { modal.close(); shell.switchView("datacenter"); dcView.locate(kind, id); dcView.setReturnAction(ret || null); };

  // === SOUS-VUES (atteintes par les liens d'en-tête ; surlignent leur onglet parent) ===
  addListTab("groupes", "Groupes", ListConfigs.groups, {
    subtitle: "Regroupements logiques d'équipements : label + couleur + description.",
    form: (id, done) => Forms.group(store, formHost, id, done), addLabel: "+ Groupe", kind: "secondary", parent: "equipements",
  });
  addListTab("spares", "Spares", ListConfigs.spares, {
    subtitle: "Inventaire de pièces de rechange (HDD · SSD · transceiver · autre) : suivi unitaire, statut, attribution.",
    form: (id, done) => Forms.spare(store, formHost, id, done), addLabel: "+ Spare", kind: "secondary", parent: "equipements",
  });
  // Images de façade : bibliothèque hors modèle (ImageStore) → câblage dédié (CRUD via imageStore)
  {
    const cfg = ListConfigs.faceImages(store);
    let view: ListView | null = null;
    const container = shell.addView({
      name: "faceimages", label: "Images de façade", subtitle: "Bibliothèque d'images de façade (JPEG/PNG/WebP) partagées par référence. Stockées hors document (IndexedDB).",
      kind: "secondary", parent: "equipements", links: [],
      count: () => imageStore.count(),
      extraActions: REST_MODE ? [] : [{ label: "Ouvrir un fichier de faces", title: "Charger un compagnon d'images .nmfb (mode dossier : liste le dossier ; mode fichier : sélecteur)", onClick: () => openFacesFile() }],
      addLabel: "+ Image", onAdd: () => Forms.faceImage(imageStore, store, formHost, null, () => shell.refreshActive()),
      onShow: () => {
        if (!view) {
          const reRender = () => view!.render();
          view = new ListView(store, container, {
            ...cfg, items: () => imageStore.list(),
            actions: { view: false, edit: true, clone: true, del: true },
            onAction: async (act, id) => {
              if (act === "edit") { Forms.faceImage(imageStore, store, formHost, id, reRender); return; }
              if (act === "clone") { const fi: any = imageStore.get(id); if (fi && fi.url) { const blob = await (await fetch(fi.url)).blob(); await imageStore.add({ name: (fi.name || "image") + " (copie)", u_height: fi.u_height, face: fi.face, description: fi.description, blob, type: fi.type }); reRender(); Notify.toast("Image clonée"); } return; }
              if (act === "del") {
                const fi: any = imageStore.get(id); const n = store.faceImageUsageCount(id);
                const ok = await Dialog.confirm({ title: "Supprimer l'image ?", message: `Supprimer « ${fi?.name || "cette image"} » ?` + (n ? ` Elle est référencée par ${n} équipement(s) (les références seront orphelines).` : ""), confirmLabel: "Supprimer", danger: true });
                if (!ok) return;
                await imageStore.remove(id); reRender(); Notify.toast("Image supprimée");
              }
            },
          });
        }
        view.render();
      },
    });
  }
  addListTab("reseaux", "Réseaux", ListConfigs.networks, {
    subtitle: "Réseaux logiques (VLAN…) ou circuits d'alimentation : label, couleur, type.",
    form: (id, done) => Forms.network(store, formHost, id, done), addLabel: "+ Réseau", kind: "secondary", parent: "cables",
  });
  addListTab("faisceaux", "Faisceaux", ListConfigs.cableBundles, {
    title: "Faisceaux / trunks", subtitle: "Câbles MULTI-FIBRES créés à l'avance. Le type d'un faisceau VERROUILLE le type de ses brins ; route et longueur partagées.",
    form: (id, done) => Forms.cableBundle(store, formHost, id, done), addLabel: "+ Faisceau", kind: "secondary", parent: "cables",
  });
  addListTab("porttypes", "Types de port", ListConfigs.portTypes, {
    title: "Types de port / liaison", subtitle: "Catalogue STANDARDISÉ (lecture seule). La « famille » lie ports et câbles compatibles ; le « connecteur » est la forme physique.",
    kind: "secondary", parent: "cables",
  });
  addListTab("cabletypes", "Types de câble", ListConfigs.cableTypes, {
    subtitle: "Catalogue STANDARDISÉ (lecture seule). Rattaché à une « famille » de port.",
    kind: "secondary", parent: "cables",
  });
  addListTab("ipaddresses", "Adresses IP", ListConfigs.ipAddresses, {
    title: "Adresses IP statiques", subtitle: "Une ligne = une IP attribuée. Liée à un réseau, optionnellement à un équipement. Unicité garantie.",
    form: (id, done) => Forms.ipAddress(store, formHost, id, done), addLabel: "+ Adresse IP", kind: "secondary", parent: "ipam",
  });
  addListTab("salles", "Salles", ListConfigs.datacenters, {
    title: "Salles (datacenters)", subtitle: "Grille au sol d'une salle : dimensions + maille. Placez-y des baies (onglet Racks → champ Salle) pour les voir en 3D.",
    form: (id, done) => Forms.datacenter(store, formHost, id, done), addLabel: "+ Salle", kind: "secondary", parent: "datacenter",
  });
  addListTab("sites", "Sites", ListConfigs.sites, {
    title: "Sites / bâtiments", subtitle: "Nom + adresse. La suppression décommissionne le site (salles & étages supprimés, baies → non placé, liaisons logiques préservées).",
    form: (id, done) => Forms.site(store, formHost, id, done), addLabel: "+ Site", kind: "secondary", parent: "datacenter",
    onDel: async (id, reRender) => {
      const s: any = store.get("sites", id);
      const ok = await Dialog.confirm({ title: "Supprimer le site « " + (s?.name || "") + " » ?", message: "Décommissionnement : salles & étages supprimés, baies → « non placé » (équipements conservés), câbles intra → « planifié », équipements d'étage décâblés, waypoints supprimés, routes inter-DC débranchées. Les liaisons LOGIQUES (port↔port) sont préservées. Continuer ?", confirmLabel: "Supprimer le site", danger: true });
      if (!ok) return;
      await store.removeSite(id); Notify.toast("Site décommissionné (liaisons logiques préservées)"); reRender();
    },
  });
  addListTab("etages", "Étages", ListConfigs.floors, {
    title: "Plans d'étage", subtitle: "Dimensions, maille et ancrage d'un étage (bâtiment + niveau). « + Étage » : choisir le bâtiment et le niveau.",
    form: (id) => { const f: any = store.get("floors", id); Forms.floor(store, formHost, f ? (f.location || "") : "", f ? String(f.floor || "") : "", {}); }, addLabel: "+ Étage", kind: "secondary", parent: "datacenter",
    onAdd: () => { if (!store.sitesSorted().length) { Notify.toast("Créez d'abord un site / bâtiment (onglet Sites)", "err"); return; } Forms.floor(store, formHost, "", "", { pick: true }); },
    onDel: async (id, reRender) => {
      const f: any = store.get("floors", id);
      const ok = await Dialog.confirm({ title: "Supprimer le plan d'étage ?", message: "Supprime le PLAN de l'étage « " + (f ? f.floor : "?") + " » du bâtiment « " + store.siteLabel(f ? (f.location || "") : "") + " ». Les salles posées sur cet étage restent (éditez-les si besoin).", confirmLabel: "Supprimer le plan", danger: true });
      if (!ok) return;
      await store.remove("floors", id); Notify.toast("Plan d'étage supprimé"); reRender();
    },
  });
  addListTab("dhcpranges", "Plages DHCP", ListConfigs.dhcpRanges, {
    title: "Plages DHCP réservées", subtitle: "Plages (début → fin) attribuées à un serveur DHCP. Pas de chevauchement avec une autre plage ni une IP statique du réseau.",
    form: (id, done) => Forms.dhcpRange(store, formHost, id, done), addLabel: "+ Plage DHCP", kind: "secondary", parent: "ipam",
  });

  shell.build();
  shell.setDataSource(REST_MODE ? "api" : prefs.dataSource);
  shell.setFileAccessMode(prefs.fileAccessMode);
  shell.setDebugLog(prefs.debugLog); Log.setEnabled(prefs.debugLog);
  shell.setRestMode(REST_MODE);   // mode API : masque les contrôles fichier (cf. docs/rest-migration.md)
  // (l'auth SSO + la pastille utilisateur sont gérées par restBootstrap, au boot)

  // ---- état save-state ----
  // ---- barre de statut / undo-redo (cohérence avec l'état du store) ----
  const refreshChrome = () => {
    session.setFile(!!(currentHandle && HAS_FS_API)); session.setAutosave(prefs.autosave);   // synchronise le contexte de save
    shell.setDocName(store.meta.docName || "");
    shell.setStatus({
      file: currentName || (store.meta.docName ? docFileName() : "— en mémoire —"),
      release: APP_RELEASE, source: prefs.dataSource === "api" ? "API" : adapter.label, entities: store.totalCount(), lastSave: "—",
    });
    // mode API : pas d'undo client (le serveur fait autorité ; écritures immédiates) → boutons désactivés.
    shell.setUndoRedo(!REST_MODE && (store.canUndo() || imageStore.canUndo()), !REST_MODE && redoOrder.length > 0 && (store.canRedo() || imageStore.canRedo()));
    shell.setSaveState(session.state());
  };
  onTimelineChange = () => refreshChrome();   // noteUndoable/resetUndoTimeline rafraîchissent les boutons undo/redo

  // UNDO / REDO UNIFIÉS : dépile la timeline et délègue à la bonne pile (modèle ou images).
  const afterUndoRedo = (msg: string) => { shell.refreshActive(); refreshChrome(); Notify.toast(msg); };
  const doUndo = async (): Promise<void> => {
    while (undoOrder.length) {
      const kind = undoOrder[undoOrder.length - 1];
      if (kind === "image" && imageStore.canUndo()) { undoOrder.pop(); await imageStore.undo(); redoOrder.push(kind); afterUndoRedo("Annulé"); return; }
      if (kind === "model" && store.canUndo()) { undoOrder.pop(); await store.undo(); redoOrder.push(kind); afterUndoRedo("Annulé"); return; }
      undoOrder.pop();   // jeton dont la pile est épuisée (plafond atteint) → ignorer
    }
    if (store.canUndo()) { await store.undo(); redoOrder.push("model"); afterUndoRedo("Annulé"); }   // filet (timeline désynchronisée)
    else if (imageStore.canUndo()) { await imageStore.undo(); redoOrder.push("image"); afterUndoRedo("Annulé"); }
  };
  const doRedo = async (): Promise<void> => {
    while (redoOrder.length) {
      const kind = redoOrder[redoOrder.length - 1];
      if (kind === "image" && imageStore.canRedo()) { redoOrder.pop(); await imageStore.redo(); undoOrder.push(kind); afterUndoRedo("Rétabli"); return; }
      if (kind === "model" && store.canRedo()) { redoOrder.pop(); await store.redo(); undoOrder.push(kind); afterUndoRedo("Rétabli"); return; }
      redoOrder.pop();
    }
  };
  resetUndoTimeline();   // état propre au boot (ignore un éventuel jeton parasite du newDocument initial)

  // cohérence inter-vues : toute mutation marque dirty + rafraîchit le chrome (pastille/undo) IMMÉDIATEMENT, et
  // débounce le re-render LOURD de la vue active. Le chrome est DÉCOUPLÉ du re-render : si `refreshActive()` lève
  // (erreur de rendu d'une vue), la pastille de dirty reste correctement mise à jour.
  let refreshQueued = false;
  store.onChange(() => {
    if (booted) session.setRevision(store.histIndex());   // révision modèle → dirty par comparaison (undo→point sauvé = propre)
    refreshChrome();   // cheap (pastille save + undo/redo) → toujours synchrone, jamais sauté
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshQueued = false; try { shell.refreshActive(); } catch (e) { console.error(e); } });
  });

  // raccourcis clavier UNDO / REDO (Ctrl/Cmd+Z · Ctrl/Cmd+Shift+Z ou Ctrl+Y). Ignorés pendant la saisie dans un
  // champ (undo natif du texte) et sous une modale/dialogue (qui gèrent leurs propres touches).
  document.addEventListener("keydown", (e) => {
    if (REST_MODE) return;   // pas d'undo client en mode API (le serveur fait autorité)
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase(); if (k !== "z" && k !== "y") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    // bloque l'undo SEULEMENT si un overlay est réellement OUVERT (ces nœuds persistent cachés dans le DOM) :
    // modale = classe `.open` ; dialogue = présence (retiré à la fermeture) ; accueil = classe `welcome-active` sur <body>.
    if (document.querySelector(".modal-overlay.open, .dialog-overlay") || document.body.classList.contains("welcome-active")) return;
    e.preventDefault();
    const redo = (k === "y") || (k === "z" && e.shiftKey);
    void (redo ? doRedo() : doUndo());   // timeline unifiée (modèle + images)
  });

  applyAutosave();        // initialise l'état auto-save + le popover
  refreshChrome();
  shell.switchView("equipements");
  booted = true;

  // ÉCRAN D'ACCUEIL (mode FICHIER uniquement) : au (re)chargement le handle FS est perdu → on force une
  // ré-interaction pour le raccrocher. En mode API, les données viennent du serveur au boot → pas d'accueil.
  if (REST_MODE) {
    shell.hideWelcome();
    await restBootstrap();   // ouvre le document le plus récent (ou en crée un) — données chargées du serveur
  } else {
    let reopenName: string | null = null;
    if (HAS_FS_API) {
      try {
        if (dirMode()) { const d = await handleStore.getDir(); if (d && d.handle && d.name) reopenName = d.name; }
        if (!reopenName) { lastRec = await handleStore.getLast(); reopenName = lastRec ? (lastRec.name || "fichier") : null; }
      } catch (_) { lastRec = null; }
    }
    shell.showWelcome({ reopenName, mode: prefs.fileAccessMode, fsApi: HAS_FS_API });
  }

  (window as any).__NETMAP__ = { EntityRegistry, adapter, store, prefs, shell, graph, dcView, modal, tabChannel, reopenLast, imageStore };
}
boot();

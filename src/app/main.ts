/* Point d'entrée. Monte le SHELL (topbar fichier/réglages + barre de statut + onglets +
   en-têtes de domaine), câble les vues de liste (ListView + ListConfigs + Forms), la
   topologie (GraphView) et un emplacement Datacenters (à porter). Bootstrap GLOBAL :
   préférences (thème / source de données / auto-save) via `Prefs`, opérations FICHIER
   (File System Access API quand dispo, sinon download/upload), auto-save périodique, et
   verrou d'ouverture exclusive multi-onglets (`TabChannel` sur BroadcastChannel). */
import "../styles/dc-manager.css";
import { EntityRegistry } from "../models";
import { BrowserStorageAdapter, RestAdapter } from "../data";
import { Store } from "../store";
import { RuntimeConfigLoader } from "./RuntimeConfig";
import { GraphView, ListView, ListConfigs, Forms, DatacenterView } from "../views";
import { ImageStore, IdbImageBackend, RestImageBackend } from "../data";
import { ReloadPlanner, Changeset } from "../sync";
import type { DocumentChangeset } from "../sync";
import type { ListOptions, FormHost } from "../views";
import { Modal, Notify, FormControls, Dialog, Fullscreen } from "../ui";
import { Html } from "../core/Html";
import { Prefs } from "../core/Prefs";
import { Log } from "../core/Log";
import { APP_RELEASE, EQUIP_FACE_IMG_FIELD } from "../domain/constants";
import { Shell } from "./Shell";
import type { ShellHost } from "./Shell";
import { Pwa } from "./Pwa";
import { SaveState } from "./SaveState";
import { TabChannel } from "./TabChannel";
import { HandleStore } from "./HandleStore";
import { UndoTimeline } from "./UndoTimeline";
import { AutoSave } from "./AutoSave";
import { FileDocumentController } from "./FileDocuments";

// Timeline d'undo UNIFIÉE (modèle + images) : UN SEUL geste défait dans l'ordre chronologique, quelle que soit
// la pile d'origine. Logique EXTRAITE dans `UndoTimeline` (pure, testée) ; les piles sont enregistrées au boot.
const undoTimeline = new UndoTimeline();
const noteUndoable = (kind: string): void => undoTimeline.note(kind);

// MODE D'EXÉCUTION : piloté par les PRÉFÉRENCES utilisateur (réglages → Source de données), initialisées au 1er
// run depuis la config injectée par le backend. L'utilisateur peut basculer local⟷api et changer l'URL d'API ;
// le changement est appliqué au RECHARGEMENT (adapter/store recréés).
const prefs = new Prefs();
const INJECTED = RuntimeConfigLoader.read();
// VISUALISEUR AUTONOME : un document EMBARQUÉ dans le HTML (export readonly hors-ligne) → on l'ouvre en LOCAL,
// en lecture seule, sans réseau ni écran d'accueil (cf. exportStandalone / branche VIEWER au boot).
const EMBED: any = (() => { try { return (window as any).__DCMANAGER_EMBED__ || null; } catch (_) { return null; } })();
const VIEWER = !!EMBED;
// Mode EFFECTIF : le choix EXPLICITE de l'utilisateur prime ; sinon on suit la config injectée par le backend
// (défaut). Ainsi : 1er run servi par le backend → API ; et l'utilisateur peut repasser en LOCAL (mémorisé) même
// servi par le backend — ce qui était impossible avant (le mode était fixé par la config à chaque boot).
const REST_MODE = !VIEWER && (prefs.dataSourceUserSet ? (prefs.dataSource === "api") : (INJECTED.mode === "api"));
const API_BASE_URL = (prefs.apiBaseUrl && prefs.apiBaseUrl.trim()) || INJECTED.apiBaseUrl || "api";   // défaut RELATIF (cf. <base>) → compatible sous-dossier
// API même origine, cookies SSO transmis (l'app NE gère PAS l'auth — le SSO valide).
const adapter = REST_MODE
  ? new RestAdapter({ baseUrl: API_BASE_URL })
  : new BrowserStorageAdapter({ persistent: false, onUndoable: noteUndoable });
const store = new Store(adapter);
const W = window as any;
const HAS_FS_API = typeof W.showSaveFilePicker === "function" && typeof W.showOpenFilePicker === "function";

/** Le document est-il « non vide » (au-delà des seuls catalogues fermés réinjectés) ? */
function hasUserData(): boolean { return store.totalCount() > store.all("portTypes").length + store.all("cableTypes").length; }

function applyTheme(theme: string): void {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}
/** Applique l'échelle d'interface (zoom global piloté par --ui-scale, cf. dc-manager.css `body { zoom }`). */
function applyUiScale(scale: number): void {
  document.documentElement.style.setProperty("--ui-scale", String(scale || 1));
}

async function boot(): Promise<void> {
  Pwa.register();   // app installable + chargement hors-ligne (service worker) — no-op en file:// / build dev
  await store.init();
  // En mode API, le SERVEUR fait autorité : on N'ENSEMENCE PAS (un newDocument pousserait un /snapshot
  // qui écraserait la base). En mode fichier, on sème le document par défaut si rien n'a été restauré.
  if (!store.restored && !REST_MODE && !VIEWER) await store.newDocument();
  applyTheme(prefs.theme);
  applyUiScale(prefs.uiScale);   // échelle d'interface persistée (taille du texte)

  const root = document.getElementById("app");
  if (!root) return;

  // ---- état FICHIER / session ----
  // L'état fichier (handles, nom) et tout le cycle de vie fichier/compagnon vivent dans `FileDocumentController`
  // (cf. app/FileDocuments — découpage P4 de boot()). Ici : la session de save + les dépendances qu'on lui injecte.
  const session = new SaveState();      // suivi dirty/save (révision modèle vs dernière sauvegarde + meta/images)
  let booted = false;                   // garde : ne suit pas la révision pendant le chargement initial

  const tabChannel = new TabChannel({
    enabled: HAS_FS_API && !REST_MODE,   // verrou inter-onglets = concept FICHIER ; en mode API le serveur arbitre (cf. P3)
    onConflict: () => Notify.toast("Ce fichier est aussi ouvert dans un autre onglet.", "err"),
  });
  const handleStore = new HandleStore();

  const modal = new Modal();
  const formHost: FormHost = { openModal: (o) => modal.open(o), setDirty: () => { refreshChrome(); } };   // mutation modèle déjà suivie par la révision (store.onChange)
  // bibliothèque d'images de façade (hors modèle : IndexedDB + miroir mémoire)
  // backend d'images selon le mode : IndexedDB (fichier, + compagnon .nmfb) · endpoints blob (REST). Cf. P2.
  const imageBackend = REST_MODE ? new RestImageBackend(API_BASE_URL) : new IdbImageBackend();
  // Hook tardif (dcView n'existe pas encore) : toute mutation d'image (y c. le mode d'oreilles, qui ne change PAS
  // l'URL) doit forcer une reconstruction 3D — sinon la scène garderait l'ancien gabarit de plan de façade.
  let onImageMutated: () => void = () => {};
  const imageStore = new ImageStore({ onDirty: () => { onImageMutated(); session.markDirty(); refreshChrome(); shell.refreshActive(); }, onUndoable: noteUndoable, backend: imageBackend });   // images HORS historique modèle, undo intégré à la timeline unifiée
  Forms.images = imageStore;   // singleton pour le picker d'image (faceEditor)
  imageStore.restoreLoadedKey();   // clé du bundle .nmfb actuellement en IndexedDB (persistée) — appariement json↔compagnon
  if (!REST_MODE) await imageStore.ready();   // en REST, le miroir est chargé à l'ouverture d'un document
  let restDocId: string | null = null;   // document serveur courant (mode API)
  Fullscreen.install();   // re-parente les overlays (modale/dialogues/toasts/menus) dans l'élément plein écran

  /* ---- documents FICHIER : cycle de vie EXTRAIT dans `FileDocumentController` (ouvrir/enregistrer/rouvrir,
     mode dossier, compagnon .nmfb, exports) ; ici, seule l'adhérence à la boucle applicative. Les closures de
     l'hôte capturent des consts définies PLUS BAS (shell, refreshChrome, applyAutosave) — appelées après le boot. */
  const files = new FileDocumentController({
    store, imageStore, session, prefs, handleStore, tabChannel, hasFsApi: HAS_FS_API,
    host: {
      refreshChrome: () => refreshChrome(),
      refreshActive: () => shell.refreshActive(),
      documentOpened: () => { shell.hideWelcome(); shell.switchView("equipements"); applyAutosave(); refreshChrome(); },
      applyTheme: () => applyTheme(prefs.theme),
      applyAutosave: () => applyAutosave(),
      setReopen: (name: string | null) => shell.setReopen(name),
      resetUndo: () => undoTimeline.reset(),
    },
  });

  /* ---- auto-save : mécanique EXTRAITE dans `AutoSave` (testée) ; ici, seule l'adhérence à l'app ---- */
  const autoSave = new AutoSave(prefs, {
    hasFsApi: () => HAS_FS_API,
    hasFile: () => !!files.handle,
    dirty: () => session.dirty,
    ensureWritePermission: () => files.ensureCurrentWritePermission(),
    write: async () => { await files.writeCurrent(); refreshChrome(); },
    pickFile: () => files.doSaveAs(),
    confirmEnable: () => Dialog.confirm({ title: "Activer l'auto-save", message: "Pour l'auto-save, le document doit être lié à un fichier. Choisir maintenant ?", confirmLabel: "Choisir un fichier" }),
    onStateChange: (on, intervalS, statusHtml) => { shell.setAutosave(on, intervalS); shell.setAutosaveStatus(statusHtml); refreshChrome(); },
    notify: (msg, kind) => Notify.toast(msg, kind),
  });
  const applyAutosave = (): void => autoSave.apply();
  const setAutosave = (on: boolean): Promise<void> => autoSave.setEnabled(on);

  /* ---- MODE API : documents serveur (workspaces) ---- */
  /** Ouvre un document serveur : scope l'adapter + le backend d'images, recharge données & images. */
  let restEvents: EventSource | null = null;   // flux SSE du document courant (concurrence multi-client)
  let restReloadTO: any = 0;
  let restLastBy: { name?: string; ip?: string } | null = null;   // auteur du dernier changement externe (pour le toast)
  const flog = Log.scope("fs");   // trace fichier/REST (flag de débogage) — le contrôleur fichier a la sienne
  const reloadPlanner = new ReloadPlanner();   // changeset → plan (quoi reconstruire) — cf. src/sync/RenderImpact.ts
  // Changesets des événements SSE rapprochés, ACCUMULÉS pendant la fenêtre de debounce puis planifiés en une fois.
  let pendingChangeset: DocumentChangeset | null = null;
  /** Recharge le document courant depuis le serveur. `changeset` (SSE) cible la reconstruction (3D sautée si aucune
      collection dessinée n'a changé) ; `conflict` (409 sur NOTRE écriture) force un rechargement total + notifie le rejet. */
  async function restReloadDocument(opts?: { conflict?: boolean; changeset?: DocumentChangeset }): Promise<void> {
    if (!restDocId) return;
    // 409 : on ignore QUELLES entités l'autre client a changées → rechargement total prudent. Sinon : périmètre du changeset.
    const changeset = opts?.conflict ? Changeset.full() : (opts?.changeset || Changeset.full());
    const plan = reloadPlanner.plan(changeset);
    flog("reload document", opts?.conflict ? "(conflit 409)" : "(changement externe)", "→ 3D:" + plan.threeRebuild, restLastBy);
    Notify.busy(opts?.conflict ? "Conflit de version — rechargement…" : "Mise à jour du document…");
    // laisse le navigateur PEINDRE l'overlay AVANT le travail synchrone lourd (fetch + rebuild 3D ≈ 1 s) qui gèle
    // le thread : sans ce double rAF, l'overlay ne s'affiche qu'une fois le freeze terminé (donc jamais visible).
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      // P2 : rechargement GRANULAIRE — on ne re-tire QUE les collections du changeset ; le périmètre indéterminé
      // (`refetchCollections === null` : import/snapshot/conflit 409) impose encore un rechargement TOTAL.
      if (plan.refetchCollections) {
        await store.reloadCollections(plan.refetchCollections);   // 0 collection (ex. méta seule) → aucun fetch d'entités
        if (plan.refreshMeta) await store.reloadMeta();           // la méta (nom, dispositions…) a changé → relue à part
      } else {
        await store.init();   // re-tirage COMPLET du document
      }
      if (plan.refreshImages) await imageStore.reloadFromBackend();   // métadonnées d'images SEULEMENT si une image a changé
      session.markLoaded(store.histIndex());
      // saut de la reconstruction 3D quand AUCUNE collection dessinée n'a changé (ex. adresse IP, spare, réseau IP) :
      // c'est tout l'intérêt du plan — éviter le gel d'UI pour un changement sans impact géométrique. Cf. RenderImpact.
      if (plan.threeRebuild !== "none") dcView.invalidate3D();
      shell.refreshActive(); refreshChrome();
    } finally { Notify.idle(); }
    if (opts?.conflict) {
      Notify.toast("Modification refusée : le document a changé entre-temps. Données rechargées — refais ta modification.", "conflict");
    } else {
      const by = restLastBy ? (" par " + (restLastBy.name || "?") + (restLastBy.ip ? " (" + restLastBy.ip + ")" : "")) : "";
      Notify.toast("Document mis à jour" + by);
    }
  }
  // 409 (verrou optimiste serveur) sur une de nos écritures → recharge + notifie (PAS de rejeu : le serveur fait autorité).
  if (REST_MODE) (adapter as RestAdapter).onConflict = () => { void restReloadDocument({ conflict: true }); };
  // 400 (validation PARTAGÉE serveur) : données refusées → notifie (les 2-3 premières erreurs, suffisant pour situer le problème).
  if (REST_MODE) (adapter as RestAdapter).onValidationError = (errors) => {
    const head = errors.slice(0, 3).map((e) => e.message).join(" · ");
    Notify.toast("Données refusées par le serveur : " + head + (errors.length > 3 ? " …" : ""), "err");
  };
  // Validation PARTAGÉE côté client (Store) : SEUL garde-fou en mode fichier, retour immédiat en mode API.
  store.onInvalid = (errors) => {
    const head = errors.slice(0, 3).map((e) => e.message).join(" · ");
    Notify.toast("Données invalides : " + head + (errors.length > 3 ? " …" : ""), "err");
  };
  // Échec de persistance HORS transaction (meta / snapshot) : sans ce câblage, un échec réseau (renommage,
  // import, dispositions de graphe) finissait en console.warn et l'UI croyait au succès.
  store.onPersistError = (op, e: any) => {
    const what = op === "meta" ? "métadonnées non enregistrées" : "document non enregistré";
    Notify.toast("Échec de persistance (" + what + ") : " + ((e && e.message) || e), "err");
  };
  /** Planifie un rechargement débouncé en consommant les changesets SSE accumulés (fusionnés). */
  function flushPendingReload(): void {
    const changeset = pendingChangeset || Changeset.full();
    pendingChangeset = null;
    void restReloadDocument({ changeset });
  }
  /** Abonnement SSE : recharge si une révision PLUS RÉCENTE que la nôtre arrive (changement d'un autre client). */
  function restSubscribeLive(): void {
    if (restEvents) { restEvents.close(); restEvents = null; }
    const url = (adapter as RestAdapter).eventsUrl; if (!url || typeof EventSource === "undefined") return;
    try {
      const es = new EventSource(url, { withCredentials: true }); restEvents = es;
      es.onmessage = (e) => { try {
        const d = JSON.parse(e.data); const ra = adapter as RestAdapter;
        if (!d || (d.origin && d.origin === ra.clientId)) return;   // NOTRE propre écriture → on ignore (pas de reload)
        if (typeof d.rev === "number" && d.rev > ra.docRev) {
          restLastBy = d.by || null;
          // accumule le périmètre de CET événement avec ceux déjà en attente (plusieurs écritures peuvent tomber
          // dans la fenêtre de debounce) → une seule reconstruction couvrant l'union des changements.
          const incoming = Changeset.coerce(d.changeset, EntityRegistry.isCollection);   // filtre les collections inconnues (évite un refetch inutile)
          pendingChangeset = pendingChangeset ? Changeset.merge(pendingChangeset, incoming) : incoming;
          clearTimeout(restReloadTO); restReloadTO = setTimeout(flushPendingReload, 250);
        }
      } catch (_) { /* ignore */ } };
      es.onerror = () => { /* reconnexion auto du navigateur (champ retry) */ };
    } catch (e) { flog("SSE indisponible", e); }
  }
  async function restOpenDocument(docId: string, name?: string): Promise<void> {
    const ra = adapter as RestAdapter;
    ra.setDocument(docId);
    if (imageBackend instanceof RestImageBackend) imageBackend.setBaseUrl(ra.dataBase);
    restDocId = docId;
    prefs.lastRestDocId = docId;              // mémorise le DERNIER doc ouvert → rouvert au prochain lancement (cf. restBootstrap)
    await store.init();                       // charge les collections du document
    if (name) store.meta.docName = store.meta.docName || name;
    await imageStore.reloadFromBackend();     // miroir d'images du document
    undoTimeline.reset();
    files.name = name || store.meta.docName || "Document";
    session.setFile(true); session.markLoaded(store.histIndex());
    shell.hideWelcome(); shell.switchView("equipements"); refreshChrome(); shell.refreshActive();
    restSubscribeLive();
    Notify.toast("Document « " + files.name + " » ouvert");
  }
  /** Crée un nouveau document serveur (catalogues semés) puis l'ouvre. */
  async function restNewDocument(name: string): Promise<void> {
    const ra = adapter as RestAdapter;
    let d: any; try { d = await ra.createDocument(name); } catch (e: any) { Notify.toast("Création impossible : " + (e.message || e), "err"); return; }
    ra.setDocument(d.id);
    if (imageBackend instanceof RestImageBackend) imageBackend.setBaseUrl(ra.dataBase);
    restDocId = d.id;
    prefs.lastRestDocId = d.id;               // un doc fraîchement créé devient le « dernier ouvert »
    await store.newDocument();                // sème les catalogues + pousse le snapshot DANS le nouveau document
    store.meta.docName = d.name; await store.persistMeta();
    await imageStore.reloadFromBackend();
    undoTimeline.reset();
    files.name = d.name; session.setFile(true); session.markLoaded(store.histIndex());
    shell.hideWelcome(); shell.switchView("equipements"); refreshChrome(); shell.refreshActive();
    restSubscribeLive();
    Notify.toast("Document « " + d.name + " » créé");
  }
  /** Importe un export `.json` (format mode-fichier) DANS UN NOUVEAU document serveur : crée le document,
      pousse le snapshot (meta + collections) puis les images de façade (compagnon `.nmfb` prioritaire, sinon
      `faceImages` inline), et l'ouvre. Réutilise exactement la logique d'écriture du DataAdapter REST. */
  async function restImportJson(text: string, nmfbBuf: ArrayBuffer | null, suggestedName: string): Promise<void> {
    const ra = adapter as RestAdapter;
    let raw: any; try { raw = JSON.parse(text); } catch { Notify.toast("Fichier invalide (JSON attendu).", "err"); return; }
    const name = String((raw && raw.meta && raw.meta.docName) || suggestedName || "Document").replace(/\.json$/i, "") || "Document";
    let d: any; try { d = await ra.createDocument(name); } catch (e: any) { Notify.toast("Création impossible : " + (e.message || e), "err"); return; }
    ra.setDocument(d.id);
    if (imageBackend instanceof RestImageBackend) imageBackend.setBaseUrl(ra.dataBase);
    restDocId = d.id;
    prefs.lastRestDocId = d.id;               // le doc importé devient le « dernier ouvert »
    try {
      await store.replaceAll(raw);                                              // meta + collections → PUT /snapshot du nouveau document
      let nImg = 0;
      if (nmfbBuf) nImg = await imageStore.loadBundle(nmfbBuf);                  // compagnon d'images .nmfb (prioritaire)
      else if (Array.isArray(raw.faceImages)) nImg = await imageStore.replaceAllFromLegacy(raw.faceImages);   // images inline (legacy ≤ v51)
      else await imageStore.clearAll();
      store.meta.docName = name; await store.persistMeta();
      await imageStore.reloadFromBackend();
      undoTimeline.reset();
      files.name = name; session.setFile(true); session.markLoaded(store.histIndex());
      shell.hideWelcome(); shell.switchView("equipements"); refreshChrome(); shell.refreshActive();
      restSubscribeLive();
      const nbEnt = Object.keys(raw).filter((k) => k !== "faceImages" && Array.isArray((raw as any)[k])).reduce((n, k) => n + (raw as any)[k].length, 0);
      Notify.toast("Importé « " + name + " » (" + nbEnt + " entités, " + nImg + " image(s))");
    } catch (e: any) { Notify.toast("Import échoué : " + (e.message || e), "err"); }
  }
  /** Sélectionne un `.json` (+ compagnon `.nmfb` facultatif) puis l'importe dans un nouveau document serveur. */
  async function restImportFromPicker(): Promise<void> {
    let jsonFile: File | null = null, nmfbBuf: ArrayBuffer | null = null;
    if (HAS_FS_API) {
      try {
        const handles = await W.showOpenFilePicker({ multiple: true, types: [{ description: "Document DC Manager (.json) + images (.nmfb)", accept: { "application/json": [".json"], "application/octet-stream": [".nmfb"] } }] });
        for (const h of handles) { const f = await h.getFile(); if (/\.nmfb$/i.test(f.name)) nmfbBuf = await f.arrayBuffer(); else if (!jsonFile) jsonFile = f; }
      } catch (e: any) { if (e && e.name !== "AbortError") Notify.toast("Sélection impossible : " + (e.message || e), "err"); return; }
    } else {
      jsonFile = await new Promise<File | null>((resolve) => {
        const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json";
        inp.onchange = () => resolve((inp.files && inp.files[0]) || null); inp.click();
      });
    }
    if (!jsonFile) { Notify.toast("Aucun fichier .json sélectionné.", "err"); return; }
    await restImportJson(await jsonFile.text(), nmfbBuf, jsonFile.name);
  }
  /** Sélecteur de documents (mode API) : liste serveur, ouverture / création / suppression. */
  async function restOpenChooser(): Promise<void> {
    const ra = adapter as RestAdapter;
    let docs: any[]; try { docs = await ra.listDocuments(); } catch { Notify.toast("Serveur injoignable.", "err"); return; }
    const defaultDocId = await ra.getDefaultDocId().catch(() => null);   // doc par défaut global (best-effort) → mis en évidence + bascule par étoile
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
          const isDefault = d.id === defaultDocId;
          const ti = document.createElement("span"); ti.className = "ok-title"; ti.textContent = (d.locked ? "🔒 " : "") + d.name + (d.id === restDocId ? "  ◀ ouvert" : "") + (isDefault ? "  ★ défaut" : "");
          const de = document.createElement("span"); de.className = "ok-desc"; de.textContent = "maj " + String(d.updated_date || "").slice(0, 10);
          tx.append(ti, de); b.append(ic, tx);
          b.onmousedown = (e) => { e.preventDefault(); chosen = d.id; confirmBtn?.click(); };
          // Étoile : bascule du DOC PAR DÉFAUT global (ouvert au boot d'un client sans « dernier doc ouvert »).
          // Cliquer l'étoile du défaut courant l'efface ; cliquer une autre la déplace. Défaut = ★ net ; sinon ☆ estompé.
          const star = document.createElement("span"); star.textContent = isDefault ? "★" : "☆";
          star.title = isDefault ? "Retirer comme document par défaut" : "Définir comme document par défaut (ouvert au démarrage)";
          star.style.cssText = "margin-left:auto;padding:0 6px;cursor:pointer;opacity:" + (isDefault ? "1" : "0.4");
          star.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); chosen = "__default__:" + (isDefault ? "" : d.id); confirmBtn?.click(); };
          b.appendChild(star);
          // Cadenas : bascule de verrouillage (protège d'une suppression accidentelle). Verrouillé = 🔒 net ; libre = 🔓 estompé.
          const lock = document.createElement("span"); lock.textContent = d.locked ? "🔒" : "🔓";
          lock.title = d.locked ? "Déverrouiller (réautorise la suppression)" : "Verrouiller (protège de la suppression)";
          lock.style.cssText = "padding:0 6px;cursor:pointer;opacity:" + (d.locked ? "1" : "0.4");
          lock.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); chosen = "__lock__:" + d.id; confirmBtn?.click(); };
          b.appendChild(lock);
          // Suppression proposée UNIQUEMENT si non verrouillé → flux délibéré « déverrouiller d'abord » (le serveur refuse en 423 par sécurité).
          if (!d.locked) {
            const del = document.createElement("span"); del.textContent = "✕"; del.title = "Supprimer ce document"; del.style.cssText = "padding:0 8px;cursor:pointer;color:var(--fg-dimmer)";
            del.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); chosen = "__del__:" + d.id; confirmBtn?.click(); };
            b.appendChild(del);
          }
          wrap.appendChild(b);
        });
        const nb = document.createElement("button"); nb.type = "button"; nb.className = "open-kind-btn";
        const ni = document.createElement("span"); ni.className = "ok-ic"; ni.textContent = "＋"; const nt = document.createElement("span"); nt.className = "ok-tx";
        const nti = document.createElement("span"); nti.className = "ok-title"; nti.textContent = "Nouveau document"; nt.appendChild(nti);
        nb.append(ni, nt); nb.onmousedown = (e) => { e.preventDefault(); chosen = "__new__"; confirmBtn?.click(); }; wrap.appendChild(nb);
        const ib = document.createElement("button"); ib.type = "button"; ib.className = "open-kind-btn";
        const ii = document.createElement("span"); ii.className = "ok-ic"; ii.textContent = "📥"; const itx = document.createElement("span"); itx.className = "ok-tx";
        const iti = document.createElement("span"); iti.className = "ok-title"; iti.textContent = "Importer un fichier .json…";
        const ide = document.createElement("span"); ide.className = "ok-desc"; ide.textContent = "crée un nouveau document depuis un export .json (+ .nmfb d'images)";
        itx.append(iti, ide); ib.append(ii, itx); ib.onmousedown = (e) => { e.preventDefault(); chosen = "__import__"; confirmBtn?.click(); }; wrap.appendChild(ib);
        root.appendChild(wrap);
        return { collect: () => chosen, validate: () => true };
      },
    });
    if (!action) return;
    if (action === "__new__") { const n = await Dialog.prompt("Nom du document", "Document"); if (n) await restNewDocument(n); return; }
    if (action === "__import__") { await restImportFromPicker(); return; }
    if (action.startsWith("__default__:")) {
      const id = action.slice(12) || null;   // "" → efface le défaut ; sinon le déplace sur ce doc
      try { await ra.setDefaultDocId(id); Notify.toast(id ? "Document par défaut défini." : "Document par défaut retiré."); }
      catch (e: any) { Notify.toast("Action impossible : " + (e.message || e), "err"); }
      await restOpenChooser(); return;   // rouvre le sélecteur rafraîchi
    }
    if (action.startsWith("__lock__:")) {
      const id = action.slice(9), d = docs.find((x) => x.id === id);
      try { await ra.setDocumentLocked(id, !d?.locked); Notify.toast(d?.locked ? "Document déverrouillé." : "Document verrouillé."); }
      catch (e: any) { Notify.toast("Action impossible : " + (e.message || e), "err"); }
      await restOpenChooser(); return;   // rouvre le sélecteur rafraîchi
    }
    if (action.startsWith("__del__:")) {
      const id = action.slice(8), d = docs.find((x) => x.id === id);
      const ok = await Dialog.confirm({ title: "Supprimer le document ?", message: "Supprimer « " + (d?.name || id) + " » et toutes ses données ? Irréversible.", confirmLabel: "Supprimer", danger: true });
      if (ok) { try { await ra.deleteDocument(id); } catch (e: any) { Notify.toast("Suppression impossible : " + (e.message || e), "err"); } if (id === restDocId) restDocId = null; if (id === prefs.lastRestDocId) prefs.lastRestDocId = ""; }
      await restOpenChooser(); return;   // rouvre le sélecteur rafraîchi
    }
    if (action !== restDocId) { const d = docs.find((x) => x.id === action); await restOpenDocument(action, d?.name); }
  }
  /** Au boot (mode API) : valide l'auth SSO, puis ouvre le document selon cette PRIORITÉ :
      1) le DERNIER doc ouvert sur ce navigateur (prefs.lastRestDocId), s'il existe encore ;
      2) sinon le doc par DÉFAUT (réglage serveur global), s'il est défini ;
      3) sinon le plus récemment modifié (1er de la liste, triée DESC côté serveur) ;
      4) sinon (aucun document) on en crée un. */
  async function restBootstrap(): Promise<void> {
    const ra = adapter as RestAdapter;
    const me = await ra.me().catch(() => null);
    shell.setUser(me && me.logged ? me.user : null);
    const authorized = !!(me && me.logged && me.adminRight === "SUPER_ADMIN");
    flog("auth", { logged: me && me.logged, adminRight: me && me.adminRight, authorized });
    if (!authorized) {
      // pas une app noire : on AFFICHE l'état sur l'écran d'accueil, avec un bouton Réessayer.
      const who = (me && me.user && (me.user.login || [me.user.prenom, me.user.nom].filter(Boolean).join(" "))) || "";
      shell.showAccessDenied({ connected: !!(me && me.logged), user: who, onRetry: () => { void restBootstrap(); }, loginUrl: (prefs.loginUrl && prefs.loginUrl.trim()) || INJECTED.loginUrl });
      return;   // n'ouvre aucun document tant que l'accès n'est pas autorisé
    }
    let docs: any[] = []; try { docs = await ra.listDocuments(); } catch { /* serveur injoignable */ }
    const exists = (id: string | null | undefined) => !!id && docs.some((d) => d.id === id);
    // 1) dernier doc ouvert (s'il n'a pas été supprimé entre-temps)
    let targetId = exists(prefs.lastRestDocId) ? prefs.lastRestDocId : null;
    // 2) sinon doc par défaut global (best-effort : ignore une erreur réseau/serveur)
    if (!targetId) { const def = await ra.getDefaultDocId().catch(() => null); if (exists(def)) targetId = def; }
    // 3) sinon le plus récent ; 4) sinon création
    if (!targetId && docs.length) targetId = docs[0].id;
    flog("boot: doc choisi", { targetId, last: prefs.lastRestDocId, total: docs.length });
    if (targetId) { const d = docs.find((x) => x.id === targetId); await restOpenDocument(targetId, d?.name); }
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
      await store.newDocument(); await imageStore.clearAll(); undoTimeline.reset(); files.detach(); session.markLoaded(store.histIndex());
      applyTheme(prefs.theme); shell.hideWelcome(); shell.switchView("equipements"); applyAutosave(); refreshChrome(); Notify.toast("Nouveau document");
    },
    onOpen: () => { if (REST_MODE) restOpenChooser(); else void files.doOpen(); },
    onSave: () => { void files.doSave(); },
    onSaveAs: () => { void files.doSaveAs(); },
    onUndo: () => { void doUndo(); },   // timeline unifiée (modèle + images) ; révision suivie via onChange → dirty recalculé
    onRedo: () => { void doRedo(); },
    onToggleTheme: () => { prefs.theme = (prefs.theme === "light") ? "dark" : "light"; applyTheme(prefs.theme); dcView.onThemeChanged(); },
    onUiScale: (value) => { prefs.uiScale = value; applyUiScale(prefs.uiScale); shell.setUiScale(prefs.uiScale); },
    onResetViewPrefs: () => {
      try { Object.keys(window.localStorage).filter((k) => k.startsWith("dcmanager.view3d")).forEach((k) => window.localStorage.removeItem(k)); } catch (_) { /* noop */ }
      dcView.resetView(); shell.refreshActive();   // force une restauration aux défauts à la prochaine activation
      Notify.toast("Préférences d'affichage 3D réinitialisées");
    },
    onRenameDoc: async (name) => {
      store.meta.docName = name; await store.persistMeta(); session.markDirty(); refreshChrome();   // meta HORS historique
      if (REST_MODE && restDocId) { files.name = name; try { await (adapter as RestAdapter).renameDocument(restDocId, name); } catch (_) { /* registre best-effort */ } refreshChrome(); }
    },
    onDataSource: async (value) => {
      // Changement de mode = redémarrage de l'app (adapter/store recréés) → on persiste puis on RECHARGE.
      const target = (value === "api") ? "api" : "local";
      if (target === (REST_MODE ? "api" : "local")) { prefs.dataSource = target; return; }   // déjà ce mode → on mémorise juste le choix
      const ok = await Dialog.confirm({
        title: "Changer de mode de données ?",
        message: "Passer en mode « " + (target === "api" ? "API (serveur)" : "Local (fichier)") + " » recharge l'application. Les modifications non enregistrées seront perdues.",
        confirmLabel: "Changer et recharger", cancelLabel: "Annuler", danger: true,
      });
      if (!ok) { shell.setDataSource(prefs.dataSource); return; }   // rétablit la position du toggle
      prefs.dataSource = target;
      window.location.reload();
    },
    onApiBaseUrl: async (url) => {
      const clean = (url || "").trim() || "api";
      if (clean === ((prefs.apiBaseUrl && prefs.apiBaseUrl.trim()) || API_BASE_URL)) return;
      prefs.apiBaseUrl = clean; shell.setApiBaseUrl(clean);
      if (prefs.dataSource !== "api") return;   // sans effet tant qu'on n'est pas en mode API
      const ok = await Dialog.confirm({ title: "Appliquer la nouvelle URL d'API ?", message: "Modifier l'URL de l'API (" + clean + ") recharge l'application.", confirmLabel: "Recharger", cancelLabel: "Plus tard" });
      if (ok) window.location.reload();
    },
    onLoginUrl: (url) => { prefs.loginUrl = url; shell.setLoginUrl(prefs.loginUrl); },   // utilisée par le bouton « Connexion » du welcome
    onFileAccessMode: (value) => {
      if (value === "directory" && !HAS_FS_API) { Notify.toast("Mode dossier indisponible : navigateur sans File System Access API (Chrome/Edge/Brave/Opera).", "err"); shell.setFileAccessMode("file"); return; }
      prefs.fileAccessMode = (value === "directory") ? "directory" : "file";
      if (prefs.fileAccessMode === "file") files.dirHandle = null;   // repasse en mode fichier → on oublie le dossier courant
      shell.setWelcomeMode(prefs.fileAccessMode, HAS_FS_API); refreshChrome();
      Notify.toast(prefs.fileAccessMode === "directory" ? "Mode dossier : une seule autorisation couvre le document et ses images." : "Mode fichier : autorisation par fichier.");
    },
    onOpenMode: (mode) => {
      const m = (mode === "directory") ? "directory" : "file";
      if (m === "directory" && !HAS_FS_API) { Notify.toast("Mode dossier indisponible : navigateur sans File System Access API (Chrome/Edge/Brave/Opera).", "err"); return; }
      prefs.fileAccessMode = m;
      if (m === "file") files.dirHandle = null;
      shell.setFileAccessMode(m); shell.setWelcomeMode(m, HAS_FS_API);
      void files.doOpen();
    },
    onAutosaveToggle: (on) => { setAutosave(on); },
    onAutosaveInterval: (sec) => { prefs.autosaveInterval = sec; applyAutosave(); },
    onReopenLast: () => { void files.reopenLast(); },
    onExportJson: () => { void files.exportJsonDownload(); },
    onExportStandalone: () => { void files.exportStandalone(); },
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
      addLabel: VIEWER ? undefined : opts.addLabel, onAdd: VIEWER ? undefined : (opts.onAdd || (formFn ? () => formFn(null, () => shell.refreshActive()) : undefined)),   // viewer : pas de création
      onShow: () => {
        if (!view) {
          const reRender = () => view!.render();
          view = new ListView(store, container, {
            ...cfg,
            actions: VIEWER
              ? { view: true, locate: !!opts.locate }   // viewer : consultation + localisation seulement (pas d'édition/clone/suppression)
              : { ...(cfg.actions || { view: true, edit: !!formFn, clone: true, del: true }), ...(opts.locate ? { locate: true } : {}) },
            onAction: async (act, id) => {
              if (act === "locate" && opts.locate) { shell.switchView("datacenter"); dcView.locate(opts.locate, id); dcView.setReturnAction(() => shell.switchView(name)); return; }
              if (act === "view") {
                if (cfg.collection === "equipments") Forms.equipmentDetail(store, formHost, id, reRender);
                else if (cfg.collection === "racks") Forms.rackDetail(store, formHost, id, reRender);
                else openDetail(cfg.collection, id);
                return;
              }
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
    openRackDetail: (id) => Forms.rackDetail(store, formHost, id, () => shell.refreshActive()),
    openEquipmentDetail: (id) => Forms.equipmentDetail(store, formHost, id, () => shell.refreshActive()),
    openEquipmentForm: (id) => Forms.equipment(store, formHost, id, () => shell.refreshActive()),   // modale d'ÉDITION (≠ détail)
    openCableForm: (id, opts) => Forms.cable(store, formHost, id, () => shell.refreshActive(), opts),
    assignSlot: (rackId, u, side, height, onDone) => Forms.assignSlot(store, formHost, rackId, u, side, height, onDone),
    assignSideSlot: (rackId, face, lr, col, uTop, onDone) => Forms.assignSideSlot(store, formHost, rackId, face, lr, col, uTop, onDone),
    assignWallSlot: (rackId, wall, margin, col, uTop, onDone) => Forms.assignWallSlot(store, formHost, rackId, wall, margin, col, uTop, onDone),
    assignCapSlot: (rackId, face, cx, cy, onDone) => Forms.assignCapSlot(store, formHost, rackId, face, cx, cy, onDone),
    openDatacenterForm: (id) => Forms.datacenter(store, formHost, id, () => shell.refreshActive()),
    openDoorForm: (dcId, doorId) => Forms.door(store, formHost, dcId, doorId, () => shell.refreshActive()),
    openWaypointForm: (id, opts) => Forms.waypoint(store, formHost, id, opts),
    openFloorForm: (loc, fl, opts) => Forms.floor(store, formHost, loc, fl, opts),
    openSiteForm: (id) => Forms.site(store, formHost, id, () => { dcView.buildToolbar(); dcView.render(); }),
    faceImageUrl: (eqId, face) => {
      const e: any = store.get("equipments", eqId);
      const fld = (EQUIP_FACE_IMG_FIELD as any)[face];
      const im: any = e && fld && e[fld] ? imageStore.get(e[fld]) : null;
      if (!im || !im.url) return null;
      const withEars = !!im.with_ears;   // arrière/« autre » : toujours false (coercé par le miroir)
      // REST : l'URL serveur (/images/{id}/blob) est STABLE par id → on y ajoute une version (octets) qui change quand
      // l'image est remplacée. Sans ce jeton, l'image remplacée resterait périmée (cache navigateur max-age + cache de
      // textures 3D, tous deux indexés par URL). En mode fichier, l'URL est déjà un objectURL unique par chargement.
      const url = im.url.startsWith("blob:") ? im.url : (im.url + "?v=" + (im.bytes || 0));
      return { url, withEars };
    },
  });
  // dcView existe désormais : une mutation d'image invalide la scène 3D (rebuild au prochain rendu de la vue DC).
  onImageMutated = () => dcView.invalidate3D();
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
      extraActions: [
        { label: "Importer des images…", title: "Charger une bibliothèque d'images .nmfb — ÉCRASE la bibliothèque actuelle ; les faces des équipements concernés seront à ré-assigner", onClick: () => files.importFacesLibrary() },
        { label: "Exporter les images", title: "Télécharger toute la bibliothèque d'images au format .nmfb (portable, ré-importable dans un autre document)", onClick: () => files.exportFacesLibrary() },
        // Compagnon (mode fichier uniquement) : .nmfb APPARIÉ au document, rechargé/enregistré automatiquement à côté du .json.
        ...(REST_MODE ? [] : [{ label: "Ouvrir un fichier de faces", title: "Charger le compagnon d'images .nmfb apparié au document (mode dossier : liste le dossier ; mode fichier : sélecteur)", onClick: () => files.openFacesFile() }]),
      ],
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
    form: (id) => { const f: any = id ? store.get("floors", id) : null; Forms.floor(store, formHost, f ? (f.location || "") : "", f ? String(f.floor || "") : "", {}); }, addLabel: "+ Étage", kind: "secondary", parent: "datacenter",
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
  shell.setDataSource(REST_MODE ? "api" : "local");   // position du toggle = mode EFFECTIF
  shell.setApiBaseUrl((prefs.apiBaseUrl && prefs.apiBaseUrl.trim()) || API_BASE_URL);
  shell.setLoginUrl(prefs.loginUrl);
  shell.setFileAccessMode(prefs.fileAccessMode);
  shell.setDebugLog(prefs.debugLog); Log.setEnabled(prefs.debugLog);
  shell.setUiScale(prefs.uiScale);
  shell.setRestMode(REST_MODE);   // mode API : masque les contrôles fichier
  // (l'auth SSO + la pastille utilisateur sont gérées par restBootstrap, au boot)

  // ---- état save-state ----
  // ---- barre de statut / undo-redo (cohérence avec l'état du store) ----
  const refreshChrome = () => {
    session.setFile(files.hasLinkedFile); session.setAutosave(prefs.autosave);   // synchronise le contexte de save
    shell.setDocName(store.meta.docName || "");
    // Mode API : la barre de statut est masquée (cf. Shell.setRestMode) → inutile de la peupler. On saute donc
    // setStatus, qui n'aurait aucun effet visible (champs fichier/source/sauvegarde sans objet côté serveur).
    if (!REST_MODE) {
      shell.setStatus({
        file: files.name || (store.meta.docName ? files.docFileName() : "— en mémoire —"),
        release: APP_RELEASE, source: prefs.dataSource === "api" ? "API" : adapter.label, entities: store.totalCount(), lastSave: "—",
      });
    }
    // mode API : pas d'undo client (le serveur fait autorité ; écritures immédiates) → boutons désactivés.
    shell.setUndoRedo(!REST_MODE && (store.canUndo() || imageStore.canUndo()), !REST_MODE && undoTimeline.redoDepth > 0 && (store.canRedo() || imageStore.canRedo()));
    shell.setSaveState(session.state());
  };
  undoTimeline.onChange = () => refreshChrome();   // note/reset de la timeline rafraîchissent les boutons undo/redo

  // UNDO / REDO UNIFIÉS : la timeline délègue à la bonne pile (modèle ou images) — cf. UndoTimeline.
  // Ordre d'enregistrement = priorité du filet de sécurité (modèle d'abord, comme historiquement).
  undoTimeline.register("model", store);
  undoTimeline.register("image", imageStore);
  const afterUndoRedo = (msg: string) => { shell.refreshActive(); refreshChrome(); Notify.toast(msg); };
  const doUndo = async (): Promise<void> => { if (await undoTimeline.undo()) afterUndoRedo("Annulé"); };
  const doRedo = async (): Promise<void> => { if (await undoTimeline.redo()) afterUndoRedo("Rétabli"); };
  undoTimeline.reset();   // état propre au boot (ignore un éventuel jeton parasite du newDocument initial)

  // cohérence inter-vues : toute mutation marque dirty + rafraîchit le chrome (pastille/undo) IMMÉDIATEMENT, et
  // débounce le re-render LOURD de la vue active. Le chrome est DÉCOUPLÉ du re-render : si `refreshActive()` lève
  // (erreur de rendu d'une vue), la pastille de dirty reste correctement mise à jour.
  let refreshQueued = false;
  store.onChange(() => {
    if (booted) session.setRevision(store.histIndex());   // révision modèle → dirty par comparaison (undo→point sauvé = propre)
    // Toute mutation de données invalide EXPLICITEMENT le cache de build WebGL → rebuild COMPLET au prochain refresh.
    // Indispensable en REST (histIndex() figé à 0, la garde de révision croirait la scène à jour) ET robuste en mode
    // fichier — sinon certaines mutations déclenchées hors drag (menu contextuel : retrait, rotation…) pouvaient ne
    // pas se répercuter en 3D. markStale est bon marché ; le rebuild n'a lieu qu'au render suivant (déjà planifié).
    dcView.invalidate3D();
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
  // restaure l'onglet BOOKMARKÉ depuis l'URL (#nom) si valide, sinon l'onglet par défaut.
  const bookmarkedView = (typeof location !== "undefined") ? decodeURIComponent(location.hash.replace(/^#/, "")) : "";
  shell.switchView(shell.hasView(bookmarkedView) ? bookmarkedView : "equipements");
  booted = true;

  // VISUALISEUR AUTONOME : charge le document EMBARQUÉ et passe en LECTURE SEULE (ni réseau ni accueil).
  if (VIEWER) {
    shell.hideWelcome();
    try {
      await store.replaceAll(EMBED);
      if (Array.isArray(EMBED.faceImages)) await imageStore.replaceAllFromLegacy(EMBED.faceImages); else await imageStore.clearAll();
    } catch (e) { console.error(e); Notify.toast("Document embarqué illisible", "err"); }
    undoTimeline.reset();
    document.body.classList.add("viewer-mode");   // interface allégée (cf. dc-manager.css) + édition bloquée
    modal.editLocked = true;                       // bloque toute modale d'ÉDITION (les fiches restent consultables)
    if (store.meta.docName) shell.setDocName(store.meta.docName);
    refreshChrome(); shell.refreshActive();
    (window as any).__DCMANAGER__ = { EntityRegistry, adapter, store, prefs, shell, graph, dcView, modal, tabChannel, files, imageStore };
    return;
  }
  // ÉCRAN D'ACCUEIL (mode FICHIER uniquement) : au (re)chargement le handle FS est perdu → on force une
  // ré-interaction pour le raccrocher. En mode API, les données viennent du serveur au boot → pas d'accueil.
  if (REST_MODE) {
    shell.hideWelcome();
    await restBootstrap();   // ouvre le dernier doc ouvert → défaut global → plus récent (ou en crée un) — cf. restBootstrap
  } else {
    const reopenName: string | null = HAS_FS_API ? await files.lastOpenName() : null;
    shell.showWelcome({ reopenName, mode: prefs.fileAccessMode, fsApi: HAS_FS_API });
  }

  (window as any).__DCMANAGER__ = { EntityRegistry, adapter, store, prefs, shell, graph, dcView, modal, tabChannel, files, imageStore };
}
boot();

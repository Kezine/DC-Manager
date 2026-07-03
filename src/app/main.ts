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
import { RestDocumentController } from "./RestDocuments";

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

  /* ---- MODE API : cycle de vie des documents SERVEUR extrait dans `RestDocumentController` (bootstrap SSO,
     ouverture/création/import/sélecteur, SSE + debounce/fusion des changesets, rechargement granulaire).
     Construit UNIQUEMENT en mode REST (les callbacks 409/400 de l'adapter sont câblés à la construction). */
  const rest = REST_MODE ? new RestDocumentController({
    adapter: adapter as RestAdapter, store, imageStore, session, prefs, hasFsApi: HAS_FS_API,
    setImagesBase: (base) => { if (imageBackend instanceof RestImageBackend) imageBackend.setBaseUrl(base); },
    injectedLoginUrl: INJECTED.loginUrl,
    host: {
      refreshChrome: () => refreshChrome(),
      refreshActive: () => shell.refreshActive(),
      documentOpened: () => { shell.hideWelcome(); shell.switchView("equipements"); refreshChrome(); shell.refreshActive(); },
      resetUndo: () => undoTimeline.reset(),
      setDisplayName: (name) => { files.name = name; },
      invalidate3D: () => dcView.invalidate3D(),
      setUser: (user) => shell.setUser(user),
      showAccessDenied: (opts) => shell.showAccessDenied(opts),
    },
  }) : null;

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

  // ---- services FICHIER / GLOBAUX (topbar) ----
  const shellHost: ShellHost = {
    onNew: async () => {
      if (REST_MODE) { const n = await Dialog.prompt("Nom du nouveau document", "Document"); if (n) await rest!.newDocument(n); return; }
      if (hasUserData()) {
        const ok = await Dialog.confirm({ title: "Nouveau document ?", message: "Le document courant (non enregistré) sera remplacé. Continuer ?", confirmLabel: "Nouveau", danger: true });
        if (!ok) return;
      }
      tabChannel.release(store.meta.fileId || null);
      await store.newDocument(); await imageStore.clearAll(); undoTimeline.reset(); files.detach(); session.markLoaded(store.histIndex());
      applyTheme(prefs.theme); shell.hideWelcome(); shell.switchView("equipements"); applyAutosave(); refreshChrome(); Notify.toast("Nouveau document");
    },
    onOpen: () => { if (rest) void rest.openChooser(); else void files.doOpen(); },
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
      if (rest && rest.docId) { files.name = name; try { await (adapter as RestAdapter).renameDocument(rest.docId, name); } catch (_) { /* registre best-effort */ } refreshChrome(); }
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
    await rest!.bootstrap();   // ouvre le dernier doc ouvert → défaut global → plus récent (ou en crée un) — cf. RestDocumentController.bootstrap
  } else {
    const reopenName: string | null = HAS_FS_API ? await files.lastOpenName() : null;
    shell.showWelcome({ reopenName, mode: prefs.fileAccessMode, fsApi: HAS_FS_API });
  }

  (window as any).__DCMANAGER__ = { EntityRegistry, adapter, store, prefs, shell, graph, dcView, modal, tabChannel, files, imageStore };
}
boot();

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
import { GraphView, ListView, ListConfigs, Forms, DatacenterView, VmForms, VmProvidersForm, VmSyncClient, VmClustersView, NotificationsAdminView, NotifyClient, CertsAdminView, CertsClient, InterventionsAdminView, InterventionsClient } from "../views";
import type { InterventionTargetSource, InterventionFicheHooks } from "../views";
import { FormBase } from "../views/forms/FormBase";
import { ImageStore, IdbImageBackend, RestImageBackend } from "../data";
import type { ListOptions, FormHost } from "../views";
import { Modal, Notify, FormControls, Dialog, Fullscreen, RichTooltip } from "../ui";
import { Html } from "../core/Html";
import { TargetSearch } from "../core/TargetSearch";
import { Schema } from "../../src-shared/Schema";
import { Download } from "../core/Download";
import { Prefs } from "../core/Prefs";
import { Log } from "../core/Log";
import { I18n } from "../i18n/I18n";
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
// Client de synchro VM (feature AMOVIBLE) — mode API SEULEMENT (null en mode fichier/viewer → boutons masqués).
// `adapter` est ici un RestAdapter (garanti par REST_MODE) ; il satisfait `VmRestContext` (dataBase/docId/headers/clientId publics).
const vmSyncClient = REST_MODE ? new VmSyncClient(adapter as RestAdapter) : null;
// Client du service de notifications (feature notify/ AMOVIBLE) — mode API SEULEMENT (null en mode fichier/viewer :
// la page admin affiche alors un message d'indisponibilité). Le RestAdapter satisfait `NotifyRestContext` (apiRoot/
// docId/headers/clientId publics) ; les routes notify sont GLOBALES (`<apiRoot>/notify`, non scopées par document).
const notifyClient = REST_MODE ? new NotifyClient(adapter as RestAdapter) : null;
// Client de la PKI interne (feature certs/ AMOVIBLE) — mode API SEULEMENT (null en mode fichier/viewer :
// la page admin affiche alors un message d'indisponibilité). Le RestAdapter satisfait `CertsRestContext`
// (dataBase/docId/headers/clientId publics) ; les routes certs sont SCOPÉES PAR DOCUMENT (`<dataBase>/certs`).
const certsClient = REST_MODE ? new CertsClient(adapter as RestAdapter) : null;
// Client du suivi d'interventions (feature interventions/ AMOVIBLE) — mode API SEULEMENT (null en mode
// fichier/viewer : la page affiche alors un message d'indisponibilité). Le RestAdapter satisfait
// `InterventionsRestContext` (dataBase/docId/headers/clientId publics) ; routes SCOPÉES PAR DOCUMENT (`<dataBase>/interventions`).
const interventionsClient = REST_MODE ? new InterventionsClient(adapter as RestAdapter) : null;
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
  // LOCALISATION : à initialiser AVANT toute construction d'UI (Shell, onglets…) — sinon `I18n.t()` jette. La
  // préférence de langue est lue depuis localStorage ; une bascule recharge la page (cf. I18n / docs/i18n.md).
  I18n.init();
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
    onConflict: () => Notify.toast(I18n.t("app.main.tabConflict"), "err"),
  });
  const handleStore = new HandleStore();

  const modal = new Modal();
  const formHost: FormHost = { openModal: (o) => modal.open(o), closeModal: () => modal.close(), setDirty: () => { refreshChrome(); }, autocompleteLimit: () => prefs.autocompleteMaxResults };   // mutation modèle déjà suivie par la révision (store.onChange)
  // bibliothèque d'images de façade (hors modèle : IndexedDB + miroir mémoire)
  // backend d'images selon le mode : IndexedDB (fichier, + compagnon .nmfb) · endpoints blob (REST). Cf. P2.
  const imageBackend = REST_MODE ? new RestImageBackend(API_BASE_URL) : new IdbImageBackend();
  // Hook tardif (dcView n'existe pas encore) : toute mutation d'image (y c. le mode d'oreilles, qui ne change PAS
  // l'URL) doit forcer une reconstruction 3D — sinon la scène garderait l'ancien gabarit de plan de façade.
  let onImageMutated: () => void = () => {};
  const imageStore = new ImageStore({ onDirty: () => { onImageMutated(); session.markDirty(); refreshChrome(); shell.refreshActive(); }, onUndoable: noteUndoable, backend: imageBackend });   // images HORS historique modèle, undo intégré à la timeline unifiée
  // Magasin d'images posé sur la BASE partagée FormBase : visible par la chaîne Forms (héritage) ET par
  // FaceEditor qui étend FormBase HORS de la chaîne Forms (sinon son `this.images` restait null → bouton
  // « Attacher une image » masqué et picker vide, cf. FaceEditor `extends FormBase`).
  FormBase.images = imageStore;   // singleton pour le picker d'image (faceEditor)
  imageStore.restoreLoadedKey();   // clé du bundle .nmfb actuellement en IndexedDB (persistée) — appariement json↔compagnon
  if (!REST_MODE) await imageStore.ready();   // en REST, le miroir est chargé à l'ouverture d'un document
  Fullscreen.install();   // re-parente les overlays (modale/dialogues/toasts/menus) dans l'élément plein écran
  RichTooltip.install();  // délégation UNIQUE des tooltips enrichis (data-rich-tooltip) — idempotent

  /* Onglet à afficher à l'OUVERTURE d'un document : on PRÉSERVE l'onglet actif — restauré du hash #nom au
     boot (lien rapide bookmarkable) ou choisi par l'utilisateur — au lieu de forcer « equipements » (ce qui
     écrasait systématiquement le fragment au load/reload : le boot restaurait le bon onglet, puis
     documentOpened re-switchait). Seul un document NEUF (menu « Nouveau ») ramène à l'onglet par défaut. */
  const viewAfterOpen = (): string => (shell.current && shell.hasView(shell.current)) ? shell.current : "equipements";

  /* ---- documents FICHIER : cycle de vie EXTRAIT dans `FileDocumentController` (ouvrir/enregistrer/rouvrir,
     mode dossier, compagnon .nmfb, exports) ; ici, seule l'adhérence à la boucle applicative. Les closures de
     l'hôte capturent des consts définies PLUS BAS (shell, refreshChrome, applyAutosave) — appelées après le boot. */
  const files = new FileDocumentController({
    store, imageStore, session, prefs, handleStore, tabChannel, hasFsApi: HAS_FS_API,
    host: {
      refreshChrome: () => refreshChrome(),
      refreshActive: () => shell.refreshActive(),
      documentOpened: () => { shell.hideWelcome(); shell.switchView(viewAfterOpen()); applyAutosave(); refreshChrome(); },
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
    confirmEnable: () => Dialog.confirm({ title: I18n.t("app.autosave.confirmTitle"), message: I18n.t("app.autosave.confirmMessage"), confirmLabel: I18n.t("app.autosave.confirmBtn") }),
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
      documentOpened: () => { shell.hideWelcome(); shell.switchView(viewAfterOpen()); refreshChrome(); shell.refreshActive(); },
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
    Notify.toast(I18n.t("app.main.invalidData", { head }) + (errors.length > 3 ? " …" : ""), "err");
  };
  // Échec de persistance HORS transaction (meta / snapshot) : sans ce câblage, un échec réseau (renommage,
  // import, dispositions de graphe) finissait en console.warn et l'UI croyait au succès.
  store.onPersistError = (op, e: any) => {
    const what = op === "meta" ? I18n.t("app.main.persistMeta") : I18n.t("app.main.persistDoc");
    Notify.toast(I18n.t("app.main.persistError", { what, error: (e && e.message) || e }), "err");
  };

  // NETTOYAGE des images de façade NON UTILISÉES (réglages → Maintenance) : purge de la bibliothèque après
  // confirmation. Mode FICHIER : élagage IndexedDB (keepOnly) → le prochain compagnon .nmfb n'embarque plus les
  // orphelins. Mode API : maintenance SERVEUR (purge + VACUUM — cf. Repository.maintenance) puis rechargement du
  // miroir. Manuel et confirmé : une image dé-référencée peut être volontairement conservée en bibliothèque.
  const purgeUnusedImages = async (): Promise<void> => {
    const refs = store.faceImageRefIds();
    const orphans = imageStore.list().filter((im: any) => !refs.has(im.id));
    if (!orphans.length && !REST_MODE) { Notify.toast(I18n.t("app.maint.noUnused")); return; }
    const ok = await Dialog.confirm({
      title: I18n.t("app.maint.cleanTitle"),
      message: I18n.t("app.maint.cleanMessage", { n: orphans.length }) + (REST_MODE ? I18n.t("app.maint.cleanVacuum") : ""),
      confirmLabel: I18n.t("app.maint.cleanConfirm"), danger: true,
    });
    if (!ok) return;
    if (REST_MODE) {
      const r = await (adapter as RestAdapter).maintenance();
      await imageStore.reloadFromBackend();
      const mb = (n: number) => (n / 1048576).toFixed(1) + " Mo";
      Notify.toast(r ? I18n.t("app.maint.purgedRest", { n: r.purgedImages, before: mb(r.bytesBefore), after: mb(r.bytesAfter) }) : I18n.t("app.maint.done"));
    } else {
      await imageStore.keepOnly(refs);
      Notify.toast(I18n.t("app.maint.purgedFile", { n: orphans.length }));
      session.markDirty(); refreshChrome();
    }
    shell.refreshActive();
  };

  // ---- services FICHIER / GLOBAUX (topbar) ----
  const shellHost: ShellHost = {
    onNew: async () => {
      if (REST_MODE) { const n = await Dialog.prompt(I18n.t("app.main.newDocPromptTitle"), "Document"); if (n) await rest!.newDocument(n); return; }
      if (hasUserData()) {
        const ok = await Dialog.confirm({ title: I18n.t("app.main.newDocTitle"), message: I18n.t("app.main.newDocMessage"), confirmLabel: I18n.t("app.main.newDocConfirm"), danger: true });
        if (!ok) return;
      }
      tabChannel.release(store.meta.fileId || null);
      await store.newDocument(); await imageStore.clearAll(); undoTimeline.reset(); files.detach(); session.markLoaded(store.histIndex());
      applyTheme(prefs.theme); shell.hideWelcome(); shell.switchView("equipements"); applyAutosave(); refreshChrome(); Notify.toast(I18n.t("app.main.newDocToast"));
    },
    onOpen: () => { if (rest) void rest.openChooser(); else void files.doOpen(); },
    onSave: () => { void files.doSave(); },
    onSaveAs: () => { void files.doSaveAs(); },
    onUndo: () => { void doUndo(); },   // timeline unifiée (modèle + images) ; révision suivie via onChange → dirty recalculé
    onRedo: () => { void doRedo(); },
    onToggleTheme: () => { prefs.theme = (prefs.theme === "light") ? "dark" : "light"; applyTheme(prefs.theme); dcView.onThemeChanged(); },
    onUiScale: (value) => { prefs.uiScale = value; applyUiScale(prefs.uiScale); shell.setUiScale(prefs.uiScale); },
    onAutocompleteMax: (value) => { prefs.autocompleteMaxResults = value; shell.setAutocompleteMax(prefs.autocompleteMaxResults); },
    onPurgeImages: () => { void purgeUnusedImages(); },
    onResetViewPrefs: () => {
      try { Object.keys(window.localStorage).filter((k) => k.startsWith("dcmanager.view3d")).forEach((k) => window.localStorage.removeItem(k)); } catch (_) { /* noop */ }
      dcView.resetView(); shell.refreshActive();   // force une restauration aux défauts à la prochaine activation
      Notify.toast(I18n.t("app.main.viewPrefsReset"));
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
        title: I18n.t("app.main.switchModeTitle"),
        message: I18n.t("app.main.switchModeMessage", { mode: target === "api" ? I18n.t("app.main.switchModeApi") : I18n.t("app.main.switchModeLocal") }),
        confirmLabel: I18n.t("app.main.switchModeConfirm"), cancelLabel: I18n.t("ui.action.cancel"), danger: true,
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
      const ok = await Dialog.confirm({ title: I18n.t("app.main.applyUrlTitle"), message: I18n.t("app.main.applyUrlMessage", { url: clean }), confirmLabel: I18n.t("app.common.reload"), cancelLabel: I18n.t("app.common.later") });
      if (ok) window.location.reload();
    },
    onLoginUrl: (url) => { prefs.loginUrl = url; shell.setLoginUrl(prefs.loginUrl); },   // utilisée par le bouton « Connexion » du welcome
    onFileAccessMode: (value) => {
      if (value === "directory" && !HAS_FS_API) { Notify.toast(I18n.t("app.main.dirModeUnavailable"), "err"); shell.setFileAccessMode("file"); return; }
      prefs.fileAccessMode = (value === "directory") ? "directory" : "file";
      if (prefs.fileAccessMode === "file") files.dirHandle = null;   // repasse en mode fichier → on oublie le dossier courant
      shell.setWelcomeMode(prefs.fileAccessMode, HAS_FS_API); refreshChrome();
      Notify.toast(prefs.fileAccessMode === "directory" ? I18n.t("app.main.dirModeOn") : I18n.t("app.main.fileModeOn"));
    },
    onOpenMode: (mode) => {
      const m = (mode === "directory") ? "directory" : "file";
      if (m === "directory" && !HAS_FS_API) { Notify.toast(I18n.t("app.main.dirModeUnavailable"), "err"); return; }
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
    onDebugLog: (on) => { prefs.debugLog = on; Log.setEnabled(on); Notify.toast(on ? I18n.t("app.main.debugOn") : I18n.t("app.main.debugOff")); },
  };

  const shell = new Shell(root, shellHost);

  // ---- fiche détail générique (lecture seule) ----
  const openDetail = (coll: string, id: string) => {
    const o: any = store.get(coll, id);
    if (!o) return;
    // Fiche DÉDIÉE (liens résolus, entités liées agrégées) si la collection en a une ; sinon repli GÉNÉRIQUE
    // (vidage champ-par-champ) pour les collections sans fiche (ports, agrégats, rackItems, waypoints…).
    if (Forms.detail(store, formHost, coll, id, () => shell.refreshActive())) return;
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
    modal.open({ title: Html.escape(o.name || o.label || I18n.t("app.main.detailFallback")), subtitle: coll, body, hideFooter: true });
  };

  // ---- onglets de LISTE (ListView paramétré par ListConfigs) ----
  type FormFn = (id: string | null, onSaved: () => void) => void;
  interface TabOpts { title?: string; subtitle?: string; form?: FormFn; addLabel?: string; kind?: "primary" | "secondary"; parent?: string; links?: string[]; onAdd?: () => void; onDel?: (id: string, reRender: () => void) => void; locate?: "equipment" | "rack" | "cable"; manage?: boolean; extraActions?: Array<{ label: string; onClick: (btn: HTMLButtonElement) => void; title?: string }>; }
  const addListTab = (name: string, label: string, configFn: (s: typeof store) => ListOptions, opts: TabOpts = {}) => {
    const cfg = configFn(store);
    const formFn = opts.form;
    let view: ListView | null = null;
    const container = shell.addView({
      name, label, title: opts.title, subtitle: opts.subtitle, kind: opts.kind || "primary", parent: opts.parent, links: opts.links,
      extraActions: opts.extraActions,   // boutons secondaires d'en-tête (ex. « Réseaux virtuels… » sur l'onglet VMs)
      count: () => store.all(cfg.collection).length,
      addLabel: VIEWER ? undefined : opts.addLabel, onAdd: VIEWER ? undefined : (opts.onAdd || (formFn ? () => formFn(null, () => shell.refreshActive()) : undefined)),   // viewer : pas de création
      onShow: () => {
        if (!view) {
          const reRender = () => view!.render();
          view = new ListView(store, container, {
            ...cfg,
            actions: VIEWER
              ? { view: true, locate: !!opts.locate }   // viewer : consultation + localisation seulement (pas d'édition/clone/suppression)
              : { ...(cfg.actions || { view: true, edit: !!formFn, clone: true, del: true }), ...(opts.locate ? { locate: true } : {}), ...(opts.manage ? { manage: true } : {}) },
            onAction: async (act, id) => {
              if (act === "locate" && opts.locate) { shell.switchView("datacenter"); dcView.locate(opts.locate, id); dcView.setReturnAction(() => shell.switchView(name)); return; }
              if (act === "manage" && cfg.collection === "racks") { Forms.rackContent(store, formHost, id, reRender); return; }   // ▦ Contenu : éditeur de montage des U
              if (act === "view") {
                if (cfg.collection === "equipments") Forms.equipmentDetail(store, formHost, id, reRender);
                else if (cfg.collection === "racks") Forms.rackDetail(store, formHost, id, reRender);
                else openDetail(cfg.collection, id);
                return;
              }
              if (act === "edit") { formFn?.(id, reRender); return; }
              if (act === "clone") {
                const c = cfg.collection === "equipments" ? await store.cloneEquipment(id) : await store.cloneSimple(cfg.collection, id);
                if (c) { reRender(); Notify.toast(I18n.t("app.main.itemCloned")); }
                return;
              }
              if (act === "del") {
                if (opts.onDel) { opts.onDel(id, reRender); return; }   // suppression spécifique (ex. site → décommissionnement)
                const o: any = store.get(cfg.collection, id);
                const ok = await Dialog.confirm({ title: I18n.t("app.main.deleteGenericTitle"), message: I18n.t("app.main.deleteGenericMessage", { name: o?.name || o?.label || I18n.t("app.main.deleteGenericItem") }), confirmLabel: I18n.t("ui.action.delete"), danger: true });
                if (!ok) return;
                await store.remove(cfg.collection, id);
                reRender(); Notify.toast(I18n.t("app.main.deleted"));
              }
            },
          });
        }
        view.render();
      },
    });
  };

  // === ONGLETS PRINCIPAUX (ordre de l'original) ===
  addListTab("equipements", I18n.t("tabs.equipements.label"), ListConfigs.equipments, {
    subtitle: I18n.t("tabs.equipements.subtitle"),
    form: (id, done) => Forms.equipment(store, formHost, id, done), addLabel: I18n.t("app.add.equipment"),
    links: ["groupes", "faceimages", "spares"], locate: "equipment",
  });
  // VMs : onglet de PREMIER NIVEAU (à côté d'Équipements) — ALIMENTÉ PAR LA SYNCHRO (Proxmox…). Pas de
  // `form`/`addLabel` : AUCUN bouton « + créer » en v1 (liste en lecture seule, cf. ListConfigs.vms `actions: view`) ;
  // les enrichissements locaux (notes + groupes) se font depuis la fiche. Actions d'en-tête (feature amovible) :
  //  - « Réseaux virtuels… » : mapping bridge/tag → réseau logique (méta) — les deux modes, hors viewer ;
  //  - « Synchroniser » : MODE API SEULEMENT (masqué en mode fichier — pas de serveur à interroger). L'ancien
  //    « Statut de synchro… » a migré vers le sous-onglet « Clusters » (état de synchro PAR provider + nœuds).
  // Sous-onglet « Clusters » (feature amovible, MODE API) : instancié plus bas si REST_MODE. Déclaré ICI pour que
  // le « Synchroniser » de la barre d'outils puisse le rafraîchir après une passe réussie (cf. onDone ci-dessous).
  let clustersView: VmClustersView | null = null;
  const vmExtraActions: NonNullable<TabOpts["extraActions"]> = VIEWER ? [] : [
    { label: I18n.t("app.vm.netMapping"), title: I18n.t("app.vm.netMappingTitle"), onClick: () => VmForms.netMapping(store, formHost) },
  ];
  if (REST_MODE && vmSyncClient) {
    const client = vmSyncClient;   // const → non-null capturé dans les closures (garde REST_MODE ci-dessus)
    // « Synchroniser » : après une passe réussie, rafraîchit le sous-onglet Clusters (le statut du cluster vit en
    // MÉMOIRE serveur, sans push SSE → on retire à la main). « Statut de synchro… » a été RETIRÉ : redondant avec
    // le sous-onglet Clusters (qui affiche désormais l'état de synchro PAR provider, cf. cadrage 2026-07-13).
    vmExtraActions.push(
      { label: I18n.t("app.vm.sync"), title: I18n.t("app.vm.syncTitle"), onClick: (btn) => { void VmForms.sync(client, btn, () => { void clustersView?.reload(); }); } },
    );
  }
  // L'onglet VMs expose le lien « Clusters » vers son sous-onglet — MODE API uniquement (masqué en mode fichier/viewer).
  const vmLinks = (REST_MODE && vmSyncClient) ? ["clusters"] : undefined;
  addListTab("vms", I18n.t("tabs.vms.label"), ListConfigs.vms, {
    title: I18n.t("tabs.vms.title"), subtitle: I18n.t("tabs.vms.subtitle"),
    extraActions: VIEWER ? undefined : vmExtraActions, links: vmLinks,
  });
  // Sous-onglet « Clusters » : vue PERSONNALISÉE (non-liste) enregistrée comme les vues Netmap/Datacenters
  // (shell.addView + classe dédiée à `.show()`), en `kind: "secondary"` rattachée à l'onglet VMs — on réutilise le
  // mécanisme de sous-onglet des listes (secondary + parent + lien d'en-tête) pour une vue custom. MODE API seulement.
  if (REST_MODE && vmSyncClient) {
    const client = vmSyncClient;
    // En-tête du sous-onglet : « Providers… » (gestion CRUD, NON-VIEWER seulement) avant « Actualiser ».
    // Après toute écriture, la modale rappelle `onChanged` → on recharge l'état des clusters (config à chaud).
    const clustersActions: NonNullable<TabOpts["extraActions"]> = [];
    if (!VIEWER) clustersActions.push({ label: I18n.t("app.vm.providers"), title: I18n.t("app.vm.providersTitle"), onClick: () => VmProvidersForm.open(formHost, client, () => { void clustersView?.reload(); }) });
    clustersActions.push({ label: I18n.t("app.vm.refresh"), title: I18n.t("app.vm.refreshTitle"), onClick: () => { void clustersView?.reload(); } });
    const clustersContainer = shell.addView({
      name: "clusters", label: I18n.t("tabs.clusters.label"), kind: "secondary", parent: "vms",
      title: I18n.t("tabs.clusters.label"), subtitle: I18n.t("tabs.clusters.subtitle"),
      extraActions: clustersActions,
      onShow: () => clustersView?.show(),
    });
    clustersView = new VmClustersView(store, clustersContainer, client, {
      // Rapprochement nœud→équipement rendu en LIEN : ouvre la fiche équipement (comme GraphView/DatacenterView).
      openEquipmentDetail: (id) => Forms.equipmentDetail(store, formHost, id, () => shell.refreshActive()),
    });
  }
  addListTab("racks", I18n.t("tabs.racks.label"), ListConfigs.racks, {
    subtitle: I18n.t("tabs.racks.subtitle"),
    form: (id, done) => Forms.rack(store, formHost, id, done), addLabel: I18n.t("app.add.rack"), locate: "rack", manage: true,
  });
  addListTab("cables", I18n.t("tabs.cables.label"), ListConfigs.cables, {
    subtitle: I18n.t("tabs.cables.subtitle"),
    form: (id, done) => Forms.cable(store, formHost, id, done), addLabel: I18n.t("app.add.cable"),
    links: ["reseaux", "porttypes", "cabletypes", "faisceaux"], locate: "cable",
  });
  addListTab("ipam", I18n.t("tabs.ipam.label"), ListConfigs.ipNetworks, {
    title: I18n.t("tabs.ipam.title"), subtitle: I18n.t("tabs.ipam.subtitle"),
    form: (id, done) => Forms.ipNetwork(store, formHost, id, done), addLabel: I18n.t("app.add.ipNetwork"),
    links: ["ipaddresses", "dhcpranges"],
  });

  // Netmap (GraphView) — « Netmap » est un NOM DE FONCTIONNALITÉ, conservé tel quel dans les deux langues (cf. catalogues).
  let graph: GraphView;
  const graphContainer = shell.addView({ name: "graph", label: I18n.t("tabs.graph.label"), subtitle: I18n.t("tabs.graph.subtitle"), onShow: () => graph.show() });
  const stage = document.createElement("div");
  stage.className = "graph-stage";
  stage.style.cssText = "position:relative;flex:1 1 auto;min-height:560px;background:var(--bg-2);overflow:hidden";
  graphContainer.appendChild(stage);
  graph = new GraphView(store, stage, {
    setDirty: () => { refreshChrome(); },
    openEquipmentDetail: (id) => Forms.equipmentDetail(store, formHost, id, () => shell.refreshActive()),
    // Overlay « VMs » : fiches détail des nœuds vm:/net: (routage générique DetailForms — mêmes conventions).
    openVmDetail: (id) => Forms.vmDetail(store, formHost, id, () => shell.refreshActive()),
    openNetworkDetail: (id) => Forms.networkDetail(store, formHost, id, () => shell.refreshActive()),
    deleteEquipment: async (id) => {
      const eq = store.get("equipments", id);
      const ok = await Dialog.confirm({ title: I18n.t("app.main.deleteGenericTitle"), message: I18n.t("app.main.deleteEqMessage", { name: eq?.name || I18n.t("app.main.deleteEqItem") }), confirmLabel: I18n.t("ui.action.delete"), danger: true });
      if (!ok) return;
      await store.remove("equipments", id);
      Notify.toast(I18n.t("app.main.eqDeleted"));
    },
    openModal: (opts) => modal.open(opts),
  });

  // Datacenters (vue 3D — tranche-pilote : caméra orbitale + salle/baies)
  let dcView: DatacenterView;
  const dcContainer = shell.addView({ name: "datacenter", label: I18n.t("tabs.datacenter.label"), subtitle: I18n.t("tabs.datacenter.subtitle"), links: ["salles", "etages", "sites"], onShow: () => dcView.show() });
  const dcStage = document.createElement("div");
  dcStage.className = "dc-stage";
  dcStage.style.cssText = "position:relative;flex:1 1 auto;min-height:560px;background:var(--bg-2);overflow:hidden";
  dcContainer.appendChild(dcStage);
  dcView = new DatacenterView(store, dcStage, {
    setDirty: () => { refreshChrome(); },
    openRackForm: (id) => Forms.rack(store, formHost, id, () => shell.refreshActive()),
    openRackDetail: (id) => Forms.rackDetail(store, formHost, id, () => shell.refreshActive()),
    openRackContentForm: (id) => Forms.rackContent(store, formHost, id, () => shell.refreshActive()),   // ▦ Contenu depuis la vue 2D

    openEquipmentDetail: (id) => Forms.equipmentDetail(store, formHost, id, () => shell.refreshActive()),
    openEquipmentForm: (id) => Forms.equipment(store, formHost, id, () => shell.refreshActive()),   // modale d'ÉDITION (≠ détail)
    openCableForm: (id, opts) => Forms.cable(store, formHost, id, () => shell.refreshActive(), opts),
    openCableBundleForm: (id) => Forms.cableBundle(store, formHost, id, () => shell.refreshActive()),   // clic sur un trunk 2D/3D
    assignSlot: (rackId, u, side, height, onDone) => Forms.assignSlot(store, formHost, rackId, u, side, height, onDone),
    assignSideSlot: (rackId, face, lr, col, uTop, onDone) => Forms.assignSideSlot(store, formHost, rackId, face, lr, col, uTop, onDone),
    assignWallSlot: (rackId, wall, margin, col, uTop, onDone) => Forms.assignWallSlot(store, formHost, rackId, wall, margin, col, uTop, onDone),
    assignCapSlot: (rackId, face, cx, cy, onDone) => Forms.assignCapSlot(store, formHost, rackId, face, cx, cy, onDone),
    openDatacenterForm: (id) => Forms.datacenter(store, formHost, id, () => shell.refreshActive()),
    openDoorForm: (dcId, doorId) => Forms.door(store, formHost, dcId, doorId, () => shell.refreshActive()),
    openWaypointForm: (id, opts) => Forms.waypoint(store, formHost, id, opts),
    openRackItemForm: (id) => Forms.rackItem(store, formHost, id, () => shell.refreshActive()),
    assignTraySlot: (trayItemId, onDone) => Forms.assignTraySlot(store, formHost, trayItemId, onDone),
    removeRackItem: async (id, onDone) => { if (store.get("rackItems", id)) { await store.remove("rackItems", id); Notify.toast(I18n.t("app.main.rackItemRemoved")); onDone?.(); } },
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
      // jeton de cache-busting : RÉVISION du binaire (bumpée par le serveur à chaque nouveau blob) — l'ancien
      // jeton (taille en octets) ne voyait pas un remplacement par un fichier de MÊME taille. Repli `bytes`
      // pour les images d'avant l'introduction de `rev`.
      const url = im.url.startsWith("blob:") ? im.url : (im.url + "?v=" + (im.rev != null ? im.rev : (im.bytes || 0)));
      return { url, withEars };
    },
  });
  // dcView existe désormais : une mutation d'image invalide la scène 3D (rebuild au prochain rendu de la vue DC).
  onImageMutated = () => dcView.invalidate3D();
  // « Localiser » depuis une fiche (modale) : ferme la modale, bascule en 3D, centre la caméra ; « Retour » rouvre la fiche.
  formHost.locate = (kind, id, ret) => { modal.close(); shell.switchView("datacenter"); dcView.locate(kind, id); dcView.setReturnAction(ret || null); };

  // === SOUS-VUES (atteintes par les liens d'en-tête ; surlignent leur onglet parent) ===
  addListTab("groupes", I18n.t("tabs.groupes.label"), ListConfigs.groups, {
    subtitle: I18n.t("tabs.groupes.subtitle"),
    form: (id, done) => Forms.group(store, formHost, id, done), addLabel: I18n.t("app.add.group"), kind: "secondary", parent: "equipements",
  });
  addListTab("spares", I18n.t("tabs.spares.label"), ListConfigs.spares, {
    subtitle: I18n.t("tabs.spares.subtitle"),
    form: (id, done) => Forms.spare(store, formHost, id, done), addLabel: I18n.t("app.add.spare"), kind: "secondary", parent: "equipements",
  });
  // Images de façade : bibliothèque hors modèle (ImageStore) → câblage dédié (CRUD via imageStore)
  {
    const cfg = ListConfigs.faceImages(store);
    let view: ListView | null = null;
    const container = shell.addView({
      name: "faceimages", label: I18n.t("tabs.faceimages.label"), subtitle: I18n.t("tabs.faceimages.subtitle"),
      kind: "secondary", parent: "equipements", links: [],
      count: () => imageStore.count(),
      extraActions: [
        { label: I18n.t("app.faces.import"), title: I18n.t("app.faces.importTitle"), onClick: () => files.importFacesLibrary() },
        { label: I18n.t("app.faces.export"), title: I18n.t("app.faces.exportTitle"), onClick: () => files.exportFacesLibrary() },
        // Compagnon (mode fichier uniquement) : .nmfb APPARIÉ au document, rechargé/enregistré automatiquement à côté du .json.
        ...(REST_MODE ? [] : [{ label: I18n.t("app.faces.openCompanion"), title: I18n.t("app.faces.openCompanionTitle"), onClick: () => files.openFacesFile() }]),
      ],
      addLabel: I18n.t("app.add.image"), onAdd: () => Forms.faceImage(imageStore, store, formHost, null, () => shell.refreshActive()),
      onShow: () => {
        if (!view) {
          const reRender = () => view!.render();
          view = new ListView(store, container, {
            ...cfg, items: () => imageStore.list(),
            actions: { view: false, edit: true, clone: true, del: true, download: true },
            onAction: async (act, id) => {
              if (act === "edit") { Forms.faceImage(imageStore, store, formHost, id, reRender); return; }
              if (act === "download") { const fi: any = imageStore.get(id); if (fi && fi.url) { const blob = await (await fetch(fi.url)).blob(); Download.blob(ImageStore.downloadName(fi.name, blob.type || fi.type), blob); } return; }
              if (act === "clone") { const fi: any = imageStore.get(id); if (fi && fi.url) { const blob = await (await fetch(fi.url)).blob(); await imageStore.add({ name: (fi.name || "image") + " (copie)", u_height: fi.u_height, face: fi.face, description: fi.description, blob, type: fi.type }); reRender(); Notify.toast(I18n.t("app.main.imageCloned")); } return; }
              if (act === "del") {
                const fi: any = imageStore.get(id); const n = store.faceImageUsageCount(id);
                const ok = await Dialog.confirm({ title: I18n.t("app.main.deleteImageTitle"), message: I18n.t("app.main.deleteImageMessage", { name: fi?.name || I18n.t("app.main.deleteImageItem") }) + (n ? I18n.t("app.main.deleteImageRefs", { n }) : ""), confirmLabel: I18n.t("ui.action.delete"), danger: true });
                if (!ok) return;
                await imageStore.remove(id); reRender(); Notify.toast(I18n.t("app.main.imageDeleted"));
              }
            },
          });
        }
        view.render();
      },
    });
  }
  addListTab("reseaux", I18n.t("tabs.reseaux.label"), ListConfigs.networks, {
    subtitle: I18n.t("tabs.reseaux.subtitle"),
    form: (id, done) => Forms.network(store, formHost, id, done), addLabel: I18n.t("app.add.network"), kind: "secondary", parent: "cables",
  });
  addListTab("faisceaux", I18n.t("tabs.faisceaux.label"), ListConfigs.cableBundles, {
    title: I18n.t("tabs.faisceaux.title"), subtitle: I18n.t("tabs.faisceaux.subtitle"),
    form: (id, done) => Forms.cableBundle(store, formHost, id, done), addLabel: I18n.t("app.add.bundle"), kind: "secondary", parent: "cables",
  });
  addListTab("porttypes", I18n.t("tabs.porttypes.label"), ListConfigs.portTypes, {
    title: I18n.t("tabs.porttypes.title"), subtitle: I18n.t("tabs.porttypes.subtitle"),
    kind: "secondary", parent: "cables",
  });
  addListTab("cabletypes", I18n.t("tabs.cabletypes.label"), ListConfigs.cableTypes, {
    subtitle: I18n.t("tabs.cabletypes.subtitle"),
    kind: "secondary", parent: "cables",
  });
  addListTab("ipaddresses", I18n.t("tabs.ipaddresses.label"), ListConfigs.ipAddresses, {
    title: I18n.t("tabs.ipaddresses.title"), subtitle: I18n.t("tabs.ipaddresses.subtitle"),
    form: (id, done) => Forms.ipAddress(store, formHost, id, done), addLabel: I18n.t("app.add.ipAddress"), kind: "secondary", parent: "ipam",
  });
  addListTab("salles", I18n.t("tabs.salles.label"), ListConfigs.datacenters, {
    title: I18n.t("tabs.salles.title"), subtitle: I18n.t("tabs.salles.subtitle"),
    form: (id, done) => Forms.datacenter(store, formHost, id, done), addLabel: I18n.t("app.add.datacenter"), kind: "secondary", parent: "datacenter",
  });
  addListTab("sites", I18n.t("tabs.sites.label"), ListConfigs.sites, {
    title: I18n.t("tabs.sites.title"), subtitle: I18n.t("tabs.sites.subtitle"),
    form: (id, done) => Forms.site(store, formHost, id, done), addLabel: I18n.t("app.add.site"), kind: "secondary", parent: "datacenter",
    onDel: async (id, reRender) => {
      const s: any = store.get("sites", id);
      const ok = await Dialog.confirm({ title: I18n.t("app.main.deleteSiteTitle", { name: s?.name || "" }), message: I18n.t("app.main.deleteSiteMessage"), confirmLabel: I18n.t("app.main.deleteSiteConfirm"), danger: true });
      if (!ok) return;
      await store.removeSite(id); Notify.toast(I18n.t("app.main.siteDecommissioned")); reRender();
    },
  });
  addListTab("etages", I18n.t("tabs.etages.label"), ListConfigs.floors, {
    title: I18n.t("tabs.etages.title"), subtitle: I18n.t("tabs.etages.subtitle"),
    form: (id) => { const f: any = id ? store.get("floors", id) : null; Forms.floor(store, formHost, f ? (f.location || "") : "", f ? String(f.floor || "") : "", {}); }, addLabel: I18n.t("app.add.floor"), kind: "secondary", parent: "datacenter",
    onAdd: () => { if (!store.sitesSorted().length) { Notify.toast(I18n.t("app.main.createSiteFirst"), "err"); return; } Forms.floor(store, formHost, "", "", { pick: true }); },
    onDel: async (id, reRender) => {
      const f: any = store.get("floors", id);
      const ok = await Dialog.confirm({ title: I18n.t("app.main.deleteFloorTitle"), message: I18n.t("app.main.deleteFloorMessage", { floor: f ? f.floor : "?", building: store.siteLabel(f ? (f.location || "") : "") }), confirmLabel: I18n.t("app.main.deleteFloorConfirm"), danger: true });
      if (!ok) return;
      await store.remove("floors", id); Notify.toast(I18n.t("app.main.floorPlanDeleted")); reRender();
    },
  });
  addListTab("dhcpranges", I18n.t("tabs.dhcpranges.label"), ListConfigs.dhcpRanges, {
    title: I18n.t("tabs.dhcpranges.title"), subtitle: I18n.t("tabs.dhcpranges.subtitle"),
    form: (id, done) => Forms.dhcpRange(store, formHost, id, done), addLabel: I18n.t("app.add.dhcpRange"), kind: "secondary", parent: "ipam",
  });
  // CONTACTS : carnet des destinataires des NOTIFICATIONS (email/sms), tenu PAR DOCUMENT. Le module serveur
  // notify/ route ses alertes via `repo.getOne("contacts", id)` (référence souple `contact_id`, HORS document).
  // SOUS-PAGE du groupe « Paramètres » (S6, cf. cadrage notifications 2026-07-14 §3) : vraie vue `kind:"secondary"`
  // rattachée au groupe `parametres`, atteinte par son menu déroulant (et bookmarkable via #contacts). Décision Q4 :
  // contacts PAR DOCUMENT.
  addListTab("contacts", I18n.t("tabs.contacts.label"), ListConfigs.contacts, {
    title: I18n.t("tabs.contacts.title"), subtitle: I18n.t("tabs.contacts.subtitle"),
    form: (id, done) => Forms.contact(store, formHost, id, done), addLabel: I18n.t("app.add.contact"),
    kind: "secondary", parent: "parametres",
  });
  // NOTIFICATIONS (S7) : page d'ADMINISTRATION du module serveur notify/ (canaux, abonnements, rappels, alertes
  // actives, historique, tests d'envoi). SOUS-PAGE du groupe « Paramètres » (vue custom, pattern VmClustersView).
  // TOUJOURS enregistrée (visible dans le menu Paramètres, même en mode fichier) : `notifyClient` est null hors
  // mode API → la vue affiche un message « nécessite le mode API/serveur » au lieu d'appeler le réseau (feature
  // AMOVIBLE : retirer S7 = supprimer NotificationsAdminView + NotifyClient + ces lignes).
  let notificationsView: NotificationsAdminView;
  const notifyContainer = shell.addView({
    name: "notifications", label: I18n.t("tabs.notifications.label"), kind: "secondary", parent: "parametres",
    title: I18n.t("tabs.notifications.label"), subtitle: I18n.t("tabs.notifications.subtitle"),
    onShow: () => notificationsView.show(),
  });
  notificationsView = new NotificationsAdminView(store, notifyContainer, notifyClient, formHost);   // formulaires dans LA modale de l'app (principe n°11)
  // INTERVENTIONS : page d'ADMINISTRATION du suivi des incidents & interventions (liés aux équipements/VMs/
  // spares). ONGLET PRINCIPAL (décision de cadrage), enregistré JUSTE AVANT « Certificats ». Vue custom
  // TOUJOURS enregistrée : `interventionsClient` est null hors mode API → la vue affiche « mode API requis »
  // (feature AMOVIBLE : retirer = supprimer InterventionsAdminView + InterventionsClient + InterventionsFormat
  // + ces lignes). Les cibles liables viennent d'une interface hôte INJECTÉE (la vue ne touche jamais le Store).
  const targetFallback = (kind: string): string => I18n.t(kind === "equipment" ? "interventions.target.fallback.equipment" : kind === "vm" ? "interventions.target.fallback.vm" : "interventions.target.fallback.spare");
  const targetLabel = (kind: string, r: any): string => {
    if (kind === "spare") return (r.displayName ? r.displayName() : r.name) || r.serial || targetFallback(kind);
    return r.name || targetFallback(kind);
  };
  const targetCollection = (kind: string): string => (kind === "equipment" ? "equipments" : kind === "vm" ? "vms" : "spares");
  const interventionTargets: InterventionTargetSource = {
    labelOf: (kind, id) => { const r: any = store.get(targetCollection(kind), id); return r ? targetLabel(kind, r) : null; },
    // Recherche UNIFIÉE des cibles liables : concatène les 3 familles en items {kind,id,label} puis délègue le
    // tri de pertinence (préfixe avant inclusion), le plafond et la dédup (cibles déjà liées) au module pur
    // TargetSearch, avec la normalisation PARTAGÉE Schema.normSearch (insensibilité casse/accents).
    search: (query, excluded) => {
      const families: ReadonlyArray<readonly [string, string]> = [["equipment", "equipments"], ["vm", "vms"], ["spare", "spares"]];
      const items = families.flatMap(([kind, coll]) => store.all(coll).map((r: any) => ({ kind, id: r.id, label: targetLabel(kind, r) })));
      return TargetSearch.rank(items, query, { normalize: Schema.normSearch, limit: 12, excluded });
    },
    // Ouvre la FICHE DE DÉTAIL existante de la cible (equipment/vm/spare) via la machinerie des fiches. Le
    // retour-auto à la modale de détail de l'intervention passe par l'option GÉNÉRIQUE onClose d'openModal
    // (appelée à TOUTE fermeture) : un hôte enveloppant l'injecte dans l'ouverture de la fiche (overlay UNIQUE).
    openTargetDetail: (kind, id, onClosed) => {
      const wrappedHost: FormHost = { ...formHost, openModal: (o) => modal.open({ ...o, onClose: onClosed }) };
      Forms.detail(store, wrappedHost, targetCollection(kind), id, () => shell.refreshActive());
    },
  };
  let interventionsView: InterventionsAdminView;
  const interventionsContainer = shell.addView({
    name: "interventions", label: I18n.t("tabs.interventions.label"), kind: "primary",
    title: I18n.t("tabs.interventions.label"), subtitle: I18n.t("tabs.interventions.subtitle"),
    onShow: () => interventionsView.show(),
  });
  interventionsView = new InterventionsAdminView(interventionsContainer, interventionsClient, formHost, interventionTargets);   // formulaires dans LA modale de l'app (principe n°11)
  // INTÉGRATION « FICHES » (badge + déclaration depuis équipement/VM/spare) : hooks injectés dans les fiches
  // via FormHost (contrat découplé — les formulaires n'importent NI la vue NI le client interventions). null
  // hors mode API → aucune rangée « Interventions » dans les fiches. `declareFor` FERME la fiche courante
  // (fait par InterventionFicheRow) PUIS navigue vers l'onglet et ouvre la modale de création pré-liée (la
  // modale de l'app est un overlay UNIQUE, pas d'empilement — cf. Modal).
  const interventionHooks: InterventionFicheHooks | null = interventionsClient ? {
    countOpen: async (kind, id) => { const map = await interventionsClient.counts([{ kind, id }]); return map[kind + ":" + id] || 0; },
    declareFor: (kind, id, label) => { shell.switchView("interventions"); interventionsView.openCreateFor(kind, id, label); },
  } : null;
  formHost.interventionHooks = interventionHooks;
  // CERTIFICATS (C6) : page d'ADMINISTRATION de la PKI interne (clé maître, arbre CA/dérivés, créations
  // X.509/SSH, exports, révocation, aide au déploiement de la confiance). ONGLET PRINCIPAL de premier niveau
  // (décision utilisateur 2026-07-15 : « ce n'est pas vraiment un paramètre ») — enregistré EN DERNIER parmi les
  // primaires, juste AVANT le groupe « Paramètres », donc rendu comme dernier onglet primaire de la barre. Le
  // hash #certificats reste inchangé (bookmarkable). Vue custom (pattern NotificationsAdminView) TOUJOURS
  // enregistrée : `certsClient` est null hors mode API → la vue affiche « mode API requis » (feature AMOVIBLE :
  // retirer C6 = supprimer CertsAdminView + CertsClient + CertsFormat + ces lignes).
  let certsView: CertsAdminView;
  const certsContainer = shell.addView({
    name: "certificats", label: I18n.t("tabs.certificats.label"), kind: "primary",
    title: I18n.t("tabs.certificats.label"), subtitle: I18n.t("tabs.certificats.subtitle"),
    onShow: () => certsView.show(),
  });
  certsView = new CertsAdminView(certsContainer, certsClient, formHost);   // formulaires dans LA modale de l'app (principe n°11)
  // GROUPE « Paramètres » : onglet TOUJOURS DÉROULANT (jamais une vue) regroupant les pages rarement visitées.
  // EN DERNIER (après les onglets métier ET l'onglet Certificats).
  shell.addGroup({ name: "parametres", label: I18n.t("tabs.parametres.label"), kind: "group", children: ["contacts", "notifications"] });

  shell.build();
  shell.setDataSource(REST_MODE ? "api" : "local");   // position du toggle = mode EFFECTIF
  shell.setApiBaseUrl((prefs.apiBaseUrl && prefs.apiBaseUrl.trim()) || API_BASE_URL);
  shell.setLoginUrl(prefs.loginUrl);
  shell.setFileAccessMode(prefs.fileAccessMode);
  shell.setDebugLog(prefs.debugLog); Log.setEnabled(prefs.debugLog);
  shell.setUiScale(prefs.uiScale);
  shell.setAutocompleteMax(prefs.autocompleteMaxResults);
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
        file: files.name || (store.meta.docName ? files.docFileName() : I18n.t("shell.status.inMemory")),
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
  const doUndo = async (): Promise<void> => { if (await undoTimeline.undo()) afterUndoRedo(I18n.t("app.main.undone")); };
  const doRedo = async (): Promise<void> => { if (await undoTimeline.redo()) afterUndoRedo(I18n.t("app.main.redone")); };
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
    } catch (e) { console.error(e); Notify.toast(I18n.t("app.main.embedUnreadable"), "err"); }
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

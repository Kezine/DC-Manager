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
import { GraphView, ListView, ListConfigs, Forms, DatacenterView, VmForms, VmProvidersForm, VmPurgeForm, VmSyncClient, VmClustersView, WifiForms, WifiProvidersForm, WifiSyncClient, NotificationsAdminView, NotifyClient, CertsAdminView, CertsClient, InterventionsAdminView, InterventionsClient, TrackerSyncClient } from "../views";
import type { InterventionTargetSource, InterventionFicheHooks } from "../views";
import { FormBase } from "../views/forms/FormBase";
import { AttachmentUi } from "../views/forms/AttachmentUi";   // téléchargement d'une pièce jointe (action de ligne du sous-onglet + purge maintenance)
import { GlobalSearchPalette } from "../views/GlobalSearchPalette";   // palette de recherche globale (loupe topbar + Ctrl+K)
import { UserInfoModal } from "../views/UserInfoModal";   // modale d'infos utilisateur (clic sur la pastille de la topbar)
import { GlobalSearchSources } from "../views/GlobalSearchSources";   // familles à fiche = périmètre envoyé à la recherche transverse serveur (mode API)
import { ImageStore, IdbImageBackend, RestImageBackend, AttachmentStore, IdbAttachmentBackend, RestAttachmentBackend } from "../data";
import type { ListOptions, FormHost } from "../views";
import { Modal, Notify, FormControls, Dialog, Fullscreen, RichTooltip, Icons, ScanControl, LabelPrintDialog, CartPanel } from "../ui";
import { LABEL_FONT_CSS } from "../ui/LabelFontAssets";   // fonte embarquée du document d'impression (import DIRECT, hors barrel : il ne doit pas remonter dans les tests Node)
import { LabelSubjects } from "../core/LabelSubjects";
import type { LabelSubject } from "../core/LabelHtml";   // sujets de la PLANCHE du panier (cf. docs/panier.md)
import { CartFamilies } from "../core/CartFamilies";            // famille d'une collection (invariant mono-famille du panier)
import { CartLabelPlans } from "../core/CartLabelPlan";         // « imprimer un panier » : sujet de politique + étiquettes par élément   // matière des étiquettes imprimables (lot E étiquettes QR) — constructeurs par famille
import { Html } from "../core/Html";
import type { RemoteListReader } from "../core/StoreListRowSource";   // lecteur SERVEUR des listings (mode API — lot 3)
import { EntityCandidateSource, type EntitySearchReader, type EntityCandidateFamily } from "../core/EntityCandidates";   // candidats d'entités serveur-pilotés (mode API — lot 4)
import { CollectionPickerSource } from "../core/EntityPickerSource";   // source standard du picker ASYNC (parcours + recherche + libellés — chantier picker async)
import { UserDirectory } from "../core/UserDirectory";   // annuaire client (résolution des auteurs d'audit — mode API)
import { InterventionsFormat } from "../core/InterventionsFormat";   // OPEN_STATUS_SLUGS : filtre du comptage « interventions ouvertes »
import { CertsFormat } from "../core/CertsFormat";   // libellés/échéances des certs — famille externe de la recherche globale
import type { InterventionRecord } from "../views/forms/InterventionsClient";   // cache des enregistrements pour l'ouverture depuis la palette
import { CertTargetMatch } from "../core/CertTargetMatch";   // moteur PUR du rapprochement certificat ↔ équipement/VM (calculé)
import { VmLocate } from "../core/VmLocate";   // « Localiser » une VM = localiser son HÔTE (prédicat PUR, feature VM AMOVIBLE)
import { VmPurge } from "../core/VmPurge";   // « y a-t-il des VMs à purger ? » — prédicat PUR de visibilité du bouton « Purger… »
import { WifiLocate } from "../core/WifiLocate";   // « Localiser » un client wifi = localiser son AP (prédicat PUR, feature WIFI AMOVIBLE)
import type { NetworkIdentity } from "../core/CertTargetMatch";
import type { CertFicheHooks, CertFicheMatch } from "../views/CertFicheHooks";
import type { CertTargetResolver } from "../views/CertsAdminView";
import type { CertificateListItem } from "../views/forms/CertsClient";
import { Download } from "../core/Download";
import { HydrationState } from "../core/HydrationState";   // état d'hydratation par collection (lot 0 lazy-load — injecté en mode API seulement)
import { LAZY_COLLECTIONS_API } from "../core/LazyCollections";   // LA liste des collections chargées paresseusement (vague 1 : contacts)
import { TargetLabelResolution } from "../core/TargetLabelResolution";   // résolution GROUPÉE des libellés de cibles d'intervention (vague 4)
import { Prefs } from "../core/Prefs";
import { ThemeResolution, type ThemePreference } from "../core/ThemeResolution";   // préférence clair/auto/sombre → thème EFFECTIF (module pur, testé)
import { AccessState } from "../core/AccessState";   // état d'AUTORISATION du client (lot 2 auth/ACL — `ALL` en mode fichier : injection nulle)
import { ViewAccess } from "../core/ViewAccess";     // vues NON-listing → leur permission de lecture (les listings, eux, dérivent de leur collection)
import { ViewRestoration } from "../core/ViewRestoration";   // QUELLE vue activer (boot, arrivée des droits, ouverture de document) — décision PURE
import type { ViewRestorationState } from "../core/ViewRestoration";
import { SessionExpiry } from "../core/SessionExpiry";   // verrou idempotent « session expirée → retour au login » (mode API)
import { Log } from "../core/Log";
import { Format } from "../core/Format";   // taille lisible des pièces jointes purgées (toast de maintenance)
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
import { AppLink } from "../../src-shared/AppLink";         // grammaire PARTAGÉE des liens directs (fiche · intervention · cert · recherche) — lecture AGNOSTIQUE de l'hôte imprimé
import { AppLinkOpener } from "./AppLinkOpener";            // exécution d'un lien direct : cible → onglet activé + modale ouverte (hash + greffon de scan)
import type { AppLinkTarget } from "../../src-shared/AppLink";

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
// ÉTAT D'HYDRATATION par collection (chantier lazy-load — cf. docs/hydratation.md) : en mode API, état
// TRAÇANT + la liste des collections chargées PARESSEUSEMENT (cf. `core/LazyCollections` — le SEUL
// endroit où cette liste s'écrit) ; en mode fichier/visualiseur,
// INJECTION NULLE → le Store fabrique l'état INERTE « tout full, par construction » et IGNORE la liste
// (« le document EST le fichier », principe n°15). D'où UN seul test de mode ici, aucun dans les modules.
/* ---- AUTORISATION (lot 2 auth/ACL, cf. docs/auth.md § « Gating côté client ») ----------------------
   ÉTAT COURANT de ce que l'utilisateur a le droit de faire. Il vit ICI, dans la racine de composition,
   et DESCEND partout par des PRÉDICATS (jamais par un import d'un état global depuis une vue) :
     · le Shell reçoit `visible` / `canAdd` par vue ;
     · les listings reçoivent leurs raffinements d'action de ligne ;
     · les fiches lisent `FormBase.access` (chaîne statique — même accroche que `FormBase.images`) ;
     · la vue Datacenter reçoit `canEditSpace` par son hôte ;
     · le STORE reçoit l'ASSIETTE DE LECTURE (correctif « droits partiels » — ci-dessous).
   Les prédicats relisent la variable à CHAQUE évaluation → un changement de droits à chaud (403 en vol
   → relecture de `/me`) se propage sans reconstruire quoi que ce soit.
   🚨 MODE FICHIER / VISUALISEUR : `AccessState.ALL`, donc tous ces prédicats rendent VRAI par
   construction — c'est l'injection nulle (patron `HydrationState`), et c'est ce qui garantit que le
   mode fichier ne change pas d'un pixel. C'est l'UNIQUE test de mode de tout le gating.
   MODE API : `NONE` jusqu'à la réponse de `GET /me` (le bootstrap REST l'installe) — on n'affiche pas
   d'onglet avant de savoir, plutôt que d'en afficher puis d'en retirer.
   ⚠ Déclaré au niveau MODULE (et non dans `boot()`) parce que le Store, construit ici même, en dépend. */
let access: AccessState = REST_MODE ? AccessState.NONE : AccessState.ALL;
/* Identité de session courante (réponse `/me`, mode API) — CAPTURÉE au passage de `setUser` pour la
   modale d'infos utilisateur (clic sur la pastille de la topbar). null = non connecté / mode fichier :
   la pastille est alors masquée, la modale n'est jamais ouverte. AUCUN appel serveur — donnée déjà reçue. */
let currentAuthUser: { name?: string; prenom?: string; nom?: string; login?: string; email?: string; eMail?: string } | null = null;
/* ASSIETTE DE LECTURE du Store (correctif « droits partiels », docs/auth.md § 10.6) : le plan de
   chargement du document est INTERSECTÉ avec les collections lisibles, au point commun `Store.init`.
   Même forme que `FormBase.access` — un objet de PRÉDICATS qui relit `access` à chaque appel, jamais
   l'instance (immuable et remplacée à chaque changement de droits). Mode fichier/visualiseur : rien
   n'est injecté (injection nulle) → aucune collection ne peut y être interdite, PAR CONSTRUCTION. */
const store = new Store(adapter, REST_MODE ? new HydrationState() : null, LAZY_COLLECTIONS_API,
  REST_MODE ? { canReadCollection: (collection: string) => access.canReadCollection(collection) } : null);
// LECTEUR SERVEUR des listings (lot 3 « listings serveur-pilotés », cf. docs/recherche.md) — mode API
// SEULEMENT. Injecté dans chaque `ListView` : une requête ACTIVE (recherche saisie, ou filtre de cible
// traduisible en `where`) est alors servie par le SERVEUR (colonne `search` enrichie), avec anti-rebond,
// annulation et repli local. null en mode fichier/viewer → les listings restent 100 % locaux, sans jamais
// toucher au réseau (principe n°15). `Store.list` absorbe les lignes reçues : ce sont des entités du Store,
// donc les colonnes (rendus, tris, liens) fonctionnent à l'identique.
const listRemoteReader: RemoteListReader | null = REST_MODE ? {
  list: async (collection, { query, where, limit, signal }) =>
    (await store.list(collection, { query, where, pageSize: limit, signal })).rows,
  // PAGE serveur d'une collection NON hydratée (garde G4, cf. docs/hydratation.md) : le MÊME `Store.list`,
  // mais on remonte aussi les compteurs — `total` est un `COUNT(*)` SQL, c'est lui qui rend le pager RÉEL.
  // `sort` (pagination ORDONNÉE complète, lot 1b) : le critère de tri du listing, mappé en champ serveur
  // par la vue (`core/ListServerSort`), part en `sort`/`dir` — l'ORDER BY ordonne le CORPUS entier.
  // Les lignes reçues sont absorbées au Store (`_absorbRecord`), donc l'état d'hydratation passe à `partial`.
  page: async (collection, { page, pageSize, where, sort, signal }) => {
    const res = await store.list(collection, { page, pageSize, where, sort: sort ? sort.field : null, dir: sort ? sort.dir : null, signal });
    return { rows: res.rows, total: res.total, page: res.page, pages: res.pages };
  },
} : null;
// LECTEUR SERVEUR des CANDIDATS d'entités (lot 4) — mode API SEULEMENT. La recherche transverse
// `GET …/search` restreinte aux collections des familles → records par collection, en UN aller-retour.
// Injecté dans `EntityCandidateSource` (éditeur de liens d'intervention + filtres CIBLE des listings) :
// en mode API, les candidats viennent du SERVEUR (au-delà du corpus chargé) ; null en mode fichier/viewer
// → les sources restent 100 % locales, sans jamais toucher au réseau (principe n°15). Même route que la
// palette globale, mais les collections VARIENT selon les familles du point de recherche (d'où le paramètre).
const entitySearchReader: EntitySearchReader | null = REST_MODE ? {
  search: async (query, collections, signal) => (await (adapter as RestAdapter).searchAll(query, { collections, signal })).results,
} : null;
// Client de synchro VM (feature AMOVIBLE) — mode API SEULEMENT (null en mode fichier/viewer → boutons masqués).
// `adapter` est ici un RestAdapter (garanti par REST_MODE) ; il satisfait `VmRestContext` (dataBase/docId/headers/clientId publics).
const vmSyncClient = REST_MODE ? new VmSyncClient(adapter as RestAdapter) : null;
// Client de synchro des CLIENTS WIFI (feature AMOVIBLE) — mode API SEULEMENT, même montage que le client VM
// (le RestAdapter satisfait `WifiRestContext` ; routes SCOPÉES PAR DOCUMENT, `<dataBase>/wifi`).
const wifiSyncClient = REST_MODE ? new WifiSyncClient(adapter as RestAdapter) : null;
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
// Client du PONT « interventions ⇄ tracker distant » (module serveur tracker/ AMOVIBLE) — mode API
// SEULEMENT, donc jamais en viewer (REST_MODE l'exclut) : la réplication et la configuration des
// providers ÉCRIVENT. null ⇒ la vue Interventions n'affiche ni actions de pont, ni bloc « Ticket »,
// ni pastille de statut, sans une condition de plus dans son code. Le RestAdapter satisfait
// `TrackerRestContext` ; routes SCOPÉES PAR DOCUMENT (`<dataBase>/tracker`).
const trackerClient = REST_MODE ? new TrackerSyncClient(adapter as RestAdapter) : null;
// Annuaire utilisateurs (service CORE, mode API SEULEMENT — null en mode fichier/viewer : aucune identité serveur,
// donc aucune ligne « Créé/Modifié par » dans les fiches). Le RestAdapter satisfait `UserResolverClient`
// (méthode `resolveUsers` → endpoint batch GET /users/resolve). Injecté dans les fiches via FormHost. Cf. docs/user-resolver.md.
const userDirectory = REST_MODE ? new UserDirectory(adapter as RestAdapter) : null;
const W = window as any;
const HAS_FS_API = typeof W.showSaveFilePicker === "function" && typeof W.showOpenFilePicker === "function";
/** Onglet d'ACCUEIL de l'application — la cible quand ni la vue courante ni le hash ne tranchent
    (cf. `core/ViewRestoration`). Nommé ici plutôt que répété en littéral aux trois points de décision. */
const DEFAULT_VIEW = "equipements";

/** Le document est-il « non vide » (au-delà des seuls catalogues fermés réinjectés) ? */
function hasUserData(): boolean { return store.totalCount() > store.all("portTypes").length + store.all("cableTypes").length; }

/** Ce que préfère le SYSTÈME (OS / navigateur). Interrogé UNE fois et gardé : l'objet `MediaQueryList`
    reste vivant — son `.matches` suit l'état courant, et c'est LUI qui notifie un changement en cours
    de session (bascule nuit automatique). `null` si `matchMedia` manque : on retombe alors sur le
    thème sombre, celui que la feuille de style applique en l'absence d'attribut. */
const systemDarkQuery: MediaQueryList | null = (typeof window.matchMedia === "function") ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const systemPrefersDark = (): boolean => !!(systemDarkQuery && systemDarkQuery.matches);

/** Applique une PRÉFÉRENCE de thème au document. La préférence (« light » | « auto » | « dark ») n'est
    JAMAIS écrite telle quelle dans `data-theme` : `ThemeResolution.effective` la résout d'abord en
    thème réel, le système n'étant consulté que pour « auto » (cf. core/ThemeResolution). */
function applyTheme(pref: ThemePreference): void {
  if (ThemeResolution.effective(pref, systemPrefersDark()) === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}
/** Applique l'échelle d'interface (zoom global piloté par --ui-scale, cf. dc-manager.css `body { zoom }`). */
function applyUiScale(scale: number): void {
  document.documentElement.style.setProperty("--ui-scale", String(scale || 1));
}
/** Active/désactive les modales PLEIN ÉCRAN en desktop via `data-modal-fs` sur <html> (même pattern que le thème,
    CSS seul — pas de resize JS). Sous le breakpoint responsive, le plein écran s'applique de toute façon (règle miroir). */
function applyModalFullscreen(on: boolean): void {
  if (on) document.documentElement.setAttribute("data-modal-fs", "");
  else document.documentElement.removeAttribute("data-modal-fs");
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
  applyModalFullscreen(prefs.modalFullscreen);   // préférence « modales plein écran » (desktop) — attribut posé AVANT toute ouverture

  const root = document.getElementById("app");
  if (!root) return;

  // ---- état FICHIER / session ----
  // L'état fichier (handles, nom) et tout le cycle de vie fichier/compagnon vivent dans `FileDocumentController`
  // (cf. app/FileDocuments — découpage P4 de boot()). Ici : la session de save + les dépendances qu'on lui injecte.
  const session = new SaveState();      // suivi dirty/save (révision modèle vs dernière sauvegarde + meta/images)
  let booted = false;                   // garde : ne suit pas la révision pendant le chargement initial

  /* AUTORISATION : l'état `access` est déclaré au niveau MODULE (cf. son bloc, au voisinage du Store —
     qui en dépend pour son assiette de lecture). Ne restent ici que les prédicats qui en dérivent. */
  /** Une VUE NON-LISTING est-elle lisible ? Sa permission vient de la carte `ViewAccess` (verrouillée par
      test : une vue déclarée sans entrée casse la suite). Vue hors carte ⇒ visible (elle n'est pas gatée). */
  const canSeeView = (name: string): boolean => {
    const permission = ViewAccess.readPermissionOf(name);
    return !permission || access.has(permission);
  };

  const tabChannel = new TabChannel({
    enabled: HAS_FS_API && !REST_MODE,   // verrou inter-onglets = concept FICHIER ; en mode API le serveur arbitre (cf. P3)
    onConflict: () => Notify.toast(I18n.t("app.main.tabConflict"), "err"),
  });
  const handleStore = new HandleStore();

  const modal = new Modal();
  // LIENS DIRECTS — contexte du bouton « copier le lien » de l'en-tête des modales (cf. `ui/Modal`,
  // docs/liens-directs.md). Accroche posée ici, comme `editLocked` : `Modal` n'a ainsi à connaître ni
  // le mode de données ni le document courant. Les deux fermetures sont RELUES à chaque copie.
  //   · `docId` — en mode fichier, le document n'a PAS d'identifiant (« le document EST le fichier ») :
  //     on pose la sentinelle partagée `AppLink.LOCAL_DOC`, que la relecture ignore de toute façon dans
  //     ce mode (arbitrage n°1 du chantier QR). ⚠ Fermeture sur `rest`, déclaré plus bas : légale, ces
  //     rappels ne s'exécutent qu'au clic.
  //   · `baseUrl` — l'URL COURANTE, débarrassée de son hash ET de sa query par `AppLink.baseOf`
  //     (décision A3). C'est l'adresse par laquelle l'utilisateur accède RÉELLEMENT, donc celle qui
  //     marchera pour son collègue ; `PUBLIC_BASE_URL` reste réservée au QR imprimé, qui doit, lui,
  //     survivre hors de l'application.
  const linkContext = {
    docId: () => (REST_MODE ? (rest ? rest.docId : null) : AppLink.LOCAL_DOC),
    baseUrl: () => (typeof location !== "undefined" ? AppLink.baseOf(location.href) : ""),
  };
  modal.linkContext = linkContext;
  // `markDirty` : garde « modifications non enregistrées » du NIVEAU de modale, pour les éditeurs SANS
  // champ de saisie (la chaîne de route) que l'instantané de `Modal` ne peut pas voir bouger.
  const formHost: FormHost = { openModal: (o) => modal.open(o), closeModal: () => modal.close(), refreshModal: () => modal.refresh(), markDirty: () => modal.markDirty(), setDirty: () => { refreshChrome(); }, autocompleteLimit: () => prefs.autocompleteMaxResults, userDirectory };   // mutation modèle déjà suivie par la révision (store.onChange) ; userDirectory : résout les auteurs d'audit (mode API)
  /* ---- SCAN CAMÉRA (chantier étiquettes QR, lot D — docs/qr-scan.md § « L'UI de scan ») ----
     L'hôte du greffon est câblé UNE fois : pile de modales STANDARD (la même instance `modal` que
     formHost — le viseur est un niveau de la pile, jamais un overlay parallèle) + préférences.
     `installGeneric` observe le CORPS de la modale : quand la préférence « scan partout » est
     active, les champs texte des formulaires qui s'y posent reçoivent le bouton (parseur brut).
     `installFieldTracking` suit le dernier champ texte actif — la cible du « insérer dans le
     dernier champ » de l'entrée globale. Les champs DÉCLARÉS (n° de série), eux, s'attachent
     dans leurs formulaires (`ScanControl.attach`, cf. EquipmentForms/SubEquipmentForms). */
  ScanControl.setup({
    openModal: (o) => formHost.openModal(o),
    closeModal: () => modal.close(),
    enginePref: () => prefs.scanEngine,
    setEnginePref: (mode) => { prefs.scanEngine = mode; },
    scanAllFields: () => prefs.scanAllFields,
    forceButtons: () => prefs.scanForceButtons,
  });
  ScanControl.installGeneric(modal.body);
  ScanControl.installFieldTracking();
  /* ---- IMPRESSION D'ÉTIQUETTES (chantier étiquettes QR, lot E — docs/qr-scan.md § « Étiquettes
     imprimables ») : MODE API SEULEMENT (la génération des QR est serveur, décision § 2.1 du handoff).
     Patron « injection nulle » : `setup` n'est appelé qu'ici et qu'en mode API — partout ailleurs
     `LabelPrintDialog.available()` rend faux et TOUTES les entrées d'impression (fiches, action de
     ligne) restent masquées, sans aucun test de mode dispersé. La modale s'ouvre dans la pile
     STANDARD (même instance que formHost) ; les SVG viennent de la route `GET …/qr/…?format=svg`. */
  if (REST_MODE) {
    LabelPrintDialog.setup({
      openModal: (o) => formHost.openModal(o),
      fetchQrSvg: (collection, id) => (adapter as RestAdapter).qrSvg(collection, id),
      // MATRICE de modules (`?format=matrix`) — l'export en images dessine le QR depuis elle,
      // à un nombre ENTIER de pixels par module (diagnostic Q11.14) : c'est la seule façon
      // d'obtenir des modules carrés dans un PNG. Appelée À LA DEMANDE, pas à l'ouverture.
      fetchQrMatrix: (collection, id) => (adapter as RestAdapter).qrMatrix(collection, id),
      // FONTE EMBARQUÉE (data: URI) : le document d'impression est une iframe isolée, il ne voit
      // pas la feuille de l'app. Injectée depuis ICI et non importée par la modale — les woff2 ne
      // sont des chaînes que sous webpack, et la modale est chargée sous Node par les tests.
      fontCss: LABEL_FONT_CSS,
    });
  }
  // RECHERCHE GLOBALE (modale dédiée) — UNE instance, UNE implémentation pour les DEUX chemins
  // (déclencheur topbar + Ctrl+K). Garde d'overlay = le pattern des raccourcis undo/redo (sélecteurs
  // DOM) : la palette est un geste de NAVIGATION GLOBALE, pas un niveau de la pile de modales — son
  // « Localiser » VIDE la file (`closeAll`), donc l'ouvrir par-dessus un formulaire en cours mènerait
  // à jeter la saisie au premier résultat cliqué. Ignorée aussi sur l'accueil (corpus vide). ⚠ Son overlay à elle
  // (`.gs-overlay`) n'est PAS dans le sélecteur de garde : Ctrl+K palette ouverte = FERMER (toggle).
  // « Localiser » depuis un résultat : MÊME flux que l'action des listes (switch vue Datacenter +
  // `dcView.locate` + bouton « ← Retour » vers la vue quittée). `shell.current` est capturé AVANT le
  // switch ; s'il n'y a pas de vue quittée (déjà sur le Datacenter), pas d'action de retour.
  const globalSearch = new GlobalSearchPalette(store, formHost, (kind, id) => {
    const cameFrom = shell.current;
    shell.switchView("datacenter");
    dcView.locate(kind, id);
    dcView.setReturnAction(cameFrom && cameFrom !== "datacenter" ? () => shell.switchView(cameFrom) : null);
  }, [
    // ACTIONS de la palette (portée « > ») — le POINT UNIQUE où elles se déclarent. Chaque `run` rejoue
    // un geste EXISTANT de l'app (formulaire de création, bascule du shell, export), jamais une logique
    // propre : la palette est un raccourci vers ce qui existe, pas un second chemin d'écriture.
    // ⚠ Fermetures sur `shell`/`shellHost` déclarés PLUS BAS : légal (exécution au clic, bien après le
    // boot) — même montage que `onLocate` ci-dessus. VIEWER : les créations passent par openModal, que
    // `Modal.editLocked` neutralise déjà — l'action devient un no-op silencieux, cohérent avec le mode.
    { id: "new-equipment", label: I18n.t("search.action.newEquipment"), sub: I18n.t("search.action.newEquipmentSub"), terms: ["add", "ajouter", "créer"], run: () => Forms.equipment(store, formHost, null, () => shell.refreshActive()) },
    { id: "new-rack", label: I18n.t("search.action.newRack"), sub: I18n.t("search.action.newRackSub"), terms: ["add", "ajouter", "créer", "baie"], run: () => Forms.rack(store, formHost, null, () => shell.refreshActive()) },
    { id: "new-cable", label: I18n.t("search.action.newCable"), sub: I18n.t("search.action.newCableSub"), terms: ["add", "ajouter", "créer"], run: () => Forms.cable(store, formHost, null, () => shell.refreshActive()) },
    { id: "goto-datacenter", label: I18n.t("search.action.gotoDatacenter"), sub: I18n.t("search.action.gotoDatacenterSub"), terms: ["3d", "plan", "salle", "vue"], run: () => shell.switchView("datacenter") },
    { id: "toggle-theme", label: I18n.t("search.action.toggleTheme"), sub: I18n.t("search.action.toggleThemeSub"), terms: ["dark", "light", "sombre", "clair", "thème"], run: () => shellHost.onToggleTheme?.() },
    // EXPORT : même gating que la section « Export » des Réglages (droits partiels → document amputé,
    // cf. docs/auth.md § 10.6). Sans ce prédicat, la palette serait la porte de service du masquage.
    { id: "export-json", label: I18n.t("search.action.exportJson"), sub: I18n.t("search.action.exportJsonSub"), terms: ["download", "télécharger", "sauvegarde"], visible: () => access.hasFullDocumentRead(), run: () => shellHost.onExportJson?.() },
  ], REST_MODE ? [
    // FAMILLES EXTERNES de la palette (mode API seulement — leurs bases vivent côté serveur).
    // Les fermetures visent des `let` assignés PLUS BAS (certsView, interventionsView) : légal,
    // `fetch`/`open` ne s'exécutent qu'à l'usage — même montage que `onLocate` ci-dessus.
    {
      kind: "__certs", scopeId: "certs", icon: Icons.CERT_LIST, prefix: "cert:",
      // `list()` = l'arbre COMPLET (la page Certificats le charge déjà ainsi — pas de pagination à gérer).
      // 🚨 Gaté sur `certs:read` (correctif « droits partiels ») : la palette est ouverte à quiconque a
      // UNE lecture documentaire, mais ses familles EXTERNES interrogent des modules qui ont leur propre
      // permission — sans cette garde, chaque Ctrl+F d'un lecteur DC tirait un 403 et son toast.
      fetch: async () => (!access.has("certs:read") ? [] : await certsClient!.list()).map((c) => ({
        kind: "__certs", id: c.id,
        label: c.label || c.subject || "?",
        sub: [CertsFormat.kindLabel(c.kind), c.key_algo].filter(Boolean).join(" · "),
        path: c.subject && c.subject !== c.label ? c.subject : "",
        terms: [c.serial, c.fingerprint, c.comment],
        // révoqué PRIME sur l'échéance (un cert révoqué « encore valide 300 j » n'est pas vert).
        pill: c.revoked_at ? { text: I18n.t("certs.status.revoked"), tone: "err" as const }
          : { text: CertsFormat.expiryLabel(c.not_after), tone: (["ok", "warn", "err"] as const).find((t) => t === CertsFormat.expiryClass(c.not_after)) || ("" as const) },
      })),
      // MÊME chemin que « ouvrir un cert depuis une fiche » (certFicheHooks.openCert, plus bas) :
      // bascule d'onglet + focus arborescent — focusCert ATTEND le chargement d'activation.
      open: (id) => { shell.switchView("certificats"); void certsView.focusCert(id); },
    },
    {
      kind: "__interventions", scopeId: "interventions", icon: Icons.INTERVENTION, prefix: "int:",
      // Listing paginé serveur : UNE page large (500 ≫ tout parc réel d'interventions), et les
      // enregistrements sont GARDÉS (interventionSearchCache) — `open` en a besoin, la modale de
      // détail prend l'enregistrement, pas un id (il n'existe pas de GET /interventions/:id).
      fetch: async () => {
        if (!access.has("interventions:read")) return [];   // même garde que la famille « certs » ci-dessus
        const page = await interventionsClient!.listPage({ pageSize: 500 });
        interventionSearchCache.clear();
        return page.interventions.map((it) => {
          interventionSearchCache.set(it.id, it);
          const tone = InterventionsFormat.statusClass(it.status);
          return {
            kind: "__interventions", id: it.id,
            label: it.title || InterventionsFormat.shortId(it.id),
            sub: [I18n.t(InterventionsFormat.kindLabelKey(it.kind)), I18n.t(InterventionsFormat.priorityLabelKey(it.priority))].join(" · "),
            path: it.jira_ref || "",
            terms: [it.description, it.jira_ref, InterventionsFormat.shortId(it.id)],
            pill: { text: I18n.t(InterventionsFormat.statusLabelKey(it.status)), tone: (tone === "ok" || tone === "warn" || tone === "err") ? tone : ("" as const) },
          };
        });
      },
      open: (id) => {
        shell.switchView("interventions");
        const record = interventionSearchCache.get(id);
        if (record) interventionsView.openDetail(record);
      },
    },
  ] : [],
  // RECHERCHE SERVEUR-PILOTÉE (mode API seulement — lot 2 recherche partagée) : la palette interroge la
  // route transverse `GET …/search` en un aller-retour, restreinte à ses familles À FICHE (inutile de
  // scanner ports/agrégats côté serveur : le corpus ne saurait pas les habiller). En mode FICHIER,
  // undefined → la palette reste 100 % locale (principe n°15, jamais de réseau).
  REST_MODE ? { search: async (q: string, signal: AbortSignal) => (await (adapter as RestAdapter).searchAll(q, { collections: GlobalSearchSources.families(), signal })).results } : undefined);
  /** Enregistrements d'interventions du DERNIER chargement de la palette — `open` en a besoin (cf. ci-dessus). */
  const interventionSearchCache = new Map<string, InterventionRecord>();
  const openGlobalSearch = (): void => {
    if (globalSearch.isOpen()) { globalSearch.close(); return; }
    if (document.querySelector(".modal-overlay.open, .dialog-overlay") || document.body.classList.contains("welcome-active")) return;
    globalSearch.open();
  };
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
  // BINAIRES des pièces jointes (hors modèle — les MÉTADONNÉES sont la collection `attachments` du Store) :
  // IndexedDB + compagnon .nmfa en mode fichier, endpoints REST en mode API. Cf. docs/attachments.md.
  const attachmentBackend = REST_MODE ? new RestAttachmentBackend(API_BASE_URL) : new IdbAttachmentBackend();
  const attachmentStore = new AttachmentStore({ backend: attachmentBackend });
  attachmentStore.restoreLoadedKey();   // clé du bundle .nmfa actuellement en IndexedDB — appariement json↔compagnon
  // Pièces jointes : injecte le stockage des binaires + le mode dans le host des formulaires (dépôt du binaire
  // à la création, branche de création API/fichier, téléchargement). Posé ICI car `attachmentStore` est
  // construit après `formHost` (au voisinage d'imageStore) ; rien ne le consomme avant le boot des vues.
  formHost.attachmentStore = attachmentStore;
  formHost.restMode = REST_MODE;
  // Même contexte de lien que la modale : la palette porte, elle aussi, un bouton « copier » — il SAUVE
  // la recherche courante sous forme d'URL (point 4 du cadrage).
  globalSearch.linkContext = linkContext;
  Fullscreen.install();   // re-parente les overlays (modale/dialogues/toasts/menus) dans l'élément plein écran
  RichTooltip.install();  // délégation UNIQUE des tooltips enrichis (data-rich-tooltip) — idempotent

  /* Onglet à afficher à l'OUVERTURE d'un document : on PRÉSERVE l'onglet actif — restauré du hash #nom au
     boot (lien rapide bookmarkable) ou choisi par l'utilisateur — au lieu de forcer « equipements » (ce qui
     écrasait systématiquement le fragment au load/reload : le boot restaurait le bon onglet, puis
     documentOpened re-switchait). Seul un document NEUF (menu « Nouveau ») ramène à l'onglet par défaut. */
  /* ⚠ En mode API, l'onglet BOOKMARKÉ ne peut pas être activé au boot : les droits ne sont connus qu'après
     `GET /me`, donc AUCUNE vue n'est encore visible à ce moment-là et `shell.current` reste null. On garde
     donc l'intention (`bookmarkedView`, déclaré plus bas — fermeture évaluée bien après le boot) comme repli
     avant l'onglet par défaut, sinon un lien profond serait perdu à chaque ouverture de document serveur.
     La DÉCISION elle-même (courante → bookmarkée → défaut → première visible) vit dans le module PUR
     `core/ViewRestoration`, qu'elle partage avec la restauration d'après-droits (cf. `restoreViewIfIdle`) :
     l'écrire deux fois, c'est l'avoir écrite deux fois DIFFÉREMMENT — c'était le cas avant le correctif
     « droits partiels » (existence de la vue ici, visibilité là-bas). */
  const viewRestorationState = (): ViewRestorationState => ({
    current: shell.current,
    bookmarked: bookmarkedView,
    defaultView: DEFAULT_VIEW,
    isVisible: (name) => shell.hasView(name) && shell.isViewVisible(name),
    firstVisible: () => shell.firstVisibleView(),
  });
  const viewAfterOpen = (): string => ViewRestoration.afterDocumentOpened(viewRestorationState()) || "";

  /* ---- documents FICHIER : cycle de vie EXTRAIT dans `FileDocumentController` (ouvrir/enregistrer/rouvrir,
     mode dossier, compagnon .nmfb, exports) ; ici, seule l'adhérence à la boucle applicative. Les closures de
     l'hôte capturent des consts définies PLUS BAS (shell, refreshChrome, applyAutosave) — appelées après le boot. */
  const files = new FileDocumentController({
    store, imageStore, attachmentStore, session, prefs, handleStore, tabChannel, hasFsApi: HAS_FS_API,
    host: {
      refreshChrome: () => refreshChrome(),
      refreshActive: () => shell.refreshActive(),
      // `consumePendingDeepLink` EN DERNIER : la fiche d'un lien d'étiquette se pose PAR-DESSUS la vue
      // restaurée, une fois le document chargé (cf. le bloc DEEP-LINK D'ENTITÉ plus bas). No-op si aucun
      // lien n'est en attente — c'est le cas de tous les jours.
      documentOpened: () => { shell.hideWelcome(); shell.switchView(viewAfterOpen()); applyAutosave(); refreshChrome(); consumePendingDeepLink(); },
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
    // Recale AUSSI le backend de pièces jointes : même scope document (/api/documents/{docId}) que les images.
    setImagesBase: (base) => {
      if (imageBackend instanceof RestImageBackend) imageBackend.setBaseUrl(base);
      if (attachmentBackend instanceof RestAttachmentBackend) attachmentBackend.setBaseUrl(base);
    },
    injectedLoginUrl: INJECTED.loginUrl,
    host: {
      refreshChrome: () => refreshChrome(),
      refreshActive: () => shell.refreshActive(),
      // `resetVmProvidersProbe` EN PREMIER : la config des providers VM est PAR DOCUMENT, et les
      // rafraîchissements qui suivent réévaluent la visibilité du bouton « Purger… » — donc re-sondent
      // avec le document désormais ouvert. (Closure sur une const déclarée plus bas, cf. note ci-dessus.)
      // `consumePendingDeepLink` EN DERNIER, même raison qu'en mode fichier (fiche par-dessus la vue
      // restaurée) : ici le document VISÉ est déjà le bon dans le cas nominal, cf. le pré-positionnement
      // de `prefs.lastRestDocId` avant le bootstrap.
      documentOpened: () => { resetVmProvidersProbe(); shell.hideWelcome(); shell.switchView(viewAfterOpen()); refreshChrome(); shell.refreshActive(); consumePendingDeepLink(); },
      resetUndo: () => undoTimeline.reset(),
      setDisplayName: (name) => { files.name = name; },
      invalidate3D: () => dcView.invalidate3D(),
      setUser: (user) => { currentAuthUser = user || null; shell.setUser(user); },
      // Nouveaux droits (bootstrap, relecture après un 403, expiration de session) → on remplace l'état et on
      // rejoue le gating. `applyAccess` est déclaré PLUS BAS (il a besoin de `shell`) : légal, l'appel est
      // asynchrone — même montage que les autres fermetures de cet hôte.
      setAccess: (next) => applyAccess(next),
      showAccessDenied: (opts) => shell.showAccessDenied(opts),
      // Session expirée (401) : ferme toute la pile de modales avant de basculer sur l'écran d'accueil (même
      // instance `modal` que formHost.locate) — sinon fiches/formulaires resteraient par-dessus le login.
      closeAllModals: () => modal.closeAll(),
      // Écriture d'un AUTRE client dans un module (interventions/certs) : recompte les pastilles concernées,
      // throttlé (cf. scheduleModulesRecount, défini plus bas ; appelé seulement après le boot, via SSE).
      onModulesChanged: (modules) => scheduleModulesRecount(modules),
    },
  }) : null;
  // 401 (session SSO absente/EXPIRÉE) sur une requête → UNE action idempotente : retour au login. Installé APRÈS
  // la construction (référence `rest`), mode REST uniquement (le mode fichier n'a pas de session).
  if (rest) SessionExpiry.install(() => rest.sessionExpired());

  /* ---- LIENS DIRECTS (cf. `src-shared/AppLink`, `core/AppLinkRouting`, docs/liens-directs.md) ----
     Quatre formes, une seule grammaire, toutes sous `doc/<docId>/` : fiche d'un objet (ce qu'encode
     une étiquette QR), intervention, certificat, recherche. Scanné ou collé hors app, un lien arrive
     ici comme un simple fragment d'URL. Trois coutures, et l'ORDRE fait tout :

     1. CAPTURER la cible MAINTENANT, avant que quoi que ce soit ne réécrive le hash. `Shell.switchView`
        reflète l'onglet actif dans l'URL (`location.hash = "#equipements"`) et la fin du boot le fait
        SYSTÉMATIQUEMENT : relire `location.hash` plus tard ne rendrait plus qu'un nom d'onglet.
     2. N'AGIR qu'une fois un document PRÊT — sinon `Forms.detail` lirait un cache vide et dirait
        « introuvable » d'un objet qui existe. Au boot, aucun document n'est encore là (mode fichier :
        l'utilisateur n'a pas choisi son fichier ; mode API : `rest.bootstrap()` va le charger). On
        s'accroche donc au MÊME instant que la restauration de vue — la fermeture `documentOpened` des
        deux contrôleurs — et APRÈS elle : la fiche est une MODALE, elle se pose PAR-DESSUS la vue
        active. ⚠ Un lien porteur de `?vue=1` ACTIVE d'abord la vue de son objet : il passe donc après
        `core/ViewRestoration` et la remplace, ce qui est exactement ce qu'il demande.
     3. NE RIEN CASSER en cas d'échec : `AppLinkOpener.open` ne lève jamais et notifie lui-même
        (et se tait quand un autre mécanisme a déjà parlé : 403 → `core/AccessDenial`, 401 →
        `SessionExpiry`). Un boot sous droits partiels reste donc exactement ce qu'il était.

     CONSOMMATION UNIQUE (`pendingDeepLink` remis à null AVANT l'exécution) : une bascule de document
     rappelle `documentOpened`, qui rappellerait ce consommateur — la remise à zéro préalable est ce
     qui empêche la boucle. */
  let pendingDeepLink: AppLinkTarget | null = AppLink.parse(typeof location !== "undefined" ? location.hash : "");
  const appLinkOpener = new AppLinkOpener({
    store, formHost,
    // ACTIVATION D'ONGLET — interface étroite sur le Shell (déclaré plus bas : fermeture légale, ces
    // rappels ne s'exécutent qu'à l'arrivée d'un lien). Le test de visibilité est FAIT PAR L'OPENER
    // avant d'activer : `switchView` se replierait sinon sur la première vue accessible et
    // déménagerait l'utilisateur alors qu'il ne demandait qu'une fiche.
    views: { isVisible: (view) => shell.isViewVisible(view), activate: (view) => shell.switchView(view) },
    // FAMILLES HORS DOCUMENT — injection NULLE en mode fichier : leurs bases vivent côté serveur.
    // L'opener le DIT alors (« mode serveur requis ») au lieu de rester muet, et aucun test de mode
    // n'est écrit ici ni là-bas. Mêmes chemins d'ouverture que les familles externes de la palette.
    externals: REST_MODE ? {
      openIntervention: async (id) => {
        // La modale de détail prend l'ENREGISTREMENT, pas un id — d'où la lecture unitaire préalable.
        // Un échec (404, ou droit retiré depuis l'activation de l'onglet) devient « introuvable » :
        // le cas « page interdite » a déjà été écarté par la garde de vue de l'opener.
        let record; try { record = await interventionsClient!.getOne(id); } catch (_) { return false; }
        interventionsView.openDetail(record);
        return true;
      },
      openCert: (id) => certsView.focusCert(id),
    } : null,
    // RECHERCHE — disponible dans les DEUX modes : la palette est locale en mode fichier (principe n°15).
    openSearch: (query) => globalSearch.open(query),
    // Injection NULLE en mode fichier/visualiseur : sans accès aux documents serveur, la décision pure
    // ignore le `docId` de la cible (mono-document par nature) — aucun test de mode ailleurs.
    documents: rest ? {
      currentDocId: () => rest.docId,
      // FILET de la bascule : `openDocument` scope l'adapter AVANT de charger. Si le chargement échoue
      // (étiquette plus vieille que le parc : document supprimé, droit retiré, serveur injoignable),
      // l'application resterait branchée sur un document MORT — toutes ses requêtes suivantes en 404.
      // On rouvre donc celui d'où l'on vient avant de laisser l'échec remonter (l'opener le notifiera).
      // Pas de récursion possible : le lien en attente a déjà été consommé quand ce rappel s'exécute.
      openDocument: async (docId: string) => {
        const previous = rest.docId;
        try { await rest.openDocument(docId); }
        catch (e) {
          if (previous && previous !== rest.docId) await rest.openDocument(previous).catch(() => { /* le toast d'échec suffit */ });
          throw e;
        }
      },
    } : null,
    notify: (message, kind) => Notify.toast(message, kind),
    onChanged: () => shell.refreshActive(),   // même rappel que les autres ouvertures de fiche (closure sur `shell`, déclaré plus bas)
  });
  const consumePendingDeepLink = (): void => {
    const target = pendingDeepLink;
    pendingDeepLink = null;
    if (target) void appLinkOpener.open(target);
  };
  // HASH CHANGÉ pendant que l'app tourne (lien collé, retour arrière, URL d'étiquette ouverte dans
  // l'onglet courant) : le lien direct est tenté EN PREMIER. Les deux routages ne peuvent PAS se
  // disputer un même hash — toute forme de la grammaire contient des `/`, aucun nom de vue n'en
  // contient — donc quand `parse` rend null on ne fait RIEN, et la navigation par onglet reste
  // EXACTEMENT ce qu'elle était (`ShellNav.resolveHash`, écouteur propre au Shell, intouché).
  // ⚠ Aucune boucle possible quand le lien active une vue : `switchView` réécrit le hash en `#nom`,
  // qui n'est justement PAS un lien direct — le tour suivant rend null et s'arrête.
  window.addEventListener("hashchange", () => {
    const target = AppLink.parse(location.hash);
    if (target) void appLinkOpener.open(target);
  });

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
  // G6 — un COMPTE relevé en async vient d'arriver (collection chargée paresseusement) : la pastille
  // d'onglet qui l'affiche doit se repeindre. Le rendu du Shell est synchrone, donc ce rappel est le
  // SEUL moment où la vraie valeur peut atteindre l'écran (patron du badge « Interventions »).
  // ⚠ Fermeture sur `shell`, déclaré PLUS BAS : légal — l'appel est asynchrone, bien après le boot.
  store.onCountResolved = () => shell.refreshCounts();
  // G8 (vague 3) — les VALEURS d'une facette servie par le serveur viennent d'arriver : seule la barre
  // de filtres du listing concerné les affiche, et son rendu est synchrone. Même patron que G6 pour les
  // pastilles, avec le registre « collection → listing » déjà tenu pour le point d'accroche G3.
  store.onFacetResolved = (collection) => listViewsByCollection.get(collection)?.()?.refreshFacetOptions();
  // G3 — des collections NON hydratées ont été SAUTÉES par un rechargement SSE (un autre client les a
  // touchées, ou nous-mêmes par un chemin qui n'écrit pas dans le Store : l'upload d'une pièce jointe
  // passe par sa route multipart). On ne les recharge PAS — ce serait annuler le lazy. Deux dérivés
  // sont rafraîchis, tous deux à coût BORNÉ :
  //   - les COMPTEURS (déjà invalidés par le Store) → on redemande leur rendu ;
  //   - tout ce que le listing de cette collection tient du SERVEUR : la PAGE en main (régime pagé G4)
  //     ET le JEU mémoïsé par signature de requête (régime `rows()` sous recherche/filtre actif). On les
  //     OUBLIE, le prochain rendu les redemandera. Ce n'est pas un contournement de G3 (on ne re-tire pas
  //     la collection, on redemande UNE page — ce que fait tout clic sur « ‹ › ») ; sans ça, une pièce
  //     jointe qu'on vient d'envoyer n'apparaîtrait dans SON listing qu'au prochain changement d'onglet,
  //     alors que la pastille, elle, se serait mise à jour. Le re-rendu suit : le contrôleur REST appelle
  //     `refreshActive()` juste après le rechargement (cf. RestDocuments). Voir docs/hydratation.md.
  //     🐛 T8/Q8.5 (2026-09-01) : on n'oubliait ici que la PAGE. Le JEU serveur, lui, est mémoïsé par
  //     SIGNATURE (collection + saisie + cible) qu'une écriture d'un autre client ne change pas — donc
  //     sous une recherche ou un filtre ACTIF, le listing d'une collection lazy restait périmé même en
  //     quittant puis rouvrant l'onglet. C'est le défaut que le lot R2 avait refermé pour les collections
  //     HYDRATÉES (`store.onChange` appelle bien les deux, cf. ListView) ; la branche lazy était restée à
  //     mi-chemin. Les deux branches font désormais la même chose (principe n°3).
  store.onLazyReloadDeferred = (collections) => {
    for (const collection of collections) listViewsByCollection.get(collection)?.()?.forgetServerData();
    shell.refreshCounts();
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
      // Côté serveur, la maintenance purge AUSSI les binaires de pièces jointes orphelins (D5) —
      // compteurs dans la réponse (`purgedAttachments`/`purgedAttachmentBytes`, posés par le lot A).
      const r = await (adapter as RestAdapter).maintenance();
      await imageStore.reloadFromBackend();
      const mb = (n: number) => (n / 1048576).toFixed(1) + " Mo";
      if (r) {
        // Segment « pièces jointes » ajouté SEULEMENT si la purge en a retiré (sinon on n'alourdit pas le toast).
        const attPart = r.purgedAttachments ? I18n.t("app.maint.purgedAttachmentsRest", { n: r.purgedAttachments, bytes: Format.bytes(r.purgedAttachmentBytes || 0) }) : "";
        Notify.toast(I18n.t("app.maint.purgedRest", { n: r.purgedImages, before: mb(r.bytesBefore), after: mb(r.bytesAfter) }) + attPart);
      } else Notify.toast(I18n.t("app.maint.done"));
    } else {
      await imageStore.keepOnly(refs);
      // Même geste pour les BINAIRES de pièces jointes (D5, mode fichier) : ne garder que ceux dont
      // l'enregistrement existe encore dans la collection — le prochain compagnon .nmfa n'embarquera
      // plus les orphelins. Le compte est joint au toast (segment omis si aucune pièce purgée).
      const purgedAttachments = await attachmentStore.keepOnly(store.all("attachments").map((a: any) => a.id));
      const attPart = purgedAttachments ? I18n.t("app.maint.purgedAttachmentsFile", { n: purgedAttachments }) : "";
      Notify.toast(I18n.t("app.maint.purgedFile", { n: orphans.length }) + attPart);
      session.markDirty(); refreshChrome();
    }
    shell.refreshActive();
  };

  // AVERTISSEMENT D8 avant un export SANS binaires (JSON autonome / visualiseur HTML) : si le document porte
  // des pièces jointes, prévenir que leurs BINAIRES n'y seront PAS (seules les métadonnées y sont). Renvoie
  // `true` s'il faut poursuivre l'export (aucune pièce jointe, ou l'utilisateur confirme malgré tout).
  const warnAttachmentsExcluded = async (): Promise<boolean> => {
    // G10 (chantier lazy-load) : `store.all("attachments").length` MENTIRAIT en mode API — `attachments`
    // est chargée PARESSEUSEMENT, le cache ne contient que ce qui a été parcouru, et l'avertissement
    // manquerait précisément sur un document dont les pièces n'ont pas encore été ouvertes. `countOf`
    // rend le compte LOCAL sur une collection hydratée (mode fichier : aucun réseau, inchangé) et le
    // `COUNT(*)` serveur sinon. Le chemin est déjà asynchrone (Dialog.confirm) : aucun coût d'UI.
    const count = await store.countOf("attachments");
    if (!count) return true;   // rien à prévenir → export direct
    return await Dialog.confirm({
      title: I18n.t("app.maint.exportAttachTitle"),
      message: I18n.t("app.maint.exportAttachMessage", { n: count }),
      confirmLabel: I18n.t("app.maint.exportAttachConfirm"),
    });
  };

  // ---- services FICHIER / GLOBAUX (topbar) ----
  /* PRÉFÉRENCE DE THÈME — point de passage UNIQUE. Trois entrées y mènent : le toggle à trois
     positions des réglages, l'action « Basculer le thème » de la palette, et le suivi du système
     quand la préférence est « auto ». Chacune ne fait que CHOISIR une préférence ; ce qui s'ensuit
     (persistance, attribut sur <html>, position du toggle, couleurs de la vue 3D) est écrit ici, une
     seule fois — un chemin qui oublierait `dcView.onThemeChanged()` laisserait une scène aux couleurs
     de l'ancien thème. */
  const applyThemePreference = (pref: ThemePreference): void => {
    prefs.theme = pref;
    applyTheme(pref);
    shell.setTheme(pref);
    dcView.onThemeChanged();
  };

  const shellHost: ShellHost = {
    // Ouverture d'une modale de la pile STANDARD, injectée au Shell (même patron que `ScanControl.setup`
    // et `LabelPrintDialog.setup`) : les RÉGLAGES sont désormais une modale ordinaire (`app/SettingsPanel`),
    // plus un popover ancré à la topbar. Le Shell n'ouvre donc aucun overlay maison.
    openModal: (o) => formHost.openModal(o),
    onNew: async () => {
      if (REST_MODE) { const n = await Dialog.prompt(I18n.t("app.main.newDocPromptTitle"), "Document"); if (n) await rest!.newDocument(n); return; }
      if (hasUserData()) {
        const ok = await Dialog.confirm({ title: I18n.t("app.main.newDocTitle"), message: I18n.t("app.main.newDocMessage"), confirmLabel: I18n.t("app.main.newDocConfirm"), danger: true });
        if (!ok) return;
      }
      tabChannel.release(store.meta.fileId || null);
      await store.newDocument(); await imageStore.clearAll(); await attachmentStore.clearAll(); undoTimeline.reset(); files.detach(); session.markLoaded(store.histIndex());
      applyTheme(prefs.theme); shell.hideWelcome(); shell.switchView("equipements"); applyAutosave(); refreshChrome(); Notify.toast(I18n.t("app.main.newDocToast"));
    },
    onOpen: () => { if (rest) void rest.openChooser(); else void files.doOpen(); },
    onSave: () => { void files.doSave(); },
    onSaveAs: () => { void files.doSaveAs(); },
    onUndo: () => { void doUndo(); },   // timeline unifiée (modèle + images) ; révision suivie via onChange → dirty recalculé
    onRedo: () => { void doRedo(); },
    onGlobalSearch: () => openGlobalSearch(),   // loupe topbar — même implémentation (et même garde) que Ctrl+K
    // Clic sur la pastille utilisateur → modale d'infos. On lui passe l'identité DÉJÀ reçue de `/me`
    // (`currentAuthUser`) et l'état d'autorisation COURANT (`access`, relu à chaud) — aucun réseau.
    onUserInfo: () => UserInfoModal.open(formHost, currentAuthUser, access),
    // SCANNER UNE ÉTIQUETTE (bouton topbar, à côté de la loupe) : viseur en mode LIBRE. Un
    // lien direct décodé passe par l'instance UNIQUE `appLinkOpener` (le même service que le
    // hash du boot et le hashchange — jamais une résolution dupliquée) ; toute autre valeur
    // offre copier / insérer dans le dernier champ actif (cf. ScanControl.openGlobal).
    onScanGlobal: () => ScanControl.openGlobal({ openTarget: (target) => { void appLinkOpener.open(target); } }),
    // PANIER (actions groupées) : la modale liste le contenu et porte l'action. Le bouton n'existe
    // que si `CartPanel.setup` a eu lieu (mode API en V1-Beta) — cf. docs/panier.md.
    onCart: () => CartPanel.open(),
    // Préférences du scan (réglages → Scan) : persistées puis reflétées — l'effet est IMMÉDIAT
    // pour les prochains formulaires (le greffon relit les préférences à chaque attachement).
    onScanAllFields: (on) => { prefs.scanAllFields = on; shell.setScanPrefs(prefs.scanAllFields, prefs.scanForceButtons); },
    onScanForceButtons: (on) => { prefs.scanForceButtons = on; shell.setScanPrefs(prefs.scanAllFields, prefs.scanForceButtons); },
    // Toggle à TROIS positions des réglages : la préférence arrive telle quelle (« light » | « auto » | « dark »).
    onThemePreference: (pref) => applyThemePreference(pref),
    // Action « Basculer le thème » de la palette : elle demande un changement VISIBLE, pas un aller-retour.
    // Depuis « auto », on épingle donc l'inverse de ce qui est AFFICHÉ (décision pure, cf. ThemeResolution.toggled).
    onToggleTheme: () => applyThemePreference(ThemeResolution.toggled(prefs.theme, systemPrefersDark())),
    onUiScale: (value) => { prefs.uiScale = value; applyUiScale(prefs.uiScale); shell.setUiScale(prefs.uiScale); },
    onModalFullscreen: (on) => { prefs.modalFullscreen = on; applyModalFullscreen(prefs.modalFullscreen); shell.setModalFullscreen(prefs.modalFullscreen); },   // une modale DÉJÀ ouverte s'adapte par le CSS seul
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
    // Export JSON autonome / visualiseur HTML : les MÉTADONNÉES des pièces jointes en font partie (collection
    // du document), mais JAMAIS les BINAIRES (D8 — des PDF en base64 rendraient le fichier impraticable). On
    // PRÉVIENT donc l'utilisateur si le document en porte, en pointant le canal complet (compagnon .nmfa en
    // mode fichier / dossier serveur en mode API). Annulable — il peut vouloir le fichier binaire à côté d'abord.
    onExportJson: () => { void (async () => { if (await warnAttachmentsExcluded()) await files.exportJsonDownload(); })(); },
    onExportStandalone: () => { void (async () => { if (await warnAttachmentsExcluded()) await files.exportStandalone(); })(); },
    onDebugLog: (on) => { prefs.debugLog = on; Log.setEnabled(on); Notify.toast(on ? I18n.t("app.main.debugOn") : I18n.t("app.main.debugOff")); },
  };

  const shell = new Shell(root, shellHost);
  /* ---- PANIER D'ACTIONS GROUPÉES (docs/panier.md) — MODE API SEULEMENT en V1-Beta, pour la même
     raison que l'impression d'étiquettes : c'est sa SEULE action, et elle est serveur. Patron
     « injection nulle » comme `LabelPrintDialog.setup` — hors de ce bloc, `CartPanel.available()`
     rend faux, l'entrée de topbar reste masquée et AUCUN listing ne pose de case (décision P11).
     `families: ["links"]` = les familles portant une action ; les câbles et les faisceaux la
     partagent (même anatomie d'étiquette, cf. core/CartFamilies). */
  /* Constructeur de sujet d'étiquette PAR COLLECTION — le seul endroit du panier qui touche au
     Store. La règle « qu'imprime-t-on pour un X ? » reste, elle, dans `core/LabelSubjects`. */
  const CART_LABEL_SUBJECTS: Record<string, (record: any) => LabelSubject> = {
    equipments: (record) => LabelSubjects.equipment(store, record),
    cables: (record) => LabelSubjects.cable(store, record),
    cableBundles: (record) => LabelSubjects.bundle(store, record),
    subEquipments: (record) => LabelSubjects.subEquipment(store, record),
    spares: (record) => LabelSubjects.spare(store, record),
  };
  if (REST_MODE) {
    CartPanel.setup({
      openModal: (o) => formHost.openModal(o),
      docKey: () => (adapter as RestAdapter).docId || "",   // cloisonnement : un panier par document
      onCount: (count) => shell.setCartCount(count),
      refreshView: () => shell.refreshActive(),   // retrait depuis la modale ⇒ les cases du listing dessous se remettent à jour
      // Familles imprimables DÉRIVÉES de la table des plans, jamais recopiées : une liste tenue à
      // la main finirait par diverger de la règle qu'elle est censée refléter.
      families: CartLabelPlans.families(),
      print: (items) => {
        if (!items.length) return;
        // Le panier est mono-famille par construction : la première ligne suffit à décider du plan.
        const family = CartFamilies.of(items[0].collection);
        const plan = family ? CartLabelPlans.of(family) : null;
        if (!plan) { Notify.toast(I18n.t("cart.nothing"), "err"); return; }
        /* La VÉRITÉ est relue au Store au moment d'agir (décision P3) : un élément supprimé
           entre-temps par un autre client est EXCLU et signalé, jamais cause d'un échec global. */
        const subjects: LabelSubject[] = [];
        let missing = 0;
        for (const item of items) {
          const record: any = store.get(item.collection, item.id);
          const build = record ? CART_LABEL_SUBJECTS[item.collection] : null;
          if (!build) { missing++; continue; }
          // 🚨 T11 : UN sujet par élément. La règle « un lien s'étiquette par paire »
          // (décision P9) n'est plus appliquée ICI en dupliquant le sujet — elle est le
          // DÉFAUT de la bascule A / B / A+B de la modale (`plan.defaultEndsMode`), qui
          // développe le tirage elle-même. Le panier redevient une simple liste d'OBJETS,
          // et la volumétrie reste réglable devant l'aperçu.
          subjects.push(build(record));
        }
        if (missing) Notify.toast(I18n.t("cart.missing", { n: missing }), "warn");
        if (!subjects.length) { Notify.toast(I18n.t("cart.nothing"), "err"); return; }
        LabelPrintDialog.open({
          kind: plan.kind, subjects,
          source: I18n.t("cart.printSource", { n: subjects.length }),
          ...(plan.defaultEndsMode ? { defaultEndsMode: plan.defaultEndsMode } : {}),
        });
      },
    });
    shell.setCartAvailable(true);
  }
  // SCAN : reflète les préférences dans les réglages, puis SONDE la caméra (async) — l'entrée
  // globale « scanner une étiquette » n'apparaît que si le poste peut scanner (caméra + contexte
  // sécurisé, cf. core/ScanAffordance) : jamais de bouton qui ne mène qu'à un échec.
  shell.setScanPrefs(prefs.scanAllFields, prefs.scanForceButtons);
  void ScanControl.globalAvailable().then((ok) => shell.setScanAvailable(ok));

  /** Installe un nouvel état d'autorisation et REJOUE tout le gating d'un coup. Les prédicats posés sur les
      vues/actions relisent `access` d'eux-mêmes, il suffit donc de redemander une évaluation
      (`refreshCounts` : visibilité des onglets + pastilles + actions conditionnelles + repli de l'onglet
      actif) ; restent les quelques contrôles de CHROME qui ne passent pas par une définition de vue. */
  const applyAccess = (next: AccessState): void => {
    access = next;
    shell.setGlobalSearchAllowed(access.hasAnyDocumentRead());   // même règle que la garde serveur de GET /search
    shell.setNewDocumentAllowed(access.has("documents:manage"));
    shell.setMaintenanceAllowed(access.has("maintenance:run"));
    // EXPORTS du document COMPLET (décision du correctif « droits partiels », docs/auth.md § 10.6) :
    // proposés SEULEMENT si l'utilisateur peut lire TOUTES les collections. Sous droits partiels, le
    // cache ne contient plus le document (l'assiette de chargement est intersectée avec le lisible) et
    // `hydrateAll` ne peut plus le compléter — l'export serait une copie AMPUTÉE, sans que rien ne le
    // dise. On masque le geste : un export partiel silencieux est un piège, pas une dégradation.
    shell.setExportAllowed(access.hasFullDocumentRead());
    shell.refreshCounts();
    // 🚨 RESTAURATION DE VUE (symptôme S3). `refreshCounts` vient d'appliquer la visibilité des onglets :
    // c'est le premier instant où l'on sait quoi activer. Cf. `restoreViewIfIdle` pour le pourquoi du
    // garde-fou `viewRestorationReady`.
    restoreViewIfIdle();
  };
  /* 🚨 REJEU de l'activation de vue après un changement de droits (correctif « droits partiels », S3).
     LA SÉQUENCE, mesurée (instrumentée au navigateur avant correctif) :
       1. `applyAccess(NONE)` du boot          → aucune vue visible ;
       2. `switchView(#hash)` (fin de boot)    → REFUSÉ (rien n'est visible) → `shell.current` reste NUL ;
       3. `applyAccess(grants)` du bootstrap   → les onglets apparaissent… et personne n'active rien ;
       4. `documentOpened()`                   → activait enfin une vue — MAIS seulement si le document
          s'est chargé. Un chargement en échec (c'était le cas sous droits partiels, cf. Store.init)
          laissait l'app sur une barre d'onglets garnie et un écran VIDE.
     On rejoue donc l'étape 4 dès l'étape 3. L'ordre 3→4 est CONSERVÉ (on n'active pas à la place de
     `documentOpened`, on active AVANT lui) : `documentOpened` re-switche ensuite sur la MÊME vue, ce qui
     la re-rend avec les données chargées — coût nul, et le trou est bouché même si l'étape 4 n'arrive pas.
     ⚠ GARDE-FOU `viewRestorationReady` : `applyAccess` est appelé une PREMIÈRE fois (étape 1) AVANT que
     `bookmarkedView` ne soit initialisé — y toucher lèverait une ReferenceError de zone morte temporelle.
     Le drapeau passe à vrai exactement au point où l'intention du hash est connue. */
  let viewRestorationReady = false;
  const restoreViewIfIdle = (): void => {
    if (!viewRestorationReady) return;
    const target = ViewRestoration.target(viewRestorationState());
    if (target) shell.switchView(target);   // null = vue courante valable, OU plus aucune vue accessible
  };
  // Les FICHES sont une chaîne de méthodes STATIQUES : elles lisent l'autorisation par le point d'accroche
  // de `FormBase` (comme `FormBase.images`), et la fonction relit l'état COURANT à chaque ouverture.
  FormBase.access = {
    canCreateCollection: (collection) => access.canCreateCollection(collection),
    canUpdateCollection: (collection) => access.canUpdateCollection(collection),
    canDeleteCollection: (collection) => access.canDeleteCollection(collection),
  };

  // RACCOURCI d'ergonomie (2026-07-31), PROBABLEMENT TEMPORAIRE — pose l'accroche qui fait apparaître, dans
  // l'en-tête des modales, une bascule « Modales en plein écran ». On NE duplique PAS le chemin d'écriture :
  // `toggle()` rejoue EXACTEMENT le geste du toggle des Réglages (`onModalFullscreen`), qui écrit la pref,
  // l'applique en direct et resynchronise la bascule du panneau Réglages. `active()` relit l'état global.
  // Le RETIRER = supprimer ce bloc + le bouton `.modal-fs` dans Modal, rien d'autre (cf. Modal.fullscreenShortcut).
  modal.fullscreenShortcut = { active: () => prefs.modalFullscreen, toggle: () => shellHost.onModalFullscreen?.(!prefs.modalFullscreen) };

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
  /** Registre « collection → son listing » (accesseurs PARESSEUX : la vue n'est bâtie qu'au 1er affichage
      de l'onglet). Rempli par `addListTab`, lu par le seul point d'accroche G3 du chantier lazy-load. */
  const listViewsByCollection = new Map<string, () => ListView | null>();
  type FormFn = (id: string | null, onSaved: () => void) => void;
  interface TabOpts {
    title?: string; subtitle?: string; form?: FormFn; addLabel?: string; kind?: "primary" | "secondary"; parent?: string; icon?: string;
    onAdd?: () => void; onDel?: (id: string, reRender: () => void) => void; locate?: "equipment" | "rack" | "cable"; manage?: boolean;
    /** Supprime le bouton « + créer » de l'en-tête TOUT EN gardant l'édition en ligne. Sans lui, fournir `form`
        (pour l'action « éditer ») ferait apparaître un « + » par défaut. Cas d'usage : le listing des
        sous-équipements, où la création n'existe pas (le maître fournit `equipment_id`, cf. cadrage lot C). */
    noAdd?: boolean;
    /** Cible de « Localiser » quand la LIGNE n'EST PAS l'objet localisé : id de ligne → id de l'objet de type
        `locate` à viser, ou `null` si cette ligne n'est pas localisable. Absent = la ligne est l'objet
        (comportement historique de tous les autres onglets).
        SEUL cas d'usage aujourd'hui : une VM n'a aucune existence dans la scène 3D — on localise son
        ÉQUIPEMENT HÔTE (cf. `core/VmLocate`). */
    locateTarget?: (id: string) => string | null;
    /** Boutons secondaires d'en-tête — même forme que `ViewDef.extraActions` du Shell, `visible` compris
        (prédicat de visibilité réévalué à chaque `refreshCounts`, cf. Shell.ts). */
    extraActions?: Array<{ label: string; onClick: (btn: HTMLButtonElement) => void; title?: string; visible?: () => boolean }>;
    /** Action « Télécharger » d'une ligne (le listing déclare `download: true` dans `cfg.actions`). Threadée
        ici plutôt que codée en dur comme view/edit/del : le download d'une pièce jointe passe par
        l'`attachmentStore` (binaire hors document), pas par le Store du modèle. Absent = pas de download. */
    onDownload?: (id: string) => void;
    /** Action « Afficher » d'une ligne (viewer intégré ; le listing déclare `show: true` dans `cfg.actions`).
        Même raison d'être que `onDownload` : le viewer lit le binaire via l'`attachmentStore` (hors Store du
        modèle). Absent = pas de viewer. À ne pas confondre avec l'`onShow` du cycle de vue (build paresseux). */
    onShow?: (id: string) => void;
    /** Action « Imprimer l'étiquette » d'une ligne (chantier étiquettes QR, lot E). Threadée comme
        `onDownload` : l'impression passe par `LabelPrintDialog` (génération serveur), pas par le Store.
        Présente ⇒ l'action est proposée, GATÉE par `LabelPrintDialog.available()` (mode API seulement —
        le prédicat est réévalué au rendu, donc l'action disparaît d'elle-même en mode fichier). */
    onPrint?: (id: string) => void;
  }
  /** Déclare un onglet de LISTE et rend un ACCESSEUR sur sa `ListView` — null tant que l'onglet n'a
      jamais été affiché (la vue est construite au premier `onShow`, à dessein : on ne paie pas le
      coût d'un listing qu'on n'ouvre pas). Utile aux navigations qui doivent AGIR sur le listing
      d'arrivée — un « Afficher plus » de fiche qui bascule d'onglet puis y pose un filtre de cible
      (cf. `ListView.focusTarget`). Tous les appelants actuels ignorent simplement ce retour. */
  const addListTab = (name: string, label: string, configFn: (s: typeof store) => ListOptions, opts: TabOpts = {}): (() => ListView | null) => {
    const cfg = configFn(store);
    const formFn = opts.form;
    let view: ListView | null = null;
    /* AUTORISATION d'un onglet de LISTE — POINT COMMUN de tous les listings (lot 2 auth/ACL). La permission
       n'est écrite NULLE PART : elle se DÉRIVE de `cfg.collection` par la carte PARTAGÉE
       `Permissions.COLLECTION_DOMAINS` (via `AccessState`). Conséquences voulues :
         · un onglet de liste ajouté demain est gaté SANS que personne y pense — il n'y a aucune table à
           tenir en phase, donc rien à oublier ;
         · le client ne peut pas diverger de la garde serveur de la même route générique, elles lisent la
           MÊME carte.
       Les prédicats sont réévalués au rendu (`shell.refreshCounts`), donc ils suivent un changement de
       droits à chaud. En mode fichier, `access` vaut ALL : tous rendent vrai, rien ne bouge. */
    const canReadTab = () => access.canReadCollection(cfg.collection);
    const canCreateRow = () => access.canCreateCollection(cfg.collection);
    const canUpdateRow = () => access.canUpdateCollection(cfg.collection);
    const canDeleteRow = () => access.canDeleteCollection(cfg.collection);
    const container = shell.addView({
      name, label, title: opts.title, subtitle: opts.subtitle, kind: opts.kind || "primary", parent: opts.parent,
      icon: opts.icon,   // icône d'onglet (barre desktop = icône seule ; menus = icône + libellé)
      visible: canReadTab,   // onglet masqué sans le droit de LECTURE de sa collection (carte partagée)
      extraActions: opts.extraActions,   // boutons secondaires d'en-tête (ex. « Réseaux virtuels… » sur l'onglet VMs)
      // G6 — pastille de comptage : `store.all(c).length` MENT dès que la collection est chargée
      // paresseusement (il ne compte que ce qui a été absorbé). `store.countHint` rend la longueur
      // LOCALE pour une collection hydratée (zéro régression, zéro réseau) et, pour une collection
      // partielle, la dernière valeur connue du COUNT serveur — en déclenchant son relevé si besoin.
      // L'arrivée de la valeur repasse par `store.onCountResolved` → `shell.refreshCounts()`.
      count: () => store.countHint(cfg.collection),
      addLabel: (VIEWER || opts.noAdd) ? undefined : opts.addLabel, onAdd: (VIEWER || opts.noAdd) ? undefined : (opts.onAdd || (formFn ? () => formFn(null, () => shell.refreshActive()) : undefined)),   // viewer / noAdd : pas de création
      canAdd: canCreateRow,   // « + créer » masqué sans le droit de CRÉATION du domaine de la collection
      onShow: () => {
        if (!view) {
          const reRender = () => view!.render();
          // « Localiser en 3D » par ligne : le bouton n'est proposé que si la localisation peut ABOUTIR — mêmes
          // prédicats que locateEquipment/locateRack/locateCable. Sinon le bouton n'aurait qu'un toast d'erreur
          // (équipement d'inventaire pur, baie non placée, câble en attente…).
          // La CIBLE est résolue AVANT le prédicat : sur un onglet dont la ligne n'est pas l'objet localisé
          // (VMs → leur hôte), c'est l'objet VISÉ qui doit satisfaire le prédicat, jamais la ligne.
          const locateTargetOf: (id: string) => string | null = opts.locateTarget || ((id: string) => id);
          const isLocatable =
            opts.locate === "equipment" ? (id: string) => store.equipmentLocatable(id)
            : opts.locate === "rack" ? (id: string) => { const rk: any = store.get("racks", id); return !!(rk && rk.datacenter_id); }
            // CÂBLE : prédicat PARTAGÉ (`core/Locatable`) — et plus qu'un miroir, c'est la MÊME règle que
            // consomme `DcInteract.locateCable` pour choisir l'extrémité qu'il cadre (doctrine §6.32). Il
            // reconnaît une extrémité posée sur un ÉTAGE, que l'ancien `cableDcId` (retiré, §6.33)
            // déclarait « non placée ».
            : opts.locate === "cable" ? (id: string) => store.cableLocatable(id)
            : null;
          const canLocate = isLocatable ? (id: string) => { const target = locateTargetOf(id); return !!target && isLocatable(target); } : undefined;
          // Raffinements d'action de LIGNE existants (ex. VMs : seules les MANUELLES s'éditent/se
          // suppriment) : l'autorisation s'y COMPOSE, elle ne les remplace pas — les deux doivent être
          // satisfaits. Écrit ici, une fois, pour TOUS les listings.
          const cfgActions: NonNullable<ListOptions["actions"]> = cfg.actions || {};
          const andCan = (allowed: () => boolean, refine?: (id: string) => boolean) => (id: string) => allowed() && (!refine || refine(id));
          view = new ListView(store, container, {
            ...cfg,
            remoteList: listRemoteReader,   // mode API : recherche/filtres serveur-pilotés (null en mode fichier)
            // PANIER (docs/panier.md) : colonne de cases sur les listings dont la collection entre au
            // panier — donc, en V1-Beta, câbles et faisceaux SEULEMENT. Écrit ICI, une fois, pour TOUS
            // les listings : le jour où une famille de plus porte une action, elle hérite des cases
            // sans que personne y pense. Le prédicat est réévalué à CHAQUE rendu (mode fichier ⇒ jamais
            // de case, changement de droits ⇒ suivi à chaud).
            selection: {
              enabled: () => CartPanel.accepts(cfg.collection),
              isSelected: (id) => CartPanel.isSelected(cfg.collection, id),
              setSelected: (id, on, record) => CartPanel.setSelected(cfg.collection, id, on, record),
            },
            actions: VIEWER
              ? { view: true, locate: !!opts.locate, canLocate }   // viewer : consultation + localisation seulement (pas d'édition/clone/suppression)
              : {
                  ...(cfg.actions || { view: true, edit: !!formFn, clone: true, del: true }),
                  ...(opts.locate ? { locate: true, canLocate } : {}), ...(opts.manage ? { manage: true } : {}),
                  // « Imprimer l'étiquette » (lot E) : proposée si l'onglet la câble, disponible en mode API
                  // seulement — le prédicat suit l'injection (aucun setup en mode fichier → jamais visible).
                  ...(opts.onPrint ? { print: true, canPrint: () => LabelPrintDialog.available() } : {}),
                  // Gestes d'ÉCRITURE de la ligne, gatés par le verbe correspondant du domaine.
                  canEdit: andCan(canUpdateRow, cfgActions.canEdit),
                  canDel: andCan(canDeleteRow, cfgActions.canDel),
                  canClone: andCan(canCreateRow, cfgActions.canClone),   // dupliquer = créer
                  canManage: andCan(canUpdateRow, cfgActions.canManage), // ▦ Contenu de baie = mettre à jour
                },
            onAction: async (act, id) => {
              if (act === "locate" && opts.locate) {
                const target = locateTargetOf(id);
                if (!target) return;   // défense : `canLocate` interdit déjà de proposer l'action dans ce cas
                shell.switchView("datacenter"); dcView.locate(opts.locate, target); dcView.setReturnAction(() => shell.switchView(name)); return;
              }
              if (act === "manage" && cfg.collection === "racks") { Forms.rackContent(store, formHost, id, reRender); return; }   // ▦ Contenu : éditeur de montage des U
              if (act === "view") {
                if (cfg.collection === "equipments") Forms.equipmentDetail(store, formHost, id, reRender);
                else if (cfg.collection === "racks") Forms.rackDetail(store, formHost, id, reRender);
                else openDetail(cfg.collection, id);
                return;
              }
              if (act === "download") { opts.onDownload?.(id); return; }   // binaire hors document (pièces jointes) — cf. onDownload
              if (act === "show") { opts.onShow?.(id); return; }           // viewer intégré (binaire hors document) — cf. onShow
              if (act === "print") { opts.onPrint?.(id); return; }         // étiquette QR imprimable (lot E) — cf. onPrint
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
            onOpenEntity: (collection, id) => {   // référence cliquable dans une cellule (ex. nom d'équipement dans la liaison d'un câble)
              if (collection === "equipments") Forms.equipmentDetail(store, formHost, id, reRender);
              else if (collection === "racks") Forms.rackDetail(store, formHost, id, reRender);
              else openDetail(collection, id);
            },
          });
        }
        view.render();
      },
    });
    // Accès au listing PAR COLLECTION (registre de l'hôte) : le seul consommateur est le point d'accroche
    // G3 ci-dessous, qui doit périmer la page en main d'une collection lazy touchée par un autre client.
    // Un accesseur PARESSEUX, comme le retour de cette fonction : la vue n'existe qu'une fois l'onglet ouvert.
    listViewsByCollection.set(cfg.collection, () => view);
    return () => view;
  };

  // === ONGLETS PRINCIPAUX (ordre de l'original) ===
  addListTab("equipements", I18n.t("tabs.equipements.label"), ListConfigs.equipments, {
    icon: Icons.EQUIPMENT,
    subtitle: I18n.t("tabs.equipements.subtitle"),
    form: (id, done) => Forms.equipment(store, formHost, id, done), addLabel: I18n.t("app.add.equipment"),
    locate: "equipment",
    // « Imprimer l'étiquette » de ligne (lot E étiquettes QR) : geste UNITAIRE. Une planche s'obtient par
    // la BAIE (« Planche du contenu ») ou par le PANIER — la sélection multiple « différée » du lot E a
    // été livrée depuis par le chantier panier (cases des listings, cf. docs/panier.md).
    onPrint: (id) => {
      const eq: any = store.get("equipments", id);
      if (eq) LabelPrintDialog.open({ kind: "equipment", subjects: [LabelSubjects.equipment(store, eq)], source: eq.name || "" });
    },
  });
  // VMs : onglet de PREMIER NIVEAU (à côté d'Équipements). Deux origines : la SYNCHRO (Proxmox…) et la SAISIE
  // MANUELLE (forme B, cadrage 2026-08-15 : une VM manuelle = `provider_id` vide). Le bouton « + VM » et le
  // formulaire complet `VmForms.manual` sont donc câblés (`form`/`addLabel`) — dans LES DEUX modes (fichier ET
  // API : c'est le point du chantier), le VIEWER en étant privé par `addListTab` (VIEWER ⇒ addLabel/onAdd undefined).
  // Actions d'en-tête (feature amovible) :
  //  - « Réseaux virtuels… » : mapping bridge/tag → réseau logique (méta) — les deux modes, hors viewer ;
  //  - « Purger… » : purge de MASSE des orphelines / des VMs d'un provider disparu — les deux modes, hors
  //    viewer, et CONDITIONNEL (masqué s'il n'y a rien à purger, cf. `visible` ci-dessous) ;
  //  - « Synchroniser » : MODE API SEULEMENT (masqué en mode fichier — pas de serveur à interroger). L'ancien
  //    « Statut de synchro… » a migré vers le sous-onglet « Clusters » (état de synchro PAR provider + nœuds).
  // Sous-onglet « Clusters » (feature amovible, MODE API) : instancié plus bas si REST_MODE. Déclaré ICI pour que
  // le « Synchroniser » de la barre d'outils puisse le rafraîchir après une passe réussie (cf. onDone ci-dessous).
  let clustersView: VmClustersView | null = null;
  // PURGE DE MASSE des VMs — liste des providers CONFIGURÉS, nécessaire au groupe « provider disparu ».
  // `null` = INCONNUE : mode fichier (aucun serveur à interroger, principe n°15) ou sonde pas encore
  // aboutie. Le prédicat de visibilité du bouton la lit à chaque `refreshCounts` et déclenche, UNE
  // seule fois par session, un tirage en tâche de fond (le prédicat doit rester synchrone). Sans liste,
  // seules les ORPHELINES rendent le bouton visible — jamais de supposition sur une config non lue.
  let vmConfiguredProviderIds: string[] | null = null;
  let vmProvidersProbeStarted = false;
  const probeVmProviders = (): void => {
    // `GET …/vm/providers` est gardé par `vm:read` côté serveur : sans ce droit, la sonde ne rapporterait
    // qu'un 403 (correctif « droits partiels »). La liste reste alors INCONNUE — exactement l'état prévu
    // par le prédicat de visibilité du bouton « Purger… », qui ne suppose rien d'une config non lue.
    if (vmProvidersProbeStarted || !vmSyncClient || !access.has("vm:read")) return;
    vmProvidersProbeStarted = true;
    vmSyncClient.providers()
      .then((list) => { vmConfiguredProviderIds = list.map((p) => p.id); shell.refreshCounts(); })   // relit la visibilité avec la config réelle
      .catch(() => { /* 503 (clé absente) / panne : la liste reste inconnue pour CE document, la modale le dira */ });
  };
  /** Ré-arme la sonde : la config des providers est PAR DOCUMENT, et le premier tirage a lieu au
      `shell.build()` — donc AVANT que le moindre document soit ouvert (l'appel échoue alors sur
      « aucun document ouvert »). Appelé à chaque ouverture de document en mode API. */
  const resetVmProvidersProbe = (): void => { vmProvidersProbeStarted = false; vmConfiguredProviderIds = null; };
  const vmExtraActions: NonNullable<TabOpts["extraActions"]> = VIEWER ? [] : [
    // « Réseaux virtuels… » écrit le mapping bridge/tag dans la MÉTA du document → `dc.site:update`.
    { label: I18n.t("app.vm.netMapping"), title: I18n.t("app.vm.netMappingTitle"), visible: () => access.canUpdate("dc.site"), onClick: () => VmForms.netMapping(store, formHost) },
    // « Purger… » : les DEUX modes (fichier et API), hors viewer. Visible seulement s'il y a matière —
    // au moins une orpheline, ou (config connue) au moins une VM d'un provider disparu.
    {
      label: I18n.t("app.vm.purge"), title: I18n.t("app.vm.purgeTitle"),
      // Suppression de MASSE : au prédicat métier (« y a-t-il de la matière ? ») s'ajoute le DROIT de
      // supprimer — testé EN PREMIER, pour ne pas sonder les providers d'un document qu'on ne purgera pas.
      visible: () => {
        if (!access.canDeleteCollection("vms")) return false;
        probeVmProviders();
        return VmPurge.hasPurgeable(store.all("vms"), vmConfiguredProviderIds);
      },
      onClick: () => VmPurgeForm.open(store, formHost, vmSyncClient, { onDone: () => shell.refreshActive() }),
    },
  ];
  if (REST_MODE && vmSyncClient) {
    const client = vmSyncClient;   // const → non-null capturé dans les closures (garde REST_MODE ci-dessus)
    // « Synchroniser » : après une passe réussie, rafraîchit le sous-onglet Clusters (le statut du cluster vit en
    // MÉMOIRE serveur, sans push SSE → on retire à la main). « Statut de synchro… » a été RETIRÉ : redondant avec
    // le sous-onglet Clusters (qui affiche désormais l'état de synchro PAR provider, cf. cadrage 2026-07-13).
    vmExtraActions.push(
      { label: I18n.t("app.vm.sync"), title: I18n.t("app.vm.syncTitle"), visible: () => access.has("vm:sync"), onClick: (btn) => { void VmForms.sync(client, btn, () => { void clustersView?.reload(); }); } },
    );
  }
  // « Localiser en 3D » sur une ligne de VM : une VM n'est PAS un objet de la scène — on localise son
  // ÉQUIPEMENT HÔTE. Version SOBRE (choix utilisateur) : le prédicat PARTAGÉ `VmLocate.hostEquipmentId`
  // rend `null` dès que la localisation ne peut pas aboutir (VM non rapprochée, hôte supprimé, hôte non
  // localisable — dont le cas « posé sur un étage »), et le bouton n'apparaît alors pas du tout.
  addListTab("vms", I18n.t("tabs.vms.label"), ListConfigs.vms, {
    icon: Icons.VM,
    title: I18n.t("tabs.vms.title"), subtitle: I18n.t("tabs.vms.subtitle"),
    // Création/édition d'une VM MANUELLE (formulaire complet). `cfg.actions` de ListConfigs.vms (edit/del + gating
    // canEdit/canDel par ligne) PRIME sur le défaut `edit: !!formFn` d'`addListTab` (spread `...(cfg.actions || …)`)
    // — le gating « manuelles seulement » est donc préservé. La SUPPRESSION passe par le chemin GÉNÉRIQUE (Dialog +
    // store.remove, cascade standard) : aucun `onDel` spécifique n'est nécessaire.
    form: (id, done) => VmForms.manual(store, formHost, id, done), addLabel: I18n.t("app.add.vm"),
    extraActions: VIEWER ? undefined : vmExtraActions,
    locate: "equipment", locateTarget: (id) => VmLocate.hostEquipmentId(store.get("vms", id), store),
  });
  // Sous-onglet « Clusters » : vue PERSONNALISÉE (non-liste) enregistrée comme les vues Netmap/Datacenters
  // (shell.addView + classe dédiée à `.show()`), en `kind: "secondary"` rattachée à l'onglet VMs — on réutilise le
  // mécanisme de sous-onglet des listes (secondary + parent + lien d'en-tête) pour une vue custom. MODE API seulement.
  if (REST_MODE && vmSyncClient) {
    const client = vmSyncClient;
    // En-tête du sous-onglet : « Providers… » (gestion CRUD, NON-VIEWER seulement) avant « Actualiser ».
    // Après toute écriture, la modale rappelle `onChanged` → on recharge l'état des clusters (config à chaud).
    const clustersActions: NonNullable<TabOpts["extraActions"]> = [];
    if (!VIEWER) clustersActions.push({ label: I18n.t("app.vm.providers"), title: I18n.t("app.vm.providersTitle"), visible: () => access.has("vm.providers:manage"), onClick: () => VmProvidersForm.open(formHost, client, () => { void clustersView?.reload(); }) });
    clustersActions.push({ label: I18n.t("app.vm.refresh"), title: I18n.t("app.vm.refreshTitle"), onClick: () => { void clustersView?.reload(); } });
    const clustersContainer = shell.addView({
      name: "clusters", label: I18n.t("tabs.clusters.label"), kind: "secondary", parent: "vms",
      icon: Icons.NETWORK,
      visible: () => canSeeView("clusters"),
      title: I18n.t("tabs.clusters.label"), subtitle: I18n.t("tabs.clusters.subtitle"),
      extraActions: clustersActions,
      onShow: () => clustersView?.show(),
    });
    clustersView = new VmClustersView(store, clustersContainer, client, {
      // Rapprochement nœud→équipement rendu en LIEN : ouvre la fiche équipement (comme GraphView/DatacenterView).
      openEquipmentDetail: (id) => Forms.equipmentDetail(store, formHost, id, () => shell.refreshActive()),
      // Raccourci « Purger… » de la carte provider (non-viewer seulement : c'est une action destructrice) —
      // ouvre la MÊME modale que l'en-tête de l'onglet VMs, en pré-sélectionnant les orphelines du provider.
      openPurge: VIEWER ? undefined : (providerId) => VmPurgeForm.open(store, formHost, client, {
        providerId, onDone: () => { shell.refreshActive(); void clustersView?.reload(); },
      }),
    });
  }
  // CLIENTS WIFI : onglet de PREMIER NIVEAU, LECTURE SEULE — alimenté par la synchro d'un contrôleur
  // (UniFi en 1re implémentation ; la marque n'est qu'un adaptateur serveur, cf. docs/wifi-unifi.md).
  // Pas de `form`/`addLabel` : AUCUN bouton « + créer » (cf. ListConfigs.wifiClients `actions: view`) ;
  // les enrichissements locaux (description/notes) se font depuis la fiche. Actions d'en-tête (feature
  // amovible), MODE API SEULEMENT — masquées en mode fichier, où il n'y a aucun serveur à interroger :
  //  - « Synchroniser » : lance une passe sur tous les providers du document ;
  //  - « Providers… » : CRUD des contrôleurs (hors VIEWER — c'est de la configuration).
  const wifiExtraActions: NonNullable<TabOpts["extraActions"]> = [];
  if (REST_MODE && wifiSyncClient) {
    const client = wifiSyncClient;   // const → non-null capturé dans les closures (garde REST_MODE ci-dessus)
    wifiExtraActions.push({ label: I18n.t("app.wifi.sync"), title: I18n.t("app.wifi.syncTitle"), visible: () => access.has("wifi:sync"), onClick: (btn) => { void WifiForms.sync(client, btn); } });
    if (!VIEWER) wifiExtraActions.push({ label: I18n.t("app.wifi.providers"), title: I18n.t("app.wifi.providersTitle"), visible: () => access.has("wifi.providers:manage"), onClick: () => WifiProvidersForm.open(formHost, client, () => shell.refreshActive()) });
  }
  // « Localiser en 3D » sur une ligne : un client wifi n'est PAS un objet de la scène — on localise
  // son POINT D'ACCÈS. Version SOBRE (comme les VMs) : le prédicat PARTAGÉ `WifiLocate.apEquipmentId`
  // rend `null` dès que la localisation ne peut pas aboutir (client non rapproché, AP supprimé, AP non
  // localisable), et le bouton n'apparaît alors pas du tout.
  addListTab("wifi", I18n.t("tabs.wifi.label"), ListConfigs.wifiClients, {
    icon: Icons.WIFI,
    title: I18n.t("tabs.wifi.title"), subtitle: I18n.t("tabs.wifi.subtitle"),
    extraActions: wifiExtraActions.length ? wifiExtraActions : undefined,
    locate: "equipment", locateTarget: (id) => WifiLocate.apEquipmentId(store.get("wifiClients", id), store),
  });
  addListTab("racks", I18n.t("tabs.racks.label"), ListConfigs.racks, {
    icon: Icons.RACK_CONTENT,
    subtitle: I18n.t("tabs.racks.subtitle"),
    form: (id, done) => Forms.rack(store, formHost, id, done), addLabel: I18n.t("app.add.rack"), locate: "rack", manage: true,
  });
  addListTab("cables", I18n.t("tabs.cables.label"), (s) => ListConfigs.cables(s, entitySearchReader), {
    icon: Icons.CABLE,
    subtitle: I18n.t("tabs.cables.subtitle"),
    form: (id, done) => Forms.cable(store, formHost, id, done), addLabel: I18n.t("app.add.cable"),
    locate: "cable",
    // « Imprimer l'étiquette » de ligne (retour terrain 2026-08-20 : l'action manquait ici).
    // T11 : UN sujet, comme la fiche — c'est la bascule A / B / A+B de la modale (défaut A+B)
    // qui dit combien de drapeaux, et non plus le point d'entrée qui pousse le sujet en double.
    onPrint: (id) => {
      const cable: any = store.get("cables", id);
      if (!cable) return;
      LabelPrintDialog.open({ kind: "cable", subjects: [LabelSubjects.cable(store, cable)], source: cable.name || "", defaultEndsMode: "ab" });
    },
  });
  // IPAM : la page PRINCIPALE de l'onglet est la liste des ADRESSES IP ; les réseaux (sous-réseaux) et les plages
  // DHCP sont des sous-onglets. Le titre/soustitre réutilisent les libellés « adresses » ; ceux « IPAM — Réseaux IP »
  // partent au sous-onglet ipnetworks.
  addListTab("ipam", I18n.t("tabs.ipam.label"), (s) => ListConfigs.ipAddresses(s, entitySearchReader), {
    icon: Icons.IPAM,
    title: I18n.t("tabs.ipaddresses.title"), subtitle: I18n.t("tabs.ipaddresses.subtitle"),
    form: (id, done) => Forms.ipAddress(store, formHost, id, done), addLabel: I18n.t("app.add.ipAddress"),
  });

  // Netmap (GraphView) — « Netmap » est un NOM DE FONCTIONNALITÉ, conservé tel quel dans les deux langues (cf. catalogues).
  let graph: GraphView;
  const graphContainer = shell.addView({ name: "graph", label: I18n.t("tabs.graph.label"), subtitle: I18n.t("tabs.graph.subtitle"), icon: Icons.GRAPH, visible: () => canSeeView("graph"), onShow: () => graph.show() });
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
  const dcContainer = shell.addView({ name: "datacenter", label: I18n.t("tabs.datacenter.label"), subtitle: I18n.t("tabs.datacenter.subtitle"), icon: Icons.DATACENTER, visible: () => canSeeView("datacenter"), onShow: () => dcView.show() });
  const dcStage = document.createElement("div");
  dcStage.className = "dc-stage";
  dcStage.style.cssText = "position:relative;flex:1 1 auto;min-height:560px;background:var(--bg-2);overflow:hidden";
  dcContainer.appendChild(dcStage);
  dcView = new DatacenterView(store, dcStage, {
    // Outils d'ÉDITION de la barre d'outils 2D (placement libre, édition salle/étage, cases inaccessibles) :
    // masqués sans le droit d'écrire la donnée spatiale. La NAVIGATION (modes de vue, filtres, localisation,
    // mesure) reste entière — voir une salle et la modifier sont deux droits distincts.
    canEditSpace: () => access.canUpdate("dc.site"),
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
  // ⚠ `closeAll` et non `close` : le geste QUITTE les modales pour aller voir la scène. Une fiche atteinte
  // depuis une autre (intervention → cible, contenu de baie → équipement) laisserait sinon les niveaux
  // inférieurs affichés PAR-DESSUS la vue 3D qu'on vient justement d'aller regarder.
  formHost.locate = (kind, id, ret) => { modal.closeAll(); shell.switchView("datacenter"); dcView.locate(kind, id); dcView.setReturnAction(ret || null); };

  // === SOUS-VUES (atteintes par les liens d'en-tête ; surlignent leur onglet parent) ===
  addListTab("groupes", I18n.t("tabs.groupes.label"), ListConfigs.groups, {
    icon: Icons.GROUP,
    subtitle: I18n.t("tabs.groupes.subtitle"),
    form: (id, done) => Forms.group(store, formHost, id, done), addLabel: I18n.t("app.add.group"), kind: "secondary", parent: "equipements",
  });
  addListTab("spares", I18n.t("tabs.spares.label"), ListConfigs.spares, {
    icon: Icons.SPARE,
    subtitle: I18n.t("tabs.spares.subtitle"),
    form: (id, done) => Forms.spare(store, formHost, id, done), addLabel: I18n.t("app.add.spare"), kind: "secondary", parent: "equipements",
    // « Imprimer l'étiquette » de ligne — parité avec la fiche (le geste y existait déjà) et avec
    // les autres listings étiquetables. UNE étiquette : un spare n'a pas deux extrémités.
    onPrint: (id) => {
      const spare: any = store.get("spares", id);
      if (spare) LabelPrintDialog.open({ kind: "spare", subjects: [LabelSubjects.spare(store, spare)], source: (spare.displayName ? spare.displayName() : (spare.name || "")) });
    },
  });
  // Sous-équipements : vue SECONDAIRE d'Équipements (D2 revue le 2026-08-03, lot C). PAS de bouton « + »
  // (`noAdd` — la création reste sur la fiche du maître, qui fournit `equipment_id`), mais l'ÉDITION en ligne
  // marche : `form` rappelle `Forms.subEquipment` en lisant `equipment_id` sur le record. Fiche/clone/suppression
  // sont génériques (clone duplique `equipment_id`, comportement voulu). Pas de `locate` : un sous-équipement
  // n'a aucune existence physique propre (doctrine du chantier d'origine).
  addListTab("sousequipements", I18n.t("tabs.sousequipements.label"), (s) => ListConfigs.subEquipments(s, entitySearchReader), {
    icon: Icons.EQUIPMENT,
    title: I18n.t("tabs.sousequipements.title"), subtitle: I18n.t("tabs.sousequipements.subtitle"),
    kind: "secondary", parent: "equipements", noAdd: true,
    form: (id, done) => {
      if (!id) return;   // création absente de ce listing (le « + » est neutralisé par noAdd)
      const se: any = store.get("subEquipments", id);
      if (se) Forms.subEquipment(store, formHost, se.equipment_id, id, done);
    },
    // « Imprimer l'étiquette » de ligne — même geste que la fiche, gabarit S par défaut.
    onPrint: (id) => {
      const se: any = store.get("subEquipments", id);
      if (se) LabelPrintDialog.open({ kind: "subEquipment", subjects: [LabelSubjects.subEquipment(store, se)], source: se.name || "" });
    },
  });
  // Applications : vue SECONDAIRE d'Équipements (cadrage applications 2026-08-10) — collection du DOCUMENT
  // (les deux modes nativement, principe n°15 sans écart). Création/édition par `Forms.application`
  // (picker d'hôte UNIQUE équipement+VM) ; fiche via le mécanisme générique (DETAIL_OPENERS). Le filtrage
  // par hôte passe par la dimension CIBLE « Hébergée sur » du listing (candidats serveur-pilotés en mode API).
  addListTab("applications", I18n.t("tabs.applications.label"), (s) => ListConfigs.applications(s, entitySearchReader), {
    icon: Icons.APPLICATION,
    title: I18n.t("tabs.applications.title"), subtitle: I18n.t("tabs.applications.subtitle"),
    kind: "secondary", parent: "equipements",
    form: (id, done) => Forms.application(store, formHost, id, done), addLabel: I18n.t("app.add.application"),
  });
  // Pièces jointes : vue SECONDAIRE d'Équipements (cadrage 2026-08-10) — collection du DOCUMENT (les deux
  // modes nativement, principe n°15). Création/édition par `Forms.application`… non : `Forms.attachment`
  // (FilePicker + picker de cible équipement/sous-équipement) ; fiche via le mécanisme générique
  // (DETAIL_OPENERS). Le filtrage par cible passe par la dimension « Attachée à » du listing. Le download
  // d'une ligne passe par l'`attachmentStore` (binaire HORS document) — d'où le hook dédié `onDownload`.
  addListTab("attachments", I18n.t("tabs.attachments.label"), (s) => ListConfigs.attachments(s, entitySearchReader), {
    icon: Icons.ATTACHMENT,
    title: I18n.t("tabs.attachments.title"), subtitle: I18n.t("tabs.attachments.subtitle"),
    kind: "secondary", parent: "equipements",
    form: (id, done) => Forms.attachment(store, formHost, id, done), addLabel: I18n.t("app.add.attachment"),
    onDownload: (id) => { void AttachmentUi.download(formHost, store.get("attachments", id)); },
    onShow: (id) => { void AttachmentUi.view(formHost, store.get("attachments", id)); },   // viewer intégré (D-B4)
  });
  // Images de façade : bibliothèque hors modèle (ImageStore) → câblage dédié (CRUD via imageStore)
  {
    const cfg = ListConfigs.faceImages(store);
    let view: ListView | null = null;
    const container = shell.addView({
      name: "faceimages", label: I18n.t("tabs.faceimages.label"), subtitle: I18n.t("tabs.faceimages.subtitle"),
      kind: "secondary", parent: "equipements", icon: Icons.IMAGE,
      count: () => imageStore.count(),
      // Les images de façade sont la pseudo-collection `images`, rattachée à `dc.site` par la carte
      // partagée : la LECTURE ouvre la page, la MISE À JOUR autorise l'ajout et l'import.
      visible: () => canSeeView("faceimages"),
      canAdd: () => access.canUpdate("dc.site"),
      extraActions: [
        { label: I18n.t("app.faces.import"), title: I18n.t("app.faces.importTitle"), visible: () => access.canUpdate("dc.site"), onClick: () => files.importFacesLibrary() },
        { label: I18n.t("app.faces.export"), title: I18n.t("app.faces.exportTitle"), onClick: () => files.exportFacesLibrary() },
        // Compagnon (mode fichier uniquement) : .nmfb APPARIÉ au document, rechargé/enregistré automatiquement à côté du .json.
        ...(REST_MODE ? [] : [{ label: I18n.t("app.faces.openCompanion"), title: I18n.t("app.faces.openCompanionTitle"), onClick: () => files.openFacesFile() }]),   // mode FICHIER seulement : rien à gater (tout permis)
      ],
      addLabel: I18n.t("app.add.image"), onAdd: () => Forms.faceImage(imageStore, store, formHost, null, () => shell.refreshActive()),
      onShow: () => {
        if (!view) {
          const reRender = () => view!.render();
          view = new ListView(store, container, {
            ...cfg, items: () => imageStore.list(),
            // Les images vivent hors du Store (ImageStore), mais leurs routes serveur sont gardées par
            // `dc.site:update` (PUT/DELETE `/images/:id`) : même verbe pour éditer, dupliquer et supprimer.
            // Le téléchargement, lui, est une LECTURE — il suit la visibilité de la page.
            actions: {
              view: false, edit: true, clone: true, del: true, download: true,
              canEdit: () => access.canUpdate("dc.site"), canClone: () => access.canUpdate("dc.site"), canDel: () => access.canUpdate("dc.site"),
            },
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
    icon: Icons.NETWORK,
    subtitle: I18n.t("tabs.reseaux.subtitle"),
    form: (id, done) => Forms.network(store, formHost, id, done), addLabel: I18n.t("app.add.network"), kind: "secondary", parent: "cables",
  });
  addListTab("faisceaux", I18n.t("tabs.faisceaux.label"), ListConfigs.cableBundles, {
    icon: Icons.BUNDLE,
    title: I18n.t("tabs.faisceaux.title"), subtitle: I18n.t("tabs.faisceaux.subtitle"),
    form: (id, done) => Forms.cableBundle(store, formHost, id, done), addLabel: I18n.t("app.add.bundle"), kind: "secondary", parent: "cables",
    // Étiquette de FAISCEAU (retour terrain 2026-08-20) : même anatomie que le câble — un
    // drapeau par patch terminal (cf. docs/faisceaux.md), donc même défaut A+B, décidé dans la
    // modale depuis T11 et non plus par un sujet poussé en double.
    onPrint: (id) => {
      const bundle: any = store.get("cableBundles", id);
      if (!bundle) return;
      LabelPrintDialog.open({ kind: "bundle", subjects: [LabelSubjects.bundle(store, bundle)], source: bundle.name || "", defaultEndsMode: "ab" });
    },
  });
  addListTab("porttypes", I18n.t("tabs.porttypes.label"), ListConfigs.portTypes, {
    icon: Icons.PORT,
    title: I18n.t("tabs.porttypes.title"), subtitle: I18n.t("tabs.porttypes.subtitle"),
    kind: "secondary", parent: "cables",
  });
  addListTab("cabletypes", I18n.t("tabs.cabletypes.label"), ListConfigs.cableTypes, {
    icon: Icons.CABLE,
    subtitle: I18n.t("tabs.cabletypes.subtitle"),
    kind: "secondary", parent: "cables",
  });
  addListTab("ipnetworks", I18n.t("tabs.ipnetworks.label"), ListConfigs.ipNetworks, {
    icon: Icons.IPAM,
    title: I18n.t("tabs.ipam.title"), subtitle: I18n.t("tabs.ipam.subtitle"),
    form: (id, done) => Forms.ipNetwork(store, formHost, id, done), addLabel: I18n.t("app.add.ipNetwork"), kind: "secondary", parent: "ipam",
  });
  addListTab("salles", I18n.t("tabs.salles.label"), ListConfigs.datacenters, {
    icon: Icons.DATACENTER,
    title: I18n.t("tabs.salles.title"), subtitle: I18n.t("tabs.salles.subtitle"),
    form: (id, done) => Forms.datacenter(store, formHost, id, done), addLabel: I18n.t("app.add.datacenter"), kind: "secondary", parent: "datacenter",
  });
  addListTab("sites", I18n.t("tabs.sites.label"), ListConfigs.sites, {
    icon: Icons.SITE,
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
    icon: Icons.FLOOR,
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
    icon: Icons.IPAM,
    title: I18n.t("tabs.dhcpranges.title"), subtitle: I18n.t("tabs.dhcpranges.subtitle"),
    form: (id, done) => Forms.dhcpRange(store, formHost, id, done), addLabel: I18n.t("app.add.dhcpRange"), kind: "secondary", parent: "ipam",
  });
  // CONTACTS : carnet des destinataires des NOTIFICATIONS (email/sms), tenu PAR DOCUMENT. Le module serveur
  // notify/ route ses alertes via `repo.getOne("contacts", id)` (référence souple `contact_id`, HORS document).
  // Vue du domaine « Paramètres » (S6, cf. cadrage notifications 2026-07-14 §3), bookmarkable via #contacts.
  // Décision Q4 : contacts PAR DOCUMENT. ⚠ AUCUN `parent` : le rattachement au menu vient de `NAV_DOMAINS`
  // depuis le re-design (le GROUPE « parametres » n'existe plus, cf. docs/navigation.md) — un `parent`
  // pointant vers lui serait une référence pendante.
  addListTab("contacts", I18n.t("tabs.contacts.label"), ListConfigs.contacts, {
    icon: Icons.USER,
    title: I18n.t("tabs.contacts.title"), subtitle: I18n.t("tabs.contacts.subtitle"),
    form: (id, done) => Forms.contact(store, formHost, id, done), addLabel: I18n.t("app.add.contact"),
    kind: "secondary",
  });
  // NOTIFICATIONS (S7) : page d'ADMINISTRATION du module serveur notify/ (canaux, abonnements, rappels, alertes
  // actives, historique, tests d'envoi). Vue du domaine « Paramètres » (vue custom, pattern VmClustersView).
  // TOUJOURS enregistrée (visible dans le domaine Paramètres, même en mode fichier) : `notifyClient` est null hors
  // mode API → la vue affiche un message « nécessite le mode API/serveur » au lieu d'appeler le réseau (feature
  // AMOVIBLE : retirer S7 = supprimer NotificationsAdminView + NotifyClient + ces lignes).
  // ⚠ AUCUN `parent` : cf. la note de l'onglet Contacts ci-dessus (le groupe `parametres` n'existe plus).
  let notificationsView: NotificationsAdminView;
  const notifyContainer = shell.addView({
    name: "notifications", label: I18n.t("tabs.notifications.label"), kind: "secondary",
    icon: Icons.NOTIFICATION,
    visible: () => canSeeView("notifications"),
    title: I18n.t("tabs.notifications.label"), subtitle: I18n.t("tabs.notifications.subtitle"),
    onShow: () => notificationsView.show(),
  });
  // Source du sélecteur de CONTACT des abonnements (picker ASYNC, pilote du chantier) : le carnet
  // est chargé PARESSEUSEMENT en mode API — la page ne l'hydrate PLUS en entier, le champ va
  // chercher ses candidats au serveur (parcours par la route de listing trié `name`, recherche
  // transverse via `entitySearchReader` — null en mode fichier/viewer : source 100 % locale,
  // principe n°15). Construite ICI et injectée : la vue ne connaît que le CONTRAT (principe n°2).
  const contactPickerSource = new CollectionPickerSource(store, {
    kind: "contact", collection: "contacts",
    label: (contact: any) => contact.name || I18n.t("lists.ph.noName"),   // même règle de nommage que la table des abonnements
    sortColumn: "name",
  }, entitySearchReader);
  // Écritures de la page (canaux, abonnements, rappels, test d'envoi) : permission MÉTA `notify:manage` —
  // la LECTURE, elle, est déjà gardée par la visibilité de l'onglet (`notify:read`, cf. ViewAccess).
  notificationsView = new NotificationsAdminView(store, notifyContainer, notifyClient, formHost, contactPickerSource, () => access.has("notify:manage"));   // formulaires dans LA modale de l'app (principe n°11)
  // INTERVENTIONS : page d'ADMINISTRATION du suivi des incidents & interventions (liés aux équipements/VMs/
  // spares). ONGLET PRINCIPAL (décision de cadrage), enregistré JUSTE AVANT « Certificats ». Vue custom
  // TOUJOURS enregistrée : `interventionsClient` est null hors mode API → la vue affiche « mode API requis »
  // (feature AMOVIBLE : retirer = supprimer InterventionsAdminView + InterventionsClient + InterventionsFormat
  // + ces lignes). Les cibles liables viennent d'une interface hôte INJECTÉE (la vue ne touche jamais le Store).
  // FAMILLES de cibles liables — UNE SEULE table, MIROIR de INTERVENTION_TARGET_KINDS (serveur).
  // ⚠ Elle remplace trois chaînes de ternaires (`targetFallback`, `targetCollection` et la liste `families`
  // ci-dessous) dont le DÉFAUT était « spare » : une 4ᵉ famille non déclarée s'y résolvait SILENCIEUSEMENT en
  // spare — mauvaise collection lue, mauvais libellé de repli, aucune erreur. Ajouter une famille = ajouter
  // UNE entrée ici ; un slug inconnu rend désormais `undefined` et se voit (cf. les gardes ci-dessous).
  const TARGET_FAMILIES: Record<string, { collection: string; fallbackKey: string }> = {
    equipment:     { collection: "equipments",    fallbackKey: "interventions.target.fallback.equipment" },
    vm:            { collection: "vms",           fallbackKey: "interventions.target.fallback.vm" },
    spare:         { collection: "spares",        fallbackKey: "interventions.target.fallback.spare" },
    sub_equipment: { collection: "subEquipments", fallbackKey: "interventions.target.fallback.sub_equipment" },
    application:   { collection: "applications",  fallbackKey: "interventions.target.fallback.application" },
  };
  const targetFallback = (kind: string): string => {
    const family = TARGET_FAMILIES[kind];
    return family ? I18n.t(family.fallbackKey) : I18n.t("interventions.target.unknown");
  };
  const targetLabel = (kind: string, r: any): string => {
    // Un spare n'a pas toujours de `name` : son identité lisible est calculée (displayName), avec le numéro de
    // série en dernier recours. Les autres familles portent un `name` — un sous-équipement en a un REQUIS.
    if (kind === "spare") return (r.displayName ? r.displayName() : r.name) || r.serial || targetFallback(kind);
    return r.name || targetFallback(kind);
  };
  const targetCollection = (kind: string): string => {
    const family = TARGET_FAMILIES[kind];
    return family ? family.collection : "";   // slug inconnu → collection vide : `store.get("")` rend null, la cible s'affiche « introuvable »
  };
  // Source de CANDIDATS des cibles liables (double mode, lot 4) — familles DÉRIVÉES de TARGET_FAMILIES
  // (plus de tableau parallèle à garder en phase), règle de nommage = `targetLabel` (spare → displayName…).
  // En mode API, les candidats viennent du SERVEUR (recherche transverse, au-delà du corpus chargé) avec
  // anti-rebond/annulation/repli ; en mode fichier, du cache LOCAL (`entitySearchReader` null). Le tri de
  // pertinence, le plafond et la dédup (cibles déjà liées) restent délégués au module pur `TargetSearch`.
  const interventionCandidateFamilies: EntityCandidateFamily[] = Object.entries(TARGET_FAMILIES)
    .map(([kind, family]) => ({ kind, collection: family.collection, label: (r: any) => targetLabel(kind, r) }));
  const interventionCandidates = new EntityCandidateSource(store, interventionCandidateFamilies, entitySearchReader);
  const interventionTargets: InterventionTargetSource = {
    // G10 (chantier lazy-load, cf. docs/hydratation.md § Vague 4) : `labelOf` est SYNCHRONE — la vue
    // résout un libellé par id au moment du rendu, elle ne peut pas attendre. Or deux familles de
    // cibles vivent dans des collections chargées PARESSEUSEMENT en mode API (`applications` vague 2,
    // `spares` vague 4) : une cible non absorbée s'afficherait « (introuvable) », comme supprimée.
    // Ce préalable résout, GROUPÉ PAR COLLECTION, les seuls ids RÉFÉRENCÉS par ce que la vue va
    // afficher (doctrine 2026-08-13 « hydraté = ce que le 3D consomme » — il REMPLACE l'hydratation
    // en masse de `applications` posée en vague 2) : collecte des ids absents du cache (module pur
    // `core/TargetLabelResolution`), un `fetchMany` par collection (absorption + indexation), et le
    // rendu synchrone trouve tout. Mode fichier : tout est en cache → partition VIDE → AUCUN appel
    // adaptateur, no-op PAR CONSTRUCTION (principe n°15, aucun test de mode ici). Les familles
    // hydratées (équipements, VMs, sous-équipements) ne coûtent rien pour la même raison.
    // Un ÉCHEC réseau est AVALÉ : mieux vaut un listing d'interventions complet avec un libellé en
    // moins qu'une page qui refuse de s'afficher (même doctrine que `ensureTrackerProviders`).
    prepareLabels: (links) => {
      const missing = TargetLabelResolution.missingByCollection(
        links,
        (kind) => TARGET_FAMILIES[kind]?.collection,
        (collection, id) => !!store.get(collection, id),
      );
      return Promise.all(Object.entries(missing).map(([collection, ids]) => store.fetchMany(collection, ids)))
        .then(() => undefined).catch(() => undefined);
    },
    labelOf: (kind, id) => { const r: any = store.get(targetCollection(kind), id); return r ? targetLabel(kind, r) : null; },
    search: (query, excluded) => interventionCandidates.fetch(query, excluded),
    // Ouvre la FICHE DE DÉTAIL existante de la cible (equipment/vm/spare) via la machinerie des fiches. Le
    // retour à la modale d'intervention est STRUCTUREL depuis que `Modal` est une PILE : la fiche s'EMPILE
    // par-dessus et le détail d'intervention reste vivant dessous (il se rafraîchit tout seul, via son
    // propre `onResume`). L'hôte enveloppant qui injectait un `onClose` de retour a donc disparu.
    openTargetDetail: (kind, id) => {
      Forms.detail(store, formHost, targetCollection(kind), id, () => shell.refreshActive());
    },
  };
  let interventionsView: InterventionsAdminView;
  // Badge de l'onglet « Interventions » : nombre d'interventions OUVERTES. La donnée est PAGINÉE côté serveur alors
  // que le `count()` du shell est SYNCHRONE → on maintient une valeur CACHÉE, rafraîchie en ASYNC (bootstrap REST,
  // activation de l'onglet, après écriture dans la vue), et on force `shell.refreshCounts()` quand elle arrive. Le
  // total d'ouvertes = `total` du listing filtré sur les statuts ouverts (aucun chargement complet côté client).
  // Mode fichier : `interventionsClient` est null → `count` non défini (pas de badge, cf. Shell.build).
  // La pastille prend une TEINTE D'ALERTE (err) dès qu'au moins une intervention OUVERTE est de priorité
  // `critical` (2e comptage pageSize:1 filtré ouvertes + priorité critique — le listing serveur ET statuts ET
  // priorité). Le compte affiché reste le nombre d'OUVERTES (inchangé).
  let interventionsOpenCount = 0;
  let interventionsCriticalOpen = false;
  const refreshInterventionsCount = async (): Promise<void> => {
    // 🚨 Sans `interventions:read`, l'onglet est masqué : sa pastille n'a aucun spectateur, et ces deux
    // comptages ne rapporteraient qu'un 403 (correctif « droits partiels », même règle que `countHint`).
    if (!interventionsClient || !interventionsClient.docId || !access.has("interventions:read")) { interventionsOpenCount = 0; interventionsCriticalOpen = false; shell.refreshCounts(); return; }
    try {
      const openStatuses = [...InterventionsFormat.OPEN_STATUS_SLUGS];
      const [openRes, critRes] = await Promise.all([
        interventionsClient.listPage({ pageSize: 1, statuses: openStatuses }),
        interventionsClient.listPage({ pageSize: 1, statuses: openStatuses, priorities: ["critical"] }),
      ]);
      interventionsOpenCount = openRes.total;
      interventionsCriticalOpen = critRes.total > 0;
    } catch (_) { /* badge non critique : on garde l'ancienne valeur en cas d'échec réseau */ }
    shell.refreshCounts();
  };
  const interventionsContainer = shell.addView({
    name: "interventions", label: I18n.t("tabs.interventions.label"), kind: "primary",
    icon: Icons.INTERVENTION,
    visible: () => canSeeView("interventions"),
    title: I18n.t("tabs.interventions.label"), subtitle: I18n.t("tabs.interventions.subtitle"),
    count: REST_MODE ? () => interventionsOpenCount : undefined,   // badge en mode API uniquement (masqué à 0)
    countClass: REST_MODE ? () => (interventionsCriticalOpen ? "err" : null) : undefined,   // ≥ 1 ouverte critique → alerte rouge
    onShow: () => { interventionsView.show(); void refreshInterventionsCount(); },
  });
  // Dernier argument : le PONT de réplication a sa propre permission (`tracker:read`), distincte de celle
  // qui ouvre cette page — prédicat relu à chaque appel, comme partout ailleurs dans le gating.
  interventionsView = new InterventionsAdminView(interventionsContainer, interventionsClient, formHost, interventionTargets, trackerClient, () => access.has("tracker:read"));   // formulaires dans LA modale de l'app (principe n°11)
  interventionsView.onCountsChanged = () => { void refreshInterventionsCount(); };   // après création/clôture/suppression → recompte les ouvertes
  // INTÉGRATION « FICHES » (badge + déclaration depuis équipement/VM/spare) : hooks injectés dans les fiches
  // via FormHost (contrat découplé — les formulaires n'importent NI la vue NI le client interventions). null
  // hors mode API → aucune rangée « Interventions » dans les fiches. `declareFor` FERME la fiche courante
  // (fait par InterventionFicheRow) PUIS navigue vers l'onglet et ouvre la modale de création pré-liée : on
  // CHANGE DE VUE, la fiche d'où l'on part n'a donc plus lieu d'être — ce n'est pas un empilement.
  // 🚨 Chaque hook qui touche le RÉSEAU relit `interventions:read` (correctif « droits partiels ») : une
  // fiche s'ouvre depuis n'importe quel listing DC, alors que le module interventions a sa propre
  // permission — sans ces gardes, ouvrir une fiche d'équipement suffisait à déclencher un 403 et son toast.
  const interventionHooks: InterventionFicheHooks | null = interventionsClient ? {
    countOpen: async (kind, id) => {
      if (!access.has("interventions:read")) return 0;   // pas de rangée « Interventions » sur la fiche
      const map = await interventionsClient.counts([{ kind, id }]); return map[kind + ":" + id] || 0;
    },
    // Mini-listing « n dernières » de la cible : listing paginé FILTRÉ (targets) + tri activité récente (défaut
    // serveur), projeté sur le type LOCAL du contrat (on ne fait pas fuiter InterventionRecord dans les fiches).
    latestFor: async (kind, id, n) => {
      if (!access.has("interventions:read")) return [];
      const page = await interventionsClient.listPage({ pageSize: n, targets: [{ kind, id }], sort: "updated_date", dir: "desc" });
      return page.interventions.map((it) => ({ id: it.id, title: it.title, status: it.status, priority: it.priority, updated_date: it.updated_date }));
    },
    // Clic sur une LIGNE du mini-listing : la fiche de détail de l'intervention s'EMPILE par-dessus la
    // fiche courante — PREMIER hook SANS `switchView` (c'est tout l'intérêt de la pile de modales, D1 levé) :
    // on ne quitte ni la vue ni la fiche, ← Retour ramène à l'objet. La vue relit l'intervention par id
    // (fraîcheur ; introuvable → toast, rien ne s'ouvre).
    openDetail: (id) => interventionsView.openDetailById(id),
    declareFor: (kind, id, label) => { shell.switchView("interventions"); interventionsView.openCreateFor(kind, id, label); },
    // « Afficher plus » ouvre la vue FILTRÉE sur la cible (chip retirable posée à l'arrivée) — même montage
    // que `declareFor` : on change de VUE puis on pose le filtre. Le LIBELLÉ du hook n'est plus transmis
    // depuis le lot 3 : la chip le résout elle-même à chaque rendu (dimension « à recherche »), ce qui la
    // garde juste après un renommage et lui donne un rendu « introuvable » si la cible disparaît.
    openListFor: (kind, id) => { shell.switchView("interventions"); interventionsView.openListFor(kind, id); },
  } : null;
  formHost.interventionHooks = interventionHooks;

  // ---- RAPPROCHEMENT CERTIFICAT ↔ équipement/VM (feature AMOVIBLE, mode API) : lien CALCULÉ, jamais persisté ----
  // Identité réseau d'une cible : hostnames rapprochables (`name` + hostnames des IP rattachées) + IP (IPAM = fait
  // foi, `observed:false` ; IP constatées sur les vNIC = `observed:true`, informatives). Alimente CertTargetMatch.
  const buildNetworkIdentity = (kind: "equipment" | "vm", id: string): NetworkIdentity | null => {
    const rec: any = store.get(kind === "equipment" ? "equipments" : "vms", id);
    if (!rec) return null;
    const addrs: any[] = kind === "equipment" ? store.ipAddressesOfEquipment(id) : store.ipAddressesOfVm(id);
    const hostnames = [rec.name, ...addrs.map((a) => a.hostname)].filter((h): h is string => typeof h === "string" && h.trim() !== "");
    const ips: { value: string; observed: boolean }[] = addrs
      .map((a) => ({ value: String(a.address || "").trim(), observed: false }))
      .filter((x) => x.value !== "");
    if (kind === "vm") {
      // IP CONSTATÉES sur les vNIC (source Proxmox) : informatives, marquées `observed` (l'IPAM prime si doublon — cf. moteur).
      for (const nic of (Array.isArray(rec.nics) ? rec.nics : [])) {
        for (const ip of (Array.isArray(nic.ips) ? nic.ips : [])) { const v = String(ip || "").trim(); if (v) ips.push({ value: v, observed: true }); }
      }
    }
    return { kind, id, name: rec.name || "", hostnames, ips };
  };
  // Identités de TOUTES les cibles, MÉMOÏSÉES — base du résolveur du listing certs (rapproché PAR LIGNE, sinon
  // O(lignes × cibles)). Invalidées à l'activation de l'onglet Certificats (inventaire figé le temps d'un parcours).
  let identitiesMemo: NetworkIdentity[] | null = null;
  const invalidateIdentities = (): void => { identitiesMemo = null; };
  const allNetworkIdentities = (): NetworkIdentity[] => {
    if (identitiesMemo) return identitiesMemo;
    const list: NetworkIdentity[] = [];
    for (const e of store.all("equipments")) { const idn = buildNetworkIdentity("equipment", e.id); if (idn) list.push(idn); }
    for (const v of store.all("vms")) { const idn = buildNetworkIdentity("vm", v.id); if (idn) list.push(idn); }
    identitiesMemo = list;
    return list;
  };
  // Liste COMPLÈTE des certs mise en cache (métadonnées + sans + subject ; JAMAIS key_enc, invariant Q5) : le
  // rapprochement DEPUIS une fiche confronte TOUS les certs à UNE identité. Invalidée sur SSE `certs` et après
  // écriture dans la vue (onCountsChanged). Un échec réseau n'est PAS mis en cache (nouvelle tentative ultérieure).
  let certsListCache: CertificateListItem[] | null = null;
  const invalidateCertsListCache = (): void => { certsListCache = null; };
  const loadCertsList = async (): Promise<CertificateListItem[]> => {
    // POINT COMMUN de toutes les lectures certs venues d'une FICHE (rangée « Certificats TLS ») : la
    // garde `certs:read` s'y pose une fois, plutôt qu'à chaque hook (correctif « droits partiels »).
    if (!certsClient || !certsClient.docId || !access.has("certs:read")) return [];
    if (certsListCache) return certsListCache;
    try { certsListCache = await certsClient.list(); return certsListCache; }
    catch (_) { return []; }
  };
  // CERTIFICATS (C6) : page d'ADMINISTRATION de la PKI interne (clé maître, arbre CA/dérivés, créations
  // X.509/SSH, exports, révocation, aide au déploiement de la confiance). ONGLET PRINCIPAL de premier niveau
  // (décision utilisateur 2026-07-15 : « ce n'est pas vraiment un paramètre ») — enregistré EN DERNIER parmi les
  // primaires, juste AVANT le groupe « Paramètres », donc rendu comme dernier onglet primaire de la barre. Le
  // hash #certificats reste inchangé (bookmarkable). Vue custom (pattern NotificationsAdminView) TOUJOURS
  // enregistrée : `certsClient` est null hors mode API → la vue affiche « mode API requis » (feature AMOVIBLE :
  // retirer C6 = supprimer CertsAdminView + CertsClient + CertsFormat + ces lignes).
  let certsView: CertsAdminView;
  // Badge de l'onglet « Certificats » : ALERTE D'ÉCHÉANCE (et non plus le total). Compte = certificats non
  // révoqués EXPIRANTS (échéance ≤ 30 j, pas encore expirés) + DÉJÀ EXPIRÉS — deux comptages plats pageSize:1
  // via le filtre serveur `status` existant (« expiring » / « expired », cf. CertsDb.filterClause, seuil 30 j).
  // Teinte : `err` si au moins un DÉJÀ EXPIRÉ, sinon `warn` si des expirants. Pastille MASQUÉE à 0 (c'est une
  // alerte : rien à signaler quand aucune échéance proche). Null en mode fichier (`certsClient` null → pas de badge).
  let certsExpiringCount = 0, certsExpiredCount = 0;
  const refreshCertsCount = async (): Promise<void> => {
    // Même garde que la pastille « Interventions » : pas de `certs:read` ⇒ onglet masqué ⇒ aucun comptage.
    if (!certsClient || !certsClient.docId || !access.has("certs:read")) { certsExpiringCount = 0; certsExpiredCount = 0; shell.refreshCounts(); return; }
    try {
      const [expiring, expired] = await Promise.all([
        certsClient.listPage({ pageSize: 1, status: "expiring" }),
        certsClient.listPage({ pageSize: 1, status: "expired" }),
      ]);
      certsExpiringCount = expiring.total;
      certsExpiredCount = expired.total;
    } catch (_) { /* badge non critique : on garde l'ancienne valeur en cas d'échec réseau */ }
    shell.refreshCounts();
  };
  const certsContainer = shell.addView({
    name: "certificats", label: I18n.t("tabs.certificats.label"), kind: "primary",
    icon: Icons.CERTIFICATE,
    visible: () => canSeeView("certificats"),
    title: I18n.t("tabs.certificats.label"), subtitle: I18n.t("tabs.certificats.subtitle"),
    count: REST_MODE ? () => certsExpiringCount + certsExpiredCount : undefined,   // badge = alerte d'échéance (masqué à 0)
    countClass: REST_MODE ? () => (certsExpiredCount > 0 ? "err" : (certsExpiringCount > 0 ? "warn" : null)) : undefined,   // expiré → rouge, expirant → orange
    onShow: () => { invalidateIdentities(); certsView.show(); void refreshCertsCount(); },   // inventaire re-photographié à l'activation
  });
  certsView = new CertsAdminView(certsContainer, certsClient, formHost);   // formulaires dans LA modale de l'app (principe n°11)
  certsView.onCountsChanged = () => { invalidateCertsListCache(); void refreshCertsCount(); };   // écriture certs → invalide le cache de rapprochement + recompte l'alerte

  // Rapprochement DEPUIS une fiche (rangée « Certificats TLS ») : hooks injectés via FormHost (contrat découplé —
  // les fiches n'importent NI la vue NI le client certs). null hors mode API → aucune rangée. `openCert` bascule
  // sur l'onglet Certificats focalisé (la fiche est fermée AVANT par CertFicheRow — on change de VUE).
  const certHooks: CertFicheHooks | null = certsClient ? {
    certsForTarget: async (kind, id) => {
      const identity = buildNetworkIdentity(kind, id);
      if (!identity) return [];
      const certs = await loadCertsList();
      return CertTargetMatch.certsForTarget(identity, certs).map(({ cert, vias }): CertFicheMatch => ({
        certId: cert.id, label: cert.label,
        vias: vias.map((v) => ({ via: v.via, value: v.value, observed: v.observed })),
        notAfter: cert.not_after,
      }));
    },
    openCert: (certId) => { shell.switchView("certificats"); void certsView.focusCert(certId); },
  } : null;
  formHost.certHooks = certHooks;
  // Indicateur « cible(s) » du LISTING certs (vue B) : le résolveur rapproche l'item de ligne (déjà porteur de
  // sans/subject → aucun réseau) aux identités du store, et ouvre la fiche cible avec retour-auto (openTargetDetail).
  if (certsClient) {
    const targetResolver: CertTargetResolver = {
      targetsForCert: (cert) => CertTargetMatch.targetsForCert(cert, allNetworkIdentities()).map(({ id }) => ({ kind: id.kind, id: id.id, label: id.name || id.id })),
      // Même montage que `openTargetDetail` ci-dessus : la fiche s'EMPILE sur ce qui est affiché, le retour
      // est structurel (pop) — plus d'hôte enveloppant à `onClose`.
      openTarget: (ref) => {
        Forms.detail(store, formHost, ref.kind === "vm" ? "vms" : "equipments", ref.id, () => shell.refreshActive());
      },
    };
    certsView.setTargetResolver(targetResolver);
  }

  // SSE MODULES (interventions/certs) : quand un AUTRE client écrit, le serveur publie un événement porteur du
  // marqueur `changeset.modules` (cf. RestDocumentController). On recompte alors les pastilles concernées, THROTTLÉ
  // (accumulation des modules d'événements rapprochés → une seule rafale de recomptes ; comptages pageSize:1 bon marché).
  const pendingModuleRecounts = new Set<string>();
  let moduleRecountTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleModulesRecount = (modules: string[]): void => {
    modules.forEach((m) => pendingModuleRecounts.add(m));
    if (moduleRecountTimer) clearTimeout(moduleRecountTimer);
    moduleRecountTimer = setTimeout(() => {
      moduleRecountTimer = null;
      const mods = new Set(pendingModuleRecounts); pendingModuleRecounts.clear();
      if (mods.has("interventions")) void refreshInterventionsCount();
      if (mods.has("certs")) { invalidateCertsListCache(); void refreshCertsCount(); }   // un autre client a modifié les certs → cache de rapprochement périmé
    }, 400);
  };
  // ⚠ Il n'y a PLUS de déclaration de menu ici. Le rattachement de chaque vue à son domaine (dont
  // « Paramètres », qui était l'unique GROUPE déroulant) vit dans `NAV_DOMAINS` (`app/NavModel`) : un
  // verrou de test relit CETTE source et échoue en nommant toute vue enregistrée sans domaine
  // (cf. docs/navigation.md § 2). L'ordre d'enregistrement ci-dessus ne fixe donc plus l'ordre du menu.

  shell.build();
  shell.setDataSource(REST_MODE ? "api" : "local");   // position du toggle = mode EFFECTIF
  shell.setApiBaseUrl((prefs.apiBaseUrl && prefs.apiBaseUrl.trim()) || API_BASE_URL);
  shell.setLoginUrl(prefs.loginUrl);
  shell.setFileAccessMode(prefs.fileAccessMode);
  shell.setDebugLog(prefs.debugLog); Log.setEnabled(prefs.debugLog);
  shell.setUiScale(prefs.uiScale);
  shell.setTheme(prefs.theme);   // position du toggle à trois états = la PRÉFÉRENCE (« auto » reste « auto »)
  // SUIVI DU SYSTÈME. Le thème de l'OS peut changer EN COURS DE SESSION (bascule nuit automatique) : on
  // re-applique alors, mais UNIQUEMENT si la préférence est « auto » — un thème choisi à la main ne se
  // fait pas écraser par l'horloge du système. Posé ici, après `dcView`, parce que la ré-application
  // repeint aussi la scène 3D.
  if (systemDarkQuery) systemDarkQuery.addEventListener("change", () => { if (prefs.theme === "auto") applyThemePreference("auto"); });
  shell.setModalFullscreen(prefs.modalFullscreen);
  shell.setAutocompleteMax(prefs.autocompleteMaxResults);
  shell.setRestMode(REST_MODE);   // mode API : masque les contrôles fichier
  // GATING INITIAL. Mode fichier/visualiseur : `AccessState.ALL` → l'appel est inerte, tout reste visible
  // (injection nulle). Mode API : `NONE` tant que `GET /me` n'a pas répondu — on n'affiche aucun onglet
  // avant de savoir ce qui est permis ; `RestDocumentController.bootstrap` rappellera `applyAccess`.
  applyAccess(access);
  // (l'auth SSO + la pastille utilisateur sont gérées par restBootstrap, au boot)

  // ---- état save-state ----
  // ---- barre de statut / undo-redo (cohérence avec l'état du store) ----
  const refreshChrome = () => {
    session.setFile(files.hasLinkedFile); session.setAutosave(prefs.autosave);   // synchronise le contexte de save
    // PANIER : relire le compte ICI suffit à tenir la pastille à jour — `CartPanel.count()` recharge
    // le panier si le DOCUMENT a changé (cloisonnement) et renotifie l'hôte. Aucun événement dédié
    // à brancher, donc aucun à oublier.
    if (CartPanel.available()) shell.setCartCount(CartPanel.count());
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

  // raccourci clavier RECHERCHE GLOBALE (Ctrl/Cmd+F — arbitrage utilisateur : le geste « chercher »
  // universel, au prix de la recherche NATIVE du navigateur dans l'app). `preventDefault` APRÈS la
  // garde, contrairement au pattern Ctrl+K envisagé d'abord : quand la palette REFUSE d'agir (modale
  // ou dialogue ouvert, écran d'accueil), Ctrl+F retombe sur le « rechercher dans la page » du
  // navigateur — chercher du texte dans une LONGUE fiche ouverte reste possible, et c'est cohérent :
  // la palette cherche des OBJETS, le navigateur cherche du TEXTE.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() !== "f") return;
    if (!globalSearch.isOpen() && (document.querySelector(".modal-overlay.open, .dialog-overlay") || document.body.classList.contains("welcome-active"))) return;
    e.preventDefault();
    openGlobalSearch();
  });

  // raccourci clavier SCAN (Ctrl+Maj+S — chantier QR lot D) : ouvre le viseur caméra sur le champ
  // texte FOCALISÉ — parseur du champ s'il est greffé en déclaré (n° de série), brut sinon. La
  // GARDE est le focus lui-même : hors d'un champ texte éditable, la touche ne fait RIEN (repli
  // navigateur). PAS de garde d'overlay, contrairement à Ctrl+F : scanner PENDANT une saisie en
  // modale est précisément le cas d'usage. NB : le tooltip « Enregistrer une copie sous… » annonce
  // historiquement le même raccourci mais aucun gestionnaire ne l'implémente — et celui-ci ne
  // s'applique qu'à un champ focalisé, aucune collision.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !e.shiftKey) return;
    if (e.key.toLowerCase() !== "s") return;
    const target = document.activeElement;
    if (!ScanControl.isEditableTextField(target)) return;
    e.preventDefault();
    ScanControl.openForField(target);
  });

  applyAutosave();        // initialise l'état auto-save + le popover
  refreshChrome();
  // restaure l'onglet BOOKMARKÉ depuis l'URL (#nom) si valide, sinon l'onglet par défaut.
  const bookmarkedView = (typeof location !== "undefined") ? decodeURIComponent(location.hash.replace(/^#/, "")) : "";
  // L'INTENTION du hash est désormais connue : la restauration d'après-droits peut s'en servir (cf.
  // `restoreViewIfIdle` — avant cette ligne, `bookmarkedView` est en zone morte temporelle).
  viewRestorationReady = true;
  shell.switchView(shell.hasView(bookmarkedView) ? bookmarkedView : DEFAULT_VIEW);
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
    // Le visualiseur n'a pas de `documentOpened` (il charge l'EMBARQUÉ lui-même) : c'est ICI qu'un
    // document devient prêt, donc ici que le lien d'étiquette se consomme. Mono-document comme le mode
    // fichier, donc le `docId` de la cible est ignoré (les fiches restent consultables en lecture seule).
    consumePendingDeepLink();
    (window as any).__DCMANAGER__ = { EntityRegistry, adapter, store, prefs, shell, graph, dcView, modal, tabChannel, files, imageStore };
    return;
  }
  // ÉCRAN D'ACCUEIL (mode FICHIER uniquement) : au (re)chargement le handle FS est perdu → on force une
  // ré-interaction pour le raccrocher. En mode API, les données viennent du serveur au boot → pas d'accueil.
  if (REST_MODE) {
    shell.hideWelcome();
    // DEEP-LINK + mode API : le document VISÉ par l'étiquette prime sur le « dernier doc ouvert ». On le
    // pose AVANT le bootstrap plutôt que de laisser ouvrir l'ancien document puis basculer : une bascule
    // paierait DEUX hydratations complètes du document (le boot est déjà le moment le plus lourd), et
    // ferait clignoter une vue peuplée du mauvais document. Ce n'est pas un raccourci risqué :
    // `bootstrap` VÉRIFIE que le document existe encore (sinon il retombe sur sa priorité historique —
    // défaut global, puis plus récent) et `openDocument` réécrit cette préférence avec le document
    // RÉELLEMENT ouvert. Le chemin `switch-doc` de l'opener reste, lui, indispensable EN VOL (hash changé
    // ou code scanné alors qu'un document est déjà ouvert), et rattrape aussi le cas « document disparu ».
    if (pendingDeepLink) prefs.lastRestDocId = pendingDeepLink.docId;
    await rest!.bootstrap();   // ouvre le dernier doc ouvert → défaut global → plus récent (ou en crée un) — cf. RestDocumentController.bootstrap
    void refreshInterventionsCount();   // badges d'onglets (données paginées serveur) — après ouverture du document
    void refreshCertsCount();
  } else {
    const reopenName: string | null = HAS_FS_API ? await files.lastOpenName() : null;
    shell.showWelcome({ reopenName, mode: prefs.fileAccessMode, fsApi: HAS_FS_API });
  }

  (window as any).__DCMANAGER__ = { EntityRegistry, adapter, store, prefs, shell, graph, dcView, modal, tabChannel, files, imageStore };
}
boot();

/* =============================================================================
   DOCUMENTS SERVEUR (mode API) — contrôleur EXTRAIT de `boot()` (main.ts,
   découpage P4) : bootstrap (auth SSO + choix du document), ouverture/création/
   import/sélecteur de documents, flux SSE (concurrence multi-client) avec
   DEBOUNCE + FUSION des changesets, et rechargement GRANULAIRE piloté par le
   ReloadPlanner (3D sautée si aucune collection dessinée n'a changé).

   L'ÉTAT serveur (docId, flux SSE, changesets en attente) vit ICI ; l'adhérence
   à la boucle applicative passe par l'interface hôte `RestDocumentsHost`.
   Construit UNIQUEMENT en mode REST : les callbacks 409/400 de l'adapter sont
   câblés au constructeur (le serveur fait autorité — pas de rejeu).
   ============================================================================= */
import type { Store } from "../store";
import type { ImageStore } from "../data/ImageStore";
import type { SaveState } from "./SaveState";
import type { Prefs } from "../core/Prefs";
import type { RestAdapter } from "../data/RestAdapter";
import { Notify } from "../ui/Notify";
import { Dialog } from "../ui/Dialog";
import { ReloadPlanner, Changeset } from "../sync";
import type { DocumentChangeset } from "../sync";
import { EntityRegistry } from "../models";
import { Log } from "../core/Log";

const W = window as any;

/** Adhérence à la boucle applicative, injectée. */
export interface RestDocumentsHost {
  refreshChrome(): void;
  refreshActive(): void;
  /** Post-ouverture d'un document serveur : masque le welcome, bascule la vue, rafraîchit chrome + vue. */
  documentOpened(): void;
  resetUndo(): void;
  /** Nom d'affichage du document (partagé avec le contrôleur fichier : `files.name`). */
  setDisplayName(name: string): void;
  /** Invalide la scène 3D (rechargement ayant touché une collection dessinée). */
  invalidate3D(): void;
  /** Pastille utilisateur SSO (topbar). */
  setUser(user: any): void;
  /** Écran « accès refusé » (auth SSO non autorisée) avec bouton Réessayer. */
  showAccessDenied(opts: { connected: boolean; user: string; onRetry: () => void; loginUrl: string }): void;
}

export interface RestDocumentsDeps {
  adapter: RestAdapter; store: Store; imageStore: ImageStore; session: SaveState; prefs: Prefs;
  hasFsApi: boolean;
  /** Rebase le backend d'images sur le scope du document courant (RestImageBackend.setBaseUrl). */
  setImagesBase(base: string): void;
  /** URL de connexion SSO injectée par le backend (repli si la préférence est vide). */
  injectedLoginUrl: string;
  host: RestDocumentsHost;
}

export class RestDocumentController {
  /** Document serveur courant (null tant qu'aucun n'est ouvert). */
  docId: string | null = null;

  private events: EventSource | null = null;   // flux SSE du document courant (concurrence multi-client)
  private reloadTO: any = 0;
  private lastBy: { name?: string; ip?: string } | null = null;   // auteur du dernier changement externe (pour le toast)
  // Changesets des événements SSE rapprochés, ACCUMULÉS pendant la fenêtre de debounce (ET tant que l'onglet est
  // caché) puis planifiés en une fois. cf. scheduleReload / le listener visibilitychange (anti-rafale d'arrière-plan).
  private pendingChangeset: DocumentChangeset | null = null;
  private reloading = false;        // un reload est EN COURS (fetch + rebuild 3D ≈ 1 s) → SÉRIALISE (jamais 2 en parallèle)
  private queuedConflict = false;   // un 409/400 est tombé PENDANT un reload → à rejouer (rechargement TOTAL) à la fin
  private readonly reloadPlanner = new ReloadPlanner();   // changeset → plan (quoi reconstruire) — cf. src/sync/RenderImpact.ts
  private readonly flog = Log.scope("fs");                // trace REST (flag de débogage)
  private readonly adapter: RestAdapter; private readonly store: Store; private readonly imageStore: ImageStore;
  private readonly session: SaveState; private readonly prefs: Prefs; private readonly hasFsApi: boolean;
  private readonly setImagesBase: (base: string) => void; private readonly injectedLoginUrl: string;
  private readonly host: RestDocumentsHost;

  constructor(deps: RestDocumentsDeps) {
    this.adapter = deps.adapter; this.store = deps.store; this.imageStore = deps.imageStore; this.session = deps.session;
    this.prefs = deps.prefs; this.hasFsApi = deps.hasFsApi; this.setImagesBase = deps.setImagesBase;
    this.injectedLoginUrl = deps.injectedLoginUrl; this.host = deps.host;
    // 409 (verrou optimiste serveur) sur une de nos écritures → recharge + notifie (PAS de rejeu : le serveur fait autorité).
    this.adapter.onConflict = () => { void this.reload({ conflict: true }); };
    // 400 (validation PARTAGÉE serveur) : notre écriture OPTIMISTE a déjà muté le cache local, mais le serveur l'a
    // REFUSÉE → on RECHARGE (comme le 409) pour restaurer l'état serveur, sinon l'UI garderait un changement
    // inexistant côté serveur (divergence). Ne devrait quasi jamais arriver pour une écriture passée par la
    // validation cliente `accepts()` (mêmes règles partagées) ; couvre les chemins qui la contournent et toute
    // divergence client⇄serveur. Notifie les 2-3 premières erreurs (suffisant pour situer le problème).
    this.adapter.onValidationError = (errors) => {
      const head = errors.slice(0, 3).map((e) => e.message).join(" · ");
      Notify.toast("Données refusées par le serveur : " + head + (errors.length > 3 ? " …" : ""), "err");
      void this.reload({ conflict: true });
    };
    // RETOUR au premier plan : en arrière-plan on a ACCUMULÉ les changesets SSE sans recharger (cf. scheduleReload) —
    // on flush MAINTENANT, en UNE fois. Sans ça, l'onglet repris se prend une rafale de reload empilés (timers
    // throttlés + rAF gelé en arrière-plan). Listener unique (le contrôleur vit toute la session).
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => { if (!document.hidden && this.pendingChangeset) this.scheduleReload(); });
    }
  }

  /** Recharge le document courant depuis le serveur. `changeset` (SSE) cible la reconstruction (3D sautée si aucune
      collection dessinée n'a changé) ; `conflict` (409 sur NOTRE écriture) force un rechargement total + notifie le rejet. */
  async reload(opts?: { conflict?: boolean; changeset?: DocumentChangeset }): Promise<void> {
    if (!this.docId) return;
    // SÉRIALISATION : jamais deux reload en parallèle (fetch + rebuild 3D lourds ; le double rAF ci-dessous ferait
    // sinon s'empiler des reload gelés en arrière-plan → rafale). Une demande arrivée PENDANT un reload est mémorisée
    // (conflit prioritaire) et rejouée à la fin ; le changeset SSE, lui, reste dans pendingChangeset (rejoué aussi).
    if (this.reloading) { if (opts?.conflict) this.queuedConflict = true; return; }
    this.reloading = true;
    // 409 : on ignore QUELLES entités l'autre client a changées → rechargement total prudent. Sinon : périmètre du changeset.
    const changeset = opts?.conflict ? Changeset.full() : (opts?.changeset || Changeset.full());
    const plan = this.reloadPlanner.plan(changeset);
    this.flog("reload document", opts?.conflict ? "(conflit 409)" : "(changement externe)", "→ 3D:" + plan.threeRebuild, this.lastBy);
    Notify.busy(opts?.conflict ? "Conflit de version — rechargement…" : "Mise à jour du document…");
    // laisse le navigateur PEINDRE l'overlay AVANT le travail synchrone lourd (fetch + rebuild 3D ≈ 1 s) qui gèle
    // le thread : sans ce double rAF, l'overlay ne s'affiche qu'une fois le freeze terminé (donc jamais visible).
    // Onglet CACHÉ : rAF est GELÉ (ne se déclencherait qu'au retour, bloquant ce reload) et il n'y a rien à peindre
    // → on saute l'attente. (En pratique on n'arrive quasi jamais ici caché : scheduleReload ne planifie pas alors.)
    if (typeof document === "undefined" || !document.hidden) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      // P2 : rechargement GRANULAIRE — on ne re-tire QUE les collections du changeset ; le périmètre indéterminé
      // (`refetchCollections === null` : import/snapshot/conflit 409) impose encore un rechargement TOTAL.
      if (plan.refetchCollections) {
        await this.store.reloadCollections(plan.refetchCollections);   // 0 collection (ex. méta seule) → aucun fetch d'entités
        if (plan.refreshMeta) await this.store.reloadMeta();           // la méta (nom, dispositions…) a changé → relue à part
      } else {
        await this.store.init();   // re-tirage COMPLET du document
      }
      if (plan.refreshImages) await this.imageStore.reloadFromBackend();   // métadonnées d'images SEULEMENT si une image a changé
      this.session.markLoaded(this.store.histIndex());
      // saut de la reconstruction 3D quand AUCUNE collection dessinée n'a changé (ex. adresse IP, spare, réseau IP) :
      // c'est tout l'intérêt du plan — éviter le gel d'UI pour un changement sans impact géométrique. Cf. RenderImpact.
      if (plan.threeRebuild !== "none") this.host.invalidate3D();
      this.host.refreshActive(); this.host.refreshChrome();
    } finally { Notify.idle(); this.reloading = false; }
    if (opts?.conflict) {
      Notify.toast("Modification refusée : le document a changé entre-temps. Données rechargées — refais ta modification.", "conflict");
    } else {
      const by = this.lastBy ? (" par " + (this.lastBy.name || "?") + (this.lastBy.ip ? " (" + this.lastBy.ip + ")" : "")) : "";
      Notify.toast("Document mis à jour" + by);
    }
    // des demandes sont tombées PENDANT ce reload → on rejoue (sérialisé, pas de rafale) : un conflit 409/400 impose un
    // rechargement TOTAL, sinon on flush le changeset SSE accumulé (débouncé). S'arrête dès que le flux se calme.
    if (this.queuedConflict) { this.queuedConflict = false; void this.reload({ conflict: true }); }
    else if (this.pendingChangeset) this.scheduleReload();
  }

  /** Planifie le rechargement DÉBOUNCÉ (250 ms) du changeset accumulé. Onglet CACHÉ : on NE planifie PAS — en
      arrière-plan les timers sont throttlés (plancher ~1 s, puis gelés) ET rAF est gelé, donc des reload() partiraient
      en RAFALE au retour au premier plan. On accumule seulement (pendingChangeset) ; le flush se fait au retour, via
      le listener visibilitychange (cf. constructeur). */
  private scheduleReload(): void {
    if (typeof document !== "undefined" && document.hidden) return;
    clearTimeout(this.reloadTO);
    this.reloadTO = setTimeout(() => this.flushPendingReload(), 250);
  }
  /** Consomme le changeset SSE accumulé (fusionné) en UN reload. No-op si un reload est déjà en cours (il
      re-planifiera à sa fin, cf. reload) ou si rien n'est en attente. */
  private flushPendingReload(): void {
    if (this.reloading || !this.pendingChangeset) return;
    const changeset = this.pendingChangeset;
    this.pendingChangeset = null;
    void this.reload({ changeset });
  }
  /** Abonnement SSE : recharge si une révision PLUS RÉCENTE que la nôtre arrive (changement d'un autre client). */
  private subscribeLive(): void {
    if (this.events) { this.events.close(); this.events = null; }
    const url = this.adapter.eventsUrl; if (!url || typeof EventSource === "undefined") return;
    try {
      const es = new EventSource(url, { withCredentials: true }); this.events = es;
      es.onmessage = (e) => { try {
        const d = JSON.parse(e.data);
        if (!d || (d.origin && d.origin === this.adapter.clientId)) return;   // NOTRE propre écriture → on ignore (pas de reload)
        if (typeof d.rev === "number" && d.rev > this.adapter.docRev) {
          this.lastBy = d.by || null;
          // accumule le périmètre de CET événement avec ceux déjà en attente (plusieurs écritures peuvent tomber
          // dans la fenêtre de debounce) → une seule reconstruction couvrant l'union des changements.
          const incoming = Changeset.coerce(d.changeset, EntityRegistry.isCollection);   // filtre les collections inconnues (évite un refetch inutile)
          this.pendingChangeset = this.pendingChangeset ? Changeset.merge(this.pendingChangeset, incoming) : incoming;
          this.scheduleReload();   // débouncé si visible ; SI CACHÉ : accumule seulement, flush au retour (visibilitychange) → pas de rafale
        }
      } catch (_) { /* ignore */ } };
      es.onerror = () => { /* reconnexion auto du navigateur (champ retry) */ };
    } catch (e) { this.flog("SSE indisponible", e); }
  }

  /** Ouvre un document serveur : scope l'adapter + le backend d'images, recharge données & images. */
  async openDocument(docId: string, name?: string): Promise<void> {
    this.adapter.setDocument(docId);
    this.setImagesBase(this.adapter.dataBase);
    this.docId = docId;
    this.prefs.lastRestDocId = docId;              // mémorise le DERNIER doc ouvert → rouvert au prochain lancement (cf. bootstrap)
    await this.store.init();                       // charge les collections du document
    if (name) this.store.meta.docName = this.store.meta.docName || name;
    await this.imageStore.reloadFromBackend();     // miroir d'images du document
    this.host.resetUndo();
    const display = name || this.store.meta.docName || "Document";
    this.host.setDisplayName(display);
    this.session.setFile(true); this.session.markLoaded(this.store.histIndex());
    this.host.documentOpened();
    this.subscribeLive();
    Notify.toast("Document « " + display + " » ouvert");
  }
  /** Crée un nouveau document serveur (catalogues semés) puis l'ouvre. */
  async newDocument(name: string): Promise<void> {
    let d: any; try { d = await this.adapter.createDocument(name); } catch (e: any) { Notify.toast("Création impossible : " + (e.message || e), "err"); return; }
    this.adapter.setDocument(d.id);
    this.setImagesBase(this.adapter.dataBase);
    this.docId = d.id;
    this.prefs.lastRestDocId = d.id;               // un doc fraîchement créé devient le « dernier ouvert »
    await this.store.newDocument();                // sème les catalogues + pousse le snapshot DANS le nouveau document
    this.store.meta.docName = d.name; await this.store.persistMeta();
    await this.imageStore.reloadFromBackend();
    this.host.resetUndo();
    this.host.setDisplayName(d.name); this.session.setFile(true); this.session.markLoaded(this.store.histIndex());
    this.host.documentOpened();
    this.subscribeLive();
    Notify.toast("Document « " + d.name + " » créé");
  }
  /** Importe un export `.json` (format mode-fichier) DANS UN NOUVEAU document serveur : crée le document,
      pousse le snapshot (meta + collections) puis les images de façade (compagnon `.nmfb` prioritaire, sinon
      `faceImages` inline), et l'ouvre. Réutilise exactement la logique d'écriture du DataAdapter REST. */
  private async importJson(text: string, nmfbBuf: ArrayBuffer | null, suggestedName: string): Promise<void> {
    let raw: any; try { raw = JSON.parse(text); } catch { Notify.toast("Fichier invalide (JSON attendu).", "err"); return; }
    const name = String((raw && raw.meta && raw.meta.docName) || suggestedName || "Document").replace(/\.json$/i, "") || "Document";
    let d: any; try { d = await this.adapter.createDocument(name); } catch (e: any) { Notify.toast("Création impossible : " + (e.message || e), "err"); return; }
    this.adapter.setDocument(d.id);
    this.setImagesBase(this.adapter.dataBase);
    this.docId = d.id;
    this.prefs.lastRestDocId = d.id;               // le doc importé devient le « dernier ouvert »
    try {
      await this.store.replaceAll(raw);                                              // meta + collections → PUT /snapshot du nouveau document
      let nImg = 0;
      if (nmfbBuf) nImg = await this.imageStore.loadBundle(nmfbBuf);                  // compagnon d'images .nmfb (prioritaire)
      else if (Array.isArray(raw.faceImages)) nImg = await this.imageStore.replaceAllFromLegacy(raw.faceImages);   // images inline (legacy ≤ v51)
      else await this.imageStore.clearAll();
      this.store.meta.docName = name; await this.store.persistMeta();
      await this.imageStore.reloadFromBackend();
      this.host.resetUndo();
      this.host.setDisplayName(name); this.session.setFile(true); this.session.markLoaded(this.store.histIndex());
      this.host.documentOpened();
      this.subscribeLive();
      const nbEnt = Object.keys(raw).filter((k) => k !== "faceImages" && Array.isArray((raw as any)[k])).reduce((n, k) => n + (raw as any)[k].length, 0);
      Notify.toast("Importé « " + name + " » (" + nbEnt + " entités, " + nImg + " image(s))");
    } catch (e: any) { Notify.toast("Import échoué : " + (e.message || e), "err"); }
  }
  /** Sélectionne un `.json` (+ compagnon `.nmfb` facultatif) puis l'importe dans un nouveau document serveur. */
  private async importFromPicker(): Promise<void> {
    let jsonFile: File | null = null, nmfbBuf: ArrayBuffer | null = null;
    if (this.hasFsApi) {
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
    await this.importJson(await jsonFile.text(), nmfbBuf, jsonFile.name);
  }
  /** Sélecteur de documents (mode API) : liste serveur, ouverture / création / suppression. */
  async openChooser(): Promise<void> {
    let docs: any[]; try { docs = await this.adapter.listDocuments(); } catch { Notify.toast("Serveur injoignable.", "err"); return; }
    const defaultDocId = await this.adapter.getDefaultDocId().catch(() => null);   // doc par défaut global (best-effort) → mis en évidence + bascule par étoile
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
          const ti = document.createElement("span"); ti.className = "ok-title"; ti.textContent = (d.locked ? "🔒 " : "") + d.name + (d.id === this.docId ? "  ◀ ouvert" : "") + (isDefault ? "  ★ défaut" : "");
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
    if (action === "__new__") { const n = await Dialog.prompt("Nom du document", "Document"); if (n) await this.newDocument(n); return; }
    if (action === "__import__") { await this.importFromPicker(); return; }
    if (action.startsWith("__default__:")) {
      const id = action.slice(12) || null;   // "" → efface le défaut ; sinon le déplace sur ce doc
      try { await this.adapter.setDefaultDocId(id); Notify.toast(id ? "Document par défaut défini." : "Document par défaut retiré."); }
      catch (e: any) { Notify.toast("Action impossible : " + (e.message || e), "err"); }
      await this.openChooser(); return;   // rouvre le sélecteur rafraîchi
    }
    if (action.startsWith("__lock__:")) {
      const id = action.slice(9), d = docs.find((x) => x.id === id);
      try { await this.adapter.setDocumentLocked(id, !d?.locked); Notify.toast(d?.locked ? "Document déverrouillé." : "Document verrouillé."); }
      catch (e: any) { Notify.toast("Action impossible : " + (e.message || e), "err"); }
      await this.openChooser(); return;   // rouvre le sélecteur rafraîchi
    }
    if (action.startsWith("__del__:")) {
      const id = action.slice(8), d = docs.find((x) => x.id === id);
      const ok = await Dialog.confirm({ title: "Supprimer le document ?", message: "Supprimer « " + (d?.name || id) + " » et toutes ses données ? Irréversible.", confirmLabel: "Supprimer", danger: true });
      if (ok) { try { await this.adapter.deleteDocument(id); } catch (e: any) { Notify.toast("Suppression impossible : " + (e.message || e), "err"); } if (id === this.docId) this.docId = null; if (id === this.prefs.lastRestDocId) this.prefs.lastRestDocId = ""; }
      await this.openChooser(); return;   // rouvre le sélecteur rafraîchi
    }
    if (action !== this.docId) { const d = docs.find((x) => x.id === action); await this.openDocument(action, d?.name); }
  }
  /** Au boot (mode API) : valide l'auth SSO, puis ouvre le document selon cette PRIORITÉ :
      1) le DERNIER doc ouvert sur ce navigateur (prefs.lastRestDocId), s'il existe encore ;
      2) sinon le doc par DÉFAUT (réglage serveur global), s'il est défini ;
      3) sinon le plus récemment modifié (1er de la liste, triée DESC côté serveur) ;
      4) sinon (aucun document) on en crée un. */
  async bootstrap(): Promise<void> {
    const me = await this.adapter.me().catch(() => null);
    this.host.setUser(me && me.logged ? me.user : null);
    const authorized = !!(me && me.logged && me.adminRight === "SUPER_ADMIN");
    this.flog("auth", { logged: me && me.logged, adminRight: me && me.adminRight, authorized });
    if (!authorized) {
      // pas une app noire : on AFFICHE l'état sur l'écran d'accueil, avec un bouton Réessayer.
      const who = (me && me.user && (me.user.login || [me.user.prenom, me.user.nom].filter(Boolean).join(" "))) || "";
      this.host.showAccessDenied({ connected: !!(me && me.logged), user: who, onRetry: () => { void this.bootstrap(); }, loginUrl: (this.prefs.loginUrl && this.prefs.loginUrl.trim()) || this.injectedLoginUrl });
      return;   // n'ouvre aucun document tant que l'accès n'est pas autorisé
    }
    let docs: any[] = []; try { docs = await this.adapter.listDocuments(); } catch { /* serveur injoignable */ }
    const exists = (id: string | null | undefined) => !!id && docs.some((d) => d.id === id);
    // 1) dernier doc ouvert (s'il n'a pas été supprimé entre-temps)
    let targetId = exists(this.prefs.lastRestDocId) ? this.prefs.lastRestDocId : null;
    // 2) sinon doc par défaut global (best-effort : ignore une erreur réseau/serveur)
    if (!targetId) { const def = await this.adapter.getDefaultDocId().catch(() => null); if (exists(def)) targetId = def; }
    // 3) sinon le plus récent ; 4) sinon création
    if (!targetId && docs.length) targetId = docs[0].id;
    this.flog("boot: doc choisi", { targetId, last: this.prefs.lastRestDocId, total: docs.length });
    if (targetId) { const d = docs.find((x) => x.id === targetId); await this.openDocument(targetId, d?.name); }
    else await this.newDocument("Document 1");
  }
}

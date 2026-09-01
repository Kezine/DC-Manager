/* =============================================================================
   APPLINKOPENER — EXÉCUTE un lien direct : « cette cible → ça, à l'écran ».
   Le pendant IMPÉRATIF de la décision pure `core/AppLinkRouting`.

   HISTORIQUE. Ce service s'appelait `EntityLinkOpener` et n'ouvrait qu'une chose :
   la fiche d'une entité, PAR-DESSUS la vue courante. Le chantier « liens directs »
   (2026-09-01) lui confie les quatre formes de la grammaire (`src-shared/AppLink`)
   et, surtout, l'ACTIVATION DE LA VUE — le seul vrai manque de l'existant.

   POURQUOI CE SERVICE. Le chemin « une cible devient quelque chose à l'écran » a
   plusieurs consommateurs, et ils n'ont rien d'autre en commun :
     · le HASH de l'URL — au boot (le navigateur a ouvert l'URL scannée ou collée
       hors app) et sur `hashchange` (lien collé, retour arrière) ;
     · le GREFFON DE SCAN — la caméra décode le texte du QR alors que
       l'application tourne déjà.
   L'écrire dans `main.ts` aurait condamné le second à le réécrire. D'où une classe
   à DÉPENDANCES INJECTÉES, dont l'API prend une cible DÉJÀ PARSÉE : le parsing
   (`AppLink.parse`) appartient à celui qui tient le texte brut.

   🚨 L'ACTIVATION DE LA VUE EST CONDITIONNELLE, ET C'EST TOUT LE CHANTIER.
   Elle n'a lieu que si le lien porte `?vue=1` (`target.syncView`). Conséquence
   VOULUE : les étiquettes QR déjà imprimées ne le portent pas, donc elles
   continuent d'ouvrir la fiche par-dessus l'onglet courant — scanner un
   équipement depuis l'onglet « Câbles » ne fait toujours pas perdre le contexte
   de travail. Seuls les liens produits par le bouton « copier le lien »
   synchronisent l'onglet (décision A1 du cadrage).
   ⚠ On vérifie `isVisible` AVANT d'activer : `Shell.switchView` se REPLIE sur la
   première vue accessible quand la cible est masquée par les droits, ce qui
   DÉMÉNAGERAIT l'utilisateur sur une vue arbitraire alors qu'il demandait juste
   une fiche. Vue interdite ⇒ on n'active rien et on ouvre la fiche par-dessus ce
   qui est là ; la fiche, elle, a sa propre garde côté serveur.

   🚨 CE QU'IL NE FAIT PAS : il ne double AUCUN message d'un autre mécanisme. Un
   403 en vol est déjà dit — une fois, dédupliqué par permission — par
   `core/AccessDenial` (et un 401 par `SessionExpiry`) ; ajouter ici un
   « introuvable » sur ces cas mentirait sur la cause.

   MODE FICHIER : `documents` ET `externals` valent `null` (injection nulle, patron
   `HydrationState`/`AccessState`) — aucun test de mode dans le code. Le mode
   fichier ne peut donc PAS partir ouvrir un document serveur qui n'existe pas chez
   lui, ni prétendre ouvrir une intervention dont la base vit côté serveur : il le
   DIT, une fois, honnêtement. La RECHERCHE, elle, reste disponible partout — la
   palette est locale en mode fichier (principe n°15).
   ============================================================================= */

import type { Store } from "../store";
import type { AppLinkTarget, AppLinkFiche } from "../../src-shared/AppLink";
import { AppLinkRouting } from "../core/AppLinkRouting";
import { CollectionViews, type ExternalFamily } from "../core/CollectionViews";
import { Forms, type FormHost } from "../views/Forms";
import { I18n } from "../i18n/I18n";

/** Accès aux documents SERVEUR (mode API) — la part de `RestDocumentController` dont le lien a besoin,
    et rien de plus : quel document est ouvert, et comment en ouvrir un autre. */
export interface AppLinkDocuments {
  /** Document serveur courant (`RestDocumentController.docId`) — `null` tant qu'aucun n'est ouvert. */
  currentDocId(): string | null;
  /** Ouvre le document `docId` (charge les collections, notifie l'hôte). Rejette si le document est
      introuvable/illisible — c'est ce rejet qui devient un toast ici. */
  openDocument(docId: string): Promise<void>;
}

/** La part du Shell dont l'ouverture a besoin : activer un onglet, et savoir s'il est accessible.
    Interface étroite plutôt que le Shell entier — même patron que `ShellDrawerHost`/`PositioningHost`. */
export interface AppLinkViews {
  /** Cette vue est-elle enregistrée ET accessible à l'utilisateur courant ? */
  isVisible(view: string): boolean;
  /** Active la vue (bascule d'onglet). */
  activate(view: string): void;
}

/** Ouverture des familles vivant dans une base SERVEUR séparée. `null` en mode fichier (injection
    nulle) : ces objets n'y existent pas, et le service le dit au lieu de rester muet. */
export interface AppLinkExternals {
  /** Ouvre la fiche d'une intervention. Rejette/rend `false` si elle est introuvable. */
  openIntervention(id: string): Promise<boolean>;
  /** Ouvre (et met en évidence) un certificat dans la page Certificats. */
  openCert(id: string): Promise<boolean>;
}

export interface AppLinkOpenerDeps {
  store: Store;
  /** Hôte des formulaires (modale) — celui de `main.ts`, comme pour la palette de recherche. */
  formHost: FormHost;
  /** `null` en mode fichier/visualiseur (injection nulle) ⇒ jamais de bascule de document. */
  documents: AppLinkDocuments | null;
  /** `null` en mode fichier/visualiseur (injection nulle) ⇒ interventions et certificats indisponibles. */
  externals: AppLinkExternals | null;
  /** Activation d'onglet. Toujours fournie : le Shell existe dans les deux modes. */
  views: AppLinkViews;
  /** Ouvre la palette de recherche pré-remplie. Toujours fournie (la palette est locale en mode fichier). */
  openSearch(query: string): void;
  /** Notification à l'utilisateur (`Notify.toast` en pratique) — injectée pour que le service ne
      dépende pas d'un singleton d'UI. */
  notify(message: string, kind?: string): void;
  /** Rafraîchissement de la vue active après une modification faite DEPUIS la fiche ouverte (même
      rôle que le `onChanged` passé par `main.ts` à `Forms.detail`). */
  onChanged?(): void;
}

export class AppLinkOpener {
  private readonly store: Store;
  private readonly formHost: FormHost;
  private readonly documents: AppLinkDocuments | null;
  private readonly externals: AppLinkExternals | null;
  private readonly views: AppLinkViews;
  private readonly openSearch: (query: string) => void;
  private readonly notify: (message: string, kind?: string) => void;
  private readonly onChanged: (() => void) | undefined;

  constructor(deps: AppLinkOpenerDeps) {
    this.store = deps.store; this.formHost = deps.formHost; this.documents = deps.documents;
    this.externals = deps.externals; this.views = deps.views; this.openSearch = deps.openSearch;
    this.notify = deps.notify; this.onChanged = deps.onChanged;
  }

  /** Exécute `target` (cible déjà parsée). Rend `true` si quelque chose est à l'écran.
      Ne LÈVE jamais : ce service est appelé depuis le boot et depuis des écouteurs d'événement, où une
      exception ne serait rattrapée par personne (et casserait, sous droits partiels, un boot par
      ailleurs valable). Tout échec = un `false` et, quand la cause n'est pas déjà signalée, un toast. */
  async open(target: AppLinkTarget): Promise<boolean> {
    // `restMode` n'est PAS un drapeau de plus : c'est la présence de l'accès aux documents serveur.
    const route = AppLinkRouting.decide({
      restMode: !!this.documents,
      currentDocId: this.documents ? this.documents.currentDocId() : null,
      target,
    });
    if (!route) return false;
    if (route.action === "switch-doc") {
      try { await this.documents!.openDocument(route.docId); }
      catch (e: any) {
        // Document supprimé, interdit, ou serveur injoignable : le lien est plus vieux que le parc. On
        // le DIT (il nommait un document précis, l'utilisateur doit comprendre pourquoi rien ne s'ouvre)
        // et on s'arrête là — agir dans le document courant montrerait un objet homonyme d'un autre
        // document, ou rien.
        this.notify(I18n.t("app.deepLink.docError", { error: (e && e.message) || e }), "err");
        return false;
      }
    }
    const t = route.target;
    if (t.kind === "recherche") { this.openSearch(t.query); return true; }
    if (t.kind === "fiche") return this.openFiche(t);
    return this.openExternal(t.kind, t.id);
  }

  /** Active la vue `view` si elle existe et si l'utilisateur y a droit. Rend `true` si elle l'a été.
      ⚠ Le test de visibilité n'est pas une précaution de style : sans lui, `Shell.switchView` se
      replierait sur la première vue accessible et déménagerait l'utilisateur (cf. en-tête). */
  private activate(view: string | null): boolean {
    if (!view || !this.views.isVisible(view)) return false;
    this.views.activate(view);
    return true;
  }

  /** Fiche d'un objet du document — PATTERN DE LA PALETTE (`GlobalSearchPalette.activate`) : le cache
      d'abord, une lecture UNITAIRE ensuite, `Forms.detail` pour finir. La lecture unitaire est ce qui
      rend le lien viable sous CHARGEMENT PARESSEUX (docs/hydratation.md) : une étiquette peut viser un
      contact ou une pièce jointe qui n'est PAS au cache — `fetchOne` l'absorbe et l'indexe.
      En mode fichier, l'objet est au cache ou n'existe pas : aucun réseau n'est touché. */
  private async openFiche(target: AppLinkFiche): Promise<boolean> {
    const { collection, id } = target;
    // L'ONGLET D'ABORD, la fiche ensuite : la fiche est une modale, elle doit se poser PAR-DESSUS la
    // vue d'arrivée, pas la voir apparaître sous elle. L'activation est faite avant même la lecture
    // réseau — l'utilisateur voit tout de suite qu'il a changé de contexte, et le listing charge
    // pendant que la fiche se résout.
    if (target.syncView) this.activate(CollectionViews.viewOf(collection));
    if (!this.store.get(collection, id)) {
      let fetched: any = null;
      try { fetched = await this.store.fetchOne(collection, id); }
      catch (_) {
        // Requête REFUSÉE (403) ou session perdue (401) ou panne réseau : déjà signalé UNE fois par
        // `core/AccessDenial` / `SessionExpiry` via les rappels de l'adapter. On ne double pas — cf. en-tête.
        return false;
      }
      if (!fetched) { this.notify(I18n.t("app.deepLink.notFound"), "err"); return false; }
    }
    // `Forms.detail` rend `false` pour une collection SANS fiche dédiée (ports, rackItems, waypoints…) :
    // le format de lien accepte toute collection du schéma (liste blanche partagée), l'application n'a
    // pas une fiche pour chacune. Un clic muet serait indiagnostiquable — on le dit.
    if (!Forms.detail(this.store, this.formHost, collection, id, this.onChanged)) {
      this.notify(I18n.t("app.deepLink.noDetail"), "err");
      return false;
    }
    return true;
  }

  /** Intervention / certificat : leur fiche est peinte PAR LEUR VUE, il n'y a pas d'autre chemin —
      l'activation n'est donc pas conditionnée par `?vue=1`, elle fait PARTIE de l'ouverture.
      Injection nulle (mode fichier) ⇒ un message honnête, jamais un silence. */
  private async openExternal(family: ExternalFamily, id: string): Promise<boolean> {
    if (!this.externals) { this.notify(I18n.t("app.deepLink.serverOnly"), "err"); return false; }
    const view = CollectionViews.viewOfExternal(family);
    // Vue interdite (droits partiels : `interventions:read` / `certs:read` absent) : inutile d'appeler
    // le module, sa route répondrait 403 et `AccessDenial` parlerait d'une permission que l'utilisateur
    // n'a pas demandée. On le dit ici, une fois, dans les termes du lien.
    if (!this.activate(view)) { this.notify(I18n.t("app.deepLink.viewDenied"), "err"); return false; }
    try {
      const ok = family === "intervention" ? await this.externals.openIntervention(id) : await this.externals.openCert(id);
      if (!ok) this.notify(I18n.t("app.deepLink.notFound"), "err");
      return ok;
    } catch (_) {
      // Même doctrine que la fiche : 401/403/réseau sont déjà dits ailleurs, on ne double pas.
      return false;
    }
  }
}

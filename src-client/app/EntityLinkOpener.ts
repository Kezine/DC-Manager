/* =============================================================================
   ENTITYLINKOPENER — EXÉCUTE un deep-link d'entité : « cette cible → cette fiche
   à l'écran ». Le pendant IMPÉRATIF de la décision pure `core/EntityLinkRouting`.

   POURQUOI CE SERVICE (chantier étiquettes QR, lot « deep-link d'entité »).
   Le chemin « une cible (docId, collection, id) devient une fiche ouverte » a
   DEUX consommateurs, et ils n'ont rien d'autre en commun :
     · le HASH de l'URL — au boot (le navigateur a ouvert l'URL scannée hors
       app) et sur `hashchange` (lien collé, retour arrière) ;
     · le futur GREFFON DE SCAN — la caméra décode le texte du QR alors que
       l'application tourne déjà.
   L'écrire dans `main.ts` aurait condamné le second à le réécrire. D'où une
   classe à DÉPENDANCES INJECTÉES (store, hôte de formulaires, accès aux
   documents serveur, notification), dont l'API prend une cible DÉJÀ PARSÉE :
   le parsing (`EntityLink.parse`) appartient à celui qui tient le texte brut.

   CE QU'IL FAIT, dans l'ordre :
     1. il DEMANDE l'action à `EntityLinkRouting` (règle unique, testée) ;
     2. `switch-doc` ⇒ il ouvre d'abord le document visé (mode API) — un échec
        est un toast, jamais une exception qui remonterait dans le boot ;
     3. il ouvre la fiche par le PATTERN DE LA PALETTE (cache → lecture unitaire
        → `Forms.detail`), le point d'entrée unique des fiches.

   🚨 CE QU'IL NE FAIT PAS : il ne double AUCUN message d'un autre mécanisme. Un
   403 en vol est déjà dit — une fois, dédupliqué par permission — par
   `core/AccessDenial` (et un 401 par `SessionExpiry`) ; ajouter ici un
   « introuvable » sur ces cas mentirait sur la cause. Il ne touche pas non plus
   à la VUE active : la fiche est une modale, elle s'ouvre PAR-DESSUS ce que la
   restauration de vue a activé (cf. `core/ViewRestoration`).

   MODE FICHIER : `documents` vaut `null` (injection nulle, patron `HydrationState`
   /`AccessState`) — aucun test de mode dans le code, et le mode fichier ne peut
   PAS partir ouvrir un document serveur qui n'existe pas chez lui.
   ============================================================================= */

import type { Store } from "../store";
import type { EntityLinkTarget } from "../../src-shared/EntityLink";
import { EntityLinkRouting } from "../core/EntityLinkRouting";
import { Forms, type FormHost } from "../views/Forms";
import { I18n } from "../i18n/I18n";

/** Accès aux documents SERVEUR (mode API) — la part de `RestDocumentController` dont le deep-link a
    besoin, et rien de plus : quel document est ouvert, et comment en ouvrir un autre. */
export interface EntityLinkDocuments {
  /** Document serveur courant (`RestDocumentController.docId`) — `null` tant qu'aucun n'est ouvert. */
  currentDocId(): string | null;
  /** Ouvre le document `docId` (charge les collections, notifie l'hôte). Rejette si le document est
      introuvable/illisible — c'est ce rejet qui devient un toast ici. */
  openDocument(docId: string): Promise<void>;
}

export interface EntityLinkOpenerDeps {
  store: Store;
  /** Hôte des formulaires (modale) — celui de `main.ts`, comme pour la palette de recherche. */
  formHost: FormHost;
  /** `null` en mode fichier/visualiseur (injection nulle) ⇒ jamais de bascule de document. */
  documents: EntityLinkDocuments | null;
  /** Notification à l'utilisateur (`Notify.toast` en pratique) — injectée pour que le service ne
      dépende pas d'un singleton d'UI. */
  notify(message: string, kind?: string): void;
  /** Rafraîchissement de la vue active après une modification faite DEPUIS la fiche ouverte (même
      rôle que le `onChanged` passé par `main.ts` à `Forms.detail`). */
  onChanged?(): void;
}

export class EntityLinkOpener {
  private readonly store: Store;
  private readonly formHost: FormHost;
  private readonly documents: EntityLinkDocuments | null;
  private readonly notify: (message: string, kind?: string) => void;
  private readonly onChanged: (() => void) | undefined;

  constructor(deps: EntityLinkOpenerDeps) {
    this.store = deps.store; this.formHost = deps.formHost; this.documents = deps.documents;
    this.notify = deps.notify; this.onChanged = deps.onChanged;
  }

  /** Ouvre la fiche désignée par `target` (cible déjà parsée). Rend `true` si une fiche est à l'écran.
      Ne LÈVE jamais : ce service est appelé depuis le boot et depuis des écouteurs d'événement, où une
      exception ne serait rattrapée par personne (et casserait, sous droits partiels, un boot par
      ailleurs valable). Tout échec = un `false` et, quand la cause n'est pas déjà signalée, un toast. */
  async open(target: EntityLinkTarget): Promise<boolean> {
    // `restMode` n'est PAS un drapeau de plus : c'est la présence de l'accès aux documents serveur.
    const route = EntityLinkRouting.decide({
      restMode: !!this.documents,
      currentDocId: this.documents ? this.documents.currentDocId() : null,
      target,
    });
    if (!route) return false;
    if (route.action === "switch-doc") {
      try { await this.documents!.openDocument(route.docId); }
      catch (e: any) {
        // Document supprimé, interdit, ou serveur injoignable : l'étiquette est plus vieille que le
        // parc. On le DIT (le lien nommait un document précis, l'utilisateur doit comprendre pourquoi
        // rien ne s'ouvre) et on s'arrête là — ouvrir la fiche dans le document courant montrerait un
        // objet homonyme d'un autre document, ou rien.
        this.notify(I18n.t("app.deepLink.docError", { error: (e && e.message) || e }), "err");
        return false;
      }
    }
    return this.openDetail(route.target);
  }

  /** Fiche d'un (collection, id) — PATTERN DE LA PALETTE (`GlobalSearchPalette.activate`) : le cache
      d'abord, une lecture UNITAIRE ensuite, `Forms.detail` pour finir. La lecture unitaire est ce qui
      rend le deep-link viable sous CHARGEMENT PARESSEUX (docs/hydratation.md) : une étiquette peut
      viser un contact ou une pièce jointe qui n'est PAS au cache — `fetchOne` l'absorbe et l'indexe.
      En mode fichier, l'objet est au cache ou n'existe pas : aucun réseau n'est touché. */
  private async openDetail(target: EntityLinkTarget): Promise<boolean> {
    const { collection, id } = target;
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
}

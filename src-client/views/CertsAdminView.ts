import { Html } from "../core/Html";
import { Format } from "../core/Format";
import { CertsFormat, type CertLifecycle } from "../core/CertsFormat";
import { CertTree, type CertTreeNode } from "../core/CertTree";
import { FormControls, type SelectOption } from "../ui/FormControls";
import { type MultiItem } from "../ui/MultiSelect";
import { FilterBar } from "../ui/FilterBar";
import { CardTable } from "../ui/CardTable";
import { Notify } from "../ui/Notify";
import { Clipboard } from "../ui/Clipboard";
import { Dialog } from "../ui/Dialog";
import { RichTooltip } from "../ui/RichTooltip";
import { Icons } from "../ui/Icons";
import { IconButton } from "../ui/IconButton";
import { OverlayA11y } from "../ui/OverlayA11y";
import { CertsTips, CERT_TIP } from "./CertsTips";
import { DeleteGuard, type DeletableCert } from "../certs/DeleteGuard";
import { I18n } from "../i18n/I18n";
import { Download } from "../core/Download";
import { CertDeployGuide, type DeployGuide } from "../core/CertDeployGuide";
import type { FormHost } from "./forms/shared";
import { CertsError } from "./forms/CertsClient";
import type { CertsClient, CertificateListItem, CertificateDetail, CertificateInput, CertSan, PkiState } from "./forms/CertsClient";
import { PkiCrypto } from "../certs/PkiCrypto";
import { PkiSession } from "../certs/PkiSession";
import { X509Factory, type X509KeyAlgo, type LeafUsage, type X509San } from "../certs/X509Factory";
import { OpenSshEncoder, type SshCertType } from "../certs/OpenSshEncoder";
import { SshKeyMaterial } from "../certs/SshKeyMaterial";
import { SshWire } from "../certs/SshWire";
import { CertExports, type CertExportRecord, type ExportArtifact } from "../certs/CertExports";
import { CertValidity } from "../certs/CertValidity";
import { RevocationReasons, REVOCATION_REASON_CODES, RENEWAL_REASON_CODE } from "../certs/RevocationReasons";
import { CertZip, type CertBundleRecord, type ExportCategoryKey } from "../certs/CertZip";
import { BulkActions, type CertSelectionSnapshot } from "../certs/BulkActions";
import * as x509 from "@peculiar/x509";

/* =============================================================================
   CertsAdminView — page « Certificats » (PKI interne ZÉRO-CONNAISSANCE), ONGLET
   PRINCIPAL de premier niveau (décision utilisateur 2026-07-15 : ce n'est pas
   vraiment un paramètre ; kind:"primary", enregistrée juste avant le groupe
   « Paramètres » dans main.ts). Administre le module serveur `certs/` (C6) : clé
   maître, arbre CA → dérivés, créations X.509/SSH, exports, révocation, suppression,
   et AIDE AU DÉPLOIEMENT de la confiance des autorités (modale « Déployer la
   confiance… », consultation pure — cf. CertDeployGuide + docs/certs.md).

   Classe DÉDIÉE et AUTONOME (feature certs AMOVIBLE, pattern NotificationsAdminView) :
   la retirer = supprimer ce fichier + CertsClient + CertsFormat + le branchement de
   main.ts, sans cicatrice ailleurs. Elle NE dérive PAS de la chaîne `Forms` : elle
   réplique les quelques primitives DOM qu'elle utilise (pill/table) avec les MÊMES
   classes CSS que les fiches, pour rester détachable. Les FORMULAIRES (init, créations,
   PKCS#12) s'ouvrent dans la MODALE de l'app (FormHost injecté — principe n°11).

   UN SEUL ARBRE DÉPLOYABLE CLIENT-SIDE (Lot 2a-ii — remplace les deux listings paginés serveur
   « Autorités » / « sous-arbre d'une racine ») : un unique `client.list()` charge TOUTES les
   métadonnées (SANS `key_enc`, invariant Q5), et le module PUR `CertTree` construit la forêt reliée
   par `parent_id`, filtre, trie et aplatit — TOUT le calcul se fait en mémoire, dans le navigateur
   (l'échelle réelle est petite : plus de pagination). L'état d'affichage (familles/état/recherche,
   tri intra-fratrie, nœuds ouverts) vit en MÉMOIRE d'instance ; les racines sont ouvertes par défaut
   au PREMIER chargement, l'état d'ouverture est ensuite préservé aux rechargements.
     - Filtre TYPE = par FAMILLE de racine (root-ca / ssh-ca / ssh-keypair) — sélectionne QUELS arbres
       s'affichent (les familles X.509 et SSH sont des arbres séparés).
     - Filtre ÉTAT (CertsFormat.lifecycle) + RECHERCHE : filtrent des LIGNES en gardant les ANCÊTRES
       pour le contexte, via CertTree.visibleIds.
     - Tri intra-fratrie (Libellé / Échéance) par en-tête cliquable, client via CertTree.sortSiblings.
   Deux repeints distincts : `refreshTree()` (filtre/tri/recherche/dépliage — SANS réseau) et
   `refreshBody()` (APRÈS écriture — recharge `loadAll()` puis repeint), la sélection multiple (L4)
   cascadant PARENT→ENFANTS (cocher un nœud coche tout son sous-arbre ; case parent INDÉTERMINÉE si
   sélection partielle — cf. CertTree.selectionStateOf), la case d'en-tête restant sur les lignes VISIBLES.

   ZÉRO-CONNAISSANCE : toute la crypto vit ICI, dans le navigateur. La clé maître
   (dérivée PBKDF2) et les clés privées déchiffrées ne sont JAMAIS persistées ni
   envoyées au serveur ; `key_enc` n'est jamais réaffiché ; les messages d'erreur ne
   portent aucun matériau de clé. Le coffre de session (PkiSession) oublie la clé au
   verrouillage manuel OU après 15 min d'inactivité (chaque action appelle `touch()`).

   VERROUILLÉ vs DÉVERROUILLÉ : seules les opérations qui ONT BESOIN de la clé maître
   exigent le déverrouillage — créer une CA, ÉMETTRE (signer réclame la clé privée de
   l'émetteur), et exporter AVEC la clé privée. Verrouillée, la page reste : liste et
   échéances consultables, export des artefacts PUBLICS, et RÉVOCATION/SUPPRESSION —
   ce sont des opérations de MÉTADONNÉES, aucun secret n'y est déchiffré. C'est ce qui
   permet de purger une PKI dont la phrase secrète est perdue (docs/certs.md § Limites).
   Le garde-fou de la suppression n'est donc pas le verrou mais l'INTENTION EXPLICITE :
   confirmation par saisie ici, et `?force=true` exigé par le serveur pour tout
   certificat encore VALIDE (cf. CertsModule).

   MODE : le service est SANS OBJET hors mode API (pas de serveur, pas de crypto scopée
   par document). En mode fichier/viewer, `client` est null → message « mode API requis ».
   503 (module en erreur serveur) → bandeau détaillé (pattern NotificationsAdminView).
   ============================================================================= */

/* Les LIBELLÉS des options/filtres sont localisés → construits AU POINT DE RENDU (méthodes statiques),
   jamais au chargement du module (avant `I18n.init()`). Ne restent en données PURES au niveau module que
   les IDENTIFIANTS de familles (valeurs de kind non traduisibles — le libellé est résolu par
   `CertsFormat.kindLabel` à la construction du filtre) et les SVG d'arbre. */
/** Familles proposées au filtre « Type » = kind de la RACINE d'un arbre (le filtre sélectionne QUELS arbres
    s'affichent). Les familles X.509 (root-ca) et SSH (ssh-ca / ssh-keypair) sont des arbres SÉPARÉS. */
const FAMILY_FILTER_IDS = ["root-ca", "ssh-ca", "ssh-keypair"];

/* SVG d'arbre INLINE (le registre Icons n'a pas d'équivalent « chevron » ni de bouclier PLEIN sans coche) :
   facture commune aux icônes de l'app (viewBox 24×24, fill:none, stroke currentColor) → prennent la couleur
   de leur hôte ; taille et épaisseur de trait viennent du CSS (.twisty svg / .node-ic svg). */
/** Chevron du bouton de dépliage (twisty) — tourné de 90° par CSS quand la ligne est ouverte. */
const TREE_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
/** Bouclier PLEIN (sans coche) — icône de niveau des autorités (racine = accent, intermédiaire = info). */
const TREE_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l7 3v6c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V5z"/></svg>';

/** Cible (équipement/VM) RAPPROCHÉE d'un certificat — vue minimale pour l'indicateur de listing (colonne Cible). */
export interface CertTargetRef {
  kind: "equipment" | "vm";
  id: string;
  label: string;
}

/** Résolveur INJECTÉ par main.ts (feature AMOVIBLE) : rapproche un certificat de cibles réseau (calculé, jamais
    persisté — cf. CertTargetMatch) et sait OUVRIR la fiche d'une cible avec retour-auto. null hors mode API →
    aucun indicateur « cible » dans le listing. `targetsForCert` reçoit l'item de ligne (déjà porteur de
    sans/subject) → aucun appel réseau. `openTarget` réutilise le patron openTargetDetail (overlay unique). */
export interface CertTargetResolver {
  targetsForCert(cert: CertificateListItem): CertTargetRef[];
  openTarget(ref: CertTargetRef, onClosed: () => void): void;
}

export class CertsAdminView {
  /** Signal ÉMIS après tout rechargement du corps de listing (dont création / suppression / révocation) : la vue
      prévient l'hôte que le NOMBRE TOTAL de certificats a pu changer, pour rafraîchir le badge de l'onglet — tenu
      HORS de cette vue (compteur caché maintenu en async dans main.ts). Branché sur refreshBody() (chokepoint de
      tous les rechargements APRÈS écriture) plutôt que dispersé sur chaque site : robuste (aucune mutation oubliée).
      Les repeints purement CLIENT (filtre/tri/recherche/dépliage) passent par refreshTree() et n'émettent RIEN
      (le total n'a pas bougé). Optionnel. */
  onCountsChanged?: () => void;

  /** Coffre de session détenant la clé maître dérivée (créé au constructeur, onLock → re-render). */
  private readonly session: PkiSession;
  /** Dernier état PKI connu (null = pas encore chargé). */
  private pkiState: PkiState | null = null;
  /** Garde anti-rechargements concurrents. */
  private loading = false;
  /** Dernier chargement d'activation (show) — AWAITÉ par `focusCert` : l'ouverture d'un cert DEPUIS une fiche
      bascule d'abord l'onglet (→ `show()` lance un reload), puis focalise ; on attend la fin de ce chargement
      avant de chercher le nœud (sinon l'arbre pourrait être vide au moment de la focalisation). */
  private lastLoad: Promise<void> = Promise.resolve();

  /** Métadonnées PLATES de TOUT le document (un seul `client.list()`, SANS key_enc, invariant Q5). Source de
      la forêt : reconstruite à chaque rechargement, consultable coffre VERROUILLÉ. */
  private allItems: CertificateListItem[] = [];
  /** Forêt (racines) construite depuis `allItems` par CertTree.build — triée intra-fratrie, filtrée/aplatie au rendu. */
  private forest: CertTreeNode<CertificateListItem>[] = [];
  /** Ids des nœuds DÉPLIÉS (état d'ouverture, préservé aux rechargements). Les racines y sont ajoutées au PREMIER
      chargement seulement (cf. `rootsOpened`). */
  private open: Set<string> = new Set();
  /** Racines ouvertes par défaut UNE FOIS (premier `loadAll`) — ensuite l'utilisateur maîtrise le dépliage. */
  private rootsOpened = false;
  /** Filtres COURANTS : famille (kind de racine, sélection unique) + état (cycle de vie, unique) + recherche libre.
      Composition : la famille choisit les arbres, l'état + la recherche filtrent les lignes (ancêtres gardés). */
  private filter: { family: string; state: "" | CertLifecycle; query: string } = { family: "", state: "", query: "" };
  /** Tri INTRA-FRATRIE (client, CertTree.sortSiblings) : critère + sens, piloté par les en-têtes cliquables. */
  private sortKey: "label" | "not_after" = "label";
  private sortDir: "asc" | "desc" = "asc";
  /** Vrai pendant un rendu FILTRÉ (visible ≠ null) : le chevron d'un nœud à enfants apparaît alors DÉPLIÉ
      (CertTree.flatten force le chemin des correspondances ouvert). Transitoire, posé par paintBody. */
  private treeFiltering = false;
  /** Items des lignes VISIBLES du dernier rendu (résultat aplati/filtré) — base de la case « toute la page » et de
      la case d'en-tête (elles portent sur les lignes AFFICHÉES ; la cascade parent→enfants, elle, touche le
      sous-arbre COMPLET, descendants cachés compris — cf. toggleSelect). */
  private visibleItems: CertificateListItem[] = [];
  /** Conteneur du corps (table arbre + barre de sélection + ligne de compte) — repeint SEUL sur filtre/tri/
      recherche/dépliage (toolbar préservée). */
  private bodyEl: HTMLElement | null = null;
  /** Champ de recherche THÉMATISÉ (loupe + effacer) — élément UNIQUE réemployé à chaque rebuild de toolbar (le
      terme saisi survit, et le focus est préservé puisque refreshTree ne reconstruit pas la toolbar). */
  private searchWrap: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  /** Barre de filtres unifiée (chips « Type/État » + « + Filtre » + Réinitialiser) — bâtie au rendu complet,
      PRÉSERVÉE sur refreshBody (un changement de filtre ne repeint que ses chips + le corps). */
  private filterBar: FilterBar | null = null;
  /** Id de la ligne à mettre en évidence après une navigation par la recherche (`.row-focus`). CONSOMMÉ au
      premier `paintBody` (mis à null après application), pour qu'un repaint ultérieur (tri/page) ne la ré-allume pas. */
  private focusId: string | null = null;

  /** Résolveur de cibles rapprochées (INJECTÉ par main.ts, feature amovible) — null hors mode API : aucune
      colonne « Cible(s) » active dans le listing. Cf. `CertTargetResolver`. */
  private targetResolver: CertTargetResolver | null = null;

  /** SÉLECTION MULTIPLE (L4) : instantané par id des éléments cochés. SURVIT aux changements de tri/filtre/dépliage ;
      VIDÉE après une action groupée. Un snapshot minimal (kind/label/has_key/revoked_at) suffit à décider les
      actions communes et au bilan (BulkActions). */
  private readonly selection = new Map<string, CertSelectionSnapshot>();
  /** Conteneur de la BARRE de sélection (au-dessus de la table, visible quand N > 0) — repeint sur toute
      variation de sélection sans reconstruire la table. */
  private selBarEl: HTMLElement | null = null;
  /** Case d'en-tête « toute la page » (état INDÉTERMINÉ si sélection partielle) — mise à jour à chaque variation. */
  private headerCheckbox: HTMLInputElement | null = null;

  constructor(
    private readonly container: HTMLElement,
    /** null = mode fichier/viewer (service sans objet) → message d'indisponibilité. */
    private readonly client: CertsClient | null,
    /** Hôte de modale de l'app — les formulaires s'ouvrent dans LA modale standard (principe n°11). */
    private readonly host: FormHost,
  ) {
    this.session = new PkiSession({ onLock: () => this.onLocked() });
    RichTooltip.registerAll(CertsTips.build());   // idempotent (Map.set) — contenus LOCALISÉS bâtis à l'enregistrement (après I18n.init())
  }

  /** Activation de la sous-page (onShow) : messages d'indisponibilité, sinon (re)charge PKI + liste. */
  show(): void {
    if (!this.client) { this.renderNeedsApi(); return; }
    if (!this.client.docId) { this.renderNoDoc(); return; }
    this.lastLoad = this.reload();   // mémorisé pour que focusCert puisse attendre la fin d'un chargement d'activation
  }

  /** Injecte (ou retire) le résolveur de cibles rapprochées — active la colonne « Cible(s) » du listing
      (feature AMOVIBLE, posée par main.ts en mode API). */
  setTargetResolver(resolver: CertTargetResolver | null): void {
    this.targetResolver = resolver;
  }

  /** FOCALISE un certificat par son id : ouvre l'onglet (déjà basculé par l'appelant) sur l'arbre, DÉPLIE tous les
      ancêtres du nœud et surligne sa ligne. Point d'entrée du rapprochement DEPUIS une fiche
      (`CertFicheHooks.openCert`). L'arbre complet étant chargé côté client, on cherche le nœud EN MÉMOIRE (aucune
      requête ciblée). Introuvable → no-op silencieux (la vue reste où elle est). */
  async focusCert(certId: string): Promise<void> {
    if (!this.client || !this.client.docId) return;
    this.session.touch();
    await this.lastLoad.catch(() => { /* un échec du chargement d'activation ne bloque pas la focalisation */ });
    // S'assurer que l'arbre est chargé (l'activation a pu ne pas avoir eu lieu / avoir échoué).
    if (!this.allItems.length) {
      try { await this.loadAll(); } catch (_) { return; }   // réseau KO → on abandonne
    }
    const node = this.findNode(certId);
    if (!node) return;   // certificat absent du document → aucune navigation
    // GARANTIR la visibilité de la cible : on lève les filtres/recherche courants (un filtre résiduel pourrait
    // exclure la ligne de l'arbre affiché) — même intention que l'ancienne navigation par la recherche.
    this.filter = { family: "", state: "", query: "" };
    // Déplier TOUS les ancêtres pour que la ligne cible soit rendue, puis la surligner au prochain paintBody.
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) this.open.add(ancestor.item.id);
    this.focusId = certId;
    this.render();
  }

  /** Retrouve un nœud de la forêt par id (parcours en profondeur borné par la structure acyclique de CertTree.build).
      Null si absent. Sert la focalisation depuis une fiche. */
  private findNode(id: string): CertTreeNode<CertificateListItem> | null {
    const stack = [...this.forest];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.item.id === id) return node;
      for (const child of node.children) stack.push(child);
    }
    return null;
  }

  /** Verrouillage (auto 15 min ou manuel) → revient à l'écran verrouillé (re-render). */
  private onLocked(): void {
    if (this.client && this.pkiState) this.render();
  }

  /* --------------------------------------------------------------------------
     Chargement réseau
     -------------------------------------------------------------------------- */

  private async reload(): Promise<void> {
    await this.guarded(async () => {
      // PKI (état de la clé maître) + arbre complet en parallèle — le listing est consultable AVANT tout
      // déverrouillage (lecture seule, métadonnées SEULES).
      const [pki] = await Promise.all([this.client!.pki(), this.loadAll()]);
      this.pkiState = pki;
      this.render();
    });
  }

  /** Exécute un chargement en traduisant 503 (module serveur en erreur) en BANDEAU actionnable, et
      toute autre erreur en message plein contenu. Ré-entrance gardée. */
  private async guarded(load: () => Promise<void>): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try { await load(); }
    catch (e) {
      if (e instanceof CertsError && e.status === 503) { this.renderDisabled(e); return; }
      this.renderMessage(I18n.t("certs.admin.msg.loadError", { detail: CertsAdminView.errText(e) }), true);
    } finally { this.loading = false; }
  }

  /* --------------------------------------------------------------------------
     Rendu principal (verrouillé / déverrouillé)
     -------------------------------------------------------------------------- */

  private render(): void {
    if (!this.client || !this.pkiState) return;
    this.container.innerHTML = "";
    this.container.appendChild(this.buildToolbar());
    // Plus de panneau de déverrouillage persistant : l'état du coffre + le déverrouillage vivent dans le
    // bouton de la barre de contrôles (buildVaultButton → unlockModal). Gain de place demandé.
    this.container.appendChild(this.buildListingSection());
    this.paintBody();
  }

  /** Barre de contrôles UNIFIÉE (revue design lot C) : recherche EN TÊTE (extensible, loupe intégrée), filtres
      « Type/État » en CHIPS + « + Filtre » (FilterBar partagée), puis le cluster de DROITE (état du coffre,
      créations/changement de phrase/verrou/actualisation, « Réinitialiser » le plus à droite). NON reconstruite
      sur refreshBody → recherche et panneau de filtre ouverts survivent. */
  private buildToolbar(): HTMLElement {
    const bar = document.createElement("div"); bar.className = "list-chrome";

    // Recherche : visible MÊME verrouillée — elle ne lit que des métadonnées (aucune opération de clé). Filtre
    // l'arbre CLIENT en gardant les ancêtres + surligne le terme (aucun réseau).
    bar.appendChild(this.searchBox());

    // Filtres « Type » (= famille de racine, sélection UNIQUE) + « État » (cycle de vie, sélection UNIQUE) → chips.
    bar.appendChild(this.buildFilters());

    const right = document.createElement("div"); right.className = "lc-right";
    if (this.session.unlocked) {
      right.append(
        this.actionButton(I18n.t("certs.admin.toolbar.addRootCa"), I18n.t("certs.admin.toolbar.addRootCaTitle"), () => this.rootCaModal(), "btn-primary"),
        this.actionButton(I18n.t("certs.admin.toolbar.addSshCa"), I18n.t("certs.admin.toolbar.addSshCaTitle"), () => this.sshKeyModal("ssh-ca"), "btn-primary"),
        this.actionButton(I18n.t("certs.admin.toolbar.addSshPair"), I18n.t("certs.admin.toolbar.addSshPairTitle"), () => this.sshKeyModal("ssh-keypair"), "btn-primary"),
      );
      right.appendChild(this.actionButton(I18n.t("certs.admin.toolbar.changePass"), I18n.t("certs.admin.toolbar.changePassTitle"), () => this.changePassphraseModal()));
    }
    // Dépliage GLOBAL de l'arbre (client) : « Tout déployer » (tous les nœuds à enfants) / « Tout replier » (vide).
    right.appendChild(this.actionButton(I18n.t("certs.admin.tree.expandAll"), I18n.t("certs.admin.tree.expandAllTitle"), () => this.expandAll()));
    right.appendChild(this.actionButton(I18n.t("certs.admin.tree.collapseAll"), I18n.t("certs.admin.tree.collapseAllTitle"), () => this.collapseAll()));
    right.appendChild(this.actionButton(I18n.t("certs.admin.toolbar.refresh"), I18n.t("certs.admin.toolbar.refreshTitle"), () => { this.session.touch(); void this.reload(); }));
    if (this.filterBar) right.appendChild(this.filterBar.resetElement);
    // Contrôle du COFFRE, TOUT À DROITE (remplace le panneau persistant + le badge d'état) : « Verrouiller »
    // si ouvert (action immédiate), sinon « Déverrouiller » / « Initialiser » qui ouvre la modale du coffre.
    right.appendChild(this.buildVaultButton());

    bar.appendChild(right);
    return bar;
  }

  /** FilterBar : « Type » = FAMILLE de racine (root-ca / ssh-ca / ssh-keypair, sélection UNIQUE → choisit QUELS
      arbres s'affichent) + « État » = cycle de vie (actif / expire ≤30j / révoqué / expiré, sélection UNIQUE →
      filtre les lignes, ancêtres gardés). Les deux dimensions sont `single` : un Set 0/1 fait autorité et se
      reporte dans `this.filter` à chaque changement, puis `refreshTree()` (repeint CLIENT, sans réseau).
      Reconstruite à chaque rendu complet ; préservée sur refreshTree (un panneau ouvert reste ouvert). */
  private buildFilters(): HTMLElement {
    // Familles = kind de la racine (le libellé est résolu par CertsFormat.kindLabel — après I18n.init()).
    const familyItems: MultiItem[] = FAMILY_FILTER_IDS.map((id) => ({ id, label: CertsFormat.kindLabel(id) }));
    const familySet = new Set<string>(this.filter.family ? [this.filter.family] : []);
    // États = cycle de vie (CertsFormat.lifecycle). Options sans le « Tous » (la FilterBar l'ajoute elle-même).
    const stateItems: MultiItem[] = CertsAdminView.stateFilterItems();
    const stateSet = new Set<string>(this.filter.state ? [this.filter.state] : []);
    this.filterBar = new FilterBar([
      { key: "family", label: I18n.t("lists.col.type"), options: familyItems, selected: familySet, single: true },
      { key: "state", label: I18n.t("certs.admin.listing.colState"), options: stateItems, selected: stateSet, single: true },
    ], () => {
      this.filter.family = [...familySet][0] || "";
      this.filter.state = ([...stateSet][0] as CertLifecycle) || "";
      this.session.touch();
      this.refreshTree();
    });
    return this.filterBar.filtersElement;
  }

  /* --------------------------------------------------------------------------
     Recherche CLIENT — un simple champ thématisé (loupe + effacer, style .lc-searchpop
     de la barre de listing) qui alimente `this.filter.query` et repeint l'arbre. Filtre
     via CertTree.visibleIds (garde les ancêtres) et surligne le terme dans les libellés.
     -------------------------------------------------------------------------- */

  /** Élément de recherche pour la toolbar : conteneur UNIQUE réemployé à chaque rebuild (le terme saisi survit,
      et le focus est préservé puisque refreshTree ne reconstruit pas la toolbar). Réutilise les classes de la
      recherche des listings (`.lc-searchpop`/`.lc-search-ic`/`.search-input`) — pas de popover ni de réseau. */
  private searchBox(): HTMLElement {
    if (!this.searchWrap) {
      const wrap = document.createElement("div"); wrap.className = "lc-searchpop";
      const icon = document.createElement("span"); icon.className = "lc-search-ic"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = Icons.SEARCH;
      const input = document.createElement("input"); input.type = "text"; input.className = "search-input";
      input.placeholder = I18n.t("certs.admin.toolbar.searchPlaceholder");
      input.value = this.filter.query;
      const clear = document.createElement("button"); clear.type = "button"; clear.className = "btn btn-ghost btn-sm";
      clear.innerHTML = Icons.CLOSE; clear.title = I18n.t("ui.search.clear");
      input.oninput = () => { this.filter.query = input.value; this.session.touch(); this.refreshTree(); };
      clear.onclick = () => { input.value = ""; this.filter.query = ""; input.focus(); this.refreshTree(); };
      wrap.append(icon, input, clear);
      this.searchWrap = wrap; this.searchInput = input;
    } else if (this.searchInput) {
      this.searchInput.value = this.filter.query;   // rebuild de toolbar : refléter le terme courant
    }
    return this.searchWrap;
  }

  /** Écran VERROUILLÉ : initialisation (PKI vierge) OU saisie de la phrase secrète maître. */
  /** Bouton de CONTRÔLE DU COFFRE (barre de contrôles, tout à droite) — reflète l'état, libellé + icône portant
      l'information (l'ancien badge d'état devient superflu) :
      - déverrouillé → « Verrouiller » (action immédiate, cadenas fermé) ;
      - PKI vierge → « Initialiser » (ouvre la modale d'initialisation) ;
      - verrouillé / contexte non sécurisé → « Déverrouiller » (ouvre la modale du coffre). */
  private buildVaultButton(): HTMLButtonElement {
    if (this.session.unlocked) {
      const btn = this.actionButton(I18n.t("certs.admin.toolbar.lock"), I18n.t("certs.admin.toolbar.lockTitle"), () => { this.session.lock(); });
      IconButton.decorate(btn, Icons.LOCK);
      return btn;
    }
    const uninit = this.pkiState?.initialized !== true && PkiCrypto.available();
    const btn = this.actionButton(
      uninit ? I18n.t("certs.admin.toolbar.init") : I18n.t("certs.admin.toolbar.unlock"),
      uninit ? I18n.t("certs.admin.toolbar.initTitle") : I18n.t("certs.admin.toolbar.unlockTitle"),
      () => this.unlockModal(), "btn-primary");
    IconButton.decorate(btn, Icons.UNLOCK);
    return btn;
  }

  /** Modale du COFFRE de certificat — remplace l'ancien panneau persistant (gain de place : la vue n'affiche
      plus qu'un bouton dans la barre de contrôles). Selon l'état PKI : contexte non sécurisé (info seule),
      PKI vierge (→ initialisation), ou verrouillée (saisie de la phrase). `reopen` (aller-retour) : à la
      fermeture — donc après un déverrouillage réussi comme après une annulation — rouvre la modale d'origine.
      Utilisé par le bouton « Déverrouiller » d'une modale d'export pour Y REVENIR une fois le coffre ouvert. */
  private unlockModal(reopen?: () => void): void {
    const state = this.pkiState;
    if (!state) return;

    // CONTEXTE NON SÉCURISÉ : crypto.subtle absent hors HTTPS/localhost → toute la crypto PKI est inopérante.
    // Info seule (les métadonnées, elles, restent consultables dans le listing : aucune opération de clé).
    if (!PkiCrypto.available()) {
      const box = document.createElement("div");
      const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.cssText = "white-space:pre-line;color:var(--warn)";
      hint.textContent = I18n.t("certs.admin.lock.insecureHint");
      box.appendChild(hint);
      this.host.openModal({ title: I18n.t("certs.admin.lock.insecureTitle"), body: box, hideFooter: true, onClose: reopen });
      return;
    }

    // PKI VIERGE → proposer l'initialisation (initModal remplace cette modale à la validation).
    if (state.initialized !== true) {
      const box = document.createElement("div");
      const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.marginBottom = "10px";
      hint.textContent = I18n.t("certs.admin.lock.uninitHint");
      const btn = this.actionButton(I18n.t("certs.admin.lock.initBtn"), I18n.t("certs.admin.lock.initBtnTitle"), () => this.initModal(), "btn-primary");
      box.append(hint, btn);
      this.host.openModal({ title: I18n.t("certs.admin.lock.uninitTitle"), body: box, hideFooter: true, onClose: reopen });
      return;
    }

    // PKI VERROUILLÉE → phrase secrète. onSave = déverrouillage (renvoie true → ferme → onClose/aller-retour).
    const root = document.createElement("div");
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.marginBottom = "10px";
    hint.textContent = I18n.t("certs.admin.lock.unlockHint");
    const input = FormControls.text("", I18n.t("certs.admin.lock.passPlaceholder")); input.type = "password"; input.autocomplete = "current-password";
    const errBox = this.errBox();
    root.append(hint, FormControls.fieldRow(I18n.t("certs.admin.lock.passLabel"), input), errBox);
    // Entrée = déverrouiller (parité avec l'ancien panneau) : tente puis ferme la modale en cas de succès
    // (closeModal → onClose → aller-retour éventuel), comme le bouton « Déverrouiller » du pied.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      void this.attemptUnlock(input.value, errBox).then((ok) => { if (ok) this.host.closeModal?.(); });
    });
    this.host.openModal({
      title: I18n.t("certs.admin.lock.unlockTitle"), body: root,
      saveLabel: I18n.t("certs.admin.lock.unlockBtn"), onClose: reopen,
      onSave: async () => this.attemptUnlock(input.value, errBox),   // true → ferme ; false → reste ouverte (erreur affichée)
    });
    setTimeout(() => input.focus(), 30);
  }

  /* --------------------------------------------------------------------------
     Listing HIÉRARCHIQUE CLIENT — un seul `client.list()` charge tout le document
     (métadonnées SEULES), CertTree construit/filtre/trie/aplatit en mémoire. Deux
     repeints : refreshTree() (client, sans réseau) et refreshBody() (après écriture).
     -------------------------------------------------------------------------- */

  /** Charge TOUT l'arbre depuis le serveur (métadonnées SEULES, SANS key_enc — invariant Q5), reconstruit la
      forêt et la trie intra-fratrie. Les racines sont ouvertes par défaut au PREMIER chargement UNIQUEMENT :
      aux rechargements suivants (après écriture), l'état d'ouverture de l'utilisateur est PRÉSERVÉ. */
  private async loadAll(): Promise<void> {
    this.allItems = await this.client!.list();
    this.forest = CertTree.build(this.allItems);
    CertTree.sortSiblings(this.forest, this.sortKey, this.sortDir);
    if (!this.rootsOpened) {
      for (const root of this.forest) this.open.add(root.item.id);
      this.rootsOpened = true;
    }
  }

  /** Repeint CLIENT (filtre/tri/recherche/dépliage) : re-trie la forêt (idempotent) puis repeint le corps —
      AUCUN réseau, AUCUN recomptage d'onglet (le total est inchangé). */
  private refreshTree(): void {
    CertTree.sortSiblings(this.forest, this.sortKey, this.sortDir);
    this.paintBody();
  }

  /** Recharge TOUT l'arbre puis repeint le corps — APRÈS une écriture (création/révocation/suppression/renouv.).
      La toolbar reste en place (un panneau de filtre ouvert n'est pas refermé). Appelé par les modales/bulk. */
  private async refreshBody(): Promise<void> {
    await this.guarded(async () => { await this.loadAll(); this.paintBody(); });
    this.onCountsChanged?.();   // le TOTAL de certificats a pu changer (création/suppression) → badge d'onglet (async, hors vue)
  }

  /** Déplie/replie un nœud (chevron) puis repeint l'arbre (client). */
  private toggleOpen(id: string): void {
    this.session.touch();
    if (this.open.has(id)) this.open.delete(id); else this.open.add(id);
    this.refreshTree();
  }

  /** « Tout déployer » : ouvre TOUS les nœuds à enfants de la forêt, puis repeint. */
  private expandAll(): void {
    this.session.touch();
    const opened = new Set<string>();
    const walk = (nodes: CertTreeNode<CertificateListItem>[]) => {
      for (const node of nodes) if (node.children.length) { opened.add(node.item.id); walk(node.children); }
    };
    walk(this.forest);
    this.open = opened;
    this.refreshTree();
  }

  /** « Tout replier » : vide l'état d'ouverture (seules les racines restent visibles), puis repeint. */
  private collapseAll(): void {
    this.session.touch();
    this.open = new Set();
    this.refreshTree();
  }

  /** En-tête de la section listing (intro localisée décrivant l'arbre) + le conteneur de corps (rempli par
      paintBody). Filtres et boutons de dépliage vivent dans la barre de contrôles unifiée (buildToolbar). */
  private buildListingSection(): HTMLElement {
    const wrap = document.createElement("div");
    const intro = document.createElement("div"); intro.className = "form-hint"; intro.style.marginBottom = "8px";
    intro.textContent = this.session.unlocked
      ? I18n.t("certs.admin.listing.introUnlocked")
      : I18n.t("certs.admin.listing.introLocked");
    wrap.appendChild(intro);
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "list-body";   // mêmes règles CSS que les listings ListView (défaut à gauche, numériques via cell-num)
    wrap.appendChild(this.bodyEl);
    return wrap;
  }

  /** Peint le CORPS (barre de sélection + table ARBRE + ligne de compte) dans `bodyEl`. L'arbre est filtré
      (CertTree.visibleIds) puis aplati (CertTree.flatten) sous l'état d'ouverture ; en filtrant, le chemin des
      correspondances est forcé ouvert. Si une focalisation a désigné un élément (`focusId`), on centre sa ligne et
      on l'illumine ; la surbrillance est CONSOMMÉE (mise à null) pour qu'un repaint ultérieur ne la ré-allume pas. */
  private paintBody(): void {
    if (!this.bodyEl) return;
    // Filtrage + aplatissement (PUR, CertTree) : visible=null si aucun filtre → seul l'état d'ouverture décide.
    const visible = CertTree.visibleIds(this.forest, { ...this.filter, now: Date.now() });
    this.treeFiltering = visible !== null;   // en mode filtré, les chevrons apparaissent dépliés (chemin forcé ouvert)
    const rows = CertTree.flatten(this.forest, { open: this.open, visible });
    this.visibleItems = rows.map((n) => n.item);   // base de la sélection « toute la page » (lignes AFFICHÉES)
    // Barre de sélection EN TÊTE du corps (avant la table) : repeinte à chaque variation de sélection sans
    // reconstruire la table. buildTree (re)crée la case d'en-tête ; on synchronise ensuite barre + case.
    this.selBarEl = document.createElement("div");
    this.bodyEl.replaceChildren(this.selBarEl, this.buildTree(rows), this.buildCountLine(this.allItems.length, rows.length));
    this.refreshSelectionUi();
    if (this.focusId) {
      const row = this.bodyEl.querySelector("tr.row-focus") as HTMLElement | null;
      if (row) {
        row.scrollIntoView({ block: "center" });
        // Estompe au PREMIER clic ailleurs (pattern locate 3D) : un écouteur unique retire la classe — son
        // retrait déclenche la transition CSS. Différé d'un tick pour ne pas capter le clic courant.
        window.setTimeout(() => {
          document.addEventListener("click", () => {
            this.bodyEl?.querySelectorAll("tr.row-focus").forEach((r) => r.classList.remove("row-focus"));
          }, { once: true });
        }, 0);
      }
      this.focusId = null;
    }
  }

  /** Ligne de COMPTE (remplace la pagination) : « N certificat(s) · M affiché(s) » — N = total du document,
      M = lignes actuellement rendues (repliées/filtrées comprises). */
  private buildCountLine(total: number, shown: number): HTMLElement {
    const line = document.createElement("div"); line.className = "list-count";
    line.textContent = I18n.t("certs.admin.listing.countLine", { total, shown });
    return line;
  }

  /* ---- Arbre unique : autorités → CA intermédiaires → dérivés (feuilles TLS / certificats SSH) ---- */

  /** Construit la TABLE-ARBRE depuis les lignes déjà ordonnées/aplaties (une <tr> par nœud). En-tête :
      ☐ · Libellé (colonne ARBRE, triable) · Type · Émetteur · Sujet · Échéance (triable) · Dérivés · [Cible] ·
      Actions. La colonne « Cible » n'apparaît que si un résolveur est injecté (mode API). */
  private buildTree(rows: CertTreeNode<CertificateListItem>[]): HTMLElement {
    const tw = document.createElement("div"); tw.className = "table-wrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead"); const tr = document.createElement("tr");
    const head: HTMLElement[] = [
      this.selectHeaderCell(),
      this.sortableTh(I18n.t("certs.admin.listing.colLabel"), "label"),
      this.plainTh(I18n.t("lists.col.type")),
      this.plainTh(I18n.t("certs.admin.listing.colIssuer")),
      this.plainTh(I18n.t("certs.admin.listing.colSubject")),
      this.sortableTh(I18n.t("certs.admin.listing.colExpiry"), "not_after"),
      this.plainTh(I18n.t("certs.admin.listing.colState")),
      this.plainTh(I18n.t("certs.admin.listing.colDerived"), "cell-num"),
    ];
    if (this.targetResolver) head.push(this.plainTh(I18n.t("certs.admin.listing.colTarget")));
    head.push(this.plainTh(I18n.t("lists.chrome.actions"), "cell-actions"));
    tr.append(...head);
    thead.appendChild(tr);
    const labels = CardTable.columnLabels(tr);   // repli en cartes (< 560px) : libellés lus depuis l'en-tête
    const tbody = document.createElement("tbody");
    if (!rows.length) tbody.appendChild(this.emptyRow(head.length));
    else for (const node of rows) { const row = this.buildTreeRow(node); CardTable.labelCells(row, labels); tbody.appendChild(row); }
    table.append(thead, tbody);
    tw.appendChild(table);
    return tw;
  }

  /** Une ligne d'arbre : sélection · cellule ARBRE (chevron + icône de niveau + libellé + compte d'enfants) ·
      type · émetteur · sujet · échéance · état · dérivés (feuilles) · [cible] · actions. */
  private buildTreeRow(node: CertTreeNode<CertificateListItem>): HTMLElement {
    const item = node.item;
    const tr = document.createElement("tr"); tr.className = "row-node";
    // `.open` pilote la rotation CSS du chevron : dépliée si l'utilisateur l'a ouverte OU si on filtre (chemin forcé).
    if (node.children.length && (this.treeFiltering || this.open.has(item.id))) tr.classList.add("open");
    if (this.focusId && item.id === this.focusId) tr.classList.add("row-focus");   // cible d'une focalisation
    tr.appendChild(this.selectRowCell(node));
    tr.appendChild(this.treeCell(node));
    tr.appendChild(this.htmlCell(this.pill(CertsFormat.kindLabel(item.kind), "neutral")));
    tr.appendChild(this.issuerCell(node));
    tr.appendChild(this.subjectCell(item.subject));
    tr.appendChild(this.htmlCell(this.expiryCell(item)));
    tr.appendChild(this.htmlCell(item.revoked_at ? this.pill(I18n.t("certs.admin.listing.revoked"), "err") : CertsAdminView.MUTED));
    tr.appendChild(this.derivedCell(node));
    if (this.targetResolver) tr.appendChild(this.targetCell(item));   // équipement/VM rapproché — colonne présente seulement si résolveur
    // Actions : opérations de clé si déverrouillé (fillActions filtre) + « Déployer la confiance… » pour les AUTORITÉS.
    const actions = document.createElement("td"); actions.className = "cell-actions";   // nowrap + alignées à DROITE (parité ListView)
    this.fillActions(actions, item, node.children.length > 0);
    if (item.kind === "root-ca" || item.kind === "ssh-ca") actions.appendChild(this.iconAction(Icons.TRUST_DEPLOY, I18n.t("certs.admin.listing.deployTitle"), CERT_TIP.trustDeploy, () => this.deployTrustModal(item)));
    tr.appendChild(actions);
    return tr;
  }

  /** Cellule ARBRE (colonne Libellé) : chevron (twisty) indenté selon la profondeur (invisible sur une feuille),
      icône de NIVEAU (racine = bouclier accent · intermédiaire = bouclier info · feuille = cadenas discret), le
      libellé (surligné si la recherche matche + « clé détenue » en title) et un petit compte d'enfants DIRECTS. */
  private treeCell(node: CertTreeNode<CertificateListItem>): HTMLElement {
    const item = node.item;
    const td = document.createElement("td");
    const cell = document.createElement("div"); cell.className = "tree-cell";
    // Chevron : indenté de profondeur × 22px ; sur une feuille, il est présent mais INVISIBLE (alignement conservé).
    const twisty = document.createElement("button"); twisty.type = "button";
    twisty.className = node.children.length ? "twisty" : "twisty leaf";
    twisty.style.setProperty("--ind", (node.depth * 22) + "px");
    const expanded = node.children.length > 0 && (this.treeFiltering || this.open.has(item.id));
    twisty.setAttribute("aria-expanded", expanded ? "true" : "false");
    twisty.setAttribute("aria-label", I18n.t("certs.admin.tree.toggle"));
    twisty.innerHTML = TREE_CHEVRON;
    if (node.children.length) twisty.onclick = (e) => { e.stopPropagation(); this.toggleOpen(item.id); };
    // Icône de NIVEAU — la classe lvl-* portée par la CELLULE colore l'icône (cf. CSS .lvl-root/.lvl-mid/.lvl-leaf).
    const level = CertsAdminView.nodeLevel(node);
    cell.classList.add(level === "root" ? "lvl-root" : level === "mid" ? "lvl-mid" : "lvl-leaf");
    const ic = document.createElement("span"); ic.className = "node-ic"; ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = CertsAdminView.nodeIcon(item.kind);
    // Libellé (surligné) + indication « clé privée détenue » (comme l'ancienne cellule libellé).
    const label = document.createElement("span"); label.className = "node-label";
    this.fillHighlighted(label, item.label);
    if (item.has_key) label.title = I18n.t("certs.admin.listing.keyOwned");
    cell.append(twisty, ic, label);
    // Petit compte d'enfants DIRECTS (repère de densité du sous-arbre).
    if (node.children.length) {
      const cnt = document.createElement("span"); cnt.className = "node-count";
      cnt.textContent = String(node.children.length);
      cnt.title = I18n.t("certs.admin.tree.childrenTitle", { count: node.children.length });
      cell.appendChild(cnt);
    }
    td.appendChild(cell);
    return td;
  }

  /** Cellule ÉMETTEUR : libellé du parent résolu depuis `allItems` (l'arbre COMPLET est chargé) — « — » si racine
      ou parent absent (orphelin toléré). */
  private issuerCell(node: CertTreeNode<CertificateListItem>): HTMLElement {
    const td = document.createElement("td");
    const parentId = node.item.parent_id;
    const label = parentId ? this.allItems.find((c) => c.id === parentId)?.label : "";
    if (label) td.textContent = label;
    else td.innerHTML = CertsAdminView.MUTED;   // racine / émetteur introuvable
    return td;
  }

  /** Cellule DÉRIVÉS : nombre de descendants FEUILLES (certificats terminaux émis SOUS ce nœud), « — » si aucun.
      Colonne numérique (droite, tabulaire). */
  private derivedCell(node: CertTreeNode<CertificateListItem>): HTMLElement {
    const td = document.createElement("td"); td.className = "cell-num";
    const leaves = CertTree.descendants(node).filter((d) => !d.children.length).length;
    if (leaves === 0) td.innerHTML = CertsAdminView.MUTED;
    else td.textContent = String(leaves);
    return td;
  }

  /** Remplit un élément avec `text`, en enveloppant les occurrences du terme recherché dans un `<mark>` (surbrillance).
      Construit par nœuds DOM (aucune interpolation HTML → pas d'échappement à la main). Sans terme → texte simple. */
  private fillHighlighted(el: HTMLElement, text: string): void {
    const query = this.filter.query.trim();
    if (!query) { el.textContent = text; return; }
    const haystack = text.toLowerCase(); const needle = query.toLowerCase();
    let from = 0; let at = haystack.indexOf(needle, from);
    if (at < 0) { el.textContent = text; return; }
    while (at >= 0) {
      if (at > from) el.appendChild(document.createTextNode(text.slice(from, at)));
      const mark = document.createElement("mark"); mark.className = "tree-hl"; mark.textContent = text.slice(at, at + query.length);
      el.appendChild(mark);
      from = at + query.length; at = haystack.indexOf(needle, from);
    }
    if (from < text.length) el.appendChild(document.createTextNode(text.slice(from)));
  }

  /** Niveau d'un nœud pour l'icône : racine (autorité de tête / paire autonome), intermédiaire (CA sous une CA)
      ou feuille (certificat terminal). Mappé par KIND en priorité, repli sur la profondeur/présence d'enfants. */
  private static nodeLevel(node: CertTreeNode<CertificateListItem>): "root" | "mid" | "leaf" {
    const kind = node.item.kind;
    if (kind === "root-ca" || kind === "ssh-ca" || kind === "ssh-keypair") return "root";
    if (kind === "intermediate-ca") return "mid";
    if (kind === "leaf-tls" || kind === "ssh-cert") return "leaf";
    if (node.depth === 0) return "root";   // repli : kind inconnu à la racine
    return node.children.length ? "mid" : "leaf";
  }

  /** Icône de niveau par KIND : BOUCLIER pour une AUTORITÉ (racine X.509/SSH ou CA intermédiaire), CLÉ pour une
      PAIRE SSH autonome (un objet clé, pas une autorité), CERTIFICAT (document scellé) pour un objet ÉMIS (feuille
      TLS / certificat SSH). Repli = certificat. NB : on n'utilise PLUS le cadenas (Icons.LOCK) ici — il prêtait à
      confusion avec le glyphe « Verrouiller » du coffre. La COULEUR reste portée par la classe lvl-* (nodeLevel). */
  private static nodeIcon(kind: string): string {
    if (kind === "root-ca" || kind === "ssh-ca" || kind === "intermediate-ca") return TREE_SHIELD;
    if (kind === "ssh-keypair") return Icons.KEY;
    return Icons.CERTIFICATE;
  }

  /** Cellule « Cible(s) » : le NOM de chaque équipement/VM RAPPROCHÉ, cliquable (ouvre sa fiche de détail —
      aller-retour, patron openTargetDetail), précédé d'une petite icône de famille (équipement/VM) pour le
      contexte + pastille discrète « ambigu » si plusieurs cibles distinctes ; rien si aucune (ou hors mode API :
      `targetResolver` null). Rapprochement CALCULÉ (CertTargetMatch), jamais persisté. */
  private targetCell(item: CertificateListItem): HTMLElement {
    const td = document.createElement("td");
    const resolver = this.targetResolver;
    if (!resolver) return td;   // hors mode API → colonne inerte
    let refs: CertTargetRef[] = [];
    try { refs = resolver.targetsForCert(item); } catch (_) { refs = []; }
    if (!refs.length) return td;   // zéro cible → cellule vide
    const wrap = document.createElement("span"); wrap.style.cssText = "display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap";
    for (const ref of refs) {
      const label = ref.label || ref.id;
      const tip = I18n.t(ref.kind === "vm" ? "certs.admin.target.openVm" : "certs.admin.target.openEquipment", { label });
      // NOM cliquable (au lieu d'un simple bouton-icône) : un clic ouvre la fiche d'info de la cible.
      const link = document.createElement("a");
      link.href = "#"; link.title = tip; link.style.cssText = "cursor:pointer;display:inline-flex;align-items:center;gap:5px";
      const icon = document.createElement("span"); icon.className = "gi"; icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = ref.kind === "vm" ? Icons.VM : Icons.EQUIPMENT;   // icône de famille = repère visuel, pas l'action
      const name = document.createElement("span"); name.textContent = label;
      link.append(icon, name);
      link.onclick = (e) => { e.preventDefault(); resolver.openTarget(ref, () => { /* retour : le listing reste affiché */ }); };
      wrap.appendChild(link);
    }
    if (refs.length > 1) {   // AMBIGUÏTÉ : plusieurs cibles distinctes → pastille discrète (liste en infobulle)
      const pill = document.createElement("span"); pill.className = "pill";
      pill.style.borderColor = "var(--warn)"; pill.style.color = "var(--warn)";
      pill.textContent = I18n.t("certs.admin.target.ambiguous");
      pill.title = refs.map((r) => r.label || r.id).join(", ");
      wrap.appendChild(pill);
    }
    td.appendChild(wrap);
    return td;
  }

  /* ---- Cellules communes ---- */

  private subjectCell(subject: string): HTMLElement {
    const td = document.createElement("td"); td.style.cssText = "font-family:var(--mono);font-size:12px"; td.textContent = subject;
    return td;
  }

  /** En-tête NON triable ; `cls` porte l'alignement de la colonne (ex. « cell-num » à droite, « cell-actions »). */
  private plainTh(text: string, cls = ""): HTMLElement {
    const th = document.createElement("th"); if (cls) th.className = cls; th.textContent = text; return th;
  }

  /** En-tête TRIABLE (CSS ListView : .sortable + .sort-ind ▲/▼) sur le tri CLIENT intra-fratrie (CertTree.sortSiblings).
      Clic : bascule le sens si déjà actif sur cette clé, sinon trie ASC sur elle, puis repeint l'arbre (sans réseau). */
  private sortableTh(text: string, key: "label" | "not_after", cls = ""): HTMLElement {
    const th = document.createElement("th"); th.className = cls ? "sortable " + cls : "sortable"; th.textContent = text;
    if (this.sortKey === key) {
      const ind = document.createElement("span"); ind.className = "sort-ind"; ind.textContent = " " + (this.sortDir === "desc" ? "▼" : "▲");
      th.appendChild(ind);
    }
    th.onclick = () => {
      if (this.sortKey === key) this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
      else { this.sortKey = key; this.sortDir = "asc"; }
      this.session.touch();
      this.refreshTree();
    };
    return th;
  }

  private emptyRow(colspan: number): HTMLElement {
    const tr = document.createElement("tr"); tr.className = "empty-row";
    const td = document.createElement("td"); td.colSpan = colspan;
    td.textContent = this.session.unlocked ? I18n.t("certs.admin.listing.emptyUnlocked") : I18n.t("certs.admin.listing.empty");
    tr.appendChild(td);
    return tr;
  }

  /** Cellule d'échéance COLORÉE (jours restants) — vert > 30 j, orange ≤ 30, rouge ≤ 7/expiré, « — » sans date. */
  private expiryCell(item: CertificateListItem): string {
    const cls = CertsFormat.expiryClass(item.not_after);
    const color = cls === "ok" ? "var(--ok)" : cls === "warn" ? "var(--warn)" : cls === "err" ? "var(--err)" : "var(--fg-dimmer)";
    const title = item.not_after ? Format.dateTime(item.not_after) : "";
    return `<span style="color:${color}" title="${Html.escape(title)}">${Html.escape(CertsFormat.expiryLabel(item.not_after))}</span>`;
  }

  /** Boutons d'action d'une ligne : émission (CA), export, révocation, suppression — tous en ICÔNE
      (listes denses), la mini-doc de chacun vivant dans son tooltip enrichi (CERTS_TIPS).
      NB : l'export PAR LIGNE a un libellé STATIQUE → il devient une icône sans rien perdre. C'est
      l'export GROUPÉ (barre de sélection) qui garde son texte : SON libellé est dynamique et porte
      une garantie de sécurité (« Exporter publics (ZIP) » = aucune clé privée).

      VERROUILLÉ : seule l'ÉMISSION disparaît — elle exige la clé privée de la CA pour signer.
      Export (publics seuls), révocation et suppression restent offerts : ce sont des opérations de
      MÉTADONNÉES, aucun secret n'est déchiffré. C'est ce qui rend une PKI dont la phrase secrète est
      perdue encore consultable ET PURGEABLE, comme le promet docs/certs.md. */
  private fillActions(cell: HTMLElement, item: CertificateListItem, hasChildren = false): void {
    const unlocked = this.session.unlocked;
    // Détail (lecture seule) : disponible EN PERMANENCE (même verrouillé / révoqué) — aucune clé, aucune écriture.
    cell.appendChild(IconButton.build({ icon: Icons.INFO, label: I18n.t("certs.admin.actions.info"), onClick: () => this.infoModal(item) }));
    // Émettre une FEUILLE TLS : une CA X.509, racine OU intermédiaire, peut signer une feuille (leafModal ne
    // présuppose aucune racine — il prend n'importe quelle CA X.509 comme émetteur).
    if (unlocked && (item.kind === "root-ca" || item.kind === "intermediate-ca") && !item.revoked_at) cell.appendChild(this.iconAction(Icons.ISSUE_TLS, I18n.t("certs.admin.actions.issueTls"), CERT_TIP.issueTls, () => this.leafModal(item)));
    // Émettre une SOUS-CA (CA intermédiaire) : une CA X.509 (racine OU intermédiaire) peut signer une autre CA.
    // L'émission est CONTEXTUELLE (ce nœud EST l'émetteur) — pas de tooltip enrichi, le title/aria-label suffit.
    if (unlocked && (item.kind === "root-ca" || item.kind === "intermediate-ca") && !item.revoked_at) cell.appendChild(this.iconAction(Icons.ISSUE_CA, I18n.t("certs.admin.actions.issueCa"), "", () => this.intermediateCaModal(item)));
    if (unlocked && item.kind === "ssh-ca" && !item.revoked_at) cell.appendChild(this.iconAction(Icons.ISSUE_SSH, I18n.t("certs.admin.actions.issueSsh"), CERT_TIP.issueSsh, () => this.sshCertModal(item)));
    // RENOUVELLEMENT unitaire (mode 1) — feuille TLS / certificat SSH.
    if (unlocked && (item.kind === "leaf-tls" || item.kind === "ssh-cert") && !item.revoked_at) cell.appendChild(this.iconAction(Icons.RENEW, I18n.t("certs.admin.actions.renew"), CERT_TIP.renew, () => void this.renewModal(item)));
    // RENOUVELLEMENT d'une CA racine (opération de masse : prolonger / rotation de clé + enfants).
    if (unlocked && item.kind === "root-ca" && !item.revoked_at) cell.appendChild(this.iconAction(Icons.RENEW, I18n.t("certs.admin.actions.renewCa"), CERT_TIP.renew, () => void this.renewCaDialog(item)));
    if (!item.revoked_at) cell.appendChild(this.iconAction(Icons.EXPORT, I18n.t("certs.admin.actions.exportArtifacts"), CERT_TIP.export, () => void this.exportModal(item)));
    if (!item.revoked_at) cell.appendChild(this.iconAction(Icons.REVOKE, I18n.t("certs.admin.actions.revoke"), CERT_TIP.revoke, () => void this.revoke(item)));
    // Suppression : VERROUILLÉE (bouton grisé) si des dérivés existent — le serveur la refuse de toute façon
    // (409 has_children, contrainte d'INTÉGRITÉ que `?force=true` ne lève pas). Mieux vaut un bouton désactivé
    // avec un tooltip explicite qu'un 409 encaissé à l'usage. Un tooltip riche est inutile ici : le title suffit.
    if (hasChildren) {
      cell.appendChild(IconButton.build({ icon: Icons.DELETE, label: I18n.t("certs.admin.actions.deleteHasChildren"), danger: true, disabled: true }));
    } else {
      cell.appendChild(this.iconAction(Icons.DELETE, I18n.t("ui.action.delete"), CERT_TIP.remove, () => void this.remove(item), true));
    }
  }

  /** Bouton d'action ICÔNE — délègue au constructeur PARTAGÉ (ui/IconButton) : un seul point de
      fabrication pour toute l'app, donc un seul style et des règles d'a11y impossibles à oublier. */
  private iconAction(icon: string, ariaLabel: string, tipKey: string, onClick: () => void, danger = false): HTMLButtonElement {
    return IconButton.build({ icon, label: ariaLabel, tipKey, danger, onClick });
  }

  /** Modale d'INFO (lecture seule) : métadonnées d'un certificat/clé pour consultation + copie (sujet, émetteur
      EN CLAIR, numéro de série, empreinte, émission/échéance, algo, SAN, dates). N'expose AUCUN secret
      (`key_enc` jamais chargé — l'item de listing suffit). Disponible même coffre VERROUILLÉ (rien à déchiffrer). */
  private infoModal(item: CertificateListItem, reopen?: () => void): void {
    const root = document.createElement("div");
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;align-items:baseline";
    const add = (label: string, valueHtml: string): void => {
      const dt = document.createElement("div"); dt.style.cssText = "color:var(--fg-dim);font-weight:600;white-space:nowrap"; dt.textContent = label;
      const dd = document.createElement("div"); dd.style.wordBreak = "break-word"; dd.innerHTML = valueHtml;
      grid.append(dt, dd);
    };
    // Variante NŒUD : pour une valeur qui porte un comportement (lien vers le certificat d'origine) — pas de HTML
    // interpolé, donc pas d'échappement à la main.
    const addNode = (label: string, node: HTMLElement): void => {
      const dt = document.createElement("div"); dt.style.cssText = "color:var(--fg-dim);font-weight:600;white-space:nowrap"; dt.textContent = label;
      const dd = document.createElement("div"); dd.style.wordBreak = "break-word"; dd.appendChild(node);
      grid.append(dt, dd);
    };
    // Variante avec bouton COPIER : valeur monospace + icône → presse-papiers (toast via Clipboard). Pour les
    // identifiants techniques qu'on recolle ailleurs (empreinte, n° de série, sujet/DN). Valeur vide → « — » simple.
    const addCopy = (label: string, value: string, copiedKey: string): void => {
      if (!value) { add(label, "—"); return; }
      const wrap = document.createElement("div"); wrap.style.cssText = "display:flex;align-items:flex-start;gap:8px";
      const val = document.createElement("span"); val.style.cssText = "font-family:var(--mono);font-size:12px;word-break:break-all;flex:1 1 auto;min-width:0"; val.textContent = value;
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn btn-ghost btn-sm icon-action"; btn.style.flex = "none";
      btn.title = I18n.t("certs.admin.info.copy"); btn.setAttribute("aria-label", I18n.t("certs.admin.info.copy")); btn.innerHTML = Icons.CLONE;
      btn.onclick = () => { void Clipboard.copy(value, I18n.t(copiedKey)); };
      wrap.append(val, btn);
      addNode(label, wrap);
    };
    // Émetteur résolu depuis l'arbre COMPLET (allItems) : plus de portée de page — le libellé du parent est
    // toujours disponible (repli id court si orphelin toléré). « — » pour une racine (parent_id nul).
    const issuerName = item.parent_id
      ? (this.allItems.find((c) => c.id === item.parent_id)?.label || CertsFormat.shortId(item.parent_id))
      : "—";
    const sans = Array.isArray(item.sans) ? item.sans : [];

    add(I18n.t("lists.col.type"), this.pill(CertsFormat.kindLabel(item.kind), "neutral") + (item.revoked_at ? " " + this.pill(I18n.t("certs.admin.listing.revoked"), "err") : ""));
    add(I18n.t("certs.admin.listing.colLabel"), Html.escape(item.label || "—"));
    addCopy(I18n.t("certs.admin.listing.colSubject"), item.subject || "", "certs.admin.info.copiedSubject");
    add(I18n.t("certs.admin.listing.colIssuer"), Html.escape(issuerName));
    addCopy(I18n.t("certs.admin.info.serial"), item.serial || "", "certs.admin.info.copiedSerial");
    addCopy(I18n.t("certs.admin.info.fingerprint"), item.fingerprint || "", "certs.admin.info.copiedFingerprint");
    add(I18n.t("certs.admin.info.algo"), Html.escape(item.key_algo || "—"));
    add(I18n.t("certs.admin.listing.colIssued"), item.not_before ? Html.escape(Format.dateTime(item.not_before)) : "—");
    add(I18n.t("certs.admin.listing.colExpiry"), this.expiryCell(item));
    add(I18n.t("certs.admin.info.sans"), sans.length ? sans.map((s) => this.pill(s.san_type + " · " + s.value, "neutral")).join(" ") : "—");
    add(I18n.t("certs.admin.info.keyOwned"), item.has_key ? I18n.t("certs.admin.info.yes") : I18n.t("certs.admin.info.no"));
    if (item.revoked_at) {
      add(I18n.t("certs.admin.listing.revoked"), Html.escape(Format.dateTime(item.revoked_at)));
      add(I18n.t("certs.admin.info.revocationReason"), Html.escape(CertsAdminView.revocationReasonText(item.revocation_reason)));
    }
    // Lignée : lien vers le certificat d'ORIGINE (aller-retour — sa fiche revient ICI à sa fermeture). L'original
    // peut être hors de la page courante → on le charge à la demande (getOne). Orphelin toléré (repli sur l'id).
    if (item.renewed_from) {
      const link = document.createElement("a"); link.href = "#"; link.style.cursor = "pointer";
      link.textContent = I18n.t("certs.admin.info.viewOriginal");
      link.onclick = (e) => { e.preventDefault(); void this.openCertInfoById(item.renewed_from!, () => this.infoModal(item)); };
      addNode(I18n.t("certs.admin.info.renewedFrom"), link);
    }
    if (item.cross_signed_pem) add(I18n.t("certs.admin.info.crossSigned"), I18n.t("certs.admin.info.crossSignedYes"));
    add(I18n.t("certs.admin.info.comment"), item.comment ? Html.escape(item.comment) : "—");
    add(I18n.t("certs.admin.info.created"), Html.escape(Format.dateTime(item.created_date)));
    add(I18n.t("certs.admin.info.updated"), Html.escape(Format.dateTime(item.updated_date)));
    // Édition du commentaire depuis la fiche (aller-retour : la fiche revient à la fermeture de l'éditeur).
    const acts = document.createElement("div"); acts.style.cssText = "margin-top:14px;display:flex;justify-content:flex-end";
    acts.appendChild(this.actionButton(I18n.t("certs.admin.meta.edit"), I18n.t("certs.admin.meta.editTitle"), () => this.metadataModal(item, () => this.infoModal(item, reopen))));
    root.append(grid, acts);
    // `reopen` (aller-retour) : présent quand cette fiche a été ouverte DEPUIS une autre (lignée) → on y revient
    // à la fermeture. Absent pour une ouverture directe (onClose null).
    this.host.openModal({ title: I18n.t("certs.admin.info.title"), subtitle: Html.escape(item.label), body: root, hideFooter: true, onClose: reopen });
  }

  /** Libellé lisible d'une raison de révocation stockée (code normé + note). Statique/pur côté données ;
      I18n.t est appliqué ici. Repli « — » si aucune raison. */
  private static revocationReasonText(stored: string | null | undefined): string {
    const { code, note } = RevocationReasons.decode(stored);
    const codeLabel = code && RevocationReasons.LABEL_KEY[code] ? I18n.t(RevocationReasons.LABEL_KEY[code]) : "";
    const text = [codeLabel, note].filter((s) => s !== "").join(" — ");
    return text || "—";
  }

  /** Ouvre la fiche INFO d'un certificat par son id (lignée). Charge ses métadonnées (getOne, aucun secret
      requis pour la fiche), puis affiche AVEC aller-retour (`reopen` = fiche d'origine à la fermeture).
      Certificat introuvable (original supprimé — orphelin toléré) → toast neutre, on rouvre la fiche d'origine. */
  private async openCertInfoById(id: string, reopen: () => void): Promise<void> {
    try {
      const detail = await this.client!.getOne(id);
      this.infoModal(detail, reopen);
    } catch (_) {
      Notify.toast(I18n.t("certs.admin.info.originalGone"), "warn");
      reopen();
    }
  }

  /** Éditeur des MÉTADONNÉES d'un certificat (LABEL d'affichage + COMMENTAIRE libre) — modale standard (principe
      n°11). Le label est modifiable APRÈS génération (il peut différer du CN, lequel vit dans le SUJET du certificat
      et n'est PAS modifiable). Enregistre via une mise à jour de métadonnées (metadataInput → save, key_enc conservé).
      `reopen` = aller-retour vers la fiche d'origine à la fermeture (appelé depuis la fiche INFO). */
  private metadataModal(item: CertificateListItem, reopen?: () => void): void {
    const root = document.createElement("div");
    const labelI = FormControls.text(item.label || "", I18n.t("certs.admin.common.labelPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.labelField"), labelI, I18n.t("certs.admin.meta.labelHint")));
    const ta = FormControls.textArea(item.comment || "");
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.info.comment"), ta, I18n.t("certs.admin.comment.hint")));
    const errBox = this.errBox(); root.appendChild(errBox);
    this.host.openModal({
      title: I18n.t("certs.admin.meta.title"), subtitle: Html.escape(item.label), body: root, onClose: reopen,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const label = labelI.value.trim();
        if (label === "") { this.showError(errBox, I18n.t("certs.admin.common.labelRequired")); return false; }
        try {
          const comment = ta.value.trim() === "" ? null : ta.value.trim();
          await this.client!.save(item.id, CertsAdminView.metadataInput(item, { label, comment }));
          item.label = label; item.comment = comment;   // objet capturé mis à jour → la fiche rouverte (aller-retour) montre les nouvelles valeurs
          Notify.toast(I18n.t("certs.admin.meta.toast"), "ok");
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /* --------------------------------------------------------------------------
     SÉLECTION MULTIPLE & ACTIONS GROUPÉES (L4) — cases par ligne + case d'en-tête,
     barre d'actions COMMUNES (intersection via BulkActions), exports ZIP (CertZip),
     révocation/suppression en masse avec BILAN systématique. La sélection vit en
     mémoire d'instance et survit page/tri/filtre (cf. `selection`).
     -------------------------------------------------------------------------- */

  /** Items des lignes VISIBLES (résultat aplati/filtré du dernier rendu) — base de la case « toute la page » et de
      la case d'en-tête (elles portent sur les lignes AFFICHÉES ; la cascade cochant un nœud touche, elle, tout son
      sous-arbre — cf. toggleSelect). */
  private currentPageItems(): CertificateListItem[] {
    return this.visibleItems;
  }

  /** Instantané minimal mémorisé pour un élément coché (suffit aux actions communes + bilan). */
  private snapshotOf(item: CertificateListItem): CertSelectionSnapshot {
    return { kind: item.kind, label: item.label, has_key: item.has_key, revoked_at: item.revoked_at, not_after: item.not_after };
  }

  /** En-tête de la colonne de sélection : case « toute la page » (cochée/indéterminée synchronisée après coup). */
  private selectHeaderCell(): HTMLElement {
    const th = document.createElement("th"); th.style.width = "1%";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.title = I18n.t("certs.admin.select.headerAll");
    cb.onclick = () => this.toggleSelectAll(cb.checked);
    this.headerCheckbox = cb;
    th.appendChild(cb);
    return th;
  }

  /** Cellule de sélection d'une ligne : case reflétant l'état de sélection de SON SOUS-ARBRE (data-cert-id pour
      la synchro « toute la page » / « effacer » / cascade). Reçoit le NŒUD (et non le seul item) : cocher cascade
      sur tout son sous-arbre. L'état exact (coché / indéterminé) est posé juste après par `syncRowCheckboxes`
      (appelé par `refreshSelectionUi`, lui-même invoqué à la fin de `paintBody`) — l'affectation initiale n'est
      qu'un point de départ. */
  private selectRowCell(node: CertTreeNode<CertificateListItem>): HTMLElement {
    const item = node.item;
    const td = document.createElement("td"); td.style.width = "1%";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.setAttribute("data-cert-id", item.id);
    cb.checked = this.selection.has(item.id);   // état de départ (raffiné en coché/indéterminé par syncRowCheckboxes)
    cb.title = I18n.t("certs.admin.select.rowSelect", { label: item.label });
    cb.onclick = () => this.toggleSelect(node, cb.checked);
    td.appendChild(cb);
    return td;
  }

  /** Coche/décoche un nœud EN CASCADE : le nœud LUI-MÊME + tous ses descendants (`CertTree.descendants`) — on
      sélectionne ainsi une CA et son sous-arbre entier d'un geste (export / révocation / suppression groupés ;
      les actions groupées gèrent déjà les refus par élément, ex. un émetteur à enfants). Met à jour l'instantané
      de chaque nœud touché, puis re-synchronise TOUTES les cases visibles (les descendants suivent, les ancêtres
      passent à l'état indéterminé le cas échéant) + la barre + la case d'en-tête. */
  private toggleSelect(node: CertTreeNode<CertificateListItem>, checked: boolean): void {
    this.session.touch();
    for (const n of [node, ...CertTree.descendants(node)]) {
      if (checked) this.selection.set(n.item.id, this.snapshotOf(n.item)); else this.selection.delete(n.item.id);
    }
    this.refreshSelectionUi();
  }

  /** Coche/décoche TOUTES les lignes VISIBLES (case d'en-tête = « toute la page/vue »). Sémantique À PLAT sur les
      lignes affichées (pas de cascade ici : les descendants visibles sont déjà des lignes de la page ; un parent
      REPLIÉ voit ses descendants cachés non touchés — cohérent avec l'en-tête qui ne parle que du visible). Les
      cases DOM (dont l'état indéterminé) sont resynchronisées par `syncRowCheckboxes` via `refreshSelectionUi`. */
  private toggleSelectAll(checked: boolean): void {
    this.session.touch();
    for (const item of this.currentPageItems()) {
      if (checked) this.selection.set(item.id, this.snapshotOf(item)); else this.selection.delete(item.id);
    }
    this.refreshSelectionUi();
  }

  /** Vide la sélection (bouton « Effacer » et après une action groupée). Les cases visibles sont décochées par
      `syncRowCheckboxes` (via `refreshSelectionUi`). */
  private clearSelection(): void {
    this.selection.clear();
    this.refreshSelectionUi();
  }

  /** Repeint la barre de sélection, resynchronise les cases de LIGNE (coché/indéterminé selon l'état du sous-arbre)
      et la case d'en-tête — sans reconstruire la table. Point de passage UNIQUE de toute variation de sélection. */
  private refreshSelectionUi(): void {
    this.syncRowCheckboxes();
    this.renderSelectionBar();
    this.syncHeaderCheckbox();
  }

  /** Pose l'état COCHÉ/INDÉTERMINÉ de chaque case de LIGNE visible depuis l'état de `selection` et la structure de
      la forêt : pour un nœud à enfants, `checked` si tout son sous-arbre est sélectionné, `indeterminate` si une
      partie seulement (calcul PUR `CertTree.selectionStateOf`) ; une feuille reflète juste son appartenance. On
      parcourt les cases réellement présentes dans le corps (`input[data-cert-id]`), retrouvant leur nœud par id. */
  private syncRowCheckboxes(): void {
    if (!this.bodyEl) return;
    this.bodyEl.querySelectorAll("input[data-cert-id]").forEach((el) => {
      const cb = el as HTMLInputElement;
      const id = cb.getAttribute("data-cert-id") || "";
      const node = this.findNode(id);
      if (!node) { cb.checked = this.selection.has(id); cb.indeterminate = false; return; }   // nœud absent → appartenance simple
      const state = CertTree.selectionStateOf(node, this.selection);
      cb.checked = state === "all";
      cb.indeterminate = state === "partial";
    });
  }

  /** Synchronise la case « toute la page » : cochée si tous les éléments de la page sont sélectionnés,
      INDÉTERMINÉE si une partie seulement, décochée si aucun. */
  private syncHeaderCheckbox(): void {
    if (!this.headerCheckbox) return;
    const items = this.currentPageItems();
    const onPage = items.filter((it) => this.selection.has(it.id)).length;
    this.headerCheckbox.checked = items.length > 0 && onPage === items.length;
    this.headerCheckbox.indeterminate = onPage > 0 && onPage < items.length;
  }

  /** (Re)construit la barre d'actions groupées : « N sélectionné(s) » + actions COMMUNES (intersection
      calculée par BulkActions selon les snapshots et l'état de session) + « Effacer la sélection ». Masquée
      quand la sélection est vide. */
  private renderSelectionBar(): void {
    if (!this.selBarEl) return;
    this.selBarEl.replaceChildren();
    const n = this.selection.size;
    if (n === 0) { this.selBarEl.style.display = "none"; return; }
    this.selBarEl.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 8px;padding:8px 10px;border:1px solid var(--accent);border-radius:6px;background:color-mix(in srgb, var(--accent) 8%, transparent)";
    const count = document.createElement("span"); count.style.cssText = "font-weight:600;color:var(--fg)";
    count.textContent = I18n.t("certs.admin.select.selected", { count: n });
    this.selBarEl.appendChild(count);

    const av = BulkActions.commonActions([...this.selection.values()], this.session.unlocked);
    // « Exporter » GARDE SON TEXTE : son libellé est dynamique et porte une garantie de sécurité
    // (« Exporter publics (ZIP) » = aucune clé privée n'entrera dans l'archive) — une icône la perdrait.
    if (av.canExport) this.selBarEl.appendChild(this.actionButton(av.exportLabel, I18n.t("certs.admin.select.exportTitle"), () => this.bulkExportDialog(), "btn-primary"));
    // Le compteur n'est PAS répété sur les boutons : le span « N sélectionné(s) » ci-dessus le dit déjà.
    if (av.canRenew) this.selBarEl.appendChild(this.iconAction(Icons.RENEW, I18n.t("certs.admin.select.renewSelection"), CERT_TIP.renew, () => void this.bulkRenewDialog()));
    if (av.canRevoke) this.selBarEl.appendChild(this.iconAction(Icons.REVOKE, I18n.t("certs.admin.select.revokeSelection"), CERT_TIP.revoke, () => void this.bulkRevoke()));
    if (av.canDelete) this.selBarEl.appendChild(this.iconAction(Icons.DELETE, I18n.t("certs.admin.select.deleteSelection"), CERT_TIP.remove, () => void this.bulkDelete(), true));
    this.selBarEl.appendChild(this.actionButton(I18n.t("certs.admin.select.clearSelection"), I18n.t("certs.admin.select.clearSelectionTitle"), () => this.clearSelection()));
  }

  /* ---- Actions groupées (N appels unitaires séquentiels — pas de route bulk serveur en v1) ---- */

  /** DIALOGUE d'export groupé (modale, principe n°11) — remplace le déclenchement direct. Propose de COCHER
      les catégories d'artefacts COMMUNES à la sélection (BulkActions.exportChoices : uniquement celles qui ont
      du sens pour tous les non-révoqués) et, en option, un MOT DE PASSE (deux champs) pour protéger l'archive
      en AES-256. À la validation : assemble le ZIP filtré et le télécharge (runBulkExport). Le mot de passe
      n'est ni stocké ni journalisé (il ne vit que le temps de dériver la clé AES). */
  private bulkExportDialog(): void {
    this.session.touch();
    const snaps = [...this.selection.values()];
    const n = snaps.length;
    const choices = BulkActions.exportChoices(snaps, this.session.unlocked);
    const available = choices.filter((c) => c.available);   // public l'est toujours → le dialogue s'ouvre au moins pour le mot de passe
    const part = BulkActions.partitionExport([...this.selection.entries()].map(([id, s]) => ({ id, revoked_at: s.revoked_at })));

    const root = document.createElement("div");
    const intro = document.createElement("div"); intro.className = "form-hint"; intro.style.marginBottom = "10px";
    intro.textContent = I18n.t("certs.admin.bulk.exportIntro");
    root.appendChild(intro);

    // Note d'exclusion : les révoqués ne sont jamais emballés (décision Q4). Affichée seulement s'il y en a.
    if (part.excludedRevoked.length) {
      const r = part.excludedRevoked.length;
      const note = document.createElement("div"); note.className = "form-hint"; note.style.cssText = "margin-bottom:10px;color:var(--warn)";
      note.textContent = I18n.t("certs.admin.bulk.excludedRevoked", { count: r });
      root.appendChild(note);
    }

    // Cases à cocher des catégories DISPONIBLES (tout coché par défaut, cf. cadrage).
    const checks = new Map<ExportCategoryKey, HTMLInputElement>();
    const catBox = document.createElement("div"); catBox.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:12px";
    const catTitle = document.createElement("div"); catTitle.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:2px";
    catTitle.textContent = I18n.t("certs.admin.bulk.catTitle");
    catBox.appendChild(catTitle);
    for (const c of available) {
      const lab = document.createElement("label"); lab.style.cssText = "display:flex;gap:8px;align-items:center;cursor:pointer";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true;
      const span = document.createElement("span"); span.textContent = c.label;
      lab.append(cb, span); catBox.appendChild(lab); checks.set(c.key, cb);
    }
    // Catégories indisponibles UNIQUEMENT à cause du VERROU (lockedOnly) : GRISÉES plutôt que cachées — l'option
    // existe, déverrouiller la session la rend cochable. Les indisponibilités STRUCTURELLES (catégorie sans sens
    // pour cette sélection) restent, elles, cachées.
    for (const c of choices.filter((x) => !x.available && x.lockedOnly)) {
      const lab = document.createElement("label"); lab.style.cssText = "display:flex;gap:8px;align-items:center;opacity:0.45;cursor:not-allowed";
      lab.title = I18n.t("certs.admin.export.lockedHint");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = false; cb.disabled = true;
      const span = document.createElement("span"); span.textContent = c.label;
      lab.append(cb, span); catBox.appendChild(lab);
    }
    root.appendChild(catBox);

    // Mot de passe OPTIONNEL (deux champs) : vides = ZIP en clair ; renseigné = AES-256 (WinZip AE-2).
    const p1 = FormControls.text("", I18n.t("certs.admin.bulk.passOptionalPlaceholder")); p1.type = "password"; p1.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.bulk.passOptional"), p1, I18n.t("certs.admin.bulk.passOptionalHint")));
    const p2 = FormControls.text("", I18n.t("certs.admin.bulk.passConfirmPlaceholder")); p2.type = "password"; p2.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.bulk.passConfirm"), p2, I18n.t("certs.admin.bulk.passConfirmHint")));

    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: I18n.t("certs.admin.bulk.exportZipTitle", { count: n }),
      body: root,
      saveLabel: I18n.t("certs.admin.bulk.exportBtn"),
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const selected = new Set<ExportCategoryKey>();
        for (const [key, cb] of checks) if (cb.checked) selected.add(key);
        if (selected.size === 0) { this.showError(errBox, I18n.t("certs.admin.bulk.noCategory")); return false; }
        // Mot de passe : deux vides = pas de chiffrement ; non identiques = erreur ; non vide = AES-256.
        const pass = p1.value;
        if (pass !== "" && pass !== p2.value) { this.showError(errBox, I18n.t("certs.admin.bulk.passMismatch")); return false; }
        try {
          await this.runBulkExport(selected, pass !== "" ? pass : null);
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => p1.focus(), 30);
  }

  /** EXÉCUTION de l'export ZIP groupé : un dossier par certificat, bundle FILTRÉ par catégories cochées (bundle
      selon kind). Les RÉVOQUÉS sont EXCLUS et signalés ; les clés privées ne sont déchiffrées/incluses que si la
      catégorie « key » est cochée ET la session déverrouillée. Les chaînes (fullchain/ca-chain) sont résolues
      via une liste COMPLÈTE chargée UNE fois ; les clés déchiffrées LOCALEMENT via GET unitaire, N fois
      (séquentiel). Avec `password` → archive AES-256 (zip.js) ; sans → ZIP en clair (fflate). Bilan systématique
      en fin (le mot de passe n'y figure JAMAIS). */
  private async runBulkExport(categories: Set<ExportCategoryKey>, password: string | null): Promise<void> {
    // Clés privées incluses SEULEMENT si « key » coché ET session déverrouillée (sinon rien à déchiffrer).
    const withKeys = categories.has("key") && this.session.unlocked;
    const ids = [...this.selection.keys()];
    const part = BulkActions.partitionExport(ids.map((id) => ({ id, revoked_at: this.selection.get(id)!.revoked_at })));

    // Liste COMPLÈTE (métadonnées, sans key_enc) : résolution des chaînes d'émission + lecture du public_pem/kind
    // des éléments sélectionnés (qui ne sont pas forcément tous sur la page affichée).
    const allItems: CertificateListItem[] = await this.client!.list();
    const all: CertExportRecord[] = allItems.map((c) => CertsAdminView.toExportRecord(c));
    const byId = new Map(allItems.map((c) => [c.id, c] as const));

    const entries: Array<{ folder: string; artifacts: ExportArtifact[] }> = [];
    const errors: Array<{ label: string; reason: string }> = [];
    let done = 0;
    for (const id of part.included) {
      const snap = this.selection.get(id)!;
      const item = byId.get(id);
      if (!item) { errors.push({ label: snap.label, reason: I18n.t("certs.admin.bulk.notFound") }); continue; }
      try {
        const keyPem = (withKeys && item.has_key) ? await this.decryptKey(id) : null;   // clé déchiffrée LOCALEMENT
        const rec: CertBundleRecord = { id: item.id, label: item.label, parent_id: item.parent_id, public_pem: item.public_pem, revoked_at: item.revoked_at, kind: item.kind, subject: item.subject };
        const artifacts = await CertZip.bundleFor(rec, all, keyPem, categories);
        if (artifacts.length) { entries.push({ folder: item.label, artifacts }); done++; }
        else errors.push({ label: item.label, reason: I18n.t("certs.admin.bulk.noArtifact") });
      } catch (e) { errors.push({ label: snap.label, reason: CertsAdminView.errText(e) }); }
    }

    if (entries.length) {
      // Avec mot de passe → ZIP chiffré AES-256 (zip.js, async) ; sinon → ZIP en clair (fflate, sync).
      const zip = password ? await CertZip.zipArtifactsEncrypted(entries, password) : CertZip.zipArtifacts(entries);
      Download.data("certificats-" + CertsAdminView.stamp() + ".zip", zip, "application/zip");
    }
    // BILAN : réussis, exclus (révoqués), en erreur — construit AVANT de vider la sélection (labels lus depuis elle).
    const encNote = password ? I18n.t("certs.admin.bulk.encNote") : "";
    const lines = [
      entries.length
        ? I18n.t("certs.admin.bulk.exportedCount", { count: done }) + (withKeys ? I18n.t("certs.admin.bulk.exportedWithKeys") : I18n.t("certs.admin.bulk.exportedPublicOnly")) + encNote
        : I18n.t("certs.admin.bulk.exportEmpty"),
      ...part.excludedRevoked.map((id) => I18n.t("certs.admin.bulk.excludedLine", { label: this.selection.get(id)?.label || id })),
      ...errors.map((e) => I18n.t("certs.admin.bulk.errorLine", { label: e.label, reason: e.reason })),
    ];
    this.showBulkSummary(I18n.t("certs.admin.bulk.sumExport"), lines);
    this.clearSelection();   // aucune donnée modifiée : on vide simplement la sélection (cadrage §5)
  }

  /** RÉVOCATION groupée : confirmation, puis N PUT (revoked_at=now, key_enc conservé). Une liste complète
      fournit les métadonnées à re-soumettre (le PUT exige le corps complet ; key_enc absent = conservé). Bilan. */
  private async bulkRevoke(): Promise<void> {
    this.session.touch();
    const ids = [...this.selection.keys()];
    const n = ids.length;
    // UNE raison saisie pour tout le lot (D3 du cadrage) — appliquée à chaque révocation.
    const reason = await this.revocationReasonDialog(I18n.t("certs.admin.bulk.revokeTitle", { count: n }), I18n.t("certs.admin.bulk.revokeMessage"));
    if (reason === null) return;

    let allItems: CertificateListItem[];
    try { allItems = await this.client!.list(); }
    catch (e) { this.actionError(e); return; }
    const byId = new Map(allItems.map((c) => [c.id, c] as const));
    const now = new Date().toISOString();
    const errors: Array<{ label: string; reason: string }> = [];
    let done = 0;
    for (const id of ids) {
      const snap = this.selection.get(id)!;
      const item = byId.get(id);
      if (!item) { errors.push({ label: snap.label, reason: I18n.t("certs.admin.bulk.notFound") }); continue; }
      if (item.revoked_at) { errors.push({ label: item.label, reason: I18n.t("certs.admin.bulk.alreadyRevoked") }); continue; }
      try { await this.client!.save(id, CertsAdminView.metadataInput(item, { revoked_at: now, revocation_reason: reason })); done++; }
      catch (e) { errors.push({ label: item.label, reason: CertsAdminView.errText(e) }); }
    }
    this.showBulkSummary(I18n.t("certs.admin.bulk.sumRevoke"), [
      I18n.t("certs.admin.bulk.revokedCount", { count: done }),
      ...errors.map((e) => I18n.t("certs.admin.bulk.errorLine", { label: e.label, reason: e.reason })),
    ]);
    this.clearSelection();
    await this.refreshBody();
  }

  /** Ré-émet une FEUILLE TLS à l'identique de `item` (renouvellement), signée par `ca` (déchiffrée en `caKeyPem`),
      pour `days` jours (déjà rognés au plafond de la CA par l'appelant) : nouveau certificat (nouvelle paire,
      `renewed_from` = item.id), puis révocation « superseded » de l'ancien. Partagé par le lot ET le renouvellement
      de CA (phase 5). Le sujet/usage/algo/SAN sont repris des MÉTADONNÉES de `item` (usage lu du PEM). */
  private async reissueLeafRenewal(item: CertificateListItem, ca: CertificateDetail, caKeyPem: string, days: number): Promise<void> {
    const commonName = CertsAdminView.parseDnField(item.subject, "CN") || item.label;
    const organization = CertsAdminView.parseDnField(item.subject, "O") || undefined;
    const organizationalUnit = CertsAdminView.parseDnField(item.subject, "OU") || undefined;
    const keyAlgo = (["ec-p256", "rsa-2048", "rsa-4096"] as string[]).includes(item.key_algo) ? item.key_algo as X509KeyAlgo : "ec-p256";
    const usage = X509Factory.readLeafUsage(item.public_pem || "");
    const sans = (item.sans || []).filter((s) => s.san_type === "dns" || s.san_type === "ip" || s.san_type === "email");
    const gen = await X509Factory.issueLeaf({
      caCertPem: ca.public_pem || "", caPrivateKeyPkcs8Pem: caKeyPem,
      commonName, organization, organizationalUnit, keyAlgo, days, sans: sans as X509San[], usage,
    });
    const keyEnc = await PkiCrypto.encryptSecret(this.session.key, gen.privateKeyPkcs8Pem);
    await this.client!.save(CertsAdminView.newId(), {
      // renouvellement : on PRÉSERVE le label (métadonnée d'affichage, possiblement ≠ CN) — le sujet, lui, suit le CN.
      kind: "leaf-tls", parent_id: ca.id, label: item.label, subject: CertsAdminView.subjectDn(commonName, organization, organizationalUnit),
      serial: gen.serial, not_before: gen.notBefore, not_after: gen.notAfter, fingerprint: gen.fingerprintSha256,
      key_algo: keyAlgo, public_pem: gen.certPem, key_enc: keyEnc, revoked_at: null, sans, renewed_from: item.id,
    });
    await this.revokeSuperseded(item);
  }

  /** RENOUVELLEMENT GROUPÉ (mode 2) : modale ne demandant QUE la durée, appliquée à toutes les feuilles TLS
      sélectionnées (chaque durée rognée au plafond de sa CA). Ré-émission à l'identique (sujet/SAN/usage/algo
      d'origine), l'ancien révoqué. Clés de CA déchiffrées UNE fois par CA (cache). Bilan systématique. */
  private async bulkRenewDialog(): Promise<void> {
    this.session.touch();
    const n = this.selection.size;
    const root = document.createElement("div");
    const intro = document.createElement("div"); intro.className = "form-hint"; intro.style.marginBottom = "10px";
    intro.textContent = I18n.t("certs.admin.bulk.renewIntro", { count: n });
    const days = FormControls.number(397, { min: 1, step: 1 });
    const errBox = this.errBox();
    root.append(intro, FormControls.fieldRow(I18n.t("certs.admin.common.validityDays"), days, I18n.t("certs.admin.bulk.renewDaysHint")), errBox);

    this.host.openModal({
      title: I18n.t("certs.admin.bulk.renewTitle", { count: n }),
      body: root, saveLabel: I18n.t("certs.admin.bulk.renewBtn"),
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const requested = Number(days.value);
        if (!Number.isFinite(requested) || requested <= 0) { this.showError(errBox, I18n.t("certs.admin.sshCert.daysInvalid")); return false; }
        const ids = [...this.selection.keys()];
        let allItems: CertificateListItem[];
        try { allItems = await this.client!.list(); }
        catch (e) { this.showError(errBox, e); return false; }
        const byId = new Map(allItems.map((c) => [c.id, c] as const));
        // Cache par CA : évite de re-télécharger/re-déchiffrer la clé d'une même CA pour chaque feuille.
        const caCache = new Map<string, { ca: CertificateDetail; key: string }>();
        const errors: Array<{ label: string; reason: string }> = [];
        let done = 0;
        for (const id of ids) {
          const snap = this.selection.get(id)!;
          const item = byId.get(id);
          if (!item) { errors.push({ label: snap.label, reason: I18n.t("certs.admin.bulk.notFound") }); continue; }
          if (item.revoked_at) { errors.push({ label: item.label, reason: I18n.t("certs.admin.bulk.alreadyRevoked") }); continue; }
          if (item.kind !== "leaf-tls" || !item.parent_id) { errors.push({ label: item.label, reason: I18n.t("certs.admin.bulk.notRenewable") }); continue; }
          try {
            let cc = caCache.get(item.parent_id);
            if (!cc) {
              const ca = await this.client!.getOne(item.parent_id);
              if (!ca.key_enc) throw new Error(I18n.t("certs.admin.leaf.noKey"));
              cc = { ca, key: await PkiCrypto.decryptSecret(this.session.key, ca.key_enc) };
              caCache.set(item.parent_id, cc);
            }
            const clamped = CertValidity.clampDays(requested, cc.ca.not_after, Date.now());
            await this.reissueLeafRenewal(item, cc.ca, cc.key, clamped);
            done++;
          } catch (e) { errors.push({ label: item.label, reason: CertsAdminView.errText(e) }); }
        }
        this.showBulkSummary(I18n.t("certs.admin.bulk.sumRenew"), [
          I18n.t("certs.admin.bulk.renewedCount", { count: done }),
          ...errors.map((e) => I18n.t("certs.admin.bulk.errorLine", { label: e.label, reason: e.reason })),
        ]);
        this.clearSelection();
        await this.refreshBody();
        return true;
      },
    });
    setTimeout(() => days.focus(), 30);
  }

  /** SUPPRESSION groupée : confirmation danger, puis N DELETE. Les 409 (descendance) sont COLLECTÉS par élément
      et rapportés au bilan — jamais de silence partiel. */
  private async bulkDelete(): Promise<void> {
    this.session.touch();
    const ids = [...this.selection.keys()];
    const n = ids.length;
    const ok = await this.confirmDelete([...this.selection.values()],
      I18n.t("certs.admin.bulk.deleteTitle", { count: n }),
      I18n.t("certs.admin.bulk.deleteMessage"));
    if (!ok) return;

    const errors: Array<{ label: string; reason: string }> = [];
    let done = 0;
    for (const id of ids) {
      const snap = this.selection.get(id)!;
      // `force` par certificat : le serveur ne l'exige que pour les ENCORE VALIDES (pas de route
      // bulk — N appels unitaires). La confirmation groupée vaut intention pour tout le lot.
      try { await this.client!.remove(id, DeleteGuard.needsForce(snap)); done++; }
      catch (e) {
        if (e instanceof CertsError && e.status === 409) errors.push({ label: snap.label, reason: I18n.t("certs.admin.bulk.hasChildren") });
        else errors.push({ label: snap.label, reason: CertsAdminView.errText(e) });
      }
    }
    this.showBulkSummary(I18n.t("certs.admin.bulk.sumDelete"), [
      I18n.t("certs.admin.bulk.deletedCount", { count: done }),
      ...errors.map((e) => I18n.t("certs.admin.bulk.errorLine", { label: e.label, reason: e.reason })),
    ]);
    this.clearSelection();
    await this.refreshBody();
  }

  /** BILAN d'une action groupée (Dialog à un seul bouton) : lignes réussies (✔) et refusées/exclues (✕),
      colorées. JAMAIS de silence partiel — chaque élément non traité y figure avec sa raison. */
  private showBulkSummary(title: string, lines: string[]): void {
    void Dialog.custom({
      title: I18n.t("certs.admin.bulk.summaryTitle", { title }),
      hideCancel: true,
      confirmLabel: I18n.t("ui.action.ok"),
      build: (root) => {
        const box = document.createElement("div");
        box.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:12px;max-height:50vh;overflow:auto";
        for (const line of lines.filter((l) => typeof l === "string" && l.trim() !== "")) {
          const row = document.createElement("div");
          row.style.color = line.startsWith("✕") ? "var(--err)" : line.startsWith("✔") ? "var(--ok)" : "var(--fg)";
          row.textContent = line;
          box.appendChild(row);
        }
        root.appendChild(box);
      },
    });
  }

  /* --------------------------------------------------------------------------
     Déverrouillage / initialisation de la clé maître
     -------------------------------------------------------------------------- */

  /** Initialisation EN MODALE : phrase ×2, avertissement de perte, dérivation KEK + tirage/emballage
      de la DEK (enveloppe) + PUT /pki. La session s'ouvre sur la DEK déballée (NON extractible). */
  private initModal(): void {
    const root = document.createElement("div");
    const warn = document.createElement("div"); warn.className = "form-hint"; warn.style.cssText = "margin-bottom:10px;color:var(--warn)";
    warn.textContent = I18n.t("certs.admin.init.warn");
    root.appendChild(warn);

    const p1 = FormControls.text("", I18n.t("certs.admin.init.passPlaceholder")); p1.type = "password"; p1.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.init.passLabel"), p1, I18n.t("certs.admin.common.longUniqueHint")));
    const p2 = FormControls.text("", I18n.t("certs.admin.init.confirmPlaceholder")); p2.type = "password"; p2.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.confirmation"), p2, I18n.t("certs.admin.init.confirmHint")));

    const errBox = this.errBox(); root.appendChild(errBox);
    this.host.openModal({
      title: I18n.t("certs.admin.init.title"),
      body: root,
      saveLabel: I18n.t("certs.admin.init.saveLabel"),
      onSave: async () => {
        errBox.style.display = "none";
        const pass = p1.value;
        if (pass.trim() === "") { this.showError(errBox, I18n.t("certs.admin.common.passRequired")); return false; }
        if (pass !== p2.value) { this.showError(errBox, I18n.t("certs.admin.init.passMismatch")); return false; }
        try {
          const salt = PkiCrypto.generateSaltB64();
          const iters = PkiCrypto.DEFAULT_ITERS;
          const kek = await PkiCrypto.deriveKek(pass, salt, iters);
          const { wrappedDek, dek } = await PkiCrypto.initDek(kek); // DEK aléatoire, emballée par la KEK
          await this.client!.initPki({ kdf_version: PkiCrypto.KDF_VERSION, kdf_salt: salt, kdf_iters: iters, wrapped_dek: wrappedDek });
          this.session.unlock(dek); // la session détient la DEK (non extractible), pas la KEK
          await this.reload();
          Notify.toast(I18n.t("certs.admin.init.toast"), "ok");
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => p1.focus(), 30);
  }

  /** Déverrouillage : dérive la KEK et DÉBALLE la DEK depuis wrapped_dek. L'unwrap AES-GCM est
      authentifié : il réussit (→ unlock) si la phrase est bonne, JETTE sinon (→ message NEUTRE).
      Le wrapped_dek FAIT donc office de keycheck — pas de vérification séparée. */
  /** Tente le déverrouillage. Renvoie `true` en cas de succès (session ouverte + vue re-rendue), `false` sinon
      (phrase vide/erronée — message neutre affiché). Le booléen pilote la fermeture de la modale du coffre. */
  private async attemptUnlock(pass: string, errBox: HTMLElement): Promise<boolean> {
    const state = this.pkiState;
    if (!state || state.initialized !== true) return false;
    errBox.style.display = "none";
    if (pass.trim() === "") { this.showError(errBox, I18n.t("certs.admin.common.passRequired")); return false; }
    try {
      const kek = await PkiCrypto.deriveKek(pass, state.kdf_salt, state.kdf_iters);
      const dek = await PkiCrypto.unwrapDek(kek, state.wrapped_dek); // JETTE si mauvaise phrase (GCM refuse)
      this.session.unlock(dek);
      this.render();
      Notify.toast(I18n.t("certs.admin.unlock.toast"), "ok");
      return true;
    } catch (_) {
      // Toute erreur (dérivation, unwrap, blob) → même réponse neutre, sans matériau de clé.
      this.showError(errBox, I18n.t("certs.admin.unlock.wrong"));
      return false;
    }
  }

  /** Changement de phrase maître EN MODALE (principe n°11) — session déverrouillée requise.
      PRINCIPE : la phrase ne garde pas les clés privées, elle garde la DEK. On déballe la DEK
      avec l'ANCIENNE phrase et on la ré-emballe avec la NOUVELLE (`rewrapDek`) : un seul petit
      wrapped_dek est réécrit, AUCUN key_enc n'est re-chiffré. La phrase actuelle est redemandée
      (on en a besoin pour dériver l'ancienne KEK — la session ne détient que la DEK, pas la KEK
      ni la phrase) et sert de RE-VÉRIFICATION. La DEK ne changeant pas, la session reste ouverte. */
  private changePassphraseModal(): void {
    const state = this.pkiState;
    if (!state || state.initialized !== true || !this.session.unlocked) return;
    this.session.touch();

    const root = document.createElement("div");
    const info = document.createElement("div"); info.className = "form-hint"; info.style.marginBottom = "10px";
    info.textContent = I18n.t("certs.admin.rekey.info");
    root.appendChild(info);

    const cur = FormControls.text("", I18n.t("certs.admin.rekey.curPlaceholder")); cur.type = "password"; cur.autocomplete = "current-password";
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rekey.curLabel"), cur, I18n.t("certs.admin.rekey.curHint")));
    const p1 = FormControls.text("", I18n.t("certs.admin.rekey.newPlaceholder")); p1.type = "password"; p1.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rekey.newLabel"), p1, I18n.t("certs.admin.common.longUniqueHint")));
    const p2 = FormControls.text("", I18n.t("certs.admin.rekey.confirmPlaceholder")); p2.type = "password"; p2.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.confirmation"), p2, I18n.t("certs.admin.rekey.confirmHint")));
    // COLLAGE BLOQUÉ sur la CONFIRMATION : la retape de la nouvelle phrase doit être une VRAIE retape
    // (coller depuis le 1er champ contournerait la vérification anti-faute de frappe).
    p2.addEventListener("paste", (e) => e.preventDefault());

    const errBox = this.errBox(); root.appendChild(errBox);
    // Liaison d'erreur (accessibilité, cf. point 7) : le message d'erreur porte un ID ; les champs
    // fautifs pointeront dessus (aria-describedby) et prendront `aria-invalid`, nettoyés dès la saisie.
    const errId = OverlayA11y.nextId("cert-rekey-err"); errBox.id = errId;
    const clearInvalid = () => [cur, p1, p2].forEach((f) => { f.removeAttribute("aria-invalid"); f.removeAttribute("aria-describedby"); });
    [cur, p1, p2].forEach((f) => f.addEventListener("input", clearInvalid));
    const failField = (f: HTMLInputElement): false => { f.setAttribute("aria-invalid", "true"); f.setAttribute("aria-describedby", errId); try { f.focus(); } catch (_) { /* sans effet */ } return false; };
    this.host.openModal({
      title: I18n.t("certs.admin.rekey.title"),
      body: root,
      saveLabel: I18n.t("certs.admin.rekey.saveLabel"),
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        clearInvalid();
        const currentPass = cur.value;
        const newPass = p1.value;
        if (currentPass.trim() === "") { this.showError(errBox, I18n.t("certs.admin.rekey.curRequired")); return failField(cur); }
        if (newPass.trim() === "") { this.showError(errBox, I18n.t("certs.admin.rekey.newRequired")); return failField(p1); }
        if (newPass !== p2.value) { this.showError(errBox, I18n.t("certs.admin.rekey.mismatch")); return failField(p2); }
        // Instantané FRAIS à CHAQUE tentative (masque la capture d'ouverture) : après un 409
        // « conflict », this.pkiState a été rafraîchi — la relance doit repartir de l'enveloppe
        // COURANTE (dériver l'ancienne KEK sur le bon sel, fonder le rewrap sur le bon blob).
        const state = this.pkiState;
        if (!state || state.initialized !== true) { this.showError(errBox, I18n.t("certs.admin.rekey.stateUnavailable")); return false; }

        // 1) Ré-emballer la DEK côté client. rewrapDek JETTE si la phrase actuelle est mauvaise
        //    (déchiffrement refusé) — on l'isole pour un message ciblé, distinct d'une panne réseau.
        //    On régénère le sel (bonne hygiène : nouvelle phrase = nouveaux paramètres KDF).
        const newSalt = PkiCrypto.generateSaltB64();
        const newIters = PkiCrypto.DEFAULT_ITERS;
        let newWrappedDek: string;
        try {
          const oldKek = await PkiCrypto.deriveKek(currentPass, state.kdf_salt, state.kdf_iters);
          const newKek = await PkiCrypto.deriveKek(newPass, newSalt, newIters);
          newWrappedDek = await PkiCrypto.rewrapDek(oldKek, newKek, state.wrapped_dek);
        } catch (_) {
          this.showError(errBox, I18n.t("certs.admin.rekey.curWrong"));
          return failField(cur);
        }

        // 2) Persister la nouvelle enveloppe. `prev_wrapped_dek` = l'enveloppe sur laquelle le
        //    ré-emballage vient d'être fondé (verrou optimiste) : si un AUTRE changement de phrase
        //    est passé entre-temps, le serveur répond 409 au lieu d'écraser silencieusement.
        try {
          await this.client!.rekeyPki({
            kdf_version: PkiCrypto.KDF_VERSION, kdf_salt: newSalt, kdf_iters: newIters,
            wrapped_dek: newWrappedDek, prev_wrapped_dek: state.wrapped_dek,
          });
        } catch (e) {
          // Conflit (ou autre échec) : re-lire l'état PKI en arrière-plan pour qu'un nouvel essai
          // reparte de l'enveloppe COURANTE (sans ça, le prev resterait périmé à chaque tentative).
          try { this.pkiState = await this.client!.pki(); } catch (_) { /* l'erreur affichée suffit */ }
          this.showError(errBox, e); return false;
        }

        // 3) Rafraîchir l'état local : les prochains déverrouillages utiliseront les nouveaux
        //    paramètres. La session détient toujours la MÊME DEK → elle reste valablement ouverte.
        this.pkiState = { initialized: true, kdf_version: PkiCrypto.KDF_VERSION, kdf_salt: newSalt, kdf_iters: newIters, wrapped_dek: newWrappedDek };
        Notify.toast(I18n.t("certs.admin.rekey.toast"), "ok");
        return true;
      },
    });
    setTimeout(() => cur.focus(), 30);
  }

  /* --------------------------------------------------------------------------
     Créations (TOUTES en MODALE — principe n°11)
     -------------------------------------------------------------------------- */

  /** Champ LABEL (métadonnée d'affichage) couplé au champ CN : le label est saisi EN PREMIER et RECOPIÉ dans le CN
      tant que celui-ci n'a pas été édité à la main (le CN reste librement modifiable → label ≠ CN possible). En
      renouvellement (`cnPrefilled` = CN déjà rempli et distinct), le couplage est désactivé d'emblée. Retourne la
      rangée de champ LABEL (à insérer AVANT la rangée CN). Le label est éditable après génération (modale méta). */
  private labelCnRow(labelInput: HTMLInputElement, cnInput: HTMLInputElement, cnPrefilled: boolean): HTMLElement {
    let cnTouched = cnPrefilled;
    cnInput.addEventListener("input", () => { cnTouched = true; });
    labelInput.addEventListener("input", () => { if (!cnTouched) cnInput.value = labelInput.value; });
    return FormControls.fieldRow(I18n.t("certs.admin.common.labelField"), labelInput, I18n.t("certs.admin.common.labelHint"));
  }

  /** CA racine X.509 auto-signée. */
  private rootCaModal(): void {
    const root = document.createElement("div");
    const label = FormControls.text("", I18n.t("certs.admin.common.labelPlaceholder"));
    const cn = FormControls.text("", I18n.t("certs.admin.rootCa.cnPlaceholder"));
    root.appendChild(this.labelCnRow(label, cn, false));   // LABEL en premier → recopié dans le CN
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rootCa.cnField"), cn, I18n.t("certs.admin.rootCa.cnHint")));
    const org = FormControls.text("", I18n.t("certs.admin.rootCa.orgPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rootCa.orgField"), org, I18n.t("certs.admin.rootCa.orgHint")));
    const ou = FormControls.text("", I18n.t("certs.admin.rootCa.ouPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rootCa.ouField"), ou, I18n.t("certs.admin.rootCa.ouHint")));
    const algo = FormControls.select(CertsAdminView.algoX509Opts(), "ec-p256");
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.algoField"), algo, I18n.t("certs.admin.rootCa.algoHint")));
    const days = FormControls.number(3650, { min: 1, step: 1 });
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.validityDays"), days, I18n.t("certs.admin.rootCa.daysHint")));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: I18n.t("certs.admin.rootCa.title"),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const lbl = label.value.trim();
        if (lbl === "") { this.showError(errBox, I18n.t("certs.admin.common.labelRequired")); return false; }
        const commonName = cn.value.trim();
        if (commonName === "") { this.showError(errBox, I18n.t("certs.admin.common.cnRequired")); return false; }
        try {
          const keyAlgo = algo.value as X509KeyAlgo;
          const organization = org.value.trim() || undefined;
          const organizationalUnit = ou.value.trim() || undefined;
          const gen = await X509Factory.createRootCa({ commonName, organization, organizationalUnit, keyAlgo, days: Number(days.value) });
          const keyEnc = await PkiCrypto.encryptSecret(this.session.key, gen.privateKeyPkcs8Pem);
          await this.client!.save(CertsAdminView.newId(), {
            kind: "root-ca", parent_id: null, label: lbl, subject: CertsAdminView.subjectDn(commonName, organization, organizationalUnit),
            serial: gen.serial, not_before: gen.notBefore, not_after: gen.notAfter, fingerprint: gen.fingerprintSha256,
            key_algo: keyAlgo, public_pem: gen.certPem, key_enc: keyEnc, revoked_at: null, sans: [],
          });
          Notify.toast(I18n.t("certs.admin.rootCa.toast"), "ok");
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => label.focus(), 30);
  }

  /** Feuille TLS signée par une CA X.509 (action « Émettre TLS »). `renewOf` présent = RENOUVELLEMENT (mode 1) :
      le formulaire est PRÉ-REMPLI à l'identique du certificat renouvelé (CN/O/OU/SAN/usage/algo/durée) et, à la
      validation, l'ancien est RÉVOQUÉ (raison « superseded ») tandis que le nouveau porte `renewed_from` = son id. */
  private leafModal(ca: CertificateListItem, renewOf?: CertificateListItem): void {
    // Pré-remplissage : depuis le certificat renouvelé si mode 1, sinon défauts (O/OU hérités de la CA).
    const cnInit = renewOf ? (CertsAdminView.parseDnField(renewOf.subject, "CN") || renewOf.label) : "";
    const orgInit = CertsAdminView.parseDnField(renewOf ? renewOf.subject : ca.subject, "O");
    const ouInit = CertsAdminView.parseDnField(renewOf ? renewOf.subject : ca.subject, "OU");
    const sansInit = renewOf ? (renewOf.sans || []).filter((s) => s.san_type === "dns" || s.san_type === "ip" || s.san_type === "email") : undefined;
    const usageInit: LeafUsage = renewOf ? X509Factory.readLeafUsage(renewOf.public_pem || "") : "server";
    const algoInit = renewOf && (["ec-p256", "rsa-2048", "rsa-4096"] as string[]).includes(renewOf.key_algo) ? renewOf.key_algo : "ec-p256";

    const root = document.createElement("div");
    const label = FormControls.text(renewOf ? renewOf.label : "", I18n.t("certs.admin.common.labelPlaceholder"));
    const cn = FormControls.text(cnInit, I18n.t("certs.admin.leaf.cnPlaceholder"));
    root.appendChild(this.labelCnRow(label, cn, !!renewOf));   // LABEL en premier → recopié dans le CN (couplage off en renouvellement)
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.leaf.cnField"), cn, I18n.t("certs.admin.leaf.cnHint")));
    const org = FormControls.text(orgInit, I18n.t("certs.admin.leaf.orgPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.leaf.orgField"), org, I18n.t("certs.admin.leaf.orgHint")));
    const ou = FormControls.text(ouInit, I18n.t("certs.admin.leaf.ouPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.leaf.ouField"), ou, I18n.t("certs.admin.leaf.ouHint")));
    const sanEditor = this.buildSanEditor(sansInit);
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.leaf.sanField"), sanEditor.element, I18n.t("certs.admin.leaf.sanHint")));
    const usage = FormControls.select(CertsAdminView.usageOpts(), usageInit);
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.leaf.usageField"), usage, I18n.t("certs.admin.leaf.usageHint")));
    const algo = FormControls.select(CertsAdminView.algoX509Opts(), algoInit);
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.algoField"), algo, I18n.t("certs.admin.leaf.algoHint")));
    // GUARD (formulaire) : la feuille ne peut vivre au-delà de la CA → durée plafonnée à ce qui reste sur la CA.
    // En renouvellement, on PRÉ-REMPLIT la durée d'origine (rognée au plafond). Double filet : validation + fabrique.
    const caDaysLeft = CertValidity.daysUntil(ca.not_after, Date.now());
    const baseDays = renewOf ? CertValidity.durationDays(renewOf.not_before, renewOf.not_after, 397) : 397;
    const defaultDays = caDaysLeft != null ? Math.min(baseDays, Math.max(1, caDaysLeft)) : baseDays;
    const days = FormControls.number(defaultDays, caDaysLeft != null ? { min: 1, max: caDaysLeft, step: 1 } : { min: 1, step: 1 });
    const daysHint = caDaysLeft != null
      ? I18n.t("certs.admin.leaf.daysHint") + " " + I18n.t("certs.admin.leaf.caCeiling", { date: (ca.not_after || "").slice(0, 10), days: caDaysLeft })
      : I18n.t("certs.admin.leaf.daysHint");
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.validityDays"), days, daysHint));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: renewOf ? I18n.t("certs.admin.renew.leafTitle") : I18n.t("certs.admin.leaf.title"),
      subtitle: Html.escape(renewOf ? renewOf.label : ca.label),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const lbl = label.value.trim();
        if (lbl === "") { this.showError(errBox, I18n.t("certs.admin.common.labelRequired")); return false; }
        const commonName = cn.value.trim();
        if (commonName === "") { this.showError(errBox, I18n.t("certs.admin.common.cnRequired")); return false; }
        if (CertValidity.exceedsCa(Number(days.value), ca.not_after, Date.now())) {
          this.showError(errBox, I18n.t("certs.admin.leaf.exceedsCa", { date: (ca.not_after || "").slice(0, 10), days: caDaysLeft ?? 0 })); return false;
        }
        const sans = sanEditor.collect();
        try {
          const detail = await this.client!.getOne(ca.id);
          if (!detail.key_enc) { this.showError(errBox, I18n.t("certs.admin.leaf.noKey")); return false; }
          const caKeyPem = await PkiCrypto.decryptSecret(this.session.key, detail.key_enc);
          const keyAlgo = algo.value as X509KeyAlgo;
          const organization = org.value.trim() || undefined;
          const organizationalUnit = ou.value.trim() || undefined;
          const gen = await X509Factory.issueLeaf({
            caCertPem: detail.public_pem || "", caPrivateKeyPkcs8Pem: caKeyPem,
            commonName, organization, organizationalUnit, keyAlgo, days: Number(days.value), sans: sans as X509San[], usage: usage.value as LeafUsage,
          });
          const keyEnc = await PkiCrypto.encryptSecret(this.session.key, gen.privateKeyPkcs8Pem);
          await this.client!.save(CertsAdminView.newId(), {
            kind: "leaf-tls", parent_id: ca.id, label: lbl, subject: CertsAdminView.subjectDn(commonName, organization, organizationalUnit),
            serial: gen.serial, not_before: gen.notBefore, not_after: gen.notAfter, fingerprint: gen.fingerprintSha256,
            key_algo: keyAlgo, public_pem: gen.certPem, key_enc: keyEnc, revoked_at: null, sans,
            renewed_from: renewOf ? renewOf.id : undefined,   // lignée (mode 1) ; undefined → null côté serveur
          });
          // RENOUVELLEMENT : révoque l'ancien APRÈS création du neuf (raison auto « superseded »). Échec de la
          // révocation → le neuf existe déjà : on avertit sans bloquer (l'ancien restera à révoquer à la main).
          if (renewOf) await this.revokeSuperseded(renewOf);
          Notify.toast(renewOf ? I18n.t("certs.admin.renew.leafToast") : I18n.t("certs.admin.leaf.toast"), "ok");
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => label.focus(), 30);
  }

  /** Émet une CA INTERMÉDIAIRE (sous-CA) signée par la CA `parentCa` (racine OU intermédiaire) — action
      « Émettre une sous-CA ». La sous-CA est à la fois un DÉRIVÉ (elle a un émetteur) et une CA (elle pourra
      à son tour signer feuilles et sous-CA). Sa NOUVELLE paire de clés naît dans le navigateur ; la clé privée
      est chiffrée par la clé maître AVANT envoi (zéro-connaissance), exactement comme une feuille. La clé de la
      CA parente est déchiffrée LOCALEMENT le temps de signer, jamais réaffichée. PAS de SAN ni d'usage/EKU
      (c'est une CA, pas une feuille) ; un champ AVANCÉ `pathLen` règle la profondeur de sous-CA encore autorisée
      EN DESSOUS (défaut 0 = cette CA n'émet QUE des feuilles — confinement par défaut, cadrage Lot 0 §8.4). */
  private intermediateCaModal(parentCa: CertificateListItem): void {
    const root = document.createElement("div");
    // Champs d'IDENTITÉ d'une autorité (CN/O/OU) : on RÉUTILISE les libellés de la CA racine (une sous-CA est
    // aussi une autorité) plutôt que d'en dupliquer. Label couplé au CN (recopié tant que le CN n'est pas édité).
    const label = FormControls.text("", I18n.t("certs.admin.common.labelPlaceholder"));
    const cn = FormControls.text("", I18n.t("certs.admin.rootCa.cnPlaceholder"));
    root.appendChild(this.labelCnRow(label, cn, false));   // LABEL en premier → recopié dans le CN
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rootCa.cnField"), cn, I18n.t("certs.admin.rootCa.cnHint")));
    const org = FormControls.text("", I18n.t("certs.admin.rootCa.orgPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rootCa.orgField"), org, I18n.t("certs.admin.rootCa.orgHint")));
    const ou = FormControls.text("", I18n.t("certs.admin.rootCa.ouPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rootCa.ouField"), ou, I18n.t("certs.admin.rootCa.ouHint")));
    const algo = FormControls.select(CertsAdminView.algoX509Opts(), "ec-p256");
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.algoField"), algo, I18n.t("certs.admin.rootCa.algoHint")));
    // GUARD (formulaire) : une sous-CA ne peut vivre AU-DELÀ de sa CA parente → durée plafonnée à ce qui reste
    // sur la parente. Défaut = la MOITIÉ de ce qui reste (une sous-CA vit moins que son ancre), repli 397 si la
    // parente n'a pas d'échéance exploitable. Double filet : validation ci-dessous + fabrique (issueIntermediateCa).
    const caDaysLeft = CertValidity.daysUntil(parentCa.not_after, Date.now());
    const defaultDays = caDaysLeft != null ? Math.max(1, Math.floor(caDaysLeft / 2)) : 397;
    const days = FormControls.number(defaultDays, caDaysLeft != null ? { min: 1, max: caDaysLeft, step: 1 } : { min: 1, step: 1 });
    const daysHint = caDaysLeft != null
      ? I18n.t("certs.admin.intermediateCa.daysHint") + " " + I18n.t("certs.admin.leaf.caCeiling", { date: (parentCa.not_after || "").slice(0, 10), days: caDaysLeft })
      : I18n.t("certs.admin.intermediateCa.daysHint");
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.validityDays"), days, daysHint));
    // pathLen (AVANCÉ) : profondeur de sous-CA encore autorisée SOUS celle-ci (entier ≥ 0, défaut 0 = feuilles seules).
    const pathLen = FormControls.number(0, { min: 0, step: 1 });
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.intermediateCa.pathLenField"), pathLen, I18n.t("certs.admin.intermediateCa.pathLenHint")));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: I18n.t("certs.admin.intermediateCa.title"),
      subtitle: Html.escape(parentCa.label),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const lbl = label.value.trim();
        if (lbl === "") { this.showError(errBox, I18n.t("certs.admin.common.labelRequired")); return false; }
        const commonName = cn.value.trim();
        if (commonName === "") { this.showError(errBox, I18n.t("certs.admin.common.cnRequired")); return false; }
        const requested = Number(days.value);
        if (CertValidity.exceedsCa(requested, parentCa.not_after, Date.now())) {
          this.showError(errBox, I18n.t("certs.admin.leaf.exceedsCa", { date: (parentCa.not_after || "").slice(0, 10), days: caDaysLeft ?? 0 })); return false;
        }
        // pathLen : entier ≥ 0 (la fabrique le revérifie ; on donne ici un message localisé et ciblé).
        const depth = Number(pathLen.value);
        if (!Number.isFinite(depth) || !Number.isInteger(depth) || depth < 0) { this.showError(errBox, I18n.t("certs.admin.intermediateCa.pathLenInvalid")); return false; }
        try {
          // Clé de la CA PARENTE chargée puis déchiffrée LOCALEMENT (getOne unitaire seul porte key_enc, invariant Q5).
          const ca = await this.client!.getOne(parentCa.id);
          if (!ca.key_enc) { this.showError(errBox, I18n.t("certs.admin.leaf.noKey")); return false; }
          const caKeyPem = await PkiCrypto.decryptSecret(this.session.key, ca.key_enc);
          const keyAlgo = algo.value as X509KeyAlgo;
          const organization = org.value.trim() || undefined;
          const organizationalUnit = ou.value.trim() || undefined;
          // Durée rognée au plafond de la parente (défensif : le champ est déjà borné et exceedsCa a bloqué le dépassement).
          const clampedDays = CertValidity.clampDays(requested, parentCa.not_after, Date.now());
          const gen = await X509Factory.issueIntermediateCa({
            caCertPem: ca.public_pem || "", caPrivateKeyPkcs8Pem: caKeyPem,
            commonName, organization, organizationalUnit, keyAlgo, days: clampedDays, pathLen: depth,
          });
          // Clé de la SOUS-CA chiffrée par la clé maître AVANT envoi (le serveur ne reçoit qu'un blob opaque).
          const keyEnc = await PkiCrypto.encryptSecret(this.session.key, gen.privateKeyPkcs8Pem);
          await this.client!.save(CertsAdminView.newId(), {
            kind: "intermediate-ca", parent_id: parentCa.id, label: lbl, subject: CertsAdminView.subjectDn(commonName, organization, organizationalUnit),
            serial: gen.serial, not_before: gen.notBefore, not_after: gen.notAfter, fingerprint: gen.fingerprintSha256,
            key_algo: keyAlgo, public_pem: gen.certPem, key_enc: keyEnc, revoked_at: null, sans: [],
          });
          Notify.toast(I18n.t("certs.admin.intermediateCa.toast"), "ok");
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => label.focus(), 30);
  }

  /** Révoque un certificat au motif « superseded » (remplacé par renouvellement). Ne LÈVE PAS : un échec (rare)
      est signalé par un toast d'avertissement — le nouveau certificat est déjà en place, l'ancien reste à révoquer
      manuellement au besoin. Partagé par tous les flux de renouvellement (feuille, ssh-cert, CA, lots). */
  private async revokeSuperseded(old: CertificateListItem): Promise<void> {
    try {
      await this.client!.save(old.id, CertsAdminView.metadataInput(old, {
        revoked_at: new Date().toISOString(), revocation_reason: RevocationReasons.encode(RENEWAL_REASON_CODE, ""),
      }));
    } catch (_) {
      Notify.toast(I18n.t("certs.admin.renew.oldRevokeFailed", { label: old.label }), "warn");
    }
  }

  /** RENOUVELLEMENT UNITAIRE (mode 1) d'une feuille TLS ou d'un certificat SSH : ouvre la modale d'émission
      PRÉ-REMPLIE à l'identique. Charge d'abord la CA émettrice (échéance pour le plafond + clé pour signer).
      Les CA (root-ca/ssh-ca) passent, elles, par renewCaDialog (opération de masse). */
  private async renewModal(item: CertificateListItem): Promise<void> {
    this.session.touch();
    if (item.kind !== "leaf-tls" && item.kind !== "ssh-cert") return;   // les CA → renewCaDialog
    if (!item.parent_id) { Notify.toast(I18n.t("certs.admin.renew.noParent"), "err"); return; }
    let ca: CertificateListItem;
    try { ca = await this.client!.getOne(item.parent_id); }
    catch (e) { this.actionError(e); return; }
    if (item.kind === "leaf-tls") this.leafModal(ca, item);
    else this.sshCertModal(ca, item);
  }

  /** RENOUVELLEMENT D'UNE CA RACINE (X.509) — opération de MASSE avec avertissement clair (cadrage §Phase 5).
      Deux mécaniques au choix :
      - « Prolonger (même clé) » : la CA est RE-SIGNÉE avec sa clé actuelle et une échéance repoussée, MISE À JOUR
        EN PLACE (même id, key_enc conservé) → l'arbre reste intact ; puis ses feuilles actives sont renouvelées.
      - « Rotation de clé » : une NOUVELLE CA (nouvelle paire) est créée, l'ancienne révoquée, et toutes les
        feuilles actives ré-émises SOUS la nouvelle CA (nouveau parent_id). Le cross-signing (recouvrement propre)
        est ajouté en phase 6.
      Réservé au root-ca : une ssh-ca (ed25519) n'a pas d'échéance à prolonger. */
  private async renewCaDialog(ca: CertificateListItem): Promise<void> {
    this.session.touch();
    if (ca.kind !== "root-ca") return;
    const root = document.createElement("div");
    const warn = document.createElement("div"); warn.style.cssText = "margin-bottom:10px;color:var(--warn);font-weight:600";
    warn.textContent = I18n.t("certs.admin.renewCa.warn");
    const intro = document.createElement("div"); intro.className = "form-hint"; intro.style.marginBottom = "10px";
    intro.textContent = I18n.t("certs.admin.renewCa.intro", { label: ca.label });
    const mode = FormControls.select([
      { value: "prolong", label: I18n.t("certs.admin.renewCa.modeProlong") },
      { value: "rotate", label: I18n.t("certs.admin.renewCa.modeRotate") },
    ], "prolong");
    const days = FormControls.number(3650, { min: 1, step: 1 });
    const errBox = this.errBox();
    root.append(warn, intro,
      FormControls.fieldRow(I18n.t("certs.admin.renewCa.modeField"), mode, I18n.t("certs.admin.renewCa.modeHint")),
      FormControls.fieldRow(I18n.t("certs.admin.common.validityDays"), days, I18n.t("certs.admin.renewCa.daysHint")),
      errBox);

    this.host.openModal({
      title: I18n.t("certs.admin.renewCa.title"), subtitle: Html.escape(ca.label), body: root,
      saveLabel: I18n.t("certs.admin.renewCa.btn"),
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const requested = Number(days.value);
        if (!Number.isFinite(requested) || requested <= 0) { this.showError(errBox, I18n.t("certs.admin.sshCert.daysInvalid")); return false; }
        try {
          const caDetail = await this.client!.getOne(ca.id);
          if (!caDetail.key_enc) { this.showError(errBox, I18n.t("certs.admin.leaf.noKey")); return false; }
          const oldCaKey = await PkiCrypto.decryptSecret(this.session.key, caDetail.key_enc);
          const cn = CertsAdminView.parseDnField(ca.subject, "CN") || ca.label;
          const organization = CertsAdminView.parseDnField(ca.subject, "O") || undefined;
          const organizationalUnit = CertsAdminView.parseDnField(ca.subject, "OU") || undefined;
          // Feuilles ACTIVES rattachées (un root-ca n'a que des feuilles TLS en enfants directs).
          const children = (await this.client!.list()).filter((c) => c.parent_id === ca.id && !c.revoked_at);
          const isRotate = mode.value === "rotate";

          // CA « effective » sous laquelle ré-émettre les enfants (+ sa clé déchiffrée).
          let effectiveCa: CertificateDetail;
          let effectiveKey: string;
          if (isRotate) {
            const keyAlgo = (["ec-p256", "rsa-2048", "rsa-4096"] as string[]).includes(ca.key_algo) ? ca.key_algo as X509KeyAlgo : "ec-p256";
            const gen = await X509Factory.createRootCa({ commonName: cn, organization, organizationalUnit, keyAlgo, days: requested });
            const newKeyEnc = await PkiCrypto.encryptSecret(this.session.key, gen.privateKeyPkcs8Pem);
            // CROSS-SIGNATURE (phase 6) : l'ANCIENNE CA certifie la clé de la NOUVELLE → recouvrement transitoire
            // (un client qui fait encore confiance à l'ancien root valide les nouvelles feuilles). Généré AVANT la
            // révocation (on a encore la clé de l'ancienne). Échéance rognée à celle de l'ancienne CA (dans crossSignCa).
            let crossPem: string | undefined;
            try {
              crossPem = (await X509Factory.crossSignCa({ subjectCaCertPem: gen.certPem, issuerCaCertPem: caDetail.public_pem || "", issuerCaPrivateKeyPkcs8Pem: oldCaKey, days: requested })).certPem;
            } catch (_) { crossPem = undefined; }   // cross-signature best-effort : son échec ne bloque pas la rotation
            const newCaId = CertsAdminView.newId();
            await this.client!.save(newCaId, {
              kind: "root-ca", parent_id: null, label: ca.label, subject: ca.subject,
              serial: gen.serial, not_before: gen.notBefore, not_after: gen.notAfter, fingerprint: gen.fingerprintSha256,
              key_algo: keyAlgo, public_pem: gen.certPem, key_enc: newKeyEnc, revoked_at: null, sans: [],
              cross_signed_pem: crossPem, renewed_from: ca.id,
            });
            await this.revokeSuperseded(ca);   // ancienne CA remplacée
            effectiveCa = await this.client!.getOne(newCaId);
            effectiveKey = gen.privateKeyPkcs8Pem;
          } else {
            const re = await X509Factory.reSignRootCa({ existingCertPem: caDetail.public_pem || "", existingPrivateKeyPkcs8Pem: oldCaKey, commonName: cn, organization, organizationalUnit, days: requested });
            // MISE À JOUR EN PLACE : metadataInput n'envoie pas key_enc → la clé de la CA est CONSERVÉE (même clé).
            await this.client!.save(ca.id, CertsAdminView.metadataInput(ca, { public_pem: re.certPem, serial: re.serial, not_before: re.notBefore, not_after: re.notAfter, fingerprint: re.fingerprintSha256 }));
            effectiveCa = { ...caDetail, public_pem: re.certPem, serial: re.serial, not_before: re.notBefore, not_after: re.notAfter, fingerprint: re.fingerprintSha256 };
            effectiveKey = oldCaKey;
          }

          // Renouvelle chaque feuille active sous la CA effective (durée rognée à SA nouvelle échéance).
          const errors: Array<{ label: string; reason: string }> = [];
          let done = 0;
          for (const child of children) {
            try {
              await this.reissueLeafRenewal(child, effectiveCa, effectiveKey, CertValidity.clampDays(requested, effectiveCa.not_after, Date.now()));
              done++;
            } catch (e) { errors.push({ label: child.label, reason: CertsAdminView.errText(e) }); }
          }
          this.showBulkSummary(I18n.t("certs.admin.renewCa.sumTitle"), [
            I18n.t(isRotate ? "certs.admin.renewCa.caRotated" : "certs.admin.renewCa.caProlonged"),
            I18n.t("certs.admin.bulk.renewedCount", { count: done }),
            ...errors.map((e) => I18n.t("certs.admin.bulk.errorLine", { label: e.label, reason: e.reason })),
          ]);
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => days.focus(), 30);
  }

  /** CA SSH (ssh-ca) ou paire SSH simple (ssh-keypair) — ed25519, WebCrypto extractible. */
  private sshKeyModal(kind: "ssh-ca" | "ssh-keypair"): void {
    const root = document.createElement("div");
    const ident = FormControls.text("", kind === "ssh-ca" ? I18n.t("certs.admin.ssh.identPlaceholderCa") : I18n.t("certs.admin.ssh.identPlaceholderPair"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.ssh.identField"), ident, I18n.t("certs.admin.ssh.identHint")));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: kind === "ssh-ca" ? I18n.t("certs.admin.ssh.titleCa") : I18n.t("certs.admin.ssh.titlePair"),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const comment = ident.value.trim();
        if (comment === "") { this.showError(errBox, I18n.t("certs.admin.ssh.identRequired")); return false; }
        try {
          const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
          const pub = await SshKeyMaterial.ed25519PublicRaw(kp.publicKey);
          const publicLine = OpenSshEncoder.ed25519PublicKeyLine(pub, comment);
          const keyEnc = await PkiCrypto.encryptSecret(this.session.key, await this.pkcs8Pem(kp.privateKey));
          await this.client!.save(CertsAdminView.newId(), {
            kind, parent_id: null, label: comment, subject: comment,
            serial: null, not_before: null, not_after: null, fingerprint: null,
            key_algo: "ed25519", public_pem: publicLine, key_enc: keyEnc, revoked_at: null, sans: [],
          });
          Notify.toast(kind === "ssh-ca" ? I18n.t("certs.admin.ssh.toastCa") : I18n.t("certs.admin.ssh.toastPair"), "ok");
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => ident.focus(), 30);
  }

  /** Certificat SSH signé par une ssh-ca (action « Émettre SSH ») — la paire sujette NAÎT avec le cert (v1).
      `renewOf` présent = RENOUVELLEMENT (mode 1) : key id + principals + durée pré-remplis, l'ancien révoqué à la
      validation, le neuf porte `renewed_from`. NB : le TYPE (user/host) n'est pas en métadonnée → défaut « user »
      en renouvellement (éditable). Une ssh-ca n'a pas d'échéance → aucun plafond de durée. */
  private sshCertModal(ca: CertificateListItem, renewOf?: CertificateListItem): void {
    const principalsInit = renewOf ? (renewOf.sans || []).filter((s) => s.san_type === "principal").map((s) => s.value) : undefined;
    const daysInit = renewOf ? CertValidity.durationDays(renewOf.not_before, renewOf.not_after, 365) : 365;
    const root = document.createElement("div");
    const keyId = FormControls.text(renewOf ? renewOf.label : "", I18n.t("certs.admin.sshCert.keyIdPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.sshCert.keyIdField"), keyId, I18n.t("certs.admin.sshCert.keyIdHint")));
    const type = FormControls.select(CertsAdminView.sshCertTypeOpts(), "user");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.type"), type, I18n.t("certs.admin.sshCert.typeHint")));
    const principalsEditor = this.buildPrincipalsEditor(principalsInit);
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.sshCert.principalsField"), principalsEditor.element, I18n.t("certs.admin.sshCert.principalsHint")));
    const days = FormControls.number(daysInit, { min: 1, step: 1 });
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.validityDays"), days, I18n.t("certs.admin.sshCert.daysHint")));
    const info = document.createElement("div"); info.className = "form-hint"; info.style.marginTop = "6px";
    info.textContent = I18n.t("certs.admin.sshCert.info");
    root.appendChild(info);
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: renewOf ? I18n.t("certs.admin.renew.sshCertTitle") : I18n.t("certs.admin.sshCert.title"),
      subtitle: Html.escape(renewOf ? renewOf.label : ca.label),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const id = keyId.value.trim();
        if (id === "") { this.showError(errBox, I18n.t("certs.admin.sshCert.keyIdRequired")); return false; }
        const nbDays = Number(days.value);
        if (!Number.isFinite(nbDays) || nbDays <= 0) { this.showError(errBox, I18n.t("certs.admin.sshCert.daysInvalid")); return false; }
        const principals = principalsEditor.collect();
        try {
          const detail = await this.client!.getOne(ca.id);
          if (!detail.key_enc) { this.showError(errBox, I18n.t("certs.admin.sshCert.noKey")); return false; }
          const caKeyPem = await PkiCrypto.decryptSecret(this.session.key, detail.key_enc);
          const caSeed = await this.seedFromPkcs8Pem(caKeyPem);
          const caSignKey = await SshKeyMaterial.importEd25519PrivateForSigning(caSeed);
          const caPub = CertsAdminView.ed25519PubFromLine(detail.public_pem || "");
          // Paire sujette NEUVE (v1 : la clé naît avec le certificat).
          const subKp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
          const subPub = await SshKeyMaterial.ed25519PublicRaw(subKp.publicKey);
          const subPkcs8Pem = await this.pkcs8Pem(subKp.privateKey);
          const nowSec = Math.floor(Date.now() / 1000);
          const validAfter = nowSec - 300;   // tolérance d'horloge (5 min), parité X509Factory
          const validBefore = nowSec + Math.floor(nbDays) * 86400;
          const serial = crypto.getRandomValues(new Uint32Array(1))[0];
          const enc = await OpenSshEncoder.certificate({
            subjectPublicKey: subPub, serial, type: type.value as SshCertType, keyId: id,
            principals, validAfter, validBefore, caPublicKey: caPub, caPrivateKey: caSignKey, comment: id,
          });
          const keyEnc = await PkiCrypto.encryptSecret(this.session.key, subPkcs8Pem);
          await this.client!.save(CertsAdminView.newId(), {
            kind: "ssh-cert", parent_id: ca.id, label: id, subject: id,
            serial: String(serial), not_before: new Date(validAfter * 1000).toISOString(), not_after: new Date(validBefore * 1000).toISOString(),
            fingerprint: null, key_algo: "ed25519", public_pem: enc.line, key_enc: keyEnc, revoked_at: null,
            sans: principals.map((p) => ({ san_type: "principal", value: p })),
            renewed_from: renewOf ? renewOf.id : undefined,   // lignée (mode 1) ; undefined → null côté serveur
          });
          if (renewOf) await this.revokeSuperseded(renewOf);   // renouvellement : révoque l'ancien (raison auto)
          Notify.toast(renewOf ? I18n.t("certs.admin.renew.sshCertToast") : I18n.t("certs.admin.sshCert.toast"), "ok");
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => keyId.focus(), 30);
  }

  /* --------------------------------------------------------------------------
     Exports (menu par ligne, actifs selon kind/has_key/session)
     -------------------------------------------------------------------------- */

  private async exportModal(item: CertificateListItem): Promise<void> {
    // `all` = liste COMPLÈTE (métadonnées, sans key_enc) pour résoudre les chaînes d'émission (fullchain/
    // ca-chain remontent parent_id) : le listing est paginé, les ancêtres ne sont pas forcément affichés.
    let all: CertExportRecord[];
    try { all = (await this.client!.list()).map((c) => CertsAdminView.toExportRecord(c)); }
    catch (e) { this.actionError(e); return; }
    this.openExportModal(item, all);   // construction/ouverture SYNCHRONE → ré-ouverture sans réseau (aller-retour)
  }

  /** Construit ET ouvre la modale d'export d'un objet (`all` déjà chargé → SYNCHRONE). Les artefacts sont
      présentés en TABLEAU (grille 2 colonnes) : le LIBELLÉ à gauche, les BOUTONS d'action à droite, chaque ligne
      soulignée d'un filet — séparation claire de « quoi » et « comment ». Afficher un artefact TEXTE ouvre une
      visualisation qui REVIENT ICI à sa fermeture (aller-retour, overlay unique → on passe la ré-ouverture
      `() => this.openExportModal(item, all)`). Extraite d'exportModal pour rendre cette ré-ouverture synchrone. */
  private openExportModal(item: CertificateListItem, all: CertExportRecord[]): void {
    const rec = CertsAdminView.toExportRecord(item);
    const root = document.createElement("div");
    const intro = document.createElement("div"); intro.className = "form-hint"; intro.style.marginBottom = "10px";
    intro.textContent = I18n.t("certs.admin.export.intro", { label: item.label });
    root.appendChild(intro);

    // Tableau des artefacts : grille [ libellé (1fr) | actions (auto, alignées à droite) ]. Chaque ligne pose ses
    // DEUX cellules via `addGridRow`, qui applique le filet de séparation et l'espacement communs.
    const list = document.createElement("div");
    list.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:0 24px;align-items:center";
    root.appendChild(list);
    const addGridRow = (labelNode: HTMLElement, actionsNode: HTMLElement): void => {
      for (const cell of [labelNode, actionsNode]) { cell.style.padding = "9px 0"; cell.style.borderBottom = "1px solid var(--line)"; }
      actionsNode.style.justifySelf = "end";   // boutons plaqués à droite → colonne d'actions nette
      list.append(labelNode, actionsNode);
    };
    const labelCell = (text: string): HTMLElement => { const n = document.createElement("span"); n.textContent = text; n.style.cssText = "font-size:13px;color:var(--fg)"; return n; };
    const actionsCell = (): HTMLElement => { const a = document.createElement("div"); a.style.cssText = "display:flex;align-items:center;gap:6px"; return a; };
    const lockTag = (): HTMLElement => { const t = document.createElement("span"); t.className = "lock-tag"; t.textContent = I18n.t("certs.admin.export.lockedTag"); t.title = I18n.t("certs.admin.export.lockedHint"); return t; };

    let hasLocked = false;
    const locked = !this.session.unlocked;

    // Ligne d'action GLOBALE (ZIP, PKCS#12, clé OpenSSH…) : libellé descriptif (col 1) + bouton-icône « exporter »
    // (col 2). `run` renvoie true pour GARDER la modale (ex. PKCS#12 ouvre sa propre modale). `lockedDisabled` :
    // l'artefact exige la clé privée et le coffre est VERROUILLÉ → pastille « Coffre verrouillé » à la place du
    // bouton (l'objet reste listé, la raison est visible + rappelée en tooltip ; le raccourci de déverrouillage
    // apparaît en bas de modale).
    const addAction = (label: string, run: () => Promise<boolean | void>, lockedDisabled = false): void => {
      const acts = actionsCell();
      if (lockedDisabled) { hasLocked = true; acts.appendChild(lockTag()); }
      else acts.appendChild(IconButton.build({ icon: Icons.EXPORT, label: I18n.t("certs.admin.export.download"), onClick: async () => {
        this.session.touch();
        try { const keep = await run(); if (!keep) this.host.closeModal?.(); }
        catch (e) { Notify.toast(CertsAdminView.errText(e), "err"); }   // laisse la modale ouverte
      } }));
      addGridRow(labelCell(label), acts);
    };

    // Artefact TEXTE (PEM / ligne OpenSSH) : libellé (col 1) + « Télécharger (⬇) » et « Afficher (👁) » (col 2).
    // L'AFFICHAGE rend le contenu EN CLAIR à l'écran pour copier-coller (besoin courant) ET REVIENT à cette modale
    // à sa fermeture (aller-retour). Opération SENSIBLE : une clé privée (`sensitive`) exige une confirmation à
    // l'affichage ; une clé privée de ROOT CA exige une confirmation TEXTUELLE (re-saisie d'une phrase) à
    // l'affichage ET au téléchargement — cf. confirmRevealPrivateKey.
    const addTextArtifact = (label: string, produce: () => Promise<ExportArtifact>, opts: { sensitive?: boolean } = {}): void => {
      const acts = actionsCell();
      if (opts.sensitive && locked) {   // clé privée + coffre VERROUILLÉ → pas de déchiffrement possible → pastille seule
        hasLocked = true; acts.appendChild(lockTag()); addGridRow(labelCell(label), acts); return;
      }
      acts.appendChild(IconButton.build({ icon: Icons.EXPORT, label: I18n.t("certs.admin.export.download"), onClick: async () => {
        this.session.touch();
        try {
          if (opts.sensitive && item.kind === "root-ca" && !(await this.confirmRevealPrivateKey(item))) return;   // clé racine : garde textuelle même au téléchargement
          this.download(await produce()); this.host.closeModal?.();
        } catch (e) { Notify.toast(CertsAdminView.errText(e), "err"); }
      } }));
      acts.appendChild(IconButton.build({ icon: Icons.EYE, label: I18n.t("certs.admin.export.display"), onClick: async () => {
        this.session.touch();
        try {
          if (opts.sensitive && !(await this.confirmRevealPrivateKey(item))) return;   // toute clé privée : confirmation (racine → textuelle)
          this.displayArtifact(label, await produce(), () => this.openExportModal(item, all));   // retour ICI à la fermeture
        } catch (e) { Notify.toast(CertsAdminView.errText(e), "err"); }
      } }));
      addGridRow(labelCell(label), acts);
    };

    // Export UNITAIRE « Tout (ZIP) » (L4) : le BUNDLE complet du certificat en une archive (ex. feuille TLS =
    // cert + fullchain + clé en un geste). Clé privée incluse SI session déverrouillée ET clé détenue, sinon
    // artefacts publics seuls — le libellé du bouton l'indique.
    const withKey = this.session.unlocked && item.has_key;
    addAction(I18n.t("certs.admin.export.allZip") + (withKey ? I18n.t("certs.admin.export.allZipWithKey") : I18n.t("certs.admin.export.allZipPublic")), async () => {
      if (item.kind === "root-ca" && withKey && !(await this.confirmRevealPrivateKey(item))) return true;   // le ZIP inclut la clé racine → garde textuelle (true = garde la modale ouverte)
      const keyPem = withKey ? await this.decryptKey(item.id) : null;
      const bundleRec: CertBundleRecord = { id: item.id, label: item.label, parent_id: item.parent_id, public_pem: item.public_pem, revoked_at: item.revoked_at, kind: item.kind, subject: item.subject };
      const artifacts = await CertZip.bundleFor(bundleRec, all, keyPem);
      const zip = CertZip.zipArtifacts([{ artifacts }]);
      Download.data(CertExports.safeFileName(item.label) + ".zip", zip, "application/zip");
    });

    if (item.kind === "root-ca" || item.kind === "leaf-tls") {
      addTextArtifact(I18n.t("certs.admin.export.pubPem"), async () => CertExports.pemCertificate(rec));
      addTextArtifact(I18n.t("certs.admin.export.fullchain"), async () => CertExports.pemFullchain(rec, all));
      if (item.kind === "leaf-tls") addTextArtifact(I18n.t("certs.admin.export.caChain"), async () => CertExports.pemCaChain(rec, all));
      // Certificat CROISÉ d'une CA issue d'une rotation de clé (phase 6) : à déployer chez les clients qui font
      // encore confiance à l'ancien root, pour valider les nouvelles feuilles pendant la transition.
      if (item.cross_signed_pem) addTextArtifact(I18n.t("certs.admin.export.crossCert"), async () => ({ filename: CertExports.safeFileName(item.label) + ".cross.pem", mime: CertExports.MIME_PEM, content: item.cross_signed_pem! }));
      if (item.has_key) {
        addTextArtifact(I18n.t("certs.admin.export.keyPem"), async () => CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id)), { sensitive: true });
        addAction(I18n.t("certs.admin.export.pkcs12"), async () => { this.pkcs12Flow(item, rec, all); return true; }, locked);
      }
    } else if (item.kind === "ssh-ca" || item.kind === "ssh-keypair") {
      if (item.has_key) {
        // Clé OpenSSH (paire privée + .pub) = PLUSIEURS fichiers, dont un binaire → téléchargement seul.
        // La MÊME clé privée est offerte en PKCS#8 PEM juste après (avec affichage copier-coller).
        addAction(I18n.t("certs.admin.export.opensshKey"), async () => {
          const seed = await this.seedFromPkcs8Pem(await this.decryptKey(item.id));
          const publicKey = CertsAdminView.ed25519PubFromLine(item.public_pem || "");
          for (const art of CertExports.opensshArtifacts(rec, { kind: item.kind as "ssh-ca" | "ssh-keypair", seed, publicKey, comment: item.subject })) this.download(art);
        }, locked);
        addTextArtifact(I18n.t("certs.admin.export.keyPem"), async () => CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id)), { sensitive: true });
      }
    } else if (item.kind === "ssh-cert") {
      addTextArtifact(I18n.t("certs.admin.export.sshCert"), async () => CertExports.opensshArtifacts(rec, { kind: "ssh-cert", certLine: item.public_pem || "" })[0]);
      if (item.has_key) addTextArtifact(I18n.t("certs.admin.export.subjectKey"), async () => CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id)), { sensitive: true });
    }

    if (!list.children.length) { const n = document.createElement("div"); n.className = "form-hint"; n.textContent = I18n.t("certs.admin.export.empty"); root.appendChild(n); }
    // Coffre verrouillé ET des exports le REQUIÈRENT (clé privée) → ouvre la modale du coffre avec ALLER-RETOUR :
    // une fois déverrouillé (ou à la fermeture), on REVIENT à CETTE modale d'export, désormais avec les exports
    // de clé disponibles (`reopen` = ré-ouverture synchrone de l'export).
    if (hasLocked) {
      const unlock = document.createElement("button");
      unlock.type = "button"; unlock.className = "btn btn-ghost btn-sm"; unlock.style.marginTop = "12px";
      unlock.textContent = I18n.t("certs.admin.export.unlockVault"); unlock.title = I18n.t("certs.admin.export.unlockVaultTitle");
      unlock.onclick = () => this.unlockModal(() => this.openExportModal(item, all));
      root.appendChild(unlock);
    }
    this.host.openModal({ title: I18n.t("certs.admin.export.title"), subtitle: Html.escape(item.label), body: root, hideFooter: true });
  }

  /** PKCS#12 : la passphrase est demandée EN MODALE et JAMAIS stockée. */
  private pkcs12Flow(item: CertificateListItem, rec: CertExportRecord, all: CertExportRecord[]): void {
    const root = document.createElement("div");
    const info = document.createElement("div"); info.className = "form-hint"; info.style.marginBottom = "10px";
    info.textContent = I18n.t("certs.admin.pkcs12.info");
    root.appendChild(info);
    const pass = FormControls.text("", I18n.t("certs.admin.pkcs12.passPlaceholder")); pass.type = "password"; pass.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.pkcs12.passField"), pass, I18n.t("certs.admin.pkcs12.passHint")));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: I18n.t("certs.admin.pkcs12.title"),
      subtitle: Html.escape(item.label),
      body: root,
      saveLabel: I18n.t("certs.admin.pkcs12.saveLabel"),
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        if (pass.value === "") { this.showError(errBox, I18n.t("certs.admin.common.passRequired")); return false; }
        try {
          const keyPem = await this.decryptKey(item.id);
          this.download(await CertExports.pkcs12(rec, all, { passphrase: pass.value, privateKeyPkcs8Pem: keyPem }));
          Notify.toast(I18n.t("certs.admin.pkcs12.toast"), "ok");
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => pass.focus(), 30);
  }

  /* --------------------------------------------------------------------------
     Aide au déploiement de la confiance (consultation PURE, même verrouillé)
     - root-ca : procédure Linux / Windows / Android (magasins de confiance clients) ;
     - ssh-ca  : variante SSH (serveurs TrustedUserCAKeys / clients @cert-authority).
     Le CONTENU vient de CertDeployGuide (logique pure testée) ; ici, seul le rendu DOM
     (blocs <pre> + bouton « Copier » par commande). La doc pérenne (docs/certs.md) dit
     la MÊME chose — la modale n'est que le pense-bête PRÉ-REMPLI avec le nom du CA.
     -------------------------------------------------------------------------- */

  /** Modale « Déployer la confiance… » d'une autorité (root-ca ou ssh-ca). Aucune clé requise :
      on ne manipule que du PUBLIC (nom de fichier du certificat, ou ligne authorized_keys de la
      CA SSH). PAS de modale sur les autres kinds (bouton non proposé en amont). */
  private deployTrustModal(item: CertificateListItem): void {
    this.session.touch();   // no-op si verrouillé ; ré-arme l'inactivité si ouvert (parité des actions)
    let guide: DeployGuide;
    let subtitle: string;
    if (item.kind === "root-ca") {
      // <FICHIER> = nom assaini du CA + « .crt » (le certificat PUBLIC exporté, renommé — cf. CertDeployGuide).
      const fileName = CertExports.safeFileName(item.label) + ".crt";
      guide = CertDeployGuide.forRootCa(fileName);
      subtitle = I18n.t("certs.admin.deploy.subtitleRootCa", { label: item.label });
    } else if (item.kind === "ssh-ca") {
      // Ligne authorized_keys de la CA SSH (public_pem stocké — public par nature, aucun déchiffrement).
      guide = CertDeployGuide.forSshCa(item.public_pem || "");
      subtitle = I18n.t("certs.admin.deploy.subtitleSshCa", { label: item.label });
    } else {
      return;   // garde-fou : aucun autre kind n'ouvre cette modale
    }
    this.host.openModal({ title: I18n.t("certs.admin.deploy.title"), subtitle: Html.escape(subtitle), body: this.renderDeployGuide(guide), hideFooter: true, wide: true });
  }

  /** Rend un `DeployGuide` en DOM : encadré d'intro, puis une section par plateforme (titre + intro +
      blocs de commande copiables + notes/caveats). Chaque bloc de commande porte un bouton « Copier ». */
  private renderDeployGuide(guide: DeployGuide): HTMLElement {
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:14px";

    // Encadré d'introduction (rappel zéro-connaissance + rôle serveur/clients).
    const introBox = document.createElement("div");
    introBox.style.cssText = "border:1px solid var(--accent);border-radius:6px;padding:10px 12px;background:color-mix(in srgb, var(--accent) 8%, transparent);display:flex;flex-direction:column;gap:6px";
    for (const p of guide.intro) { const d = document.createElement("div"); d.className = "form-hint"; d.style.color = "var(--fg)"; d.textContent = p; introBox.appendChild(d); }
    root.appendChild(introBox);

    for (const section of guide.sections) {
      const sec = document.createElement("div");
      sec.style.cssText = "display:flex;flex-direction:column;gap:8px";
      const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);border-bottom:1px solid var(--line);padding-bottom:4px"; title.textContent = section.title;
      sec.appendChild(title);
      if (section.intro) { const it = document.createElement("div"); it.className = "form-hint"; it.textContent = section.intro; sec.appendChild(it); }
      for (const cmd of section.commands) sec.appendChild(this.deployCommandBlock(cmd.command, cmd.label));
      if (section.notes && section.notes.length) {
        const ul = document.createElement("ul"); ul.style.cssText = "margin:2px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px";
        for (const note of section.notes) { const li = document.createElement("li"); li.className = "form-hint"; li.style.margin = "0"; li.textContent = note; ul.appendChild(li); }
        sec.appendChild(ul);
      }
      root.appendChild(sec);
    }
    return root;
  }

  /** Un bloc de commande PRÉ-REMPLI : étiquette optionnelle + `<pre>` (défilement horizontal) + bouton
      « Copier » (Clipboard : API moderne puis repli execCommand, toast de retour). */
  private deployCommandBlock(command: string, label?: string): HTMLElement {
    const block = document.createElement("div");
    block.style.cssText = "display:flex;flex-direction:column;gap:3px";
    if (label) { const lb = document.createElement("div"); lb.className = "form-hint"; lb.style.margin = "0"; lb.textContent = label; block.appendChild(lb); }
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;align-items:flex-start";
    const pre = document.createElement("pre");
    pre.style.cssText = "flex:1 1 auto;margin:0;padding:8px 10px;background:var(--bg-2);border:1px solid var(--line);border-radius:6px;font-family:var(--mono);font-size:12px;white-space:pre;overflow-x:auto";
    pre.textContent = command;
    const copy = this.actionButton(I18n.t("certs.admin.deploy.copy"), I18n.t("certs.admin.deploy.copyTitle"), () => void Clipboard.copy(command));
    copy.style.flex = "0 0 auto";
    row.append(pre, copy);
    block.appendChild(row);
    return block;
  }

  /* --------------------------------------------------------------------------
     Révocation / suppression
     -------------------------------------------------------------------------- */

  /** Révocation : PUT métadonnées avec revoked_at=now, SANS key_enc (conservé côté serveur). */
  private async revoke(item: CertificateListItem): Promise<void> {
    this.session.touch();
    const reason = await this.revocationReasonDialog(I18n.t("certs.admin.revoke.title"), I18n.t("certs.admin.revoke.message", { label: item.label }));
    if (reason === null) return;   // annulé
    try {
      await this.client!.save(item.id, CertsAdminView.metadataInput(item, { revoked_at: new Date().toISOString(), revocation_reason: reason }));
      Notify.toast(I18n.t("certs.admin.revoke.toast"), "ok");
      await this.refreshBody();
    } catch (e) { this.actionError(e); }
  }

  /** Dialogue de RÉVOCATION : raison NORMÉE (select des codes standard X.509) + note libre. Renvoie la raison
      ENCODÉE (RevocationReasons.encode) sur confirmation, `null` sur annulation. Partagé par la révocation
      unitaire et groupée. `preselect` = code présélectionné (défaut « unspecified »). */
  private async revocationReasonDialog(title: string, message: string, preselect: string = "unspecified"): Promise<string | null> {
    return Dialog.custom({
      title, variant: "danger", danger: true,
      confirmLabel: I18n.t("certs.admin.revoke.btn"), cancelLabel: I18n.t("ui.action.cancel"),
      build: (root: HTMLElement) => {
        const msg = document.createElement("div"); msg.className = "form-hint"; msg.style.marginBottom = "10px"; msg.textContent = message;
        root.appendChild(msg);
        const rf = document.createElement("div"); rf.className = "form-field";
        const rl = document.createElement("label"); rl.textContent = I18n.t("certs.admin.revoke.reasonLabel");
        const sel = FormControls.select(REVOCATION_REASON_CODES.map((c) => ({ value: c, label: I18n.t(RevocationReasons.LABEL_KEY[c]) })), preselect);
        rf.append(rl, sel); root.appendChild(rf);
        const nf = document.createElement("div"); nf.className = "form-field";
        const nl = document.createElement("label"); nl.textContent = I18n.t("certs.admin.revoke.noteLabel");
        const note = FormControls.textArea(""); nf.append(nl, note); root.appendChild(nf);
        setTimeout(() => sel.focus(), 30);
        // `collect` (confirmValueFromBuild) : la valeur résolue par le dialogue à la confirmation = raison encodée.
        return { collect: () => RevocationReasons.encode(sel.value, note.value) };
      },
    });
  }

  /** Suppression : DELETE avec confirmation ; 409 (descendance) → message clair. */
  private async remove(item: CertificateListItem): Promise<void> {
    this.session.touch();
    const ok = await this.confirmDelete([item], I18n.t("certs.admin.remove.title"),
      I18n.t("certs.admin.remove.message", { label: item.label }));
    if (!ok) return;
    try {
      await this.client!.remove(item.id, DeleteGuard.needsForce(item));
      Notify.toast(I18n.t("certs.admin.remove.toast"), "ok");
      await this.refreshBody();
    } catch (e) {
      if (e instanceof CertsError && e.status === 409) {
        Notify.toast(I18n.t("certs.admin.remove.hasChildren"), "err");
        return;
      }
      this.actionError(e);
    }
  }

  /** Confirmation de suppression, à cérémonie PROPORTIONNÉE au risque (DeleteGuard.ceremony) :
      confirmation ordinaire pour un révoqué/expiré · re-saisie du NOM pour un certificat encore
      valide · phrase « Oui je supprime » pour un lot. La saisie n'AUTORISE rien : elle ne fait que
      matérialiser l'intention que le serveur exigera ensuite via `?force=true`. */
  private async confirmDelete(items: DeletableCert[], title: string, message: string): Promise<boolean> {
    const cer = DeleteGuard.ceremony(items);
    if (cer.kind === "simple") return Dialog.confirm({ title, message, confirmLabel: I18n.t("ui.action.delete"), danger: true });

    const activeCount = DeleteGuard.countActive(items);
    const res = await Dialog.custom({
      title, variant: "danger", danger: true, confirmLabel: I18n.t("ui.action.delete"), cancelLabel: I18n.t("ui.action.cancel"),
      build: (root: HTMLElement) => {
        const msg = document.createElement("div"); msg.className = "form-hint"; msg.style.marginBottom = "10px"; msg.textContent = message;
        root.appendChild(msg);
        if (activeCount > 0) {
          const warn = document.createElement("div");
          warn.style.cssText = "margin-bottom:10px;color:var(--err);font-weight:600";
          warn.textContent = activeCount > 1
            ? I18n.t("certs.admin.confirm.activeWarnMany", { count: activeCount })
            : I18n.t("certs.admin.confirm.activeWarnOne");
          root.appendChild(warn);
        }
        const field = document.createElement("div"); field.className = "form-field"; field.style.margin = "0";
        const lab = document.createElement("label");
        lab.textContent = cer.kind === "type-name" ? I18n.t("certs.admin.confirm.nameLabel") : I18n.t("certs.admin.confirm.phraseLabel");
        const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.margin = "0 0 6px";
        hint.textContent = cer.expected;   // textContent → jamais interprété, même si le libellé contient du balisage
        const input = document.createElement("input"); input.type = "text"; input.autocomplete = "off"; input.spellcheck = false;
        // COLLAGE BLOQUÉ : la recopie doit être une VRAIE recopie manuelle — coller la phrase (souvent
        // récupérée du texte de l'invite juste au-dessus) réduirait la cérémonie à un Ctrl-V machinal.
        input.addEventListener("paste", (e) => e.preventDefault());
        field.append(lab, hint, input);
        root.appendChild(field);
        setTimeout(() => input.focus(), 30);
        return {
          validate: () => DeleteGuard.accepts(cer, input.value) ? true
            : (cer.kind === "type-name" ? I18n.t("certs.admin.confirm.nameMismatch") : I18n.t("certs.admin.confirm.phraseMismatch")),
        };
      },
    });
    return res !== null && res !== false;
  }

  /* --------------------------------------------------------------------------
     Helpers crypto (WebCrypto ⇄ formats) — clés jamais persistées ni envoyées
     -------------------------------------------------------------------------- */

  /** Récupère et déchiffre la clé privée d'un objet (GET unitaire → key_enc → decryptSecret). */
  private async decryptKey(id: string): Promise<string> {
    const detail = await this.client!.getOne(id);
    if (!detail.key_enc) throw new Error("Aucune clé privée détenue pour cet objet.");
    return PkiCrypto.decryptSecret(this.session.key, detail.key_enc);
  }

  /** Clé privée WebCrypto (extractible) → PKCS#8 PEM (via PemConverter de @peculiar, déjà au graphe). */
  private async pkcs8Pem(key: CryptoKey): Promise<string> {
    return x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", key), "PRIVATE KEY");
  }

  /** PKCS#8 PEM ed25519 → graine de 32 octets (ré-import extractible puis SshKeyMaterial). */
  private async seedFromPkcs8Pem(pem: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("pkcs8", x509.PemConverter.decodeFirst(pem), "Ed25519", true, ["sign"]);
    return SshKeyMaterial.ed25519Seed(key);
  }

  /** Déclenche le téléchargement d'un artefact (texte ou binaire indifféremment). */
  private download(artifact: ExportArtifact): void {
    Download.data(artifact.filename, artifact.content, artifact.mime);
  }

  /** Affiche le contenu d'un artefact TEXTE EN CLAIR (zone en lecture seule + « Copier ») pour copier-coller.
      Un artefact BINAIRE (PKCS#12) n'est pas affichable → toast. Remplace la modale courante (overlay UNIQUE de l'app). */
  private displayArtifact(title: string, artifact: ExportArtifact, reopen?: () => void): void {
    if (typeof artifact.content !== "string") { Notify.toast(I18n.t("certs.admin.export.notDisplayable"), "warn"); return; }
    const content = artifact.content;
    const root = document.createElement("div");
    const bar = document.createElement("div"); bar.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px";
    const name = document.createElement("span"); name.style.cssText = "font-family:var(--mono);font-size:12px;color:var(--fg-dim)"; name.textContent = artifact.filename;
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn btn-ghost btn-sm icon-action";
    copy.title = I18n.t("certs.admin.export.copy"); copy.setAttribute("aria-label", I18n.t("certs.admin.export.copy")); copy.innerHTML = Icons.CLONE;
    copy.onclick = () => { void Clipboard.copy(content, I18n.t("certs.admin.export.copied")); };   // toast UNIQUE (géré par Clipboard.copy) — plus de doublon
    bar.append(name, copy);
    const ta = document.createElement("textarea"); ta.readOnly = true; ta.value = content;
    // Zone en lecture seule THÉMATISÉE (mêmes variables que les champs `.form-field` : fond/texte/bordure du
    // thème courant) — un textarea nu prendrait le blanc par défaut du navigateur, illisible en thème sombre.
    ta.style.cssText = "width:100%;min-height:300px;box-sizing:border-box;font-family:var(--mono);font-size:12px;white-space:pre;overflow:auto;resize:vertical;background:var(--bg);color:var(--fg);border:1px solid var(--line-2);border-radius:var(--radius-pill);padding:10px";
    ta.onclick = () => ta.select();
    root.append(bar, ta);
    // Aller-retour (overlay UNIQUE) : à la FERMETURE de cette visualisation (croix / Échap / clic hors-modale),
    // on rouvre la modale d'export d'où elle a été ouverte (`reopen`), au lieu de tout fermer. `onClose` couvre
    // TOUTE cause de fermeture (cf. Modal.onClose) — c'est exactement le signal « je reviens en arrière ».
    this.host.openModal({ title: I18n.t("certs.admin.export.displayTitle"), subtitle: Html.escape(title), body: root, hideFooter: true, wide: true, onClose: reopen });
  }

  /** Confirmation avant de RÉVÉLER une clé privée (afficher en clair OU télécharger). Une clé de CA RACINE
      exige une confirmation TEXTUELLE (re-saisie d'une phrase, comme la suppression — collage bloqué) : sa
      compromission ruine TOUTE la PKI. Toute autre clé privée : confirmation simple (l'opération met un secret
      à l'écran / au disque). Renvoie true si l'utilisateur confirme. */
  private async confirmRevealPrivateKey(item: CertificateListItem): Promise<boolean> {
    if (item.kind !== "root-ca") {
      return Dialog.confirm({ title: I18n.t("certs.admin.reveal.title"), message: I18n.t("certs.admin.reveal.message", { label: item.label }), confirmLabel: I18n.t("certs.admin.reveal.confirm"), danger: true });
    }
    const expected = I18n.t("certs.guard.revealRoot");
    const res = await Dialog.custom({
      title: I18n.t("certs.admin.reveal.rootTitle"), variant: "danger", danger: true,
      confirmLabel: I18n.t("certs.admin.reveal.confirm"), cancelLabel: I18n.t("ui.action.cancel"),
      build: (root: HTMLElement) => {
        const msg = document.createElement("div"); msg.className = "form-hint"; msg.style.marginBottom = "10px";
        msg.textContent = I18n.t("certs.admin.reveal.rootMessage", { label: item.label });
        root.appendChild(msg);
        const warn = document.createElement("div"); warn.style.cssText = "margin-bottom:10px;color:var(--err);font-weight:600";
        warn.textContent = I18n.t("certs.admin.reveal.rootWarn");
        root.appendChild(warn);
        const field = document.createElement("div"); field.className = "form-field"; field.style.margin = "0";
        const lab = document.createElement("label"); lab.textContent = I18n.t("certs.admin.confirm.phraseLabel");
        const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.margin = "0 0 6px"; hint.textContent = expected;
        const input = document.createElement("input"); input.type = "text"; input.autocomplete = "off"; input.spellcheck = false;
        input.addEventListener("paste", (e) => e.preventDefault());   // vraie recopie manuelle (comme confirmDelete)
        field.append(lab, hint, input);
        root.appendChild(field);
        setTimeout(() => input.focus(), 30);
        return { validate: () => input.value.trim() === expected ? true : I18n.t("certs.admin.confirm.phraseMismatch") };
      },
    });
    return res !== null && res !== false;
  }

  /* --------------------------------------------------------------------------
     Éditeurs de listes dynamiques (SAN / principaux)
     -------------------------------------------------------------------------- */

  /** Éditeur de lignes SAN (type dns/ip/email + valeur) ajoutables/retirables. */
  private buildSanEditor(initial?: CertSan[]): { element: HTMLElement; collect: () => CertSan[] } {
    const container = document.createElement("div");
    const rows = document.createElement("div"); rows.style.cssText = "display:flex;flex-direction:column;gap:6px";
    const entries: Array<{ type: HTMLSelectElement; value: HTMLInputElement }> = [];
    // `pre` (pré-remplissage, cas du RENOUVELLEMENT) : la ligne naît avec le type + la valeur du SAN d'origine.
    const addRow = (pre?: CertSan): void => {
      const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;align-items:center";
      const type = FormControls.select(CertsAdminView.sanTypeOpts(), pre ? pre.san_type : "dns"); type.style.flex = "0 0 90px";
      const value = FormControls.text(pre ? pre.value : "", I18n.t("certs.admin.san.valuePlaceholder")); value.style.flex = "1 1 auto";
      const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm"; del.innerHTML = Icons.CLOSE; del.title = I18n.t("ui.chips.remove");
      const entry = { type, value };
      del.onclick = () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); row.remove(); };
      row.append(type, value, del); rows.appendChild(row); entries.push(entry);
    };
    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-ghost btn-sm"; add.style.marginTop = "6px";
    add.textContent = I18n.t("certs.admin.san.addSan"); add.onclick = () => addRow();
    container.append(rows, add);
    if (initial && initial.length) initial.forEach((s) => addRow(s));   // renouvellement : reprend les SAN d'origine
    else addRow();   // une ligne vide par défaut
    return {
      element: container,
      collect: () => entries.map((e) => ({ san_type: e.type.value as CertSan["san_type"], value: e.value.value.trim() })).filter((s) => s.value !== ""),
    };
  }

  /** Éditeur de lignes « principal » SSH (valeur seule) ajoutables/retirables. */
  private buildPrincipalsEditor(initial?: string[]): { element: HTMLElement; collect: () => string[] } {
    const container = document.createElement("div");
    const rows = document.createElement("div"); rows.style.cssText = "display:flex;flex-direction:column;gap:6px";
    const inputs: HTMLInputElement[] = [];
    const addRow = (pre?: string): void => {
      const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;align-items:center";
      const value = FormControls.text(pre || "", I18n.t("certs.admin.san.principalPlaceholder")); value.style.flex = "1 1 auto";
      const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm"; del.innerHTML = Icons.CLOSE; del.title = I18n.t("ui.chips.remove");
      del.onclick = () => { const i = inputs.indexOf(value); if (i >= 0) inputs.splice(i, 1); row.remove(); };
      row.append(value, del); rows.appendChild(row); inputs.push(value);
    };
    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-ghost btn-sm"; add.style.marginTop = "6px";
    add.textContent = I18n.t("certs.admin.san.addPrincipal"); add.onclick = () => addRow();
    container.append(rows, add);
    if (initial && initial.length) initial.forEach((p) => addRow(p));   // renouvellement : reprend les principals
    else addRow();
    return { element: container, collect: () => inputs.map((i) => i.value.trim()).filter((v) => v !== "") };
  }

  /* --------------------------------------------------------------------------
     Messages d'indisponibilité / erreurs
     -------------------------------------------------------------------------- */

  /** Mode fichier/viewer : le service n'a pas d'objet (pas de serveur) → message clair, aucun appel réseau. */
  private renderNeedsApi(): void {
    this.renderBanner("var(--line)", I18n.t("certs.admin.msg.needsApiTitle"), I18n.t("certs.admin.msg.needsApi"));
  }

  /** Aucun document courant : rien à administrer tant qu'un document n'est pas ouvert. */
  private renderNoDoc(): void {
    this.renderBanner("var(--line)", I18n.t("certs.admin.msg.noDocTitle"), I18n.t("certs.admin.msg.noDoc"));
  }

  /** 503 : module certificats en erreur côté serveur (ex. certs.db illisible) → détail actionnable. */
  private renderDisabled(err: CertsError): void {
    this.renderBanner("var(--warn)", err.message || I18n.t("certs.admin.msg.disabledTitle"),
      err.detail || I18n.t("certs.admin.msg.disabled"));
  }

  private renderBanner(borderColor: string, titleText: string, detailText: string): void {
    this.container.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid " + borderColor + ";border-radius:6px;padding:16px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:6px"; title.textContent = titleText;
    const detail = document.createElement("div"); detail.className = "form-hint"; detail.style.whiteSpace = "pre-line"; detail.textContent = detailText;
    box.append(title, detail); this.container.appendChild(box);
  }

  /** Message plein contenu (erreur de chargement) — remplace le contenu. */
  private renderMessage(text: string, isError = false): void {
    this.container.innerHTML = "";
    const n = document.createElement("div"); n.className = isError ? "form-hint err" : "form-hint"; n.textContent = text;
    this.container.appendChild(n);
  }

  /** Erreur d'une action ponctuelle → 503 : bandeau ; sinon toast. */
  private actionError(e: unknown): void {
    if (e instanceof CertsError && e.status === 503) { this.renderDisabled(e); return; }
    Notify.toast(CertsAdminView.errText(e), "err");
  }

  /** Affiche une erreur dans la zone d'erreur d'un formulaire. 503 (module coupé) : plus rien à
      éditer — on FERME la modale et on affiche le bandeau à la place du contenu. */
  private showError(errBox: HTMLElement, e: unknown): void {
    if (e instanceof CertsError && e.status === 503) { this.host.closeModal?.(); this.renderDisabled(e); return; }
    errBox.style.display = "block";
    errBox.textContent = typeof e === "string" ? e : CertsAdminView.errText(e);
  }

  /* --------------------------------------------------------------------------
     Primitives DOM + helpers statiques
     -------------------------------------------------------------------------- */

  private static readonly MUTED = `<span style="color:var(--fg-dimmer)">—</span>`;

  private actionButton(label: string, title: string, onClick: () => void, cls = "btn-ghost"): HTMLButtonElement {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn " + cls + " btn-sm";
    b.textContent = label; if (title) b.title = title; b.onclick = onClick;
    return b;
  }

  /** Pastille sémantique (mêmes couleurs que NotificationsAdminView/VmClustersView). */
  private pill(text: string, kind: "ok" | "err" | "warn" | "neutral"): string {
    const style = kind === "ok" ? ` style="border-color:var(--ok);color:var(--ok)"`
      : kind === "err" ? ` style="border-color:var(--err);color:var(--err)"`
      : kind === "warn" ? ` style="border-color:var(--warn);color:var(--warn)"`
      : "";
    return `<span class="pill"${style}>${Html.escape(text)}</span>`;
  }

  /** Cellule de table dont le contenu est du HTML déjà échappé ; `cls` = alignement éventuel (ex. « cell-num »). */
  private htmlCell(html: string, cls = ""): HTMLTableCellElement {
    const td = document.createElement("td"); if (cls) td.className = cls; td.innerHTML = html; return td;
  }

  private errBox(): HTMLElement {
    const e = document.createElement("div"); e.className = "form-hint err"; e.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    return e;
  }

  /* -- Options de sélecteurs (libellés LOCALISÉS) : construites À L'APPEL (rendu), jamais au chargement. -- */
  /** Algorithmes de clé X.509 proposés à la création. */
  private static algoX509Opts(): SelectOption[] {
    return [
      { value: "ec-p256", label: I18n.t("certs.admin.algo.ecP256") },
      { value: "rsa-2048", label: I18n.t("certs.admin.algo.rsa2048") },
      { value: "rsa-4096", label: I18n.t("certs.admin.algo.rsa4096") },
    ];
  }
  /** Usage d'une feuille TLS → ExtendedKeyUsage. */
  private static usageOpts(): SelectOption[] {
    return [
      { value: "server", label: I18n.t("certs.admin.usage.server") },
      { value: "client", label: I18n.t("certs.admin.usage.client") },
      { value: "both", label: I18n.t("certs.admin.usage.both") },
    ];
  }
  /** Types de SAN X.509 (le « principal » SSH est saisi séparément pour un certificat SSH). */
  private static sanTypeOpts(): SelectOption[] {
    return [
      { value: "dns", label: I18n.t("certs.admin.san.dns") },
      { value: "ip", label: I18n.t("certs.admin.san.ip") },
      { value: "email", label: I18n.t("certs.admin.san.email") },
    ];
  }
  /** Type d'un certificat SSH. */
  private static sshCertTypeOpts(): SelectOption[] {
    return [
      { value: "user", label: I18n.t("certs.admin.sshType.user") },
      { value: "host", label: I18n.t("certs.admin.sshType.host") },
    ];
  }
  /** Options du filtre « État » (cycle de vie CertsFormat.lifecycle) — SÉLECTION UNIQUE. Le « Tous » n'est PAS
      listé ici : la FilterBar l'ajoute elle-même (option « Tous » d'une dimension `single`). Valeurs alignées sur
      CertLifecycle (active | expiring | revoked | expired) → filtre client via CertTree.visibleIds. */
  private static stateFilterItems(): MultiItem[] {
    return [
      { id: "active", label: I18n.t("certs.admin.status.active") },
      { id: "expiring", label: I18n.t("certs.admin.status.expiring") },
      { id: "revoked", label: I18n.t("certs.admin.status.revoked") },
      { id: "expired", label: I18n.t("certs.admin.status.expired") },
    ];
  }

  /** Identifiant neuf pour une création (PUT idempotent par id côté serveur). */
  private static newId(): string {
    try { if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID(); } catch (_) { /* repli ci-dessous */ }
    return "c-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** Horodatage compact `YYYYMMDD-HHMMSS` (heure locale) — nom d'archive ZIP d'un export groupé lisible et unique. */
  private static stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /** DN X.509 lisible depuis CN (+ OU puis O éventuels, ordre X.500 CN < OU < O) — sert de `subject`
      stocké/affiché. Doit rester COHÉRENT avec X509Factory.buildDistinguishedName (même ordre de RDN). */
  private static subjectDn(commonName: string, organization?: string, organizationalUnit?: string): string {
    const parts = ["CN=" + commonName];
    if (organizationalUnit && organizationalUnit.trim() !== "") parts.push("OU=" + organizationalUnit.trim());
    if (organization && organization.trim() !== "") parts.push("O=" + organization.trim());
    return parts.join(", ");
  }

  /** Valeur d'un RDN (`O`, `OU`…) lue dans un DN stocké (« CN=…, OU=…, O=… ») — pour pré-remplir le sujet d'une
      feuille depuis celui de sa CA (l'organisation est le plus souvent partagée). "" si absent. Casse de clé
      tolérée ; le nom de clé est comparé EXACTEMENT (« O » ne matche pas « OU »). */
  private static parseDnField(dn: string, key: string): string {
    if (typeof dn !== "string") return "";
    for (const rdn of dn.split(",")) {
      const eq = rdn.indexOf("=");
      if (eq >= 0 && rdn.slice(0, eq).trim().toUpperCase() === key.toUpperCase()) return rdn.slice(eq + 1).trim();
    }
    return "";
  }

  /** Vue MINIMALE d'un certificat pour les exports (sous-ensemble du DTO, cf. CertExportRecord). */
  private static toExportRecord(item: CertificateListItem): CertExportRecord {
    return { id: item.id, label: item.label, parent_id: item.parent_id, public_pem: item.public_pem, revoked_at: item.revoked_at };
  }

  /** Corps PUT de métadonnées depuis un item de liste (SANS key_enc → conservé), plus un correctif. */
  private static metadataInput(item: CertificateListItem, patch: Partial<CertificateInput>): CertificateInput {
    return {
      kind: item.kind, parent_id: item.parent_id, label: item.label, subject: item.subject,
      serial: item.serial, not_before: item.not_before, not_after: item.not_after, fingerprint: item.fingerprint,
      key_algo: item.key_algo, public_pem: item.public_pem, revoked_at: item.revoked_at,
      // Métadonnées PRÉSERVÉES par défaut (une mise à jour comme la révocation ne doit pas les effacer) ;
      // `patch` peut les remplacer (ex. revocation_reason à la révocation).
      comment: item.comment, revocation_reason: item.revocation_reason, renewed_from: item.renewed_from, cross_signed_pem: item.cross_signed_pem,
      sans: item.sans,
      ...patch,
    };
  }

  /** Ligne authorized_keys ed25519 → 32 octets de clé publique brute (blob wire : 32 derniers octets). */
  private static ed25519PubFromLine(line: string): Uint8Array {
    const token = String(line || "").trim().split(/\s+/)[1] || "";
    if (token === "") throw new Error("ligne OpenSSH illisible (clé publique absente)");
    const blob = SshWire.fromBase64(token);
    if (blob.length < 32) throw new Error("ligne OpenSSH illisible (blob trop court)");
    return blob.slice(blob.length - 32);
  }

  private static errText(e: unknown): string {
    if (e instanceof CertsError) return e.message + (e.detail ? "\n" + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}

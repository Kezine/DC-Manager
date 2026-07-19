import { Html } from "../core/Html";
import { Format } from "../core/Format";
import { CertsFormat } from "../core/CertsFormat";
import { CertsSearch, type CertSearchItem, type CertNavTarget } from "../core/CertsSearch";
import { SearchPop, type SearchPopResult } from "../ui/SearchPop";
import { FormControls, type SelectOption } from "../ui/FormControls";
import { type MultiItem } from "../ui/MultiSelect";
import { FilterBar } from "../ui/FilterBar";
import { CardTable } from "../ui/CardTable";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_OPTIONS } from "../data/config";
import { Notify } from "../ui/Notify";
import { Clipboard } from "../ui/Clipboard";
import { Dialog } from "../ui/Dialog";
import { RichTooltip } from "../ui/RichTooltip";
import { Icons } from "../ui/Icons";
import { IconButton } from "../ui/IconButton";
import { CertsTips, CERT_TIP } from "./CertsTips";
import { DeleteGuard, type DeletableCert } from "../certs/DeleteGuard";
import { I18n } from "../i18n/I18n";
import { Download } from "../core/Download";
import { CertDeployGuide, type DeployGuide } from "../core/CertDeployGuide";
import type { FormHost } from "./forms/shared";
import { CertsError } from "./forms/CertsClient";
import type { CertsClient, CertificateListItem, CertificateInput, CertSan, PkiState, CertificatePageItem, CertificateRootItem, CertsListParams } from "./forms/CertsClient";
import { PkiCrypto } from "../certs/PkiCrypto";
import { PkiSession } from "../certs/PkiSession";
import { X509Factory, type X509KeyAlgo, type LeafUsage, type X509San } from "../certs/X509Factory";
import { OpenSshEncoder, type SshCertType } from "../certs/OpenSshEncoder";
import { SshKeyMaterial } from "../certs/SshKeyMaterial";
import { SshWire } from "../certs/SshWire";
import { CertExports, type CertExportRecord, type ExportArtifact } from "../certs/CertExports";
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

   DEUX LISTINGS PAGINÉS SERVEUR (l'arbre O(n) ne tenait pas ~100 dérivés/racine) :
   - VUE A « Autorités & clés » (par défaut) : racines + agrégats (GET /certs/roots) ;
   - VUE B « Certificats de <racine> » : sous-arbre d'une racine (GET /certs?root=…).
   Filtres (Type/État), tris par en-tête et pagination portés par la REQUÊTE (jamais de
   slice client) ; l'UI reprend les classes CSS des ListView (pagination/toolbar). L'état
   de listing (page/pageSize/tris/filtres/vue courante + racine) vit en MÉMOIRE d'instance
   (pas de sessionStorage : cohérence après écritures). La recherche (L3) et la sélection
   multiple (L4) viendront APRÈS — le terrain est préparé (une méthode de rendu par vue).

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

/* Les LIBELLÉS des options/filtres sont localisés → construits AU POINT DE RENDU (méthodes statiques
   `CertsAdminView.*Opts()`), jamais au chargement du module (avant `I18n.init()`). Ne restent en données
   PURES au niveau module que les IDENTIFIANTS de familles proposés à chaque vue (valeurs de kind non
   traduisibles — le libellé est résolu par `CertsFormat.kindLabel` à la construction du MultiSelect). */
/** Familles proposées au filtre « Type » de la VUE A (autorités & clés = premier niveau, parent_id nul). */
const ROOT_KIND_FILTER_IDS = ["root-ca", "ssh-ca", "ssh-keypair"];
/** Familles proposées au filtre « Type » de la VUE B (dérivés émis en v1 : feuilles TLS + certificats SSH ;
    les CA intermédiaires ne sont pas produites en v1 — le schéma les autoriserait, cf. cadrage). */
const CERT_KIND_FILTER_IDS = ["leaf-tls", "ssh-cert"];

/** État d'un listing (mémoire d'instance — PAS de sessionStorage en v1 : les volumes vivent côté serveur et
    l'état doit rester cohérent après chaque écriture). `status` = "" signifie « tous » (aucun filtre d'état). */
interface ListingState {
  page: number;
  pageSize: number;
  sort: string;
  dir: "asc" | "desc";
  kinds: Set<string>;
  status: string;
}

export class CertsAdminView {
  /** Signal ÉMIS après tout rechargement du corps de listing (dont création / suppression / révocation) : la vue
      prévient l'hôte que le NOMBRE TOTAL de certificats a pu changer, pour rafraîchir le badge de l'onglet — tenu
      HORS de cette vue (compteur caché maintenu en async dans main.ts, la donnée étant paginée serveur alors que
      le count() du shell est synchrone). Branché sur refreshBody() (chokepoint de tous les rechargements après
      écriture) plutôt que dispersé sur chaque site : robuste (aucune mutation oubliée) ; un rechargement de simple
      pagination/tri/filtre déclenche aussi un recomptage (requête pageSize:1, coût négligeable). Optionnel. */
  onCountsChanged?: () => void;

  /** Coffre de session détenant la clé maître dérivée (créé au constructeur, onLock → re-render). */
  private readonly session: PkiSession;
  /** Dernier état PKI connu (null = pas encore chargé). */
  private pkiState: PkiState | null = null;
  /** Garde anti-rechargements concurrents. */
  private loading = false;

  /** Vue active : A « Autorités & clés » (racines) par défaut, B « Certificats d'une racine ». */
  private view: "roots" | "certs" = "roots";
  /** Racine scopée en vue B (id + libellé pour le fil d'Ariane) ; null en vue A. */
  private rootScope: { id: string; label: string } | null = null;
  /** États de listing SÉPARÉS par vue : revenir en A conserve sa page/ses filtres ; entrer en B repart neuf. */
  private rootsState: ListingState = CertsAdminView.defaultState();
  private certsState: ListingState = CertsAdminView.defaultState();
  /** Métadonnées de pagination de la page courante (null tant qu'aucune page chargée). */
  private pageMeta: { total: number; page: number; pages: number; pageSize: number } | null = null;
  /** Items de la page courante — un seul jeu est actif selon la vue (JAMAIS key_enc, consultable verrouillé). */
  private rootItems: CertificateRootItem[] = [];
  private certItems: CertificatePageItem[] = [];
  /** Conteneur du corps (table + pagination) — repeint SEUL sur tri/pagination/filtre (toolbar préservée). */
  private bodyEl: HTMLElement | null = null;
  /** Champ de recherche + popover (L3) — instance UNIQUE réemployée à chaque rebuild de toolbar (l'élément
      est simplement re-rattaché ; le terme saisi et l'anti-rebond survivent). Créé à la volée. */
  private searchPop: SearchPop | null = null;
  /** Barre de filtres unifiée (chips « Type/État » + « + Filtre » + Réinitialiser) — bâtie au rendu complet,
      PRÉSERVÉE sur refreshBody (un changement de filtre ne repeint que ses chips + le corps). */
  private filterBar: FilterBar | null = null;
  /** Id de la ligne à mettre en évidence après une navigation par la recherche (`.row-focus`). CONSOMMÉ au
      premier `paintBody` (mis à null après application), pour qu'un repaint ultérieur (tri/page) ne la ré-allume pas. */
  private focusId: string | null = null;

  /** SÉLECTION MULTIPLE (L4) : instantané par id des éléments cochés. SURVIT aux changements de page/tri/filtre
      DANS la vue courante ; VIDÉE au changement de vue (A↔B, recherche) et après une action groupée. Un snapshot
      minimal (kind/label/has_key/revoked_at) suffit à décider les actions communes et au bilan (BulkActions). */
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
    void this.reload();
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
      // PKI (état de la clé maître) + page courante en parallèle — le listing est consultable AVANT tout
      // déverrouillage (lecture seule) ; la page chargée dépend de la vue/filtres/tri courants.
      const [pki] = await Promise.all([this.client!.pki(), this.loadCurrentPage()]);
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
    if (!this.session.unlocked) this.container.appendChild(this.buildLockPanel());
    this.container.appendChild(this.buildListingSection());
    this.paintBody();
  }

  /** Barre de contrôles UNIFIÉE (revue design lot C) : recherche EN TÊTE (extensible, loupe intégrée), filtres
      « Type/État » en CHIPS + « + Filtre » (FilterBar partagée), puis le cluster de DROITE (état du coffre,
      créations/changement de phrase/verrou/actualisation, « Réinitialiser » le plus à droite). NON reconstruite
      sur refreshBody → recherche et panneau de filtre ouverts survivent. */
  private buildToolbar(): HTMLElement {
    const bar = document.createElement("div"); bar.className = "list-chrome";

    // Recherche : visible dans les DEUX vues et MÊME verrouillée — elle ne lit que des métadonnées (aucune
    // opération de clé). Le clic sur un résultat ouvre la bonne vue avec l'élément mis en évidence.
    bar.appendChild(this.searchBox());

    // Filtres « Type » (répétable) + « État » (sélection UNIQUE — le serveur n'accepte qu'un status) → chips.
    bar.appendChild(this.buildFilters());

    const right = document.createElement("div"); right.className = "lc-right";
    // Badge d'état du coffre : SEULEMENT si la PKI existe (non initialisée = aucune clé encore, l'écran
    // d'initialisation l'explique). Placé en tête du cluster de droite (état + actions).
    if (this.pkiState?.initialized === true) {
      const status = document.createElement("span"); status.className = "lc-lockbadge";
      status.innerHTML = this.session.unlocked ? this.pill(I18n.t("certs.admin.toolbar.unlocked"), "ok") : this.pill(I18n.t("certs.admin.toolbar.locked"), "warn");
      right.appendChild(status);
    }
    if (this.session.unlocked) {
      right.append(
        this.actionButton(I18n.t("certs.admin.toolbar.addRootCa"), I18n.t("certs.admin.toolbar.addRootCaTitle"), () => this.rootCaModal(), "btn-primary"),
        this.actionButton(I18n.t("certs.admin.toolbar.addSshCa"), I18n.t("certs.admin.toolbar.addSshCaTitle"), () => this.sshKeyModal("ssh-ca"), "btn-primary"),
        this.actionButton(I18n.t("certs.admin.toolbar.addSshPair"), I18n.t("certs.admin.toolbar.addSshPairTitle"), () => this.sshKeyModal("ssh-keypair"), "btn-primary"),
      );
      right.appendChild(this.actionButton(I18n.t("certs.admin.toolbar.changePass"), I18n.t("certs.admin.toolbar.changePassTitle"), () => this.changePassphraseModal()));
      right.appendChild(this.actionButton(I18n.t("certs.admin.toolbar.lock"), I18n.t("certs.admin.toolbar.lockTitle"), () => { this.session.lock(); }));
    }
    right.appendChild(this.actionButton(I18n.t("certs.admin.toolbar.refresh"), I18n.t("certs.admin.toolbar.refreshTitle"), () => { this.session.touch(); void this.reload(); }));
    if (this.filterBar) right.appendChild(this.filterBar.resetElement);

    bar.appendChild(right);
    return bar;
  }

  /** FilterBar de la vue courante : « Type » (MultiSelect → chips, familles pertinentes à la vue A/B) + « État »
      (sélection UNIQUE — un `<select>` proxifié par un Set 0/1 reporté dans `state.status`). Reconstruite à chaque
      rendu complet ; préservée sur refreshBody (un changement de valeur ne repeint que chips + corps). */
  private buildFilters(): HTMLElement {
    const st = this.currentState();
    // Familles proposées + purge de celles mémorisées hors du jeu de la vue (évite un filtre fantôme).
    const kindItems: MultiItem[] = (this.view === "roots" ? ROOT_KIND_FILTER_IDS : CERT_KIND_FILTER_IDS).map((id) => ({ id, label: CertsFormat.kindLabel(id) }));
    const valid = new Set(kindItems.map((k) => k.id));
    [...st.kinds].forEach((k) => { if (!valid.has(k)) st.kinds.delete(k); });
    // État : le serveur n'accepte qu'UN status → dimension `single` ; le Set (0/1) fait autorité et se reporte
    // dans `st.status` à chaque changement. Options sans le « Tous » (la FilterBar l'ajoute elle-même).
    const statusSet = new Set<string>(st.status ? [st.status] : []);
    const statusItems: MultiItem[] = CertsAdminView.statusFilterOpts().filter((o) => o.value !== "").map((o) => ({ id: o.value, label: o.label }));
    this.filterBar = new FilterBar([
      { key: "kinds", label: I18n.t("lists.col.type"), options: kindItems, selected: st.kinds },
      { key: "status", label: I18n.t("certs.admin.listing.colState"), options: statusItems, selected: statusSet, single: true },
    ], () => {
      st.status = [...statusSet][0] || "";
      st.page = 1;
      this.session.touch();
      void this.refreshBody();
    });
    return this.filterBar.filtersElement;
  }

  /* --------------------------------------------------------------------------
     Recherche (L3) — champ + popover (SearchPop réutilisable), clic → bonne vue
     avec l'élément mis en évidence. La logique PURE (mapping/décision de navigation)
     vit dans CertsSearch ; ici, seuls le branchement réseau et la navigation.
     -------------------------------------------------------------------------- */

  /** Élément de recherche pour la toolbar : instance UNIQUE de SearchPop (réemployée à chaque rebuild). */
  private searchBox(): HTMLElement {
    if (!this.searchPop) {
      this.searchPop = new SearchPop({
        placeholder: I18n.t("certs.admin.toolbar.searchPlaceholder"),
        grow: true,   // barre de listing : champ extensible + loupe intégrée, à la hauteur de contrôle unifiée
        fetch: (query) => this.searchFetch(query),
        onPick: (result) => this.searchPick(result),
      });
    }
    return this.searchPop.element;
  }

  /** Source des résultats : une page COURTE (8) de la liste plate de tout le document (aucune portée de vue —
      la recherche traverse racines ET dérivés). Map en résultats via CertsSearch (badge = famille lisible). */
  private async searchFetch(query: string): Promise<SearchPopResult[]> {
    const page = await this.client!.listPage({ query, pageSize: 8 });
    return page.certificates.map((c) => CertsSearch.toResult(c));
  }

  /** Clic (ou Entrée) sur un résultat : calcule la cible de navigation (CertsSearch.navTarget) puis ouvre
      la page CONTENANT l'élément avec surbrillance. Le popover est déjà fermé par SearchPop.pick. */
  private searchPick(result: SearchPopResult): void {
    this.session.touch();
    void this.navigateToFocus(CertsSearch.navTarget(result.data as CertSearchItem));
  }

  /** Ouvre la vue portant l'élément (A racines si premier niveau, B sous-arbre sinon), à la page qui le
      CONTIENT (paramètre `focus` : le serveur recalcule la page sous le tri/filtres courants), puis surligne
      sa ligne. On RÉINITIALISE les filtres/tri du listing cible : le focus est calculé SOUS ces filtres — un
      filtre résiduel (ex. « Type ») pourrait EXCLURE l'élément et rendre le focus introuvable ; repartir de
      défauts garantit qu'il figure bien dans la page renvoyée. */
  private async navigateToFocus(nav: CertNavTarget): Promise<void> {
    await this.guarded(async () => {
      this.selection.clear();   // navigation par la recherche = (ré)ouverture d'une vue : sélection remise à zéro
      if (nav.view === "roots") {
        this.view = "roots";
        this.rootScope = null;
        this.rootsState = CertsAdminView.defaultState();
        const res = await this.client!.listRoots({ ...CertsAdminView.listParams(this.rootsState), focus: nav.focus });
        this.rootItems = res.certificates;
        this.pageMeta = { total: res.total, page: res.page, pages: res.pages, pageSize: res.pageSize };
        this.rootsState.page = res.page;
      } else {
        this.view = "certs";
        this.certsState = CertsAdminView.defaultState();
        // Fil d'Ariane : la vue B liste le sous-arbre STRICT (racine EXCLUE), la racine n'est donc pas dans la
        // page de focus. On lit ses métadonnées (GET unitaire, aucun déchiffrement) pour un libellé lisible ;
        // repli sur l'id court si l'appel échoue (le scope, lui, tient au seul id).
        let rootLabel = CertsFormat.shortId(nav.rootId!);
        try { rootLabel = (await this.client!.getOne(nav.rootId!)).label || rootLabel; } catch (_) { /* repli id court */ }
        this.rootScope = { id: nav.rootId!, label: rootLabel };
        const res = await this.client!.listPage({ ...CertsAdminView.listParams(this.certsState), root: nav.rootId!, focus: nav.focus });
        this.certItems = res.certificates;
        this.pageMeta = { total: res.total, page: res.page, pages: res.pages, pageSize: res.pageSize };
        this.certsState.page = res.page;
      }
      this.focusId = nav.focus;
      this.render();
    });
  }

  /** Écran VERROUILLÉ : initialisation (PKI vierge) OU saisie de la phrase secrète maître. */
  private buildLockPanel(): HTMLElement {
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--line);border-radius:6px;padding:14px;background:var(--bg-2);margin-bottom:12px";
    const state = this.pkiState!;

    // CONTEXTE NON SÉCURISÉ : les navigateurs retirent crypto.subtle hors HTTPS/localhost —
    // toute la crypto de la PKI (dérivation, chiffrement, signatures) est alors inopérante.
    // Bandeau actionnable AU LIEU des formulaires (la liste des métadonnées, elle, reste
    // consultable plus bas : elle ne demande aucune opération de clé).
    if (!PkiCrypto.available()) {
      box.style.borderColor = "var(--warn)";
      const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--warn);margin-bottom:6px";
      title.textContent = I18n.t("certs.admin.lock.insecureTitle");
      const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.whiteSpace = "pre-line";
      hint.textContent = I18n.t("certs.admin.lock.insecureHint");
      box.append(title, hint);
      return box;
    }

    if (state.initialized !== true) {
      // PKI VIERGE → proposer l'initialisation (formulaire EN MODALE).
      const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:6px";
      title.textContent = I18n.t("certs.admin.lock.uninitTitle");
      const hint = document.createElement("div"); hint.className = "form-hint";
      hint.textContent = I18n.t("certs.admin.lock.uninitHint");
      const btn = this.actionButton(I18n.t("certs.admin.lock.initBtn"), I18n.t("certs.admin.lock.initBtnTitle"), () => this.initModal(), "btn-primary");
      btn.style.marginTop = "10px";
      box.append(title, hint, btn);
      return box;
    }

    // PKI INITIALISÉE → déverrouillage par phrase secrète (input password STANDARD .form-field).
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:6px";
    title.textContent = I18n.t("certs.admin.lock.unlockTitle");
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.marginBottom = "8px";
    hint.textContent = I18n.t("certs.admin.lock.unlockHint");

    // Le bouton est frère de l'INPUT SEUL (pas du .form-field label+input) : posé à côté du champ
    // ENTIER, `align-items:flex-end` collait son bas à celui de l'input alors qu'il est ~15 px plus
    // court (input : padding 8px/13px ≈ 37 px · .btn-sm : padding 4px/10px ≈ 22 px) → il paraissait
    // excentré. Ici `stretch` lui fait épouser la hauteur EXACTE de l'input, sans hauteur en dur.
    const passField = document.createElement("div"); passField.className = "form-field"; passField.style.margin = "0";
    const label = document.createElement("label"); label.textContent = I18n.t("certs.admin.lock.passLabel");
    const input = document.createElement("input"); input.type = "password"; input.autocomplete = "current-password"; input.placeholder = I18n.t("certs.admin.lock.passPlaceholder");
    input.style.cssText = "flex:1 1 auto;min-width:0";   // min-width:0 : sans lui, un flex item ne descend pas sous sa largeur intrinsèque
    const errBox = this.errBox();
    const btn = this.actionButton(I18n.t("certs.admin.lock.unlockBtn"), I18n.t("certs.admin.lock.unlockBtnTitle"), () => void this.attemptUnlock(input.value, errBox), "btn-primary");
    btn.classList.remove("btn-sm");   // hauteur d'un .btn plein pour matcher l'input
    btn.style.flex = "none";
    const inputRow = document.createElement("div"); inputRow.style.cssText = "display:flex;gap:8px;align-items:stretch";
    inputRow.append(input, btn);
    passField.append(label, inputRow);

    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void this.attemptUnlock(input.value, errBox); } });

    box.append(title, hint, passField, errBox);
    setTimeout(() => input.focus(), 30);
    return box;
  }

  /* --------------------------------------------------------------------------
     Listing paginé SERVEUR — DEUX vues (A « Autorités & clés » / B « Certificats
     d'une racine »). Chaque page vient du serveur (jamais de slice client) ;
     tris/filtres/pagination portés par la requête, état en mémoire d'instance.
     -------------------------------------------------------------------------- */

  /** État du listing ACTIF (selon la vue courante). */
  private currentState(): ListingState {
    return this.view === "roots" ? this.rootsState : this.certsState;
  }

  /** Charge la PAGE COURANTE depuis le serveur (racines OU sous-arbre d'une racine). La page effective est
      relue depuis la réponse (le serveur CLAMPE si la page demandée n'existe plus après une écriture). */
  private async loadCurrentPage(): Promise<void> {
    const st = this.currentState();
    const params = CertsAdminView.listParams(st);
    if (this.view === "roots") {
      const res = await this.client!.listRoots(params);
      this.rootItems = res.certificates;
      this.pageMeta = { total: res.total, page: res.page, pages: res.pages, pageSize: res.pageSize };
    } else {
      const res = await this.client!.listPage({ ...params, root: this.rootScope!.id });
      this.certItems = res.certificates;
      this.pageMeta = { total: res.total, page: res.page, pages: res.pages, pageSize: res.pageSize };
    }
    st.page = this.pageMeta.page;
  }

  /** Re-render COMPLET après (re)chargement — reconstruit la toolbar de filtres comprise (changement de vue,
      réinitialisation des filtres). */
  private async rerender(): Promise<void> {
    await this.guarded(async () => { await this.loadCurrentPage(); this.render(); });
  }

  /** Recharge la page courante et repeint UNIQUEMENT le corps (table + pagination) — la toolbar de filtres
      reste en place (un panneau MultiSelect ouvert n'est pas refermé entre deux cases cochées). Sert aussi
      APRÈS une écriture : la page courante est rechargée (clamp serveur si elle a disparu), les agrégats de la
      vue A (Dérivés/Sous seuil) reflètent le changement. */
  private async refreshBody(): Promise<void> {
    await this.guarded(async () => { await this.loadCurrentPage(); this.paintBody(); });
    this.onCountsChanged?.();   // le TOTAL de certificats a pu changer (création/suppression) → badge d'onglet (async, hors vue)
  }

  /** Bascule vers la vue B (certificats du sous-arbre d'une racine) avec des filtres/tri NEUFS. */
  private openCerts(root: CertificateListItem): void {
    this.session.touch();
    this.selection.clear();   // changement de vue A→B : la sélection ne traverse pas les vues (cadrage §5)
    this.view = "certs";
    this.rootScope = { id: root.id, label: root.label };
    this.certsState = CertsAdminView.defaultState();
    void this.rerender();
  }

  /** Retour à la vue A (autorités & clés) — l'état de la vue A est préservé (page/filtres mémorisés). */
  private goToRoots(): void {
    this.session.touch();
    this.selection.clear();   // changement de vue B→A : la sélection ne traverse pas les vues (cadrage §5)
    this.view = "roots";
    this.rootScope = null;
    void this.rerender();
  }

  /** En-tête de la section listing (intro vue A, ou fil d'Ariane « ← Autorités » + titre vue B) + le conteneur
      de corps (rempli par paintBody). Les filtres vivent désormais dans la barre de contrôles unifiée (buildToolbar). */
  private buildListingSection(): HTMLElement {
    const wrap = document.createElement("div");
    if (this.view === "certs" && this.rootScope) {
      const bc = document.createElement("div"); bc.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px";
      bc.appendChild(this.actionButton(I18n.t("certs.admin.listing.backAuthorities"), I18n.t("certs.admin.listing.backAuthoritiesTitle"), () => this.goToRoots()));
      const title = document.createElement("span"); title.style.cssText = "font-weight:600;color:var(--fg)";
      title.textContent = I18n.t("certs.admin.listing.viewBTitle", { label: this.rootScope.label });
      bc.appendChild(title);
      wrap.appendChild(bc);
    } else {
      const intro = document.createElement("div"); intro.className = "form-hint"; intro.style.marginBottom = "8px";
      intro.textContent = this.session.unlocked
        ? I18n.t("certs.admin.listing.introUnlocked")
        : I18n.t("certs.admin.listing.introLocked");
      wrap.appendChild(intro);
    }
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "list-body";   // mêmes règles CSS que les listings ListView (défaut à gauche, numériques via cell-num)
    wrap.appendChild(this.bodyEl);
    return wrap;
  }

  /** Peint le CORPS (table + pagination) de la vue courante dans `bodyEl`. Si une navigation par la recherche
      a désigné un élément (`focusId`), on centre sa ligne et on l'illumine ; la surbrillance est CONSOMMÉE
      (mise à null) pour qu'un repaint ultérieur (tri/pagination) ne la ré-allume pas. */
  private paintBody(): void {
    if (!this.bodyEl) return;
    // Barre de sélection EN TÊTE du corps (avant la table) : repeinte à chaque variation de sélection sans
    // reconstruire la table. `buildRootsTable`/`buildCertsTable` (re)créent la case d'en-tête ; on synchronise
    // ensuite la barre et l'état de la case (indéterminée si partielle).
    this.selBarEl = document.createElement("div");
    const table = this.view === "roots" ? this.buildRootsTable() : this.buildCertsTable();
    this.bodyEl.replaceChildren(this.selBarEl, table, this.buildPagination());
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

  /* ---- Vue A : table des autorités & clés (racines + agrégats) ---- */

  private buildRootsTable(): HTMLElement {
    const st = this.currentState();
    const tw = document.createElement("div"); tw.className = "table-wrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead"); const tr = document.createElement("tr");
    tr.append(
      this.selectHeaderCell(),
      this.sortableTh(I18n.t("certs.admin.listing.colLabel"), "label", st), this.sortableTh(I18n.t("lists.col.type"), "kind", st), this.plainTh(I18n.t("certs.admin.listing.colSubject")),
      this.sortableTh(I18n.t("certs.admin.listing.colExpiry"), "not_after", st), this.plainTh(I18n.t("certs.admin.listing.colState")),
      this.sortableTh(I18n.t("certs.admin.listing.colDerived"), "children_total", st, "cell-num"), this.plainTh(I18n.t("certs.admin.listing.colAlert"), "cell-num"), this.plainTh(I18n.t("lists.chrome.actions"), "cell-actions"),
    );
    thead.appendChild(tr);
    const labels = CardTable.columnLabels(tr);   // repli en cartes (< 560px) : libellés lus depuis l'en-tête
    const tbody = document.createElement("tbody");
    if (!this.rootItems.length) tbody.appendChild(this.emptyRow(9));
    else for (const item of this.rootItems) { const row = this.buildRootRow(item); CardTable.labelCells(row, labels); tbody.appendChild(row); }
    table.append(thead, tbody);
    tw.appendChild(table);
    return tw;
  }

  private buildRootRow(item: CertificateRootItem): HTMLElement {
    const tr = document.createElement("tr");
    if (this.focusId && item.id === this.focusId) tr.classList.add("row-focus");   // cible d'une recherche
    tr.appendChild(this.selectRowCell(item));
    tr.appendChild(this.labelCell(item));
    tr.appendChild(this.htmlCell(this.pill(CertsFormat.kindLabel(item.kind), "neutral")));
    tr.appendChild(this.subjectCell(item.subject));
    tr.appendChild(this.htmlCell(this.expiryCell(item)));
    tr.appendChild(this.htmlCell(item.revoked_at ? this.pill(I18n.t("certs.admin.listing.revoked"), "err") : CertsAdminView.MUTED));
    // Dérivés : nombre total de descendants (0 pour une paire simple) — colonne numérique (droite, tabulaire).
    const derived = document.createElement("td"); derived.className = "cell-num"; derived.textContent = String(item.children_total);
    if (item.children_total === 0) derived.style.color = "var(--fg-dimmer)";
    tr.appendChild(derived);
    tr.appendChild(this.htmlCell(this.alertCell(item), "cell-num"));   // « Sous seuil » = compteur → colonne numérique
    // Actions : opérations de clé si déverrouillé + « Déployer la confiance… » / « Lister les certificats »
    // (consultation, disponibles MÊME verrouillé — aucune clé requise).
    const actions = document.createElement("td"); actions.className = "cell-actions";   // nowrap + alignées à DROITE (parité ListView)
    this.fillActions(actions, item);   // fillActions filtre lui-même ce qui exige la clé
    // Aide au déploiement : uniquement les AUTORITÉS (racine X.509 ou CA SSH) — pas les paires simples ni les
    // dérivés. Consultation pure (procédure d'installation dans les magasins de confiance des clients).
    if (item.kind === "root-ca" || item.kind === "ssh-ca") actions.appendChild(this.iconAction(Icons.TRUST_DEPLOY, I18n.t("certs.admin.listing.deployTitle"), CERT_TIP.trustDeploy, () => this.deployTrustModal(item)));
    if (item.children_total > 0) actions.appendChild(this.iconAction(Icons.CERT_LIST, I18n.t("certs.admin.listing.listCertsTitle"), CERT_TIP.certList, () => this.openCerts(item)));
    tr.appendChild(actions);
    return tr;
  }

  /** Badge « Sous seuil » d'une racine : nombre de descendants à échéance ≤ 30 j (children_alert). Le serveur
      ne distingue pas « expirant » d'« expiré » → err si l'échéance la plus proche du sous-arbre est DÉPASSÉE
      (au moins un expiré), sinon warn ; « — » si aucun. */
  private alertCell(item: CertificateRootItem): string {
    if (!item.children_alert || item.children_alert <= 0) return CertsAdminView.MUTED;
    const expired = typeof item.next_expiry === "string" && Date.parse(item.next_expiry) < Date.now();
    return this.pill(String(item.children_alert), expired ? "err" : "warn");
  }

  /* ---- Vue B : table plate du sous-arbre d'une racine ---- */

  private buildCertsTable(): HTMLElement {
    const st = this.currentState();
    const tw = document.createElement("div"); tw.className = "table-wrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead"); const tr = document.createElement("tr");
    tr.append(
      this.selectHeaderCell(),
      this.sortableTh(I18n.t("certs.admin.listing.colLabel"), "label", st), this.sortableTh(I18n.t("lists.col.type"), "kind", st),
      this.sortableTh(I18n.t("certs.admin.listing.colIssuer"), "parent", st), this.plainTh(I18n.t("certs.admin.listing.colSubject")),
      this.sortableTh(I18n.t("certs.admin.listing.colExpiry"), "not_after", st), this.plainTh(I18n.t("certs.admin.listing.colState")), this.plainTh(I18n.t("lists.chrome.actions"), "cell-actions"),
    );
    thead.appendChild(tr);
    const labels = CardTable.columnLabels(tr);   // repli en cartes (< 560px) : libellés lus depuis l'en-tête
    const tbody = document.createElement("tbody");
    if (!this.certItems.length) tbody.appendChild(this.emptyRow(8));
    else for (const item of this.certItems) { const row = this.buildCertRow(item); CardTable.labelCells(row, labels); tbody.appendChild(row); }
    table.append(thead, tbody);
    tw.appendChild(table);
    return tw;
  }

  private buildCertRow(item: CertificatePageItem): HTMLElement {
    const tr = document.createElement("tr");
    if (this.focusId && item.id === this.focusId) tr.classList.add("row-focus");   // cible d'une recherche
    tr.appendChild(this.selectRowCell(item));
    tr.appendChild(this.labelCell(item));
    tr.appendChild(this.htmlCell(this.pill(CertsFormat.kindLabel(item.kind), "neutral")));
    // Émetteur : libellé du parent RÉSOLU depuis les items de la PAGE (CertsFormat.issuerLabel) ; s'il est sur
    // une AUTRE page du sous-arbre, on montre son id court en mono avec l'id complet en title (limite assumée
    // — pas de requête par ligne, cadrage §3).
    const issuer = document.createElement("td");
    if (item.parent_id && !this.certItems.some((c) => c.id === item.parent_id)) {
      issuer.style.cssText = "font-family:var(--mono);font-size:12px"; issuer.title = item.parent_id;
    }
    issuer.textContent = CertsFormat.issuerLabel(item.parent_id, this.certItems);
    tr.appendChild(issuer);
    tr.appendChild(this.subjectCell(item.subject));
    tr.appendChild(this.htmlCell(this.expiryCell(item)));
    tr.appendChild(this.htmlCell(item.revoked_at ? this.pill(I18n.t("certs.admin.listing.revoked"), "err") : CertsAdminView.MUTED));
    const actions = document.createElement("td"); actions.className = "cell-actions";   // nowrap + alignées à DROITE (parité ListView)
    this.fillActions(actions, item);   // fillActions filtre lui-même ce qui exige la clé
    tr.appendChild(actions);
    return tr;
  }

  /* ---- Cellules & pagination communes ---- */

  /** Cellule libellé (indication « clé détenue » en title, comme l'arbre d'origine). */
  private labelCell(item: CertificateListItem): HTMLElement {
    const td = document.createElement("td");
    const span = document.createElement("span"); span.textContent = item.label;
    if (item.has_key) span.title = I18n.t("certs.admin.listing.keyOwned");
    td.appendChild(span);
    return td;
  }

  private subjectCell(subject: string): HTMLElement {
    const td = document.createElement("td"); td.style.cssText = "font-family:var(--mono);font-size:12px"; td.textContent = subject;
    return td;
  }

  /** En-tête NON triable ; `cls` porte l'alignement de la colonne (ex. « cell-num » à droite, « cell-actions »). */
  private plainTh(text: string, cls = ""): HTMLElement {
    const th = document.createElement("th"); if (cls) th.className = cls; th.textContent = text; return th;
  }

  /** En-tête TRIABLE (CSS ListView : .sortable + .sort-ind ▲/▼). Clic : bascule le sens si déjà actif, sinon
      trie ASC sur cette colonne ; retour page 1 puis repeint le corps (rechargement serveur). `cls` = classe
      d'alignement de la colonne (« cell-num » pour les colonnes numériques → en-tête + tri ancrés à droite). */
  private sortableTh(text: string, sortKey: string, st: ListingState, cls = ""): HTMLElement {
    const th = document.createElement("th"); th.className = cls ? "sortable " + cls : "sortable"; th.textContent = text;
    if (st.sort === sortKey) {
      const ind = document.createElement("span"); ind.className = "sort-ind"; ind.textContent = " " + (st.dir === "desc" ? "▼" : "▲");
      th.appendChild(ind);
    }
    th.onclick = () => {
      if (st.sort === sortKey) st.dir = st.dir === "desc" ? "asc" : "desc";
      else { st.sort = sortKey; st.dir = "asc"; }
      st.page = 1;
      void this.refreshBody();
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

  /** Bloc pagination standard (.pagination) : « N élément(s) · page x/y » + first/prev/next/last + « N/page ».
      TOUTE navigation recharge la page côté SERVEUR (jamais de slice client). */
  private buildPagination(): HTMLElement {
    const st = this.currentState();
    const meta = this.pageMeta || { total: 0, page: 1, pages: 1, pageSize: st.pageSize };
    const wrap = document.createElement("div"); wrap.className = "pagination";
    const info = document.createElement("div");
    info.textContent = I18n.t("lists.chrome.count", { count: meta.total, page: meta.page, pages: meta.pages });
    const controls = document.createElement("div"); controls.className = "pagination-controls";
    const nav = (label: string, disabled: boolean, to: number): HTMLButtonElement => {
      const b = document.createElement("button"); b.type = "button"; b.className = "page-btn"; b.textContent = label; b.disabled = disabled;
      b.onclick = () => { st.page = to; void this.refreshBody(); };
      return b;
    };
    controls.appendChild(nav("«", meta.page <= 1, 1));
    controls.appendChild(nav("‹", meta.page <= 1, Math.max(1, meta.page - 1)));
    const pos = document.createElement("span"); pos.style.cssText = "padding:0 6px"; pos.textContent = meta.page + " / " + meta.pages;
    controls.appendChild(pos);
    controls.appendChild(nav("›", meta.page >= meta.pages, Math.min(meta.pages, meta.page + 1)));
    controls.appendChild(nav("»", meta.page >= meta.pages, meta.pages));
    const sel = document.createElement("select"); sel.className = "page-size app-select";
    for (const n of PAGE_SIZE_OPTIONS) { const o = document.createElement("option"); o.value = String(n); o.textContent = I18n.t("lists.chrome.pageSize", { n }); if (n === st.pageSize) o.selected = true; sel.appendChild(o); }
    sel.onchange = () => { st.pageSize = parseInt(sel.value, 10); st.page = 1; void this.refreshBody(); };
    controls.appendChild(sel);
    wrap.append(info, controls);
    return wrap;
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
  private fillActions(cell: HTMLElement, item: CertificateListItem): void {
    const unlocked = this.session.unlocked;
    if (unlocked && item.kind === "root-ca" && !item.revoked_at) cell.appendChild(this.iconAction(Icons.ISSUE_TLS, I18n.t("certs.admin.actions.issueTls"), CERT_TIP.issueTls, () => this.leafModal(item)));
    if (unlocked && item.kind === "ssh-ca" && !item.revoked_at) cell.appendChild(this.iconAction(Icons.ISSUE_SSH, I18n.t("certs.admin.actions.issueSsh"), CERT_TIP.issueSsh, () => this.sshCertModal(item)));
    if (!item.revoked_at) cell.appendChild(this.iconAction(Icons.EXPORT, I18n.t("certs.admin.actions.exportArtifacts"), CERT_TIP.export, () => void this.exportModal(item)));
    if (!item.revoked_at) cell.appendChild(this.iconAction(Icons.REVOKE, I18n.t("certs.admin.actions.revoke"), CERT_TIP.revoke, () => void this.revoke(item)));
    cell.appendChild(this.iconAction(Icons.DELETE, I18n.t("ui.action.delete"), CERT_TIP.remove, () => void this.remove(item), true));
  }

  /** Bouton d'action ICÔNE — délègue au constructeur PARTAGÉ (ui/IconButton) : un seul point de
      fabrication pour toute l'app, donc un seul style et des règles d'a11y impossibles à oublier. */
  private iconAction(icon: string, ariaLabel: string, tipKey: string, onClick: () => void, danger = false): HTMLButtonElement {
    return IconButton.build({ icon, label: ariaLabel, tipKey, danger, onClick });
  }

  /* --------------------------------------------------------------------------
     SÉLECTION MULTIPLE & ACTIONS GROUPÉES (L4) — cases par ligne + case d'en-tête,
     barre d'actions COMMUNES (intersection via BulkActions), exports ZIP (CertZip),
     révocation/suppression en masse avec BILAN systématique. La sélection vit en
     mémoire d'instance et survit page/tri/filtre (cf. `selection`).
     -------------------------------------------------------------------------- */

  /** Items de la PAGE courante (racines OU sous-arbre) — base des cases et de la case « toute la page ». */
  private currentPageItems(): CertificateListItem[] {
    return this.view === "roots" ? this.rootItems : this.certItems;
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

  /** Cellule de sélection d'une ligne : case reflétant l'appartenance à la sélection (data-cert-id pour la
      synchro « toute la page »/« effacer »). */
  private selectRowCell(item: CertificateListItem): HTMLElement {
    const td = document.createElement("td"); td.style.width = "1%";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.setAttribute("data-cert-id", item.id);
    cb.checked = this.selection.has(item.id);
    cb.title = I18n.t("certs.admin.select.rowSelect", { label: item.label });
    cb.onclick = () => this.toggleSelect(item, cb.checked);
    td.appendChild(cb);
    return td;
  }

  /** Coche/décoche un élément (met à jour l'instantané) puis rafraîchit barre + case d'en-tête. */
  private toggleSelect(item: CertificateListItem, checked: boolean): void {
    this.session.touch();
    if (checked) this.selection.set(item.id, this.snapshotOf(item)); else this.selection.delete(item.id);
    this.refreshSelectionUi();
  }

  /** Coche/décoche TOUS les éléments de la page courante (case d'en-tête) + les cases DOM correspondantes. */
  private toggleSelectAll(checked: boolean): void {
    this.session.touch();
    for (const item of this.currentPageItems()) {
      if (checked) this.selection.set(item.id, this.snapshotOf(item)); else this.selection.delete(item.id);
    }
    this.bodyEl?.querySelectorAll("input[data-cert-id]").forEach((el) => { (el as HTMLInputElement).checked = checked; });
    this.refreshSelectionUi();
  }

  /** Vide la sélection (bouton « Effacer » et après une action groupée) + décoche les cases visibles. */
  private clearSelection(): void {
    this.selection.clear();
    this.bodyEl?.querySelectorAll("input[data-cert-id]").forEach((el) => { (el as HTMLInputElement).checked = false; });
    this.refreshSelectionUi();
  }

  /** Repeint la barre de sélection et resynchronise la case d'en-tête (sans reconstruire la table). */
  private refreshSelectionUi(): void {
    this.renderSelectionBar();
    this.syncHeaderCheckbox();
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
    const ok = await Dialog.confirm({
      title: I18n.t("certs.admin.bulk.revokeTitle", { count: n }),
      message: I18n.t("certs.admin.bulk.revokeMessage"),
      confirmLabel: I18n.t("certs.admin.bulk.revokeBtn"), danger: true,
    });
    if (!ok) return;

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
      try { await this.client!.save(id, CertsAdminView.metadataInput(item, { revoked_at: now })); done++; }
      catch (e) { errors.push({ label: item.label, reason: CertsAdminView.errText(e) }); }
    }
    this.showBulkSummary(I18n.t("certs.admin.bulk.sumRevoke"), [
      I18n.t("certs.admin.bulk.revokedCount", { count: done }),
      ...errors.map((e) => I18n.t("certs.admin.bulk.errorLine", { label: e.label, reason: e.reason })),
    ]);
    this.clearSelection();
    await this.refreshBody();
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
  private async attemptUnlock(pass: string, errBox: HTMLElement): Promise<void> {
    const state = this.pkiState;
    if (!state || state.initialized !== true) return;
    errBox.style.display = "none";
    if (pass.trim() === "") { this.showError(errBox, I18n.t("certs.admin.common.passRequired")); return; }
    try {
      const kek = await PkiCrypto.deriveKek(pass, state.kdf_salt, state.kdf_iters);
      const dek = await PkiCrypto.unwrapDek(kek, state.wrapped_dek); // JETTE si mauvaise phrase (GCM refuse)
      this.session.unlock(dek);
      this.render();
      Notify.toast(I18n.t("certs.admin.unlock.toast"), "ok");
    } catch (_) {
      // Toute erreur (dérivation, unwrap, blob) → même réponse neutre, sans matériau de clé.
      this.showError(errBox, I18n.t("certs.admin.unlock.wrong"));
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

    const errBox = this.errBox(); root.appendChild(errBox);
    this.host.openModal({
      title: I18n.t("certs.admin.rekey.title"),
      body: root,
      saveLabel: I18n.t("certs.admin.rekey.saveLabel"),
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const currentPass = cur.value;
        const newPass = p1.value;
        if (currentPass.trim() === "") { this.showError(errBox, I18n.t("certs.admin.rekey.curRequired")); return false; }
        if (newPass.trim() === "") { this.showError(errBox, I18n.t("certs.admin.rekey.newRequired")); return false; }
        if (newPass !== p2.value) { this.showError(errBox, I18n.t("certs.admin.rekey.mismatch")); return false; }
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
          return false;
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

  /** CA racine X.509 auto-signée. */
  private rootCaModal(): void {
    const root = document.createElement("div");
    const cn = FormControls.text("", I18n.t("certs.admin.rootCa.cnPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rootCa.cnField"), cn, I18n.t("certs.admin.rootCa.cnHint")));
    const org = FormControls.text("", I18n.t("certs.admin.rootCa.orgPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.rootCa.orgField"), org, I18n.t("certs.admin.rootCa.orgHint")));
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
        const commonName = cn.value.trim();
        if (commonName === "") { this.showError(errBox, I18n.t("certs.admin.common.cnRequired")); return false; }
        try {
          const keyAlgo = algo.value as X509KeyAlgo;
          const organization = org.value.trim() || undefined;
          const gen = await X509Factory.createRootCa({ commonName, organization, keyAlgo, days: Number(days.value) });
          const keyEnc = await PkiCrypto.encryptSecret(this.session.key, gen.privateKeyPkcs8Pem);
          await this.client!.save(CertsAdminView.newId(), {
            kind: "root-ca", parent_id: null, label: commonName, subject: CertsAdminView.subjectDn(commonName, organization),
            serial: gen.serial, not_before: gen.notBefore, not_after: gen.notAfter, fingerprint: gen.fingerprintSha256,
            key_algo: keyAlgo, public_pem: gen.certPem, key_enc: keyEnc, revoked_at: null, sans: [],
          });
          Notify.toast(I18n.t("certs.admin.rootCa.toast"), "ok");
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => cn.focus(), 30);
  }

  /** Feuille TLS signée par une CA X.509 (action « Émettre TLS »). */
  private leafModal(ca: CertificateListItem): void {
    const root = document.createElement("div");
    const cn = FormControls.text("", I18n.t("certs.admin.leaf.cnPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.leaf.cnField"), cn, I18n.t("certs.admin.leaf.cnHint")));
    const sanEditor = this.buildSanEditor();
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.leaf.sanField"), sanEditor.element, I18n.t("certs.admin.leaf.sanHint")));
    const usage = FormControls.select(CertsAdminView.usageOpts(), "server");
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.leaf.usageField"), usage, I18n.t("certs.admin.leaf.usageHint")));
    const algo = FormControls.select(CertsAdminView.algoX509Opts(), "ec-p256");
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.algoField"), algo, I18n.t("certs.admin.leaf.algoHint")));
    const days = FormControls.number(397, { min: 1, step: 1 });
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.validityDays"), days, I18n.t("certs.admin.leaf.daysHint")));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: I18n.t("certs.admin.leaf.title"),
      subtitle: Html.escape(ca.label),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const commonName = cn.value.trim();
        if (commonName === "") { this.showError(errBox, I18n.t("certs.admin.common.cnRequired")); return false; }
        const sans = sanEditor.collect();
        try {
          const detail = await this.client!.getOne(ca.id);
          if (!detail.key_enc) { this.showError(errBox, I18n.t("certs.admin.leaf.noKey")); return false; }
          const caKeyPem = await PkiCrypto.decryptSecret(this.session.key, detail.key_enc);
          const keyAlgo = algo.value as X509KeyAlgo;
          const gen = await X509Factory.issueLeaf({
            caCertPem: detail.public_pem || "", caPrivateKeyPkcs8Pem: caKeyPem,
            commonName, keyAlgo, days: Number(days.value), sans: sans as X509San[], usage: usage.value as LeafUsage,
          });
          const keyEnc = await PkiCrypto.encryptSecret(this.session.key, gen.privateKeyPkcs8Pem);
          await this.client!.save(CertsAdminView.newId(), {
            kind: "leaf-tls", parent_id: ca.id, label: commonName, subject: CertsAdminView.subjectDn(commonName),
            serial: gen.serial, not_before: gen.notBefore, not_after: gen.notAfter, fingerprint: gen.fingerprintSha256,
            key_algo: keyAlgo, public_pem: gen.certPem, key_enc: keyEnc, revoked_at: null, sans,
          });
          Notify.toast(I18n.t("certs.admin.leaf.toast"), "ok");
          await this.refreshBody();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => cn.focus(), 30);
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

  /** Certificat SSH signé par une ssh-ca (action « Émettre SSH ») — la paire sujette NAÎT avec le cert (v1). */
  private sshCertModal(ca: CertificateListItem): void {
    const root = document.createElement("div");
    const keyId = FormControls.text("", I18n.t("certs.admin.sshCert.keyIdPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.sshCert.keyIdField"), keyId, I18n.t("certs.admin.sshCert.keyIdHint")));
    const type = FormControls.select(CertsAdminView.sshCertTypeOpts(), "user");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.type"), type, I18n.t("certs.admin.sshCert.typeHint")));
    const principalsEditor = this.buildPrincipalsEditor();
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.sshCert.principalsField"), principalsEditor.element, I18n.t("certs.admin.sshCert.principalsHint")));
    const days = FormControls.number(365, { min: 1, step: 1 });
    root.appendChild(FormControls.fieldRow(I18n.t("certs.admin.common.validityDays"), days, I18n.t("certs.admin.sshCert.daysHint")));
    const info = document.createElement("div"); info.className = "form-hint"; info.style.marginTop = "6px";
    info.textContent = I18n.t("certs.admin.sshCert.info");
    root.appendChild(info);
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: I18n.t("certs.admin.sshCert.title"),
      subtitle: Html.escape(ca.label),
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
          });
          Notify.toast(I18n.t("certs.admin.sshCert.toast"), "ok");
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
    const rec = CertsAdminView.toExportRecord(item);
    // `all` = liste COMPLÈTE (métadonnées, sans key_enc) pour résoudre les chaînes d'émission (fullchain/
    // ca-chain remontent parent_id) : le listing est paginé, les ancêtres ne sont pas forcément affichés.
    let all: CertExportRecord[];
    try { all = (await this.client!.list()).map((c) => CertsAdminView.toExportRecord(c)); }
    catch (e) { this.actionError(e); return; }
    const root = document.createElement("div");
    const intro = document.createElement("div"); intro.className = "form-hint"; intro.style.marginBottom = "10px";
    intro.textContent = I18n.t("certs.admin.export.intro", { label: item.label });
    root.appendChild(intro);
    const list = document.createElement("div"); list.style.cssText = "display:flex;flex-direction:column;gap:8px;align-items:flex-start";
    root.appendChild(list);

    // Un bouton par artefact ; `run` renvoie true pour GARDER la modale (ex. PKCS#12 ouvre sa propre modale).
    // `lockedDisabled` : l'artefact exige la clé privée et la session est VERROUILLÉE → bouton GRISÉ (pas caché,
    // pas d'erreur au clic) avec l'explication en tooltip — déverrouiller la session le rend cliquable.
    const addAction = (label: string, run: () => Promise<boolean | void>, lockedDisabled = false): void => {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.style.textAlign = "left";
      b.textContent = label;
      if (lockedDisabled) { b.disabled = true; b.title = I18n.t("certs.admin.export.lockedHint"); }
      else b.onclick = async () => {
        this.session.touch();
        try { const keep = await run(); if (!keep) this.host.closeModal?.(); }
        catch (e) { Notify.toast(CertsAdminView.errText(e), "err"); }   // laisse la modale ouverte
      };
      list.appendChild(b);
    };
    const locked = !this.session.unlocked;

    // Export UNITAIRE « Tout (ZIP) » (L4) : le BUNDLE complet du certificat en une archive (ex. feuille TLS =
    // cert + fullchain + clé en un geste). Clé privée incluse SI session déverrouillée ET clé détenue, sinon
    // artefacts publics seuls — le libellé du bouton l'indique.
    const withKey = this.session.unlocked && item.has_key;
    addAction(I18n.t("certs.admin.export.allZip") + (withKey ? I18n.t("certs.admin.export.allZipWithKey") : I18n.t("certs.admin.export.allZipPublic")), async () => {
      const keyPem = withKey ? await this.decryptKey(item.id) : null;
      const bundleRec: CertBundleRecord = { id: item.id, label: item.label, parent_id: item.parent_id, public_pem: item.public_pem, revoked_at: item.revoked_at, kind: item.kind, subject: item.subject };
      const artifacts = await CertZip.bundleFor(bundleRec, all, keyPem);
      const zip = CertZip.zipArtifacts([{ artifacts }]);
      Download.data(CertExports.safeFileName(item.label) + ".zip", zip, "application/zip");
    });

    if (item.kind === "root-ca" || item.kind === "leaf-tls") {
      addAction(I18n.t("certs.admin.export.pubPem"), async () => this.download(CertExports.pemCertificate(rec)));
      addAction(I18n.t("certs.admin.export.fullchain"), async () => this.download(CertExports.pemFullchain(rec, all)));
      if (item.kind === "leaf-tls") addAction(I18n.t("certs.admin.export.caChain"), async () => this.download(CertExports.pemCaChain(rec, all)));
      if (item.has_key) {
        addAction(I18n.t("certs.admin.export.keyPem"), async () => this.download(CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id))), locked);
        addAction(I18n.t("certs.admin.export.pkcs12"), async () => { this.pkcs12Flow(item, rec, all); return true; }, locked);
      }
    } else if (item.kind === "ssh-ca" || item.kind === "ssh-keypair") {
      if (item.has_key) {
        addAction(I18n.t("certs.admin.export.opensshKey"), async () => {
          const seed = await this.seedFromPkcs8Pem(await this.decryptKey(item.id));
          const publicKey = CertsAdminView.ed25519PubFromLine(item.public_pem || "");
          for (const art of CertExports.opensshArtifacts(rec, { kind: item.kind as "ssh-ca" | "ssh-keypair", seed, publicKey, comment: item.subject })) this.download(art);
        }, locked);
        addAction(I18n.t("certs.admin.export.keyPem"), async () => this.download(CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id))), locked);
      }
    } else if (item.kind === "ssh-cert") {
      addAction(I18n.t("certs.admin.export.sshCert"), async () => { for (const art of CertExports.opensshArtifacts(rec, { kind: "ssh-cert", certLine: item.public_pem || "" })) this.download(art); });
      if (item.has_key) addAction(I18n.t("certs.admin.export.subjectKey"), async () => this.download(CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id))), locked);
    }

    if (!list.children.length) { const n = document.createElement("div"); n.className = "form-hint"; n.textContent = I18n.t("certs.admin.export.empty"); root.appendChild(n); }
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
    const ok = await Dialog.confirm({
      title: I18n.t("certs.admin.revoke.title"),
      message: I18n.t("certs.admin.revoke.message", { label: item.label }),
      confirmLabel: I18n.t("certs.admin.revoke.btn"), danger: true,
    });
    if (!ok) return;
    try {
      await this.client!.save(item.id, CertsAdminView.metadataInput(item, { revoked_at: new Date().toISOString() }));
      Notify.toast(I18n.t("certs.admin.revoke.toast"), "ok");
      await this.refreshBody();
    } catch (e) { this.actionError(e); }
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

  /* --------------------------------------------------------------------------
     Éditeurs de listes dynamiques (SAN / principaux)
     -------------------------------------------------------------------------- */

  /** Éditeur de lignes SAN (type dns/ip/email + valeur) ajoutables/retirables. */
  private buildSanEditor(): { element: HTMLElement; collect: () => CertSan[] } {
    const container = document.createElement("div");
    const rows = document.createElement("div"); rows.style.cssText = "display:flex;flex-direction:column;gap:6px";
    const entries: Array<{ type: HTMLSelectElement; value: HTMLInputElement }> = [];
    const addRow = (): void => {
      const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;align-items:center";
      const type = FormControls.select(CertsAdminView.sanTypeOpts(), "dns"); type.style.flex = "0 0 90px";
      const value = FormControls.text("", I18n.t("certs.admin.san.valuePlaceholder")); value.style.flex = "1 1 auto";
      const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm"; del.innerHTML = Icons.CLOSE; del.title = I18n.t("ui.chips.remove");
      const entry = { type, value };
      del.onclick = () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); row.remove(); };
      row.append(type, value, del); rows.appendChild(row); entries.push(entry);
    };
    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-ghost btn-sm"; add.style.marginTop = "6px";
    add.textContent = I18n.t("certs.admin.san.addSan"); add.onclick = () => addRow();
    container.append(rows, add);
    addRow();   // une ligne par défaut
    return {
      element: container,
      collect: () => entries.map((e) => ({ san_type: e.type.value as CertSan["san_type"], value: e.value.value.trim() })).filter((s) => s.value !== ""),
    };
  }

  /** Éditeur de lignes « principal » SSH (valeur seule) ajoutables/retirables. */
  private buildPrincipalsEditor(): { element: HTMLElement; collect: () => string[] } {
    const container = document.createElement("div");
    const rows = document.createElement("div"); rows.style.cssText = "display:flex;flex-direction:column;gap:6px";
    const inputs: HTMLInputElement[] = [];
    const addRow = (): void => {
      const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;align-items:center";
      const value = FormControls.text("", I18n.t("certs.admin.san.principalPlaceholder")); value.style.flex = "1 1 auto";
      const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm"; del.innerHTML = Icons.CLOSE; del.title = I18n.t("ui.chips.remove");
      del.onclick = () => { const i = inputs.indexOf(value); if (i >= 0) inputs.splice(i, 1); row.remove(); };
      row.append(value, del); rows.appendChild(row); inputs.push(value);
    };
    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-ghost btn-sm"; add.style.marginTop = "6px";
    add.textContent = I18n.t("certs.admin.san.addPrincipal"); add.onclick = () => addRow();
    container.append(rows, add);
    addRow();
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
  /** Options du filtre « État » — SÉLECTION UNIQUE (le serveur n'accepte qu'UN `status` :
      active|revoked|expired|expiring) : un MultiSelect laisserait croire que les états se combinent, ce que la
      route ne permet pas. « » = tous (aucun filtre d'état). */
  private static statusFilterOpts(): SelectOption[] {
    return [
      { value: "", label: I18n.t("certs.admin.status.all") },
      { value: "active", label: I18n.t("certs.admin.status.active") },
      { value: "revoked", label: I18n.t("certs.admin.status.revoked") },
      { value: "expired", label: I18n.t("certs.admin.status.expired") },
      { value: "expiring", label: I18n.t("certs.admin.status.expiring") },
    ];
  }

  /** État de listing NEUF (défauts : page 1, taille par défaut, tri par libellé ascendant, aucun filtre). */
  private static defaultState(): ListingState {
    return { page: 1, pageSize: PAGE_SIZE_DEFAULT, sort: "label", dir: "asc", kinds: new Set(), status: "" };
  }

  /** Paramètres de listing (query string) dérivés d'un état — factorisé (loadCurrentPage + navigation par
      la recherche). SANS `focus`/`root`, ajoutés ponctuellement par l'appelant. `status`/`kinds` vides = omis. */
  private static listParams(st: ListingState): CertsListParams {
    return {
      page: st.page, pageSize: st.pageSize, sort: st.sort, dir: st.dir,
      kinds: st.kinds.size ? [...st.kinds] : undefined,
      status: st.status || undefined,
    };
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

  /** DN X.509 lisible depuis CN (+ O éventuel) — sert de `subject` stocké/affiché. */
  private static subjectDn(commonName: string, organization?: string): string {
    const parts = ["CN=" + commonName];
    if (organization && organization.trim() !== "") parts.push("O=" + organization.trim());
    return parts.join(", ");
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
      key_algo: item.key_algo, public_pem: item.public_pem, revoked_at: item.revoked_at, sans: item.sans,
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

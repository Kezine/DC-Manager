import { Html } from "../core/Html";
import { Format } from "../core/Format";
import { CertsFormat } from "../core/CertsFormat";
import { CertsSearch, type CertSearchItem, type CertNavTarget } from "../core/CertsSearch";
import { SearchPop, type SearchPopResult } from "../ui/SearchPop";
import { FormControls, type SelectOption } from "../ui/FormControls";
import { MultiSelect, type MultiItem } from "../ui/MultiSelect";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_OPTIONS } from "../data/config";
import { Notify } from "../ui/Notify";
import { Clipboard } from "../ui/Clipboard";
import { Dialog } from "../ui/Dialog";
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

   VERROUILLÉ vs DÉVERROUILLÉ : verrouillée, la LISTE (métadonnées + échéances) reste
   CONSULTABLE en lecture seule ; seules les opérations de CLÉ (créer/émettre/exporter/
   révoquer/supprimer) exigent le déverrouillage.

   MODE : le service est SANS OBJET hors mode API (pas de serveur, pas de crypto scopée
   par document). En mode fichier/viewer, `client` est null → message « mode API requis ».
   503 (module en erreur serveur) → bandeau détaillé (pattern NotificationsAdminView).
   ============================================================================= */

/** Algorithmes de clé X.509 proposés à la création (données pures d'UI). */
const ALGO_X509_OPTS: SelectOption[] = [
  { value: "ec-p256", label: "EC P-256 (recommandé)" },
  { value: "rsa-2048", label: "RSA 2048" },
  { value: "rsa-4096", label: "RSA 4096" },
];
/** Usage d'une feuille TLS → ExtendedKeyUsage. */
const USAGE_OPTS: SelectOption[] = [
  { value: "server", label: "Serveur (TLS)" },
  { value: "client", label: "Client" },
  { value: "both", label: "Les deux" },
];
/** Types de SAN X.509 (le « principal » SSH est saisi séparément pour un certificat SSH). */
const SAN_TYPE_OPTS: SelectOption[] = [
  { value: "dns", label: "DNS" },
  { value: "ip", label: "IP" },
  { value: "email", label: "E-mail" },
];
/** Type d'un certificat SSH. */
const SSH_CERT_TYPE_OPTS: SelectOption[] = [
  { value: "user", label: "Utilisateur" },
  { value: "host", label: "Hôte" },
];

/** Familles proposées au filtre « Type » de la VUE A (autorités & clés = premier niveau, parent_id nul). */
const ROOT_KIND_FILTER: MultiItem[] = [
  { id: "root-ca", label: CertsFormat.kindLabel("root-ca") },
  { id: "ssh-ca", label: CertsFormat.kindLabel("ssh-ca") },
  { id: "ssh-keypair", label: CertsFormat.kindLabel("ssh-keypair") },
];
/** Familles proposées au filtre « Type » de la VUE B (dérivés émis en v1 : feuilles TLS + certificats SSH ;
    les CA intermédiaires ne sont pas produites en v1 — le schéma les autoriserait, cf. cadrage). */
const CERT_KIND_FILTER: MultiItem[] = [
  { id: "leaf-tls", label: CertsFormat.kindLabel("leaf-tls") },
  { id: "ssh-cert", label: CertsFormat.kindLabel("ssh-cert") },
];
/** Options du filtre « État » — SÉLECTION UNIQUE (le serveur n'accepte qu'UN `status` :
    active|revoked|expired|expiring) : un MultiSelect laisserait croire que les états se combinent, ce que la
    route ne permet pas. « » = tous (aucun filtre d'état). */
const STATUS_FILTER_OPTS: SelectOption[] = [
  { value: "", label: "Tous les états" },
  { value: "active", label: "Actif" },
  { value: "revoked", label: "Révoqué" },
  { value: "expired", label: "Expiré" },
  { value: "expiring", label: "Expire ≤ 30 j" },
];

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
      this.renderMessage("Chargement impossible — " + CertsAdminView.errText(e), true);
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

  /** Barre d'outils : statut (verrouillé/déverrouillé) + actions (créations + verrouiller si ouvert). */
  private buildToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:10px";
    const left = document.createElement("div"); left.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";
    const status = document.createElement("span");
    status.innerHTML = this.session.unlocked ? this.pill("déverrouillé", "ok") : this.pill("verrouillé", "warn");
    left.appendChild(status);
    // Recherche (L3) : visible dans les DEUX vues et MÊME verrouillée — elle ne lit que des métadonnées
    // (aucune opération de clé). Le clic sur un résultat ouvre la bonne vue avec l'élément mis en évidence.
    left.appendChild(this.searchBox());

    const right = document.createElement("div"); right.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
    if (this.session.unlocked) {
      right.append(
        this.actionButton("+ CA racine X.509", "Créer une autorité racine X.509 auto-signée", () => this.rootCaModal(), "btn-primary"),
        this.actionButton("+ CA SSH", "Créer une autorité de certification SSH (ed25519)", () => this.sshKeyModal("ssh-ca"), "btn-primary"),
        this.actionButton("+ Paire SSH", "Créer une paire de clés SSH simple (ed25519)", () => this.sshKeyModal("ssh-keypair"), "btn-primary"),
      );
      right.appendChild(this.actionButton("Verrouiller", "Oublier la clé maître (verrouillage immédiat)", () => { this.session.lock(); }));
    }
    right.appendChild(this.actionButton("Actualiser", "Recharger la liste", () => { this.session.touch(); void this.reload(); }));

    bar.append(left, right);
    return bar;
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
        placeholder: "Rechercher un certificat (libellé, sujet, série, SAN)…",
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
      title.textContent = "Opérations de clé indisponibles — contexte non sécurisé";
      const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.whiteSpace = "pre-line";
      hint.textContent = "Le navigateur désactive la cryptographie WebCrypto (crypto.subtle) quand la page n'est pas servie dans un contexte sécurisé. "
        + "Pour initialiser ou déverrouiller la PKI, accédez à l'application en HTTPS (cf. docs/reverse-proxy.md pour servir derrière un proxy TLS) "
        + "ou via http://localhost. La liste des certificats et leurs échéances restent consultables ci-dessous.";
      box.append(title, hint);
      return box;
    }

    if (state.initialized !== true) {
      // PKI VIERGE → proposer l'initialisation (formulaire EN MODALE).
      const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:6px";
      title.textContent = "PKI non initialisée";
      const hint = document.createElement("div"); hint.className = "form-hint";
      hint.textContent = "Ce document n'a pas encore de clé maître. Initialisez la PKI pour créer et chiffrer des clés privées : le chiffrement se fait dans votre navigateur, le serveur ne voit jamais la clé maître.";
      const btn = this.actionButton("Initialiser la PKI…", "Choisir une phrase secrète maître", () => this.initModal(), "btn-primary");
      btn.style.marginTop = "10px";
      box.append(title, hint, btn);
      return box;
    }

    // PKI INITIALISÉE → déverrouillage par phrase secrète (input password STANDARD .form-field).
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:6px";
    title.textContent = "Déverrouiller la clé maître";
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.marginBottom = "8px";
    hint.textContent = "Saisissez la phrase secrète maître pour créer, émettre ou exporter des clés. La liste ci-dessous reste consultable sans déverrouiller.";

    const passField = document.createElement("div"); passField.className = "form-field"; passField.style.margin = "0";
    const label = document.createElement("label"); label.textContent = "Phrase secrète maître";
    const input = document.createElement("input"); input.type = "password"; input.autocomplete = "current-password"; input.placeholder = "phrase secrète";
    passField.append(label, input);

    const errBox = this.errBox();
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:8px";
    const btn = this.actionButton("Déverrouiller", "Dériver la clé maître et vérifier la phrase", () => void this.attemptUnlock(input.value, errBox), "btn-primary");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void this.attemptUnlock(input.value, errBox); } });
    row.append(passField, btn);

    box.append(title, hint, row, errBox);
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

  /** En-tête de la section listing (intro vue A, ou fil d'Ariane « ← Autorités » + titre vue B) + toolbar de
      filtres + le conteneur de corps (rempli par paintBody). */
  private buildListingSection(): HTMLElement {
    const wrap = document.createElement("div");
    if (this.view === "certs" && this.rootScope) {
      const bc = document.createElement("div"); bc.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px";
      bc.appendChild(this.actionButton("← Autorités", "Revenir à la liste des autorités & clés", () => this.goToRoots()));
      const title = document.createElement("span"); title.style.cssText = "font-weight:600;color:var(--fg)";
      title.textContent = "Certificats de « " + this.rootScope.label + " »";
      bc.appendChild(title);
      wrap.appendChild(bc);
    } else {
      const intro = document.createElement("div"); intro.className = "form-hint"; intro.style.marginBottom = "8px";
      intro.textContent = this.session.unlocked
        ? "Autorités et clés de ce document. Émettez, exportez, révoquez ou supprimez ; « Lister les certificats » ouvre le détail d'une autorité."
        : "Autorités et clés de ce document (lecture seule). Déverrouillez pour les opérations de clé.";
      wrap.appendChild(intro);
    }
    wrap.appendChild(this.buildListingToolbar());
    this.bodyEl = document.createElement("div");
    wrap.appendChild(this.bodyEl);
    return wrap;
  }

  /** Toolbar de filtres (CSS ListView : .list-toolbar/.lt-filters/.lt-flabel/.lt-reset) : « Type » (MultiSelect,
      kinds pertinents à la vue) + « État » (SÉLECTION UNIQUE — le serveur n'accepte qu'un status) + réinit. */
  private buildListingToolbar(): HTMLElement {
    const st = this.currentState();
    const bar = document.createElement("div"); bar.className = "list-toolbar";
    const fg = document.createElement("div"); fg.className = "lt-filters";
    const fl = document.createElement("span"); fl.className = "lt-flabel"; fl.textContent = "Filtrer";
    fg.appendChild(fl);

    const kindItems = this.view === "roots" ? ROOT_KIND_FILTER : CERT_KIND_FILTER;
    // Purge des kinds mémorisés hors du jeu de la vue (parité ListView) — évite un filtre fantôme.
    const valid = new Set(kindItems.map((k) => k.id));
    [...st.kinds].forEach((k) => { if (!valid.has(k)) st.kinds.delete(k); });
    fg.appendChild(MultiSelect.build("Type", kindItems, st.kinds, () => { st.page = 1; void this.refreshBody(); }));

    const statusSel = FormControls.select(STATUS_FILTER_OPTS, st.status);
    statusSel.onchange = () => { st.status = statusSel.value; st.page = 1; void this.refreshBody(); };
    const statusWrap = document.createElement("label"); statusWrap.style.cssText = "display:inline-flex;align-items:center;gap:6px";
    const sl = document.createElement("span"); sl.className = "lt-flabel"; sl.textContent = "État";
    statusWrap.append(sl, statusSel);
    fg.appendChild(statusWrap);

    const reset = document.createElement("button"); reset.type = "button"; reset.className = "lt-reset btn btn-ghost btn-sm"; reset.textContent = "Réinit. filtres";
    reset.onclick = () => { st.kinds.clear(); st.status = ""; st.page = 1; void this.rerender(); };
    fg.appendChild(reset);

    bar.appendChild(fg);
    return bar;
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
      this.sortableTh("Libellé", "label", st), this.sortableTh("Type", "kind", st), this.plainTh("Sujet"),
      this.sortableTh("Échéance", "not_after", st), this.plainTh("État"),
      this.sortableTh("Dérivés", "children_total", st), this.plainTh("Sous seuil"), this.plainTh(""),
    );
    thead.appendChild(tr);
    const tbody = document.createElement("tbody");
    if (!this.rootItems.length) tbody.appendChild(this.emptyRow(9));
    else for (const item of this.rootItems) tbody.appendChild(this.buildRootRow(item));
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
    tr.appendChild(this.htmlCell(item.revoked_at ? this.pill("révoqué", "err") : CertsAdminView.MUTED));
    // Dérivés : nombre total de descendants (0 pour une paire simple).
    const derived = document.createElement("td"); derived.textContent = String(item.children_total);
    if (item.children_total === 0) derived.style.color = "var(--fg-dimmer)";
    tr.appendChild(derived);
    tr.appendChild(this.htmlCell(this.alertCell(item)));
    // Actions : opérations de clé si déverrouillé + « Déployer la confiance… » / « Lister les certificats »
    // (consultation, disponibles MÊME verrouillé — aucune clé requise).
    const actions = document.createElement("td");
    if (this.session.unlocked) this.fillActions(actions, item);
    // Aide au déploiement : uniquement les AUTORITÉS (racine X.509 ou CA SSH) — pas les paires simples ni les
    // dérivés. Consultation pure (procédure d'installation dans les magasins de confiance des clients).
    if (item.kind === "root-ca" || item.kind === "ssh-ca") actions.appendChild(this.actionButton("Déployer la confiance…", "Procédure d'installation de cette autorité dans les magasins de confiance des clients", () => this.deployTrustModal(item)));
    if (item.children_total > 0) actions.appendChild(this.actionButton("Lister les certificats", "Voir les certificats de cette autorité", () => this.openCerts(item)));
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
      this.sortableTh("Libellé", "label", st), this.sortableTh("Type", "kind", st),
      this.sortableTh("Émetteur", "parent", st), this.plainTh("Sujet"),
      this.sortableTh("Échéance", "not_after", st), this.plainTh("État"), this.plainTh(""),
    );
    thead.appendChild(tr);
    const tbody = document.createElement("tbody");
    if (!this.certItems.length) tbody.appendChild(this.emptyRow(8));
    else for (const item of this.certItems) tbody.appendChild(this.buildCertRow(item));
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
    tr.appendChild(this.htmlCell(item.revoked_at ? this.pill("révoqué", "err") : CertsAdminView.MUTED));
    const actions = document.createElement("td");
    if (this.session.unlocked) this.fillActions(actions, item);
    tr.appendChild(actions);
    return tr;
  }

  /* ---- Cellules & pagination communes ---- */

  /** Cellule libellé (indication « clé détenue » en title, comme l'arbre d'origine). */
  private labelCell(item: CertificateListItem): HTMLElement {
    const td = document.createElement("td");
    const span = document.createElement("span"); span.textContent = item.label;
    if (item.has_key) span.title = "Clé privée détenue (chiffrée)";
    td.appendChild(span);
    return td;
  }

  private subjectCell(subject: string): HTMLElement {
    const td = document.createElement("td"); td.style.cssText = "font-family:var(--mono);font-size:12px"; td.textContent = subject;
    return td;
  }

  private plainTh(text: string): HTMLElement {
    const th = document.createElement("th"); th.textContent = text; return th;
  }

  /** En-tête TRIABLE (CSS ListView : .sortable + .sort-ind ▲/▼). Clic : bascule le sens si déjà actif, sinon
      trie ASC sur cette colonne ; retour page 1 puis repeint le corps (rechargement serveur). */
  private sortableTh(text: string, sortKey: string, st: ListingState): HTMLElement {
    const th = document.createElement("th"); th.className = "sortable"; th.textContent = text;
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
    td.textContent = this.session.unlocked ? "Aucun élément. Créez une autorité ou ajustez les filtres." : "Aucun élément.";
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
    info.textContent = meta.total + " élément" + (meta.total > 1 ? "s" : "") + " · page " + meta.page + "/" + meta.pages;
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
    for (const n of PAGE_SIZE_OPTIONS) { const o = document.createElement("option"); o.value = String(n); o.textContent = n + "/page"; if (n === st.pageSize) o.selected = true; sel.appendChild(o); }
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

  /** Boutons d'action d'une ligne (déverrouillé) : émission (CA), export, révocation, suppression. */
  private fillActions(cell: HTMLElement, item: CertificateListItem): void {
    if (item.kind === "root-ca" && !item.revoked_at) cell.appendChild(this.actionButton("Émettre TLS", "Émettre une feuille TLS signée par cette CA", () => this.leafModal(item)));
    if (item.kind === "ssh-ca" && !item.revoked_at) cell.appendChild(this.actionButton("Émettre SSH", "Émettre un certificat SSH signé par cette CA", () => this.sshCertModal(item)));
    if (!item.revoked_at) cell.appendChild(this.actionButton("Exporter…", "Télécharger les artefacts", () => void this.exportModal(item)));
    if (!item.revoked_at) cell.appendChild(this.actionButton("Révoquer", "Marquer révoqué (exclu des exports)", () => void this.revoke(item)));
    cell.appendChild(this.actionButton("Supprimer", "Supprimer définitivement", () => void this.remove(item)));
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
    return { kind: item.kind, label: item.label, has_key: item.has_key, revoked_at: item.revoked_at };
  }

  /** En-tête de la colonne de sélection : case « toute la page » (cochée/indéterminée synchronisée après coup). */
  private selectHeaderCell(): HTMLElement {
    const th = document.createElement("th"); th.style.width = "1%";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.title = "Sélectionner toute la page";
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
    cb.title = "Sélectionner « " + item.label + " »";
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
    count.textContent = n + " sélectionné" + (n > 1 ? "s" : "");
    this.selBarEl.appendChild(count);

    const av = BulkActions.commonActions([...this.selection.values()], this.session.unlocked);
    if (av.canExport) this.selBarEl.appendChild(this.actionButton(av.exportLabel, "Choisir les artefacts communs et télécharger une archive ZIP (protégeable par mot de passe)", () => this.bulkExportDialog(), "btn-primary"));
    if (av.canRevoke) this.selBarEl.appendChild(this.actionButton("Révoquer (" + n + ")", "Marquer révoqués (exclus des exports)", () => void this.bulkRevoke()));
    if (av.canDelete) this.selBarEl.appendChild(this.actionButton("Supprimer (" + n + ")", "Supprimer définitivement", () => void this.bulkDelete()));
    this.selBarEl.appendChild(this.actionButton("Effacer la sélection", "Vider la sélection courante", () => this.clearSelection()));
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
    intro.textContent = "Choisissez les artefacts COMMUNS à exporter (une archive ZIP, un dossier par certificat). Les clés privées sont déchiffrées LOCALEMENT (session déverrouillée) et ne transitent jamais par le serveur.";
    root.appendChild(intro);

    // Note d'exclusion : les révoqués ne sont jamais emballés (décision Q4). Affichée seulement s'il y en a.
    if (part.excludedRevoked.length) {
      const r = part.excludedRevoked.length;
      const note = document.createElement("div"); note.className = "form-hint"; note.style.cssText = "margin-bottom:10px;color:var(--warn)";
      note.textContent = r + " révoqué" + (r > 1 ? "s" : "") + " ser" + (r > 1 ? "ont" : "a") + " exclu" + (r > 1 ? "s" : "") + " de l'archive.";
      root.appendChild(note);
    }

    // Cases à cocher des catégories DISPONIBLES (tout coché par défaut, cf. cadrage).
    const checks = new Map<ExportCategoryKey, HTMLInputElement>();
    const catBox = document.createElement("div"); catBox.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:12px";
    const catTitle = document.createElement("div"); catTitle.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:2px";
    catTitle.textContent = "Artefacts à inclure";
    catBox.appendChild(catTitle);
    for (const c of available) {
      const lab = document.createElement("label"); lab.style.cssText = "display:flex;gap:8px;align-items:center;cursor:pointer";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true;
      const span = document.createElement("span"); span.textContent = c.label;
      lab.append(cb, span); catBox.appendChild(lab); checks.set(c.key, cb);
    }
    root.appendChild(catBox);

    // Mot de passe OPTIONNEL (deux champs) : vides = ZIP en clair ; renseigné = AES-256 (WinZip AE-2).
    const p1 = FormControls.text("", "laisser vide = ZIP non chiffré"); p1.type = "password"; p1.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow("Mot de passe (optionnel)", p1, "Vide = archive NON chiffrée. Renseigné = chiffrement AES-256."));
    const p2 = FormControls.text("", "confirmer le mot de passe"); p2.type = "password"; p2.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow("Confirmer", p2, "AES-256 — s'ouvre avec 7-Zip/WinRAR, PAS avec l'explorateur Windows natif."));

    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: "Exporter " + n + " certificat" + (n > 1 ? "s" : "") + " (ZIP)",
      body: root,
      saveLabel: "Exporter",
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const selected = new Set<ExportCategoryKey>();
        for (const [key, cb] of checks) if (cb.checked) selected.add(key);
        if (selected.size === 0) { this.showError(errBox, "Sélectionnez au moins une catégorie d'artefacts à exporter."); return false; }
        // Mot de passe : deux vides = pas de chiffrement ; non identiques = erreur ; non vide = AES-256.
        const pass = p1.value;
        if (pass !== "" && pass !== p2.value) { this.showError(errBox, "Les deux mots de passe ne correspondent pas."); return false; }
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
      if (!item) { errors.push({ label: snap.label, reason: "introuvable (supprimé entre-temps ?)" }); continue; }
      try {
        const keyPem = (withKeys && item.has_key) ? await this.decryptKey(id) : null;   // clé déchiffrée LOCALEMENT
        const rec: CertBundleRecord = { id: item.id, label: item.label, parent_id: item.parent_id, public_pem: item.public_pem, revoked_at: item.revoked_at, kind: item.kind, subject: item.subject };
        const artifacts = await CertZip.bundleFor(rec, all, keyPem, categories);
        if (artifacts.length) { entries.push({ folder: item.label, artifacts }); done++; }
        else errors.push({ label: item.label, reason: "aucun artefact exportable (catégories cochées absentes de cet objet)" });
      } catch (e) { errors.push({ label: snap.label, reason: CertsAdminView.errText(e) }); }
    }

    if (entries.length) {
      // Avec mot de passe → ZIP chiffré AES-256 (zip.js, async) ; sinon → ZIP en clair (fflate, sync).
      const zip = password ? await CertZip.zipArtifactsEncrypted(entries, password) : CertZip.zipArtifacts(entries);
      Download.data("certificats-" + CertsAdminView.stamp() + ".zip", zip, "application/zip");
    }
    // BILAN : réussis, exclus (révoqués), en erreur — construit AVANT de vider la sélection (labels lus depuis elle).
    const encNote = password ? " · archive chiffrée AES-256" : "";
    const lines = [
      entries.length
        ? "✔ " + done + " certificat" + (done > 1 ? "s" : "") + " exporté" + (done > 1 ? "s" : "") + (withKeys ? " (clés privées incluses là où détenues)" : " (artefacts publics seuls)") + encNote
        : "Aucun certificat exporté.",
      ...part.excludedRevoked.map((id) => "✕ « " + (this.selection.get(id)?.label || id) + " » exclu — révoqué (décision Q4)"),
      ...errors.map((e) => "✕ « " + e.label + " » — " + e.reason),
    ];
    this.showBulkSummary("Export ZIP", lines);
    this.clearSelection();   // aucune donnée modifiée : on vide simplement la sélection (cadrage §5)
  }

  /** RÉVOCATION groupée : confirmation, puis N PUT (revoked_at=now, key_enc conservé). Une liste complète
      fournit les métadonnées à re-soumettre (le PUT exige le corps complet ; key_enc absent = conservé). Bilan. */
  private async bulkRevoke(): Promise<void> {
    this.session.touch();
    const ids = [...this.selection.keys()];
    const n = ids.length;
    const ok = await Dialog.confirm({
      title: "Révoquer " + n + " certificat" + (n > 1 ? "s" : "") + " ?",
      message: "Les certificats sélectionnés seront marqués révoqués et EXCLUS des exports. Les clés privées stockées sont conservées.",
      confirmLabel: "Révoquer", danger: true,
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
      if (!item) { errors.push({ label: snap.label, reason: "introuvable (supprimé entre-temps ?)" }); continue; }
      if (item.revoked_at) { errors.push({ label: item.label, reason: "déjà révoqué" }); continue; }
      try { await this.client!.save(id, CertsAdminView.metadataInput(item, { revoked_at: now })); done++; }
      catch (e) { errors.push({ label: item.label, reason: CertsAdminView.errText(e) }); }
    }
    this.showBulkSummary("Révocation", [
      "✔ " + done + " certificat" + (done > 1 ? "s" : "") + " révoqué" + (done > 1 ? "s" : ""),
      ...errors.map((e) => "✕ « " + e.label + " » — " + e.reason),
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
    const ok = await Dialog.confirm({
      title: "Supprimer " + n + " certificat" + (n > 1 ? "s" : "") + " ?",
      message: "Les certificats sélectionnés (clés privées chiffrées + métadonnées) seront EFFACÉS du serveur (irréversible). Un émetteur ayant des dérivés ne peut pas être supprimé : il sera signalé au bilan.",
      confirmLabel: "Supprimer", danger: true,
    });
    if (!ok) return;

    const errors: Array<{ label: string; reason: string }> = [];
    let done = 0;
    for (const id of ids) {
      const snap = this.selection.get(id)!;
      try { await this.client!.remove(id); done++; }
      catch (e) {
        if (e instanceof CertsError && e.status === 409) errors.push({ label: snap.label, reason: "des certificats dérivés existent — supprimer d'abord la descendance" });
        else errors.push({ label: snap.label, reason: CertsAdminView.errText(e) });
      }
    }
    this.showBulkSummary("Suppression", [
      "✔ " + done + " certificat" + (done > 1 ? "s" : "") + " supprimé" + (done > 1 ? "s" : ""),
      ...errors.map((e) => "✕ « " + e.label + " » — " + e.reason),
    ]);
    this.clearSelection();
    await this.refreshBody();
  }

  /** BILAN d'une action groupée (Dialog à un seul bouton) : lignes réussies (✔) et refusées/exclues (✕),
      colorées. JAMAIS de silence partiel — chaque élément non traité y figure avec sa raison. */
  private showBulkSummary(title: string, lines: string[]): void {
    void Dialog.custom({
      title: "Bilan — " + title,
      hideCancel: true,
      confirmLabel: "OK",
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

  /** Initialisation EN MODALE : phrase ×2, avertissement de perte, dérivation + keycheck + PUT /pki. */
  private initModal(): void {
    const root = document.createElement("div");
    const warn = document.createElement("div"); warn.className = "form-hint"; warn.style.cssText = "margin-bottom:10px;color:var(--warn)";
    warn.textContent = "La phrase secrète maître chiffre TOUTES les clés privées de ce document, dans votre navigateur. Le serveur ne la connaît jamais et ne peut pas la récupérer : si vous la perdez, les clés privées stockées sont DÉFINITIVEMENT perdues (les certificats publics et métadonnées, eux, restent lisibles).";
    root.appendChild(warn);

    const p1 = FormControls.text("", "phrase secrète maître"); p1.type = "password"; p1.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow("Phrase secrète maître", p1, "Choisissez une phrase longue et unique."));
    const p2 = FormControls.text("", "confirmer la phrase"); p2.type = "password"; p2.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow("Confirmation", p2, "Ressaisissez la même phrase."));

    const errBox = this.errBox(); root.appendChild(errBox);
    this.host.openModal({
      title: "Initialiser la PKI du document",
      body: root,
      saveLabel: "Initialiser et déverrouiller",
      onSave: async () => {
        errBox.style.display = "none";
        const pass = p1.value;
        if (pass.trim() === "") { this.showError(errBox, "Phrase secrète requise."); return false; }
        if (pass !== p2.value) { this.showError(errBox, "Les deux phrases ne correspondent pas."); return false; }
        try {
          const salt = PkiCrypto.generateSaltB64();
          const iters = PkiCrypto.DEFAULT_ITERS;
          const key = await PkiCrypto.deriveKey(pass, salt, iters);
          const keycheck = await PkiCrypto.makeKeycheck(key);
          await this.client!.initPki({ kdf_version: PkiCrypto.KDF_VERSION, kdf_salt: salt, kdf_iters: iters, keycheck_enc: keycheck });
          this.session.unlock(key);
          await this.reload();
          Notify.toast("PKI initialisée — session déverrouillée", "ok");
          return true;
        } catch (e) { this.showError(errBox, e); return false; }
      },
    });
    setTimeout(() => p1.focus(), 30);
  }

  /** Déverrouillage : dérive la clé, vérifie le keycheck (bon → unlock ; mauvais → message NEUTRE). */
  private async attemptUnlock(pass: string, errBox: HTMLElement): Promise<void> {
    const state = this.pkiState;
    if (!state || state.initialized !== true) return;
    errBox.style.display = "none";
    if (pass.trim() === "") { this.showError(errBox, "Phrase secrète requise."); return; }
    try {
      const key = await PkiCrypto.deriveKey(pass, state.kdf_salt, state.kdf_iters);
      const ok = await PkiCrypto.verifyKeycheck(key, state.keycheck_enc);
      if (!ok) { this.showError(errBox, "Clé maître incorrecte."); return; }  // aucun détail (invariant sécurité)
      this.session.unlock(key);
      this.render();
      Notify.toast("Session déverrouillée", "ok");
    } catch (_) {
      // Toute erreur (dérivation, blob) → même réponse neutre, sans matériau de clé.
      this.showError(errBox, "Clé maître incorrecte.");
    }
  }

  /* --------------------------------------------------------------------------
     Créations (TOUTES en MODALE — principe n°11)
     -------------------------------------------------------------------------- */

  /** CA racine X.509 auto-signée. */
  private rootCaModal(): void {
    const root = document.createElement("div");
    const cn = FormControls.text("", "ex. CA Racine interne");
    root.appendChild(FormControls.fieldRow("Nom commun (CN)", cn, "Identité de l'autorité (CN du certificat)."));
    const org = FormControls.text("", "ex. Mon Organisation");
    root.appendChild(FormControls.fieldRow("Organisation (facultatif)", org, "Ajoutée au sujet (O=…) si renseignée."));
    const algo = FormControls.select(ALGO_X509_OPTS, "ec-p256");
    root.appendChild(FormControls.fieldRow("Algorithme de clé", algo, "EC P-256 (compact) ou RSA 2048/4096."));
    const days = FormControls.number(3650, { min: 1, step: 1 });
    root.appendChild(FormControls.fieldRow("Durée de validité (jours)", days, "Défaut 3650 (~10 ans) pour une CA racine."));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: "Nouvelle CA racine X.509",
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const commonName = cn.value.trim();
        if (commonName === "") { this.showError(errBox, "Nom commun (CN) requis."); return false; }
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
          Notify.toast("CA racine créée", "ok");
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
    const cn = FormControls.text("", "ex. service.interne");
    root.appendChild(FormControls.fieldRow("Nom commun (CN)", cn, "Identité de la feuille (souvent le nom d'hôte principal)."));
    const sanEditor = this.buildSanEditor();
    root.appendChild(FormControls.fieldRow("Noms alternatifs (SAN)", sanEditor.element, "dns / ip / email. Les navigateurs valident le SAN, pas le CN — ajoutez au moins le nom d'hôte."));
    const usage = FormControls.select(USAGE_OPTS, "server");
    root.appendChild(FormControls.fieldRow("Usage", usage, "Serveur (TLS entrant), client (authentification) ou les deux."));
    const algo = FormControls.select(ALGO_X509_OPTS, "ec-p256");
    root.appendChild(FormControls.fieldRow("Algorithme de clé", algo, "EC P-256 ou RSA."));
    const days = FormControls.number(397, { min: 1, step: 1 });
    root.appendChild(FormControls.fieldRow("Durée de validité (jours)", days, "Défaut 397 (limite navigateurs pour un certificat serveur)."));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: "Émettre un certificat TLS",
      subtitle: Html.escape(ca.label),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const commonName = cn.value.trim();
        if (commonName === "") { this.showError(errBox, "Nom commun (CN) requis."); return false; }
        const sans = sanEditor.collect();
        try {
          const detail = await this.client!.getOne(ca.id);
          if (!detail.key_enc) { this.showError(errBox, "Cette CA ne détient pas de clé privée — émission impossible."); return false; }
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
          Notify.toast("Certificat TLS émis", "ok");
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
    const ident = FormControls.text("", kind === "ssh-ca" ? "ex. ca-ssh@interne" : "ex. utilisateur@poste");
    root.appendChild(FormControls.fieldRow("Identité (commentaire)", ident, "Commentaire OpenSSH de la clé (identité lisible). Sert aussi de libellé."));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: kind === "ssh-ca" ? "Nouvelle CA SSH (ed25519)" : "Nouvelle paire SSH (ed25519)",
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const comment = ident.value.trim();
        if (comment === "") { this.showError(errBox, "Identité (commentaire) requise."); return false; }
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
          Notify.toast(kind === "ssh-ca" ? "CA SSH créée" : "Paire SSH créée", "ok");
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
    const keyId = FormControls.text("", "ex. acces-admin-2026");
    root.appendChild(FormControls.fieldRow("Identifiant du certificat (key id)", keyId, "Journalisé par le serveur SSH lors de l'authentification."));
    const type = FormControls.select(SSH_CERT_TYPE_OPTS, "user");
    root.appendChild(FormControls.fieldRow("Type", type, "Utilisateur (accès à un compte) ou hôte (identité d'un serveur)."));
    const principalsEditor = this.buildPrincipalsEditor();
    root.appendChild(FormControls.fieldRow("Principaux (principals)", principalsEditor.element, "Logins autorisés (user) ou noms d'hôte (host). Vide = valable pour tous (déconseillé)."));
    const days = FormControls.number(365, { min: 1, step: 1 });
    root.appendChild(FormControls.fieldRow("Durée de validité (jours)", days, "Durée de vie du certificat SSH."));
    const info = document.createElement("div"); info.className = "form-hint"; info.style.marginTop = "6px";
    info.textContent = "Une NOUVELLE paire ed25519 sujette est générée avec ce certificat (v1). Sa clé privée est chiffrée et stockée avec le certificat.";
    root.appendChild(info);
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: "Émettre un certificat SSH",
      subtitle: Html.escape(ca.label),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        const id = keyId.value.trim();
        if (id === "") { this.showError(errBox, "Identifiant (key id) requis."); return false; }
        const nbDays = Number(days.value);
        if (!Number.isFinite(nbDays) || nbDays <= 0) { this.showError(errBox, "Durée invalide."); return false; }
        const principals = principalsEditor.collect();
        try {
          const detail = await this.client!.getOne(ca.id);
          if (!detail.key_enc) { this.showError(errBox, "Cette CA SSH ne détient pas de clé privée — signature impossible."); return false; }
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
          Notify.toast("Certificat SSH émis", "ok");
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
    intro.textContent = "Téléchargez les artefacts de « " + item.label + " ». Les clés privées sont déchiffrées LOCALEMENT (session déverrouillée) et ne transitent jamais par le serveur.";
    root.appendChild(intro);
    const list = document.createElement("div"); list.style.cssText = "display:flex;flex-direction:column;gap:8px;align-items:flex-start";
    root.appendChild(list);

    // Un bouton par artefact ; `run` renvoie true pour GARDER la modale (ex. PKCS#12 ouvre sa propre modale).
    const addAction = (label: string, run: () => Promise<boolean | void>): void => {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.style.textAlign = "left";
      b.textContent = label;
      b.onclick = async () => {
        this.session.touch();
        try { const keep = await run(); if (!keep) this.host.closeModal?.(); }
        catch (e) { Notify.toast(CertsAdminView.errText(e), "err"); }   // laisse la modale ouverte
      };
      list.appendChild(b);
    };

    // Export UNITAIRE « Tout (ZIP) » (L4) : le BUNDLE complet du certificat en une archive (ex. feuille TLS =
    // cert + fullchain + clé en un geste). Clé privée incluse SI session déverrouillée ET clé détenue, sinon
    // artefacts publics seuls — le libellé du bouton l'indique.
    const withKey = this.session.unlocked && item.has_key;
    addAction("Tout (ZIP)" + (withKey ? " — cert + clé privée" : " — artefacts publics"), async () => {
      const keyPem = withKey ? await this.decryptKey(item.id) : null;
      const bundleRec: CertBundleRecord = { id: item.id, label: item.label, parent_id: item.parent_id, public_pem: item.public_pem, revoked_at: item.revoked_at, kind: item.kind, subject: item.subject };
      const artifacts = await CertZip.bundleFor(bundleRec, all, keyPem);
      const zip = CertZip.zipArtifacts([{ artifacts }]);
      Download.data(CertExports.safeFileName(item.label) + ".zip", zip, "application/zip");
    });

    if (item.kind === "root-ca" || item.kind === "leaf-tls") {
      addAction("Certificat public (.pem)", async () => this.download(CertExports.pemCertificate(rec)));
      addAction("Chaîne complète (fullchain.pem)", async () => this.download(CertExports.pemFullchain(rec, all)));
      if (item.kind === "leaf-tls") addAction("Chaîne d'autorité (ca-chain.pem)", async () => this.download(CertExports.pemCaChain(rec, all)));
      if (item.has_key) {
        addAction("Clé privée (.key.pem)", async () => this.download(CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id))));
        addAction("Paquet PKCS#12 (.p12)…", async () => { this.pkcs12Flow(item, rec, all); return true; });
      }
    } else if (item.kind === "ssh-ca" || item.kind === "ssh-keypair") {
      if (item.has_key) {
        addAction("Clé OpenSSH (privée + .pub)", async () => {
          const seed = await this.seedFromPkcs8Pem(await this.decryptKey(item.id));
          const publicKey = CertsAdminView.ed25519PubFromLine(item.public_pem || "");
          for (const art of CertExports.opensshArtifacts(rec, { kind: item.kind as "ssh-ca" | "ssh-keypair", seed, publicKey, comment: item.subject })) this.download(art);
        });
        addAction("Clé privée (.key.pem)", async () => this.download(CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id))));
      }
    } else if (item.kind === "ssh-cert") {
      addAction("Certificat SSH (-cert.pub)", async () => { for (const art of CertExports.opensshArtifacts(rec, { kind: "ssh-cert", certLine: item.public_pem || "" })) this.download(art); });
      if (item.has_key) addAction("Clé privée du sujet (.key.pem)", async () => this.download(CertExports.pemPrivateKey(item.label, await this.decryptKey(item.id))));
    }

    if (!list.children.length) { const n = document.createElement("div"); n.className = "form-hint"; n.textContent = "Aucun export disponible pour cet objet."; root.appendChild(n); }
    this.host.openModal({ title: "Exporter", subtitle: Html.escape(item.label), body: root, hideFooter: true });
  }

  /** PKCS#12 : la passphrase est demandée EN MODALE et JAMAIS stockée. */
  private pkcs12Flow(item: CertificateListItem, rec: CertExportRecord, all: CertExportRecord[]): void {
    const root = document.createElement("div");
    const info = document.createElement("div"); info.className = "form-hint"; info.style.marginBottom = "10px";
    info.textContent = "Le fichier PKCS#12 regroupe le certificat, sa chaîne et la clé privée, protégés par une phrase secrète. Cette phrase n'est PAS stockée — notez-la pour l'import.";
    root.appendChild(info);
    const pass = FormControls.text("", "phrase secrète du fichier .p12"); pass.type = "password"; pass.autocomplete = "new-password";
    root.appendChild(FormControls.fieldRow("Phrase secrète du .p12", pass, "Demandée à l'import du fichier."));
    const errBox = this.errBox(); root.appendChild(errBox);

    this.host.openModal({
      title: "Exporter en PKCS#12",
      subtitle: Html.escape(item.label),
      body: root,
      saveLabel: "Télécharger le .p12",
      onSave: async () => {
        errBox.style.display = "none";
        this.session.touch();
        if (pass.value === "") { this.showError(errBox, "Phrase secrète requise."); return false; }
        try {
          const keyPem = await this.decryptKey(item.id);
          this.download(await CertExports.pkcs12(rec, all, { passphrase: pass.value, privateKeyPkcs8Pem: keyPem }));
          Notify.toast("Fichier PKCS#12 téléchargé", "ok");
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
      subtitle = item.label + " — autorité racine X.509";
    } else if (item.kind === "ssh-ca") {
      // Ligne authorized_keys de la CA SSH (public_pem stocké — public par nature, aucun déchiffrement).
      guide = CertDeployGuide.forSshCa(item.public_pem || "");
      subtitle = item.label + " — CA SSH";
    } else {
      return;   // garde-fou : aucun autre kind n'ouvre cette modale
    }
    this.host.openModal({ title: "Déployer la confiance", subtitle: Html.escape(subtitle), body: this.renderDeployGuide(guide), hideFooter: true, wide: true });
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
    const copy = this.actionButton("Copier", "Copier la commande dans le presse-papiers", () => void Clipboard.copy(command));
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
      title: "Révoquer ce certificat ?",
      message: "« " + item.label + " » sera marqué révoqué et EXCLU des exports. La clé privée stockée est conservée.",
      confirmLabel: "Révoquer", danger: true,
    });
    if (!ok) return;
    try {
      await this.client!.save(item.id, CertsAdminView.metadataInput(item, { revoked_at: new Date().toISOString() }));
      Notify.toast("Certificat révoqué", "ok");
      await this.refreshBody();
    } catch (e) { this.actionError(e); }
  }

  /** Suppression : DELETE avec confirmation ; 409 (descendance) → message clair. */
  private async remove(item: CertificateListItem): Promise<void> {
    this.session.touch();
    const ok = await Dialog.confirm({
      title: "Supprimer définitivement ?",
      message: "Supprimer « " + item.label + " » ? La clé privée chiffrée et les métadonnées seront EFFACÉES du serveur (irréversible).",
      confirmLabel: "Supprimer", danger: true,
    });
    if (!ok) return;
    try {
      await this.client!.remove(item.id);
      Notify.toast("Certificat supprimé", "ok");
      await this.refreshBody();
    } catch (e) {
      if (e instanceof CertsError && e.status === 409) {
        Notify.toast("Suppression refusée : des certificats dérivés existent. Supprimez d'abord la descendance de cet émetteur.", "err");
        return;
      }
      this.actionError(e);
    }
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
      const type = FormControls.select(SAN_TYPE_OPTS, "dns"); type.style.flex = "0 0 90px";
      const value = FormControls.text("", "valeur"); value.style.flex = "1 1 auto";
      const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm"; del.textContent = "✕"; del.title = "Retirer";
      const entry = { type, value };
      del.onclick = () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); row.remove(); };
      row.append(type, value, del); rows.appendChild(row); entries.push(entry);
    };
    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-ghost btn-sm"; add.style.marginTop = "6px";
    add.textContent = "+ Ajouter un SAN"; add.onclick = () => addRow();
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
      const value = FormControls.text("", "login ou nom d'hôte"); value.style.flex = "1 1 auto";
      const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm"; del.textContent = "✕"; del.title = "Retirer";
      del.onclick = () => { const i = inputs.indexOf(value); if (i >= 0) inputs.splice(i, 1); row.remove(); };
      row.append(value, del); rows.appendChild(row); inputs.push(value);
    };
    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-ghost btn-sm"; add.style.marginTop = "6px";
    add.textContent = "+ Ajouter un principal"; add.onclick = () => addRow();
    container.append(rows, add);
    addRow();
    return { element: container, collect: () => inputs.map((i) => i.value.trim()).filter((v) => v !== "") };
  }

  /* --------------------------------------------------------------------------
     Messages d'indisponibilité / erreurs
     -------------------------------------------------------------------------- */

  /** Mode fichier/viewer : le service n'a pas d'objet (pas de serveur) → message clair, aucun appel réseau. */
  private renderNeedsApi(): void {
    this.renderBanner("var(--line)", "Certificats — mode API requis",
      "La PKI interne (clé maître, certificats X.509/SSH) est fournie par le serveur. Elle n'est disponible qu'en mode API. Basculez la source de données sur « API » dans les Réglages pour l'administrer.");
  }

  /** Aucun document courant : rien à administrer tant qu'un document n'est pas ouvert. */
  private renderNoDoc(): void {
    this.renderBanner("var(--line)", "Certificats — aucun document ouvert",
      "La PKI est propre à CHAQUE document. Ouvrez ou créez un document pour gérer sa clé maître et ses certificats.");
  }

  /** 503 : module certificats en erreur côté serveur (ex. certs.db illisible) → détail actionnable. */
  private renderDisabled(err: CertsError): void {
    this.renderBanner("var(--warn)", err.message || "Service de certificats indisponible",
      err.detail || "Le module certificats est désactivé côté serveur (base certs.db illisible). Consultez les journaux du serveur.");
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

  /** Cellule de table dont le contenu est du HTML déjà échappé. */
  private htmlCell(html: string): HTMLTableCellElement {
    const td = document.createElement("td"); td.innerHTML = html; return td;
  }

  private errBox(): HTMLElement {
    const e = document.createElement("div"); e.className = "form-hint err"; e.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    return e;
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

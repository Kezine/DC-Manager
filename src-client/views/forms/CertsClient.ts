/* Client HTTP du module serveur `certs/` (PKI interne ZÉRO-CONNAISSANCE, mode API uniquement) —
   matière de la page d'administration « Certificats » (CertsAdminView).

   Vit à CÔTÉ de la vue admin (retirer la feature = supprimer ces deux fichiers + le branchement de
   main.ts, sans cicatrice ailleurs). Pattern IDENTIQUE à VmSyncClient (client REST dédié, DTOs
   miroirs commentés) : les routes certs sont SCOPÉES PAR DOCUMENT (`<dataBase>/certs/…`, montées
   sous `/documents/{docId}` côté serveur), on tape donc `dataBase` (comme VmSyncClient) et NON
   `apiRoot` (contrairement à NotifyClient, dont les routes sont globales). D'où aussi la garde
   « aucun document ouvert » : sans document courant, il n'y a pas de PKI à interroger.

   DTOs = MIROIRS des formes renvoyées / acceptées par CertsDb.ts / CertsValidate.ts (src-server).
   Duplication ASSUMÉE (principe n°3) : c'est la FORME d'une réponse réseau, pas une règle métier
   partageable — la garder ici évite de faire dépendre le cœur front d'un type serveur et préserve
   l'amovibilité. Toute évolution des routes/DTO serveur se répercute ICI (et réciproquement).

   INVARIANT ZÉRO-CONNAISSANCE : `key_enc` (clé privée chiffrée par la clé maître de l'utilisateur,
   côté navigateur) n'apparaît JAMAIS en liste — uniquement au GET UNITAIRE (getOne). Le serveur ne
   le déchiffre pas ; il ne stocke que des métadonnées et des blobs opaques. La passphrase maître et
   les clés déchiffrées ne transitent JAMAIS par ce client. */

/** Une entrée SubjectAltName (ordre = position en DB) — dns/ip/email (X.509) ou principal (SSH). */
export interface CertSan {
  san_type: "dns" | "ip" | "email" | "principal";
  value: string;
}

/** Certificat tel que LISTÉ (GET /certs) — SANS key_enc (invariant Q5) ; `has_key` signale
    qu'une clé privée chiffrée est détenue (l'UI propose alors les exports qui l'exigent).
    Miroir de `CertificateListItem` (CertsDb.ts). */
export interface CertificateListItem {
  id: string;
  /** "root-ca" | "leaf-tls" | "ssh-ca" | "ssh-keypair" | "ssh-cert" (cf. CERT_KINDS serveur). */
  kind: string;
  /** Émetteur (CA) pour un dérivé ; null pour une racine/paire autonome. */
  parent_id: string | null;
  label: string;
  subject: string;
  serial: string | null;
  not_before: string | null;
  not_after: string | null;
  fingerprint: string | null;
  /** "ec-p256" | "rsa-2048" | "rsa-4096" | "ed25519" (cf. KEY_ALGOS serveur). */
  key_algo: string;
  /** Certificat/clé publique : PEM X.509 (root-ca/leaf-tls) ou ligne OpenSSH (ssh-*). */
  public_pem: string | null;
  has_key: boolean;
  revoked_at: string | null;
  /** Note libre de l'opérateur (métadonnée). */
  comment: string | null;
  /** Raison de révocation (code standard X.509 + éventuelle note), posée à la révocation. */
  revocation_reason: string | null;
  /** Id du certificat d'origine dont celui-ci est le renouvellement (lignée). */
  renewed_from: string | null;
  /** Certificat croisé d'une CA rekeyée (Issuer = ancienne CA) — public. */
  cross_signed_pem: string | null;
  created_date: string;
  updated_date: string;
  sans: CertSan[];
}

/** Détail unitaire (GET /certs/:id) — key_enc INCLUS (décision Q5 : au GET unitaire seulement,
    pour un déchiffrement LOCAL à l'export/émission). Miroir de `CertificateDetail` (CertsDb.ts). */
export interface CertificateDetail extends CertificateListItem {
  /** Clé privée chiffrée (AES-GCM par la clé maître, format PkiCrypto `v1:<iv>:<ct>`) ; null si aucune. */
  key_enc: string | null;
}

/** Élément de la LISTE PAGINÉE (GET /certs?…) — un CertificateListItem (donc SANS key_enc, invariant Q5)
    augmenté de `root_id` : la RACINE de l'arbre du certificat (null au premier niveau). Sert la navigation de
    la recherche (L3 — cliquer un dérivé ouvre la vue de SA racine). Miroir de `CertificatePageItem` (CertsDb.ts). */
export interface CertificatePageItem extends CertificateListItem {
  root_id: string | null;
}

/** Élément de la LISTE DES RACINES (GET /certs/roots?…) — premier niveau + agrégats du sous-arbre :
    `children_total` (nombre de descendants), `children_alert` (descendants non révoqués à échéance ≤ 30 j,
    expirés inclus), `next_expiry` (échéance non révoquée la plus proche de l'arbre, racine comprise ; null si
    aucune). Miroir de `CertificateRootItem` (CertsDb.ts). */
export interface CertificateRootItem extends CertificateListItem {
  children_total: number;
  children_alert: number;
  next_expiry: string | null;
}

/** Enveloppe d'une page de listing (forme ListResult du cœur : pagination + tableau `certificates`). */
export interface CertificatePage {
  certificates: CertificatePageItem[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

/** Enveloppe d'une page de RACINES (même forme, items porteurs des agrégats de sous-arbre). */
export interface CertificateRootsPage {
  certificates: CertificateRootItem[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

/** Paramètres du listing paginé (query string des routes GET /certs et /certs/roots). Tous optionnels →
    défauts appliqués côté serveur. `kinds` devient PLUSIEURS paramètres `kind=` RÉPÉTÉS (jamais « kind=a,b »).
    `focus` (ciblage d'un élément → page qui le contient) est réservé à la recherche (L3) : accepté ici pour
    préparer le terrain, pas encore émis par la vue. Miroir SOUPLE de `CertsListOpts` (CertsDb.ts). */
export interface CertsListParams {
  page?: number;
  pageSize?: number;
  query?: string;
  kinds?: string[];
  status?: string;
  /** Restreint au SOUS-ARBRE d'une racine (vue B) — sans objet pour /roots. */
  root?: string;
  sort?: string;
  dir?: "asc" | "desc";
  focus?: string;
}

/** CORPS envoyé à PUT /certs/:id (miroir des champs acceptés par CertsValidate). Le `key_enc` :
    - ABSENT (undefined) = CONSERVER l'existant côté serveur (mise à jour de métadonnées, ex.
      révocation) — indispensable au flux zéro-connaissance (la liste ne renvoie jamais key_enc) ;
    - chaîne = nouveau blob chiffré (création) ; null = objet sans clé détenue. */
export interface CertificateInput {
  kind: string;
  parent_id: string | null;
  label: string;
  subject: string;
  serial: string | null;
  not_before: string | null;
  not_after: string | null;
  fingerprint: string | null;
  key_algo: string;
  public_pem: string | null;
  key_enc?: string | null;
  revoked_at: string | null;
  /** Métadonnées optionnelles (absent = null côté serveur) : note, raison de révocation, lignée, cert croisé. */
  comment?: string | null;
  revocation_reason?: string | null;
  renewed_from?: string | null;
  cross_signed_pem?: string | null;
  sans: CertSan[];
}

/** Paramètres PKI d'un document (GET /certs/pki). `initialized:false` signale une PKI VIERGE
    (le client enchaîne sur l'initialisation) ; sinon les paramètres KDF + `wrapped_dek` (la DEK
    chiffrée par la KEK) permettent, CÔTÉ CLIENT, de déballer la DEK (l'unwrap authentifié
    valide du même coup la phrase — pas de keycheck séparé). */
export type PkiState =
  | { initialized: false }
  | { initialized: true; kdf_version: string; kdf_salt: string; kdf_iters: number; wrapped_dek: string };

/** CORPS envoyé à PUT /certs/pki (initialisation) — miroir de `PkiParamsCandidate`. */
export interface PkiParamsInput {
  kdf_version: string;
  kdf_salt: string;
  kdf_iters: number;
  wrapped_dek: string;
}

/** CORPS envoyé à PUT /certs/pki/rekey — miroir de `PkiRekeyCandidate`. `prev_wrapped_dek` =
    l'enveloppe sur laquelle le ré-emballage a été fondé (verrou optimiste : 409 `conflict`
    si le coffre a changé entre-temps — autre changement de phrase concurrent). */
export interface PkiRekeyInput extends PkiParamsInput {
  prev_wrapped_dek: string;
}

/** Erreur d'un appel certs porteuse du CODE HTTP et du `detail` serveur (503 module en erreur,
    400 validation → `issues` agrégées, 409 conflit : PKI déjà initialisée / descendance existante),
    pour un message d'UI précis. Jumelle de VmSyncError/NotifyError (même contrat code+detail). */
export class CertsError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string | null) {
    super(message);
    this.name = "CertsError";
  }
}

/** Strict minimum dont le client a besoin de l'adaptateur REST — `RestAdapter` l'expose déjà en
    public (`dataBase` scopée sous /documents/{docId}, `docId`, `headers`, `clientId`). Interface
    (et non import de la classe) : découplage + testabilité par stub. Identique à VmRestContext
    (routes scopées par document). */
export interface CertsRestContext {
  /** Base des données du document COURANT : `apiRoot + /documents/{docId}` (ou apiRoot si aucun doc). */
  readonly dataBase: string;
  /** Document courant (null = aucun) — garde : pas d'appel certs hors d'un document ouvert. */
  readonly docId: string | null;
  /** En-têtes de base (Content-Type + éventuelle auth injectée). */
  readonly headers: Record<string, string>;
  /** Id de session par onglet — même en-tête `X-Client-Id` que les autres appels de l'adaptateur. */
  readonly clientId: string;
}

export class CertsClient {
  constructor(private readonly ctx: CertsRestContext) {}

  /** Document courant (null = aucun) — la vue s'en sert pour afficher « aucun document ouvert »
      avant d'appeler le réseau. Lu à la volée (le document change au fil de la navigation). */
  get docId(): string | null { return this.ctx.docId; }

  /* ---- Certificats (liste = métadonnées + SAN, JAMAIS key_enc) ---- */

  /** Liste COMPLÈTE (GET /certs SANS paramètre → comportement historique, une page géante SANS key_enc).
      CONSERVÉE comme utilitaire : la page paginée n'affiche qu'une tranche, mais la RÉSOLUTION des chaînes
      d'émission à l'export (fullchain/ca-chain remontent parent_id) a besoin de TOUS les ancêtres, qui ne
      sont pas forcément dans la page affichée. Peu appelée (à l'ouverture d'une modale d'export). */
  async list(): Promise<CertificateListItem[]> {
    const json = await this.call("GET", "/certs");
    return (json && Array.isArray(json.certificates)) ? (json.certificates as CertificateListItem[]) : [];
  }

  /** Liste PAGINÉE et PLATE (GET /certs?…) — filtres/tris/sous-arbre calculés côté SERVEUR (jamais de slice
      client). Chaque item porte `root_id`. JAMAIS key_enc (invariant Q5). */
  async listPage(params: CertsListParams = {}): Promise<CertificatePage> {
    const json = await this.call("GET", "/certs" + CertsClient.buildQuery(params));
    return CertsClient.toPage<CertificatePageItem>(json, params.pageSize);
  }

  /** Liste PAGINÉE des RACINES (GET /certs/roots?…) — premier niveau + agrégats de sous-arbre (children_total,
      children_alert, next_expiry). Mêmes filtres/tris que listPage, plus les tris d'agrégats portés par `sort`
      (children_total | next_expiry). */
  async listRoots(params: CertsListParams = {}): Promise<CertificateRootsPage> {
    const json = await this.call("GET", "/certs/roots" + CertsClient.buildQuery(params));
    return CertsClient.toPage<CertificateRootItem>(json, params.pageSize);
  }

  /** Construit la QUERY STRING d'un listing (LOGIQUE PURE, testée). Les scalaires passent par URLSearchParams
      (encodage correct) ; `kinds` devient PLUSIEURS paramètres `kind=` RÉPÉTÉS (`kind=a&kind=b`, JAMAIS
      « kind=a,b » — contrat serveur). Renvoie « ?… » ou "" si aucun paramètre. */
  static buildQuery(params: CertsListParams): string {
    const sp = new URLSearchParams();
    if (params.page != null) sp.set("page", String(params.page));
    if (params.pageSize != null) sp.set("pageSize", String(params.pageSize));
    if (typeof params.query === "string" && params.query !== "") sp.set("query", params.query);
    if (params.status) sp.set("status", params.status);
    if (params.root) sp.set("root", params.root);
    if (params.sort) sp.set("sort", params.sort);
    if (params.dir) sp.set("dir", params.dir);
    if (params.focus) sp.set("focus", params.focus);
    for (const kind of params.kinds || []) if (kind) sp.append("kind", kind);   // répétable
    const qs = sp.toString();
    return qs ? "?" + qs : "";
  }

  /** Normalise une réponse ListResult en enveloppe typée (garde-fous : `certificates` non tableau → [] ;
      compteurs absents → défauts). Le type d'item (T) est porté par l'appelant (page ou racines). */
  private static toPage<T>(json: any, requestedPageSize?: number): { certificates: T[]; total: number; page: number; pages: number; pageSize: number } {
    return {
      certificates: (json && Array.isArray(json.certificates)) ? (json.certificates as T[]) : [],
      total: Number(json && json.total) || 0,
      page: Number(json && json.page) || 1,
      pages: Number(json && json.pages) || 1,
      pageSize: Number(json && json.pageSize) || requestedPageSize || 0,
    };
  }

  /** Détail UNITAIRE — key_enc INCLUS (déchiffrement local pour émission d'un dérivé ou export). */
  async getOne(id: string): Promise<CertificateDetail> {
    const json = await this.call("GET", "/certs/" + encodeURIComponent(id));
    return json.certificate as CertificateDetail;
  }

  /** Crée/met à jour un certificat (PUT idempotent par `id`). `input.key_enc` omis = conservé. */
  async save(id: string, input: CertificateInput): Promise<CertificateDetail> {
    const json = await this.call("PUT", "/certs/" + encodeURIComponent(id), input);
    return json.certificate as CertificateDetail;
  }

  /** Supprime un certificat.
      `force` = intention EXPLICITE de supprimer un certificat ENCORE VALIDE : sans lui le serveur
      refuse (428 `force_required`). Un révoqué/expiré part sans `force`.
      Erreurs → CertsError (message serveur) : 409 = descendance existante · 428 = force requis. */
  async remove(id: string, force = false): Promise<void> {
    await this.call("DELETE", "/certs/" + encodeURIComponent(id) + (force ? "?force=true" : ""));
  }

  /* ---- Paramètres PKI (clé maître — dérivation CÔTÉ CLIENT) ---- */

  /** État de la PKI du document : vierge (`initialized:false`) ou paramètres KDF + wrapped_dek. */
  async pki(): Promise<PkiState> {
    const json = await this.call("GET", "/certs/pki");
    if (json && json.initialized === true) {
      return { initialized: true, kdf_version: json.kdf_version, kdf_salt: json.kdf_salt, kdf_iters: json.kdf_iters, wrapped_dek: json.wrapped_dek };
    }
    return { initialized: false };
  }

  /** Initialise la PKI du document (UNIQUE : 409 si déjà initialisée — irréversible côté serveur). */
  async initPki(input: PkiParamsInput): Promise<void> {
    await this.call("PUT", "/certs/pki", input);
  }

  /** Change la phrase maître : réécrit le seul `wrapped_dek` (DEK ré-emballée) + paramètres KDF.
      Ne touche à AUCUN key_enc (la DEK est conservée). 404 si PKI non initialisée ; 409 `conflict`
      si l'enveloppe a changé depuis la lecture (verrou optimiste — recharger puis réessayer). */
  async rekeyPki(input: PkiRekeyInput): Promise<void> {
    await this.call("PUT", "/certs/pki/rekey", input);
  }

  /* -------------------------------------------------------------------------- */

  /** Appel BAS NIVEAU : rejoue le pipeline de l'adaptateur (base scopée au document + en-têtes +
      cookies SSO). Traduit les réponses non-OK en `CertsError` (code HTTP + `detail`) ; 400 →
      `issues` agrégées en `detail`, 503 → `detail` actionnable. Une panne réseau remonte l'erreur
      brute de `fetch` (interceptée en amont pour un toast générique). */
  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
    // Garde : `dataBase` sans document viserait la racine API (route inexistante) — on le signale.
    if (!this.ctx.docId) throw new CertsError("aucun document ouvert", 0, null);
    const res = await fetch(this.ctx.dataBase + path, {
      method,
      headers: { ...this.ctx.headers, "X-Client-Id": this.ctx.clientId },
      credentials: "include",   // SSO : cookies de session transmis, comme RestAdapter (l'app ne gère pas l'auth)
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Corps JSON tolérant : un corps vide/illisible ne doit pas masquer le code HTTP.
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!res.ok) {
      const message = (json && typeof json.error === "string") ? json.error : ("HTTP " + res.status);
      const detail = (json && typeof json.detail === "string") ? json.detail
        : (json && Array.isArray(json.issues)) ? (json.issues as unknown[]).map(String).join("\n")
        : null;
      throw new CertsError(message, res.status, detail);
    }
    return json;
  }
}

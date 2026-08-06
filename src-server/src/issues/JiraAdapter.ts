import type { IssueCreateInput, IssueProviderAdapter, IssueProviderConfig, IssueProviderInfo, IssueRecord, IssueResolution } from "./IssueProvider.js";
import { JiraParse } from "./JiraParse.js";
import type { JiraCursor } from "./JiraParse.js";
import { JiraHttp } from "./JiraHttp.js";

/* =============================================================================
   ADAPTATEUR JIRA CLOUD — implémentation du contrat `IssueProviderAdapter`
   (module `issues/` amovible), partie SPÉCIFIQUE À LA MARQUE (préfixe `Jira*`).
   ORCHESTRE les appels de l'API REST et délègue TOUT le décodage à `JiraParse`
   (pur) : ici ne vivent que les CHEMINS, l'ordre des appels, le découpage en LOTS,
   la PAGINATION et l'estampillage de l'instance (`provider_id`).

   Le client HTTP est INJECTÉ (interface `JiraJsonClient` ci-dessous, déclarée par
   le CONSOMMATEUR = inversion de dépendance, comme `UnifiJsonClient` côté wifi) :
   les tests orchestrent l'adaptateur avec un stub route → fixture, sans réseau.

   ── ⚠ CE QUI EST SUPPOSÉ DE L'API JIRA (à VALIDER sur instance réelle) ────────
   Écrit SANS accès à une instance Jira. Comme pour l'intégration UniFi, les
   hypothèses sont rassemblées EN UN SEUL POINT (les constantes de chemins
   ci-dessous, et `JiraParse.FIELD_ALIASES` pour les champs) afin de rester
   corrigeables d'un geste. À rejouer au premier déploiement :

   1. BASE D'API `/rest/api/3` (Jira **Cloud**). Une instance Data Center répond,
      elle, sur `/rest/api/2` et s'authentifie en `Bearer <PAT>` : ce sera un
      adaptateur DISTINCT, pas un réglage de celui-ci.
   2. AUTH BASIC `base64(e-mail:jeton d'API)` (cf. `JiraHttp`).
   3. 🚨 RECHERCHE PAR LOTS sur `POST /rest/api/3/search/jql`, corps
      `{ jql, fields, maxResults }`, pagination par **`nextPageToken`**. Atlassian a
      REMPLACÉ l'ancien `POST /rest/api/3/search` (`startAt`/`total`) par celui-ci.
      C'est l'hypothèse la plus fragile du lot, donc la plus isolée :
      - le chemin est la constante `PATH_SEARCH` — si l'instance répond 404, c'est
        `PATH_SEARCH_LEGACY` qu'il faut y mettre, et RIEN d'autre à toucher ;
      - le décodeur de page (`JiraParse.page`) et la décision de pagination
        (`JiraParse.nextCursor`) comprennent DÉJÀ les DEUX formes — jeton ou
        décalage — et choisissent selon ce que la réponse porte réellement. Une
        instance restée sur l'ancienne forme est donc paginée correctement SANS
        modification de code.
   4. TAILLE DE LOT ~100 identifiants par requête (`BATCH_SIZE`) : à confirmer
      contre la limite réelle de `maxResults` ET la longueur maximale du JQL.
   5. STATUT : `fields.status.name` (libellé brut) + `fields.status.statusCategory.key`
      ∈ { `new`, `indeterminate`, `done` } → table de correspondance de `JiraParse`.
   6. IDENTITÉ : `id` (stable) vs `key` (MOBILE) — fondement de tout le chantier.
   7. LIEN : `<base>/browse/<clé>`. ⚠ Le champ `self` pointe l'API, PAS l'interface.
   8. CRÉATION : `POST /rest/api/3/issue`, `fields: { project:{key}, issuetype:{name},
      summary, description }` — la description en **ADF** (objet JSON, jamais une
      chaîne) sur l'API v3.
   9. TEST DE CONNEXION : `GET /rest/api/3/myself`. La VERSION applicative n'est pas
      exposée sur ce chemin (`/serverInfo` la porterait) : `version` reste `null`
      plutôt que d'ajouter un appel à chaque test pour un champ cosmétique.
   ============================================================================= */

/** Ce que l'adaptateur EXIGE du client HTTP — interface minimale côté CONSOMMATEUR (inversion de
    dépendance) : `JiraHttp` la satisfait structurellement, un stub de test aussi. Permet de tester
    l'orchestration, le découpage en lots et la pagination sans réseau. */
export interface JiraJsonClient {
  /** GET JSON authentifié (chemin absolu, query string comprise). Rejette en cas d'échec ; l'erreur
      PEUT porter un `status` HTTP — c'est ainsi que l'adaptateur reconnaît un 404. */
  getJson(path: string): Promise<any>;
  /** POST JSON authentifié. Rejette en cas d'échec, en conservant le message du tracker. */
  postJson(path: string, body: unknown): Promise<any>;
}

/** Options Jira décodées depuis `IssueProviderConfig.options` (validées par la branche `jira` de
    `IssueProviderConfigValidate.KIND_OPTION_SPECS`). Décodage DÉFENSIF : une config écrite par une
    version antérieure — ou par une autre marque — ne doit pas faire échouer l'adaptateur, elle
    retombe sur les mêmes défauts que la validation. */
interface JiraOptions {
  /** Clé du projet où sont CRÉÉS les tickets. "" = non configuré (lecture seule). */
  project_key: string;
  /** Type de ticket créé. */
  issue_type: string;
}

export class JiraAdapter implements IssueProviderAdapter {
  readonly kind = "jira";

  /* --------------------------------------------------------------------------
     CHEMINS D'API — L'UNIQUE POINT du code qui les connaît (cf. l'en-tête).
     -------------------------------------------------------------------------- */
  static readonly API_BASE = "/rest/api/3";
  /** Compte authentifié — appel le plus léger qui prouve joignabilité ET authentification. */
  static readonly PATH_MYSELF = JiraAdapter.API_BASE + "/myself";
  /** Recherche par JQL (forme ACTUELLE, pagination par jeton). */
  static readonly PATH_SEARCH = JiraAdapter.API_BASE + "/search/jql";
  /** Recherche par JQL — forme HISTORIQUE (`startAt`/`total`). Conservée en constante NOMMÉE, et
      non en commentaire, pour que la correction éventuelle soit un remplacement d'une ligne (cf.
      point 3 de l'en-tête) et non une réécriture. */
  static readonly PATH_SEARCH_LEGACY = JiraAdapter.API_BASE + "/search";
  /** Création d'un ticket. */
  static readonly PATH_ISSUE_CREATE = JiraAdapter.API_BASE + "/issue";
  /** Fiche d'UN ticket, par identifiant interne OU par clé. */
  static pathIssue(idOrKey: string): string { return JiraAdapter.API_BASE + "/issue/" + encodeURIComponent(idOrKey); }

  /** Champs demandés au tracker — exactement ceux que le pivot consomme, jamais « tout ».
      Demander `*all` ramènerait les champs personnalisés de chaque projet (parfois des centaines de
      Kio par ticket) pour rien : la description distante et les commentaires sont HORS pivot. */
  static readonly FIELDS: readonly string[] = [
    "summary", "status", "issuetype", "priority", "assignee", "reporter", "labels", "resolution", "created", "updated",
  ];

  /** Nombre d'identifiants résolus par REQUÊTE. C'est LE point qui fait la différence entre une
      passe à 3 appels et une passe à 300 : on résout par LOTS, jamais un ticket à la fois. */
  static readonly BATCH_SIZE = 100;

  /** CAP DUR de pages par lot. Garde-fou contre un tracker qui ignorerait la pagination et
      renverrait éternellement la même page pleine : `JiraParse.nextCursor` ne s'arrêterait alors
      jamais. Un lot de 100 identifiants tient normalement en UNE page — 10 laisse la place à une
      instance qui plafonnerait `maxResults` bien plus bas, tout en restant très loin d'une boucle. */
  static readonly MAX_PAGES_PER_BATCH = 10;

  /** JQL de SONDE du test de connexion : la clause vide est valide et l'ordre explicite évite toute
      dépendance à un projet particulier. Associée à `maxResults: 1`, elle coûte quasi rien et
      VÉRIFIE l'hypothèse la plus fragile de l'intégration (le chemin de recherche). */
  static readonly PROBE_JQL = "order by created DESC";

  constructor(
    readonly config: IssueProviderConfig,
    private readonly http: JiraJsonClient,
  ) {}

  /** Construction STANDARD (hors tests) : client HTTP dérivé de la config — compte + jeton en Basic,
      délai par requête. Aucun agent ni matériel TLS à monter (cf. `JiraHttp`, `fetch` injecté). */
  static fromConfig(config: IssueProviderConfig): JiraAdapter {
    return new JiraAdapter(config, new JiraHttp(config.url, config.account, config.token, config.timeout_sec * 1000));
  }

  /** Options Jira de CETTE instance, avec repli sur les défauts de la validation. */
  private options(): JiraOptions {
    const raw = this.config.options || {};
    const project = typeof raw.project_key === "string" ? raw.project_key.trim() : "";
    const type = typeof raw.issue_type === "string" && raw.issue_type.trim() !== "" ? raw.issue_type.trim() : "Task";
    return { project_key: project, issue_type: type };
  }

  /* --------------------------------------------------------------------------
     TEST DE CONNEXION
     -------------------------------------------------------------------------- */

  /** Joignabilité + authentification (via le compte courant), PUIS sonde NON BLOQUANTE de l'API de
      recherche. Ne jette JAMAIS : toute erreur devient `ok: false` + message (SANS le jeton —
      garanti par `JiraHttp`, qui construit tous ses messages).

      `supported` signifie ici « le chemin de RECHERCHE attendu a répondu » : c'est l'hypothèse dont
      dépend toute la synchro (cf. point 3 de l'en-tête), et la seule qu'un test de connexion puisse
      lever avant le premier incident. Un échec de la sonde n'est PAS bloquant : l'authentification,
      elle, est prouvée — l'utilisateur doit pouvoir enregistrer son provider et voir un
      avertissement précis, pas un refus opaque. */
  async test(): Promise<IssueProviderInfo> {
    let me: any;
    try {
      me = await this.http.getJson(JiraAdapter.PATH_MYSELF);
    } catch (e) {
      return { ok: false, kind: this.kind, version: null, supported: false, message: e instanceof Error ? e.message : String(e) };
    }
    const who = JiraAdapter.accountLabel(me);
    let supported = true;
    let warning = "";
    try {
      await this.http.postJson(JiraAdapter.PATH_SEARCH, { jql: JiraAdapter.PROBE_JQL, fields: ["summary"], maxResults: 1 });
    } catch (e) {
      supported = false;
      warning = " — ⚠ l'API de RECHERCHE (" + JiraAdapter.PATH_SEARCH + ") n'a pas répondu comme attendu : "
        + (e instanceof Error ? e.message : String(e))
        + " ; la synchro ne pourra pas résoudre les tickets tant que ce chemin ne répond pas";
    }
    return {
      ok: true, kind: this.kind, version: null, supported,
      message: "instance joignable, authentification acceptée" + (who ? " (compte « " + who + " »)" : "") + warning,
    };
  }

  /* --------------------------------------------------------------------------
     RÉSOLUTION — le cœur de l'assiette INVERSÉE
     -------------------------------------------------------------------------- */

  /** Résout l'état courant des tickets DÉSIGNÉS, PAR LOTS (cf. `BATCH_SIZE`).
      Rend les RÉSOLUS et les INTROUVABLES séparément : c'est l'appelant (le service de synchro) qui
      en déduit `orphan`, parce que lui seul sait ce que le document suit.
      ⚠ Aucun plafond de volume ici : borner le nombre d'identifiants d'UNE passe est une décision
      d'ORCHESTRATION (elle se journalise et se signale à l'utilisateur), elle appartient au service. */
  async resolve(extIds: string[]): Promise<IssueResolution> {
    const wanted = JiraAdapter.uniqueIds(extIds);
    if (wanted.length === 0) return { found: [], missing: [] };

    const found: IssueRecord[] = [];
    const seen = new Set<string>();
    for (let start = 0; start < wanted.length; start += JiraAdapter.BATCH_SIZE) {
      const chunk = wanted.slice(start, start + JiraAdapter.BATCH_SIZE);
      for (const record of await this.searchByIds(chunk)) {
        if (seen.has(record.ext_id)) continue;   // un même ticket peut réapparaître entre deux pages
        seen.add(record.ext_id);
        record.provider_id = this.config.id;     // estampillage de l'instance (le décodeur pur l'ignore)
        found.push(record);
      }
    }
    // MANQUANTS = demandés et non revenus. Calculé ICI, où l'on sait ce qui a été demandé : le
    // rendre à l'appelant lui éviterait de recomparer deux tableaux à chaque passe.
    return { found, missing: wanted.filter((id) => !seen.has(id)) };
  }

  /** UN lot : une recherche JQL `id IN (…)`, paginée si le tracker le demande. La DÉCISION de
      continuer est PURE (`JiraParse.nextCursor`, testée en isolation) ; ici ne restent que l'appel
      réseau et le CAP DUR de pages. Le décalage envoyé est celui qu'on a DEMANDÉ, jamais celui que
      l'API renvoie : une API qui répond un décalage fantaisiste ne doit pas pouvoir nous faire
      boucler ni sauter des résultats. */
  private async searchByIds(ids: string[]): Promise<IssueRecord[]> {
    const jql = "id IN (" + JiraParse.jqlIdList(ids) + ")";
    const out: IssueRecord[] = [];
    let cursor: JiraCursor | null = null;
    let sentStartAt = 0;
    for (let page = 0; page < JiraAdapter.MAX_PAGES_PER_BATCH; page++) {
      const body: Record<string, unknown> = { jql, fields: JiraAdapter.FIELDS, maxResults: JiraAdapter.BATCH_SIZE };
      if (cursor !== null) {
        if ("token" in cursor) body["nextPageToken"] = cursor.token;
        else { sentStartAt = cursor.startAt; body["startAt"] = sentStartAt; }
      }
      const decoded = JiraParse.page(await this.http.postJson(JiraAdapter.PATH_SEARCH, body));
      out.push(...JiraParse.issueRecords(decoded.items, this.config.url));
      const next = JiraParse.nextCursor(decoded, sentStartAt, JiraAdapter.BATCH_SIZE);
      if (next === null) return out;
      cursor = next;
    }
    // Cap atteint : on rend ce qu'on a (mieux qu'une exception qui perdrait le lot entier), mais
    // l'anomalie reste VISIBLE — les identifiants non revenus ressortiront en `missing`, donc en
    // « introuvables » à l'écran, ce qui est précisément le signal qu'il faut regarder.
    return out;
  }

  /* --------------------------------------------------------------------------
     PORTES D'ENTRÉE DE L'ASSIETTE — « Suivre un ticket » et « Ouvrir un ticket »
     -------------------------------------------------------------------------- */

  /** Résout UNE référence saisie (clé lisible ou URL collée). `null` si la référence n'est pas
      exploitable, ou si le ticket n'existe pas / n'est pas accessible.
      ⚠ Jira répond 404 dans les DEUX cas (inexistant ou hors permissions) — délibérément, pour ne
      pas divulguer l'existence d'un ticket. On ne cherche donc pas à les distinguer : c'est le même
      refus côté utilisateur (« introuvable ou inaccessible »). En revanche un 401/403 remonte : ce
      n'est pas un problème de ticket mais de PROVIDER, et le message est actionnable. */
  async lookup(reference: string): Promise<IssueRecord | null> {
    const idOrKey = JiraParse.referenceToIdOrKey(reference);
    if (idOrKey === null) return null;
    let json: any;
    try {
      json = await this.http.getJson(JiraAdapter.pathIssue(idOrKey) + "?fields=" + JiraAdapter.FIELDS.join(","));
    } catch (e) {
      if (JiraAdapter.isNotFound(e)) return null;
      throw e;
    }
    const record = JiraParse.issueRecord(json, this.config.url);
    if (record === null) return null;
    record.provider_id = this.config.id;
    return record;
  }

  /** Crée un ticket chez le tracker et rend son pivot.

      🚨 ERREURS NON ENVELOPPÉES : si Jira refuse (champ personnalisé obligatoire, projet inconnu,
      type inexistant), son message remonte TEL QUEL — `JiraHttp` l'a déjà extrait du corps de la
      réponse. L'envelopper dans un « échec de création » générique détruirait la seule information
      actionnable (« le champ X est requis »). On n'interroge PAS `createmeta` pour deviner les
      champs obligatoires : deviner produirait un formulaire faux, alors que le refus, lui, est juste.

      ⚠ APRÈS la création, la relecture du ticket complet est un CONFORT, jamais une condition : si
      elle échoue, le ticket EXISTE déjà chez le tracker et on ne doit ni le perdre, ni le supprimer
      pour « rattraper » (on ne détruit pas dans un système tiers pour compenser notre propre
      lecture). On rend alors le pivot MINIMAL bâti sur la réponse de création. */
  async createIssue(input: IssueCreateInput): Promise<IssueRecord> {
    const options = this.options();
    if (options.project_key === "") {
      throw new Error("Tracker : aucun projet configuré sur ce provider — renseignez l'option « project_key » (clé du projet où créer les tickets) avant d'ouvrir un ticket");
    }
    const summary = typeof input?.summary === "string" ? input.summary.trim() : "";
    if (summary === "") throw new Error("Tracker : le titre du ticket est obligatoire");

    const created = await this.http.postJson(JiraAdapter.PATH_ISSUE_CREATE, {
      fields: {
        project: { key: options.project_key },
        issuetype: { name: options.issue_type },
        summary,
        // ⚠ ADF et non une chaîne : l'API v3 refuse une description textuelle (cf. `JiraParse.toAdf`).
        description: JiraParse.toAdf(typeof input?.description === "string" ? input.description : ""),
      },
    });

    const minimal = JiraParse.issueRecord(created, this.config.url);
    if (minimal === null) {
      // Réponse sans identifiant : anormal, et surtout AMBIGU (le ticket a-t-il été créé ?). On cite
      // la clé si le tracker l'a rendue, pour que l'utilisateur puisse la reprendre par « Suivre un
      // ticket » — jamais de suppression compensatoire côté tracker.
      const key = created && typeof created === "object" && typeof created.key === "string" ? created.key : "";
      throw new Error("Tracker : ticket peut-être créé, mais la réponse ne porte pas d'identifiant exploitable"
        + (key ? " — reprenez-le via « Suivre un ticket » avec la clé « " + key + " »" : ""));
    }
    minimal.provider_id = this.config.id;
    if (minimal.summary === "") minimal.summary = summary;   // la réponse de création ne renvoie pas les champs

    try {
      const full = await this.lookup(minimal.ext_id);
      if (full !== null) return full;
    } catch { /* relecture en échec : la création, elle, a réussi — cf. le commentaire ci-dessus */ }
    return minimal;
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Identifiants demandés, NETTOYÉS : chaînes non vides, rognées, DÉDUPLIQUÉES, ordre d'origine
      conservé. La déduplication n'est pas cosmétique — un doublon gonflerait le lot et ferait
      apparaître deux fois le même identifiant dans `missing`. */
  private static uniqueIds(extIds: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(extIds) ? extIds : []) {
      const id = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /** L'erreur signale-t-elle un 404 ? Test STRUCTUREL (`status`) et non `instanceof JiraHttpError` :
      le client HTTP est INJECTÉ, donc une autre implémentation (ou un stub de test) doit pouvoir
      signaler un 404 sans hériter de notre classe d'erreur. */
  private static isNotFound(e: unknown): boolean {
    return (e as { status?: unknown } | null | undefined)?.status === 404;
  }

  /** Libellé lisible du compte authentifié pour le message de test — nom affiché, à défaut adresse
      e-mail, à défaut identifiant technique. "" si la réponse n'en porte aucun. */
  private static accountLabel(me: any): string {
    if (!me || typeof me !== "object") return "";
    for (const key of ["displayName", "emailAddress", "name", "accountId"]) {
      const value = me[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return "";
  }
}

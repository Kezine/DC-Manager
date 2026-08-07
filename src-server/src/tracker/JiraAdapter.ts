import type {
  TrackerDegradeSink, TrackerProviderAdapter, TrackerProviderConfig, TrackerProviderInfo,
  TrackerPushContent, TrackerResolution, TrackerTicketState,
} from "./TrackerProvider.js";
import { JiraParse } from "./JiraParse.js";
import type { JiraCursor } from "./JiraParse.js";
import { JiraHttp } from "./JiraHttp.js";

/* =============================================================================
   ADAPTATEUR JIRA CLOUD — implémentation du contrat `TrackerProviderAdapter`
   (module `tracker/` amovible), partie SPÉCIFIQUE À LA MARQUE (préfixe `Jira*`).
   ORCHESTRE les appels de l'API REST et délègue TOUT le décodage à `JiraParse`
   (pur) : ici ne vivent que les CHEMINS, l'ordre des appels, le découpage en LOTS,
   la PAGINATION et la composition des corps de requête.

   Le client HTTP est INJECTÉ (interface `JiraJsonClient` ci-dessous, déclarée par
   le CONSOMMATEUR = inversion de dépendance, comme `UnifiJsonClient` côté wifi) :
   les tests orchestrent l'adaptateur avec un stub route → fixture, sans réseau.

   ── 🚨 LE PROJET EST PARTAGÉ — CE QUE CET ADAPTATEUR NE FAIT JAMAIS ──────────
   Les tickets de DC Manager vivent dans un projet où d'AUTRES sources écrivent.
   Donc, sans exception :
   - les LABELS se modifient par VERBES (`update.labels: [{add}, {remove}]`) et
     JAMAIS par remplacement du tableau `fields.labels` — un remplacement
     effacerait les étiquettes posées par les autres, et personne ne s'en
     apercevrait avant longtemps (risque n°1 du cadrage) ;
   - AUCUNE suppression de ticket, en aucune circonstance ;
   - un refus du tracker remonte TEL QUEL : c'est le seul texte actionnable.

   ── ⚠ CE QUI EST SUPPOSÉ DE L'API JIRA (à VALIDER sur instance réelle) ────────
   Écrit SANS accès à une instance Jira. Comme pour l'intégration UniFi, les
   hypothèses sont rassemblées EN UN SEUL POINT (les constantes de chemins
   ci-dessous, et `JiraParse` pour les champs) afin de rester corrigeables d'un
   geste. À rejouer au premier déploiement :

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
        décalage — et choisissent selon ce que la réponse porte réellement.
   4. TAILLE DE LOT ~100 identifiants par requête (`BATCH_SIZE`) : à confirmer
      contre la limite réelle de `maxResults` ET la longueur maximale du JQL.
   5. STATUT : `fields.status.name` (libellé brut) + `fields.status.statusCategory.key`
      ∈ { `new`, `indeterminate`, `done` } → table de correspondance de `JiraParse`.
   6. IDENTITÉ : `id` (stable) vs `key` (MOBILE) — fondement de tout le chantier.
   7. LIEN : `<base>/browse/<clé>`. ⚠ Le champ `self` pointe l'API, PAS l'interface.
   8. CRÉATION : `POST /rest/api/3/issue`, `fields: { project:{key}, issuetype:{name},
      summary, description, labels, priority:{name}, duedate }` — la description en
      **ADF** (objet JSON, jamais une chaîne) sur l'API v3.
   9. TEST DE CONNEXION : `GET /rest/api/3/myself`. La VERSION applicative n'est pas
      exposée sur ce chemin (`/serverInfo` la porterait) : `version` reste `null`
      plutôt que d'ajouter un appel à chaque test pour un champ cosmétique.
  10. **MISE À JOUR : `PUT /rest/api/3/issue/{id}`**, corps
      `{ fields: { summary, description, priority, duedate }, update: { labels: [{add},{remove}] } }`,
      réponse **204 sans corps**. ⚠ Un même champ ne peut PAS figurer à la fois dans
      `fields` et dans `update` — d'où des labels EXCLUSIVEMENT en verbes, ce qui
      tombe bien puisque c'est de toute façon la seule forme non destructrice sur un
      projet partagé. `issuetype` n'est PAS repoussé à la mise à jour : changer le
      type d'un ticket existant est une opération à part entière côté Jira (parfois
      refusée par le workflow), et la nature d'un objet DC Manager est figée à la
      création.
  11. **`duedate` accepte `YYYY-MM-DD`** (date seule, sans heure ni fuseau) et se
      VIDE avec `null`. **`priority` se pose par NOM** (`{ name: "High" }`) et peut
      être ABSENTE du projet : les projets « team-managed » n'ont souvent pas de
      champ priorité, et Jira répond alors `{ errors: { priority: … } }`. Dans ce
      cas SEUL, on RETENTE UNE FOIS sans la priorité et on signale le dégradé —
      jamais de retente sans `issuetype` (un type refusé est une erreur de
      configuration à corriger, pas un champ facultatif).
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
  /** PUT JSON authentifié (mise à jour d'un ticket). Rejette en cas d'échec, message conservé. */
  putJson(path: string, body: unknown): Promise<any>;
}

/** Options Jira décodées depuis `TrackerProviderConfig.options` (validées par la branche `jira` de
    `TrackerProviderConfigValidate.KIND_OPTION_SPECS`). Décodage DÉFENSIF : une config écrite par une
    version antérieure — ou par une autre marque — ne doit pas faire échouer l'adaptateur, elle
    retombe sur les mêmes défauts que la validation. */
interface JiraOptions {
  /** Clé du projet où sont RÉPLIQUÉES les interventions. "" = non configuré (création impossible). */
  project_key: string;
  /** Type Jira des objets de nature `incident`. */
  type_incident: string;
  /** Type Jira des objets de nature `intervention`. */
  type_intervention: string;
}

export class JiraAdapter implements TrackerProviderAdapter {
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
  /** Fiche d'UN ticket, par identifiant interne OU par clé — lecture (GET) comme mise à jour (PUT). */
  static pathIssue(idOrKey: string): string { return JiraAdapter.API_BASE + "/issue/" + encodeURIComponent(idOrKey); }

  /** Champs demandés au tracker — EXACTEMENT ceux que l'état pivot consomme, jamais « tout ».
      Demander `*all` ramènerait les champs personnalisés de chaque projet (parfois des centaines de
      Kio par ticket) pour rien. ⚠ Ni `summary` ni `description` : DC Manager fait FOI sur le
      contenu, les relire créerait une seconde vérité concurrente sur des champs qu'il pousse. */
  static readonly FIELDS: readonly string[] = ["status", "assignee", "labels"];

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

  /** Nom du champ Jira dont un REFUS déclenche la retente en mode dégradé (cf. hypothèse 11). UNE
      constante nommée plutôt qu'un littéral disséminé : c'est une décision de comportement, elle
      doit se lire d'un coup d'œil et se corriger en un seul endroit. */
  static readonly OPTIONAL_FIELD_PRIORITY = "priority";

  constructor(
    readonly config: TrackerProviderConfig,
    private readonly http: JiraJsonClient,
  ) {}

  /** Construction STANDARD (hors tests) : client HTTP dérivé de la config — compte + jeton en Basic,
      délai par requête. Aucun agent ni matériel TLS à monter (cf. `JiraHttp`, `fetch` injecté). */
  static fromConfig(config: TrackerProviderConfig): JiraAdapter {
    return new JiraAdapter(config, new JiraHttp(config.url, config.account, config.token, config.timeout_sec * 1000));
  }

  /** Options Jira de CETTE instance, avec repli sur les défauts de la validation. */
  private options(): JiraOptions {
    const raw = this.config.options || {};
    const text = (name: string, fallback: string): string =>
      (typeof raw[name] === "string" && (raw[name] as string).trim() !== "" ? (raw[name] as string).trim() : fallback);
    return {
      project_key: typeof raw.project_key === "string" ? raw.project_key.trim() : "",
      type_incident: text("type_incident", "Incident"),
      type_intervention: text("type_intervention", "Infrastructure"),
    };
  }

  /** Type de ticket Jira pour une NATURE d'objet DC Manager. Une nature inconnue retombe sur le type
      des interventions : mieux vaut un ticket au mauvais type — visible, corrigeable d'un clic dans
      Jira — qu'une réplication refusée pour un slug qu'on n'attendait pas. */
  private issueTypeFor(kind: string): string {
    const options = this.options();
    return kind === "incident" ? options.type_incident : options.type_intervention;
  }

  /* --------------------------------------------------------------------------
     TEST DE CONNEXION
     -------------------------------------------------------------------------- */

  /** Joignabilité + authentification (via le compte courant), PUIS sonde NON BLOQUANTE de l'API de
      recherche. Ne jette JAMAIS : toute erreur devient `ok: false` + message (SANS le jeton —
      garanti par `JiraHttp`, qui construit tous ses messages).

      `supported` signifie ici « le chemin de RECHERCHE attendu a répondu » : c'est l'hypothèse dont
      dépend tout le retour d'état (cf. point 3 de l'en-tête), et la seule qu'un test de connexion
      puisse lever avant le premier incident. Un échec de la sonde n'est PAS bloquant :
      l'authentification, elle, est prouvée — l'utilisateur doit pouvoir enregistrer son provider et
      voir un avertissement précis, pas un refus opaque. */
  async test(): Promise<TrackerProviderInfo> {
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
        + " ; la synchro ne pourra pas relire l'état des tickets tant que ce chemin ne répond pas";
    }
    return {
      ok: true, kind: this.kind, version: null, supported,
      message: "instance joignable, authentification acceptée" + (who ? " (compte « " + who + " »)" : "") + warning,
    };
  }

  /* --------------------------------------------------------------------------
     RETOUR D'ÉTAT — le cœur de l'assiette INVERSÉE
     -------------------------------------------------------------------------- */

  /** Résout l'état courant des tickets DÉSIGNÉS, PAR LOTS (cf. `BATCH_SIZE`).
      Rend les RÉSOLUS et les INTROUVABLES séparément : c'est l'appelant (le service) qui en déduit
      « introuvable », parce que lui seul sait ce qui est répliqué.
      ⚠ Aucun plafond de volume ici : borner le nombre d'identifiants d'UNE passe est une décision
      d'ORCHESTRATION (elle se journalise et se signale à l'utilisateur), elle appartient au service. */
  async resolve(extIds: string[]): Promise<TrackerResolution> {
    const wanted = JiraAdapter.uniqueIds(extIds);
    if (wanted.length === 0) return { found: [], missing: [] };

    const found: TrackerTicketState[] = [];
    const seen = new Set<string>();
    for (let start = 0; start < wanted.length; start += JiraAdapter.BATCH_SIZE) {
      const chunk = wanted.slice(start, start + JiraAdapter.BATCH_SIZE);
      for (const state of await this.searchByIds(chunk)) {
        if (seen.has(state.ext_id)) continue;   // un même ticket peut réapparaître entre deux pages
        seen.add(state.ext_id);
        found.push(state);
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
  private async searchByIds(ids: string[]): Promise<TrackerTicketState[]> {
    const jql = "id IN (" + JiraParse.jqlIdList(ids) + ")";
    const out: TrackerTicketState[] = [];
    let cursor: JiraCursor | null = null;
    let sentStartAt = 0;
    for (let page = 0; page < JiraAdapter.MAX_PAGES_PER_BATCH; page++) {
      const body: Record<string, unknown> = { jql, fields: JiraAdapter.FIELDS, maxResults: JiraAdapter.BATCH_SIZE };
      if (cursor !== null) {
        if ("token" in cursor) body["nextPageToken"] = cursor.token;
        else { sentStartAt = cursor.startAt; body["startAt"] = sentStartAt; }
      }
      const decoded = JiraParse.page(await this.http.postJson(JiraAdapter.PATH_SEARCH, body));
      out.push(...JiraParse.ticketStates(decoded.items, this.config.url));
      const next = JiraParse.nextCursor(decoded, sentStartAt, JiraAdapter.BATCH_SIZE);
      if (next === null) return out;
      cursor = next;
    }
    // Cap atteint : on rend ce qu'on a (mieux qu'une exception qui perdrait le lot entier), mais
    // l'anomalie reste VISIBLE — les identifiants non revenus ressortiront en `missing`, donc en
    // « introuvables » à l'écran, ce qui est précisément le signal qu'il faut regarder.
    return out;
  }

  /** Résout UNE référence (clé lisible, identifiant interne, ou URL collée). `null` si la référence
      n'est pas exploitable, ou si le ticket n'existe pas / n'est pas accessible.
      Deux usages : la LIAISON d'un ticket existant à une intervention, et la relecture des labels
      COURANTS juste avant une mise à jour (le diff en dépend).
      ⚠ Jira répond 404 dans les DEUX cas (inexistant ou hors permissions) — délibérément, pour ne
      pas divulguer l'existence d'un ticket. On ne cherche donc pas à les distinguer : c'est le même
      refus côté utilisateur (« introuvable ou inaccessible »). En revanche un 401/403 remonte : ce
      n'est pas un problème de ticket mais de PROVIDER, et le message est actionnable. */
  async lookup(reference: string): Promise<TrackerTicketState | null> {
    const idOrKey = JiraParse.referenceToIdOrKey(reference);
    if (idOrKey === null) return null;
    let json: any;
    try {
      json = await this.http.getJson(JiraAdapter.pathIssue(idOrKey) + "?fields=" + JiraAdapter.FIELDS.join(","));
    } catch (e) {
      if (JiraAdapter.isNotFound(e)) return null;
      throw e;
    }
    return JiraParse.ticketState(json, this.config.url);
  }

  /* --------------------------------------------------------------------------
     POUSSÉE — création et mise à jour du CONTENU (DC Manager fait foi)
     -------------------------------------------------------------------------- */

  /** Crée un ticket chez le tracker et rend son état.

      🚨 ERREURS NON ENVELOPPÉES : si Jira refuse (champ personnalisé obligatoire, projet inconnu,
      type inexistant), son message remonte TEL QUEL — `JiraHttp` l'a déjà extrait du corps de la
      réponse. L'envelopper dans un « échec de création » générique détruirait la seule information
      actionnable (« le champ X est requis »). On n'interroge PAS `createmeta` pour deviner les
      champs obligatoires : deviner produirait un formulaire faux, alors que le refus, lui, est juste.

      ⚠ APRÈS la création, la relecture du ticket complet est un CONFORT, jamais une condition : si
      elle échoue, le ticket EXISTE déjà chez le tracker et on ne doit ni le perdre, ni le supprimer
      pour « rattraper » (on ne détruit pas dans un système tiers pour compenser notre propre
      lecture). On rend alors l'état MINIMAL bâti sur la réponse de création. */
  async createIssue(content: TrackerPushContent, onDegraded?: TrackerDegradeSink): Promise<TrackerTicketState> {
    const options = this.options();
    if (options.project_key === "") {
      throw new Error("Tracker : aucun projet configuré sur ce provider — renseignez l'option « project_key » (clé du projet de destination) avant de répliquer une intervention");
    }
    const summary = typeof content?.summary === "string" ? content.summary.trim() : "";
    if (summary === "") throw new Error("Tracker : le titre du ticket est obligatoire");

    const fields: Record<string, unknown> = {
      project: { key: options.project_key },
      issuetype: { name: this.issueTypeFor(content.kind) },
      summary,
      // ⚠ ADF et non une chaîne : l'API v3 refuse une description textuelle (cf. `JiraParse.toAdf`).
      description: JiraParse.toAdf(typeof content?.description === "string" ? content.description : ""),
    };
    const labels = JiraAdapter.cleanLabels(content?.labels);
    if (labels.length) fields.labels = labels;
    const duedate = JiraAdapter.dueDate(content?.duedate);
    if (duedate !== null) fields.duedate = duedate;

    const created = await this.sendWithOptionalPriority(
      (body) => this.http.postJson(JiraAdapter.PATH_ISSUE_CREATE, body),
      fields, content?.priority ?? null, null, "la création", onDegraded,
    );

    const minimal = JiraParse.ticketState(created, this.config.url);
    if (minimal === null) {
      // Réponse sans identifiant : anormal, et surtout AMBIGU (le ticket a-t-il été créé ?). On cite
      // la clé si le tracker l'a rendue, pour que l'utilisateur puisse la reprendre par la LIAISON
      // d'un ticket existant — jamais de suppression compensatoire côté tracker.
      const key = created && typeof created === "object" && typeof created.key === "string" ? created.key : "";
      throw new Error("Tracker : ticket peut-être créé, mais la réponse ne porte pas d'identifiant exploitable"
        + (key ? " — reprenez-le en LIANT le ticket existant « " + key + " »" : ""));
    }
    // Les labels qu'on vient de poser sont CONNUS : la réponse de création ne les renvoie pas, et
    // les laisser vides ferait croire au prochain diff qu'ils ont tous disparu.
    if (minimal.labels.length === 0 && labels.length) minimal.labels = labels.slice();

    try {
      const full = await this.lookup(minimal.ext_id);
      if (full !== null) return full;
    } catch { /* relecture en échec : la création, elle, a réussi — cf. le commentaire ci-dessus */ }
    return minimal;
  }

  /** Met à jour le CONTENU d'un ticket déjà répliqué (hypothèse 10).

      🚨 LABELS PAR VERBES, JAMAIS PAR REMPLACEMENT : `update.labels: [{add},{remove}]`. Le projet
      est partagé — un `fields.labels` effacerait les étiquettes des autres sources. Le diff est
      calculé par l'appelant (`TrackerLabels.diff`), qui SEUL sait quel sous-ensemble DC Manager
      gère ; l'adaptateur ne fait que le transmettre.
      Aucun verbe à passer ⇒ la clé `update` est OMISE : envoyer un tableau vide n'apporterait rien
      et ferait porter à chaque requête une intention qu'elle n'a pas. */
  async updateIssue(extId: string, content: TrackerPushContent, labelsAdd: string[], labelsRemove: string[], onDegraded?: TrackerDegradeSink): Promise<void> {
    const id = typeof extId === "string" ? extId.trim() : "";
    if (id === "") throw new Error("Tracker : identifiant de ticket manquant — impossible de mettre à jour");
    const summary = typeof content?.summary === "string" ? content.summary.trim() : "";
    if (summary === "") throw new Error("Tracker : le titre du ticket est obligatoire");

    const fields: Record<string, unknown> = {
      summary,
      description: JiraParse.toAdf(typeof content?.description === "string" ? content.description : ""),
      // `duedate: null` VIDE le champ côté Jira : une échéance retirée dans DC Manager doit
      // disparaître du ticket, sans quoi une date périmée y survivrait indéfiniment.
      duedate: JiraAdapter.dueDate(content?.duedate),
    };
    const add = JiraAdapter.cleanLabels(labelsAdd);
    const remove = JiraAdapter.cleanLabels(labelsRemove);
    const verbs = [...add.map((label) => ({ add: label })), ...remove.map((label) => ({ remove: label }))];
    const update = verbs.length ? { labels: verbs } : null;

    await this.sendWithOptionalPriority(
      (body) => this.http.putJson(JiraAdapter.pathIssue(id), body),
      fields, content?.priority ?? null, update, "la mise à jour", onDegraded,
    );
  }

  /** ENVOI d'une poussée avec repli « priorité refusée par le projet » (hypothèse 11, risque n°2 du
      cadrage). MUTUALISÉ entre création et mise à jour : la règle est la même des deux côtés, et
      l'écrire deux fois la ferait diverger au premier correctif.

      Déroulé : on tente AVEC la priorité ; si le tracker refuse EN DÉSIGNANT le champ `priority`,
      on retente UNE SEULE FOIS sans lui et on signale le dégradé. Toute autre erreur remonte telle
      quelle, sans retente — en particulier un `issuetype` refusé, qui est une erreur de
      CONFIGURATION à corriger (retenter sans lui créerait des tickets d'un type arbitraire).
      Une seule retente, jamais deux : au-delà, on ne saurait plus dire ce qu'on a réellement poussé. */
  private async sendWithOptionalPriority(
    send: (body: Record<string, unknown>) => Promise<any>,
    fields: Record<string, unknown>,
    prioritySlug: string | null,
    update: Record<string, unknown> | null,
    what: string,
    onDegraded?: TrackerDegradeSink,
  ): Promise<any> {
    const priorityName = JiraParse.priorityName(prioritySlug);
    const compose = (withPriority: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = { fields: { ...fields } };
      if (withPriority && priorityName !== null) (body.fields as Record<string, unknown>).priority = { name: priorityName };
      if (update !== null) body.update = update;
      return body;
    };
    try {
      return await send(compose(true));
    } catch (e) {
      if (priorityName === null || !JiraParse.errorMentionsField(e, JiraAdapter.OPTIONAL_FIELD_PRIORITY)) throw e;
      const detail = e instanceof Error ? e.message : String(e);
      const result = await send(compose(false));
      // Le dégradé est signalé APRÈS le succès de la retente : annoncer un dégradé sur une opération
      // qui a fini par échouer noierait le vrai message d'erreur.
      onDegraded?.("priorité non appliquée — le projet a refusé le champ « " + JiraAdapter.OPTIONAL_FIELD_PRIORITY
        + " » (" + detail + ") ; " + what + " a été rejouée sans lui");
      return result;
    }
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

  /** Étiquettes prêtes à partir : chaînes non vides, rognées, DÉDUPLIQUÉES. Ceinture de sécurité —
      l'appelant les a déjà normalisées (`TrackerLabels`), mais une étiquette vide ou dupliquée dans
      un verbe ferait refuser TOUTE la requête par Jira. */
  private static cleanLabels(labels: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(labels) ? labels : []) {
      const label = typeof raw === "string" ? raw.trim() : "";
      if (label === "" || seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
    return out;
  }

  /** Échéance au format attendu par Jira (`YYYY-MM-DD`), ou `null`. AVARE par principe : ce qui
      n'est pas exactement une date du calendrier grégorien rend `null` plutôt qu'une date
      approchée — une fausse échéance dans un ticket d'exploitation est pire qu'aucune. */
  private static dueDate(value: unknown): string | null {
    const raw = typeof value === "string" ? value.trim() : "";
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
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

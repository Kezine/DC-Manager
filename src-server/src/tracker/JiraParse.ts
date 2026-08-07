import { TRACKER_STATUS_CATEGORY_FALLBACK, type TrackerTicketState } from "./TrackerProvider.js";

/* =============================================================================
   DÉCODAGE JIRA PUR — module `tracker/` AMOVIBLE, partie SPÉCIFIQUE À LA MARQUE
   (préfixe `Jira*`). Transforme les réponses JSON de l'API REST Jira Cloud
   (`/rest/api/3/…`) en pivot `TrackerTicketState` (cf. `TrackerProvider.ts`), et
   traduit dans l'autre sens ce qui doit l'être (priorité, ADF). Classe à MÉTHODES
   STATIQUES, entièrement PURE : aucun accès réseau, aucun import Node, aucune
   horloge — testable en isolation (fixtures JSON → état).

   ── PRINCIPE DIRECTEUR : TOLÉRANCE ABSOLUE ────────────────────────────────────
   Ce module NE JETTE JAMAIS. Champ absent → `null` (ou "" pour les champs non
   nullables du pivot), forme inattendue → enregistrement ignoré, type inattendu →
   valeur écartée. Raison de fond : une exception de décodage ferait échouer la
   passe ENTIÈRE (et donc perdre le rafraîchissement de TOUTES les interventions
   répliquées) pour un seul ticket mal formé.

   ── 🚨 L'IDENTITÉ EST L'`id` INTERNE, JAMAIS LA CLÉ ──────────────────────────
   C'est LE risque n°1 du chantier, et il est silencieux jusqu'au jour où il frappe.
   Une clé `INFRA-123` CHANGE quand le ticket est déplacé d'un projet à l'autre (il
   devient `OPS-45`). Prendre la clé pour `ext_id` produirait, au premier
   déplacement, un DOUBLON (le « nouveau » ticket) PLUS un orphelin (l'ancien,
   introuvable). Donc : `ext_id` = l'`id` interne, et un item SANS id est REFUSÉ
   (rendu `null`) — mieux vaut ne pas suivre un ticket que le suivre sous une
   identité mobile. `key` n'est qu'un champ d'AFFICHAGE, re-synchronisé à chaque
   passe : un renommage de projet se reflète alors tout seul.

   ── ⚠ LE LIEN VISE L'INTERFACE, PAS L'API ────────────────────────────────────
   Le champ `self` d'une réponse Jira pointe la RESSOURCE D'API
   (`…/rest/api/3/issue/10042`) : le recopier dans `url` donnerait à l'utilisateur
   un lien qui affiche du JSON, ou demande une authentification. On COMPOSE donc
   `<base>/browse/<clé>` — c'est le piège classique de cette intégration.
   ============================================================================= */

/** ALIAS de champs acceptés, du plus PROBABLE au plus tolérant. UN SEUL point de déclaration :
    toute correction après validation sur instance réelle se fait ICI.
    ⚠ L'ordre COMPTE : le premier alias présent et exploitable gagne. */
const FIELD_ALIASES = {
  /** Identifiant INTERNE du ticket — la SEULE identité stable (cf. l'en-tête). */
  id: ["id", "issueId"],
  /** Clé lisible — champ d'affichage, JAMAIS l'identité. */
  key: ["key", "issueKey"],
  /** Conteneur des champs métier. L'API v3 les groupe sous `fields` ; on accepte aussi un objet
      APLATI (certaines routes de recherche « allégées » et bon nombre de fixtures le sont). */
  fields: ["fields"],
  status: ["status"],
  statusCategory: ["statusCategory", "status_category"],
  assignee: ["assignee"],
  labels: ["labels", "tags"],
} as const;

/** Alias du LIBELLÉ d'un objet nommé de Jira (statut, type, priorité, résolution) : ces objets sont
    tous de la forme `{ id, name, … }`. Un seul jeu d'alias pour tous — ils ont la même forme, et
    écrire plusieurs listes identiques les ferait diverger. */
const NAMED_ALIASES = ["name", "value", "label"] as const;

/** Alias du nom AFFICHABLE d'une personne. `displayName` d'abord : c'est ce que l'opérateur voit
    dans Jira, donc ce qu'il cherchera. L'adresse e-mail n'arrive qu'en dernier repli (elle est
    souvent masquée par les réglages de confidentialité Atlassian), et JAMAIS l'`accountId` — un
    identifiant opaque n'est pas un nom affichable (contrat du pivot). */
const PERSON_ALIASES = ["displayName", "name", "emailAddress"] as const;

/** Alias de la CLÉ de catégorie d'état. Jira l'expose sous `statusCategory.key`. */
const CATEGORY_KEY_ALIASES = ["key", "categoryKey"] as const;

/** Correspondance EXPLICITE catégorie Jira → énumération FERMÉE du pivot
    (`TRACKER_STATUS_CATEGORIES`). Table plutôt que suite de `if` : c'est LE point à corriger si
    Atlassian ajoute une clé, et une valeur ABSENTE de la table tombe sur `unknown` — on ne devine
    jamais.
    ⚠ La clé `undefined` (littéralement, pour la catégorie « No category ») n'est pas listée : elle
    tombe donc, à juste titre, sur `unknown`. */
const STATUS_CATEGORY_BY_JIRA_KEY: Readonly<Record<string, string>> = {
  new: "todo",
  indeterminate: "in_progress",
  done: "done",
};

/** Correspondance PRIORITÉ DC Manager → nom de priorité Jira. Table FIXE en v1 (§5 du cadrage) :
    ce sont les quatre noms du schéma de priorités par DÉFAUT de Jira. La rendre configurable
    n'apporterait rien tant que le besoin ne s'est pas manifesté — et elle vit ICI, dans le module de
    marque, parce que « Highest » est un vocabulaire Jira, pas un concept de DC Manager.
    ⚠ Un slug hors table rend `null` : on préfère pousser un ticket SANS priorité qu'avec une
    priorité inventée (et le champ est de toute façon facultatif — certains projets ne l'ont pas). */
const JIRA_PRIORITY_BY_SLUG: Readonly<Record<string, string>> = {
  low: "Low",
  normal: "Medium",
  high: "High",
  critical: "Highest",
};

/** Une PAGE de résultats de recherche, décodée. Porte les marqueurs des DEUX formes d'API connues
    (cf. l'en-tête de `JiraAdapter` § « ce qui est SUPPOSÉ de l'API Jira ») : `nextPageToken`/`isLast`
    pour la forme actuelle, `startAt`/`total` pour l'ancienne. Aucune n'est requise. */
export interface JiraPage {
  /** Tickets de la page (jamais null — tableau vide si la forme est inattendue). */
  items: any[];
  /** Jeton de page SUIVANTE (forme actuelle). null = non remonté. */
  nextPageToken: string | null;
  /** Le tracker ANNONCE que c'est la dernière page. null = non remonté. */
  isLast: boolean | null;
  /** Décalage tel que RENVOYÉ par l'API (ancienne forme). null = non remonté. */
  startAt: number | null;
  /** Nombre TOTAL de résultats (ancienne forme). null = non remonté. */
  total: number | null;
}

/** Comment demander la page SUIVANTE : par JETON (forme actuelle) ou par DÉCALAGE (ancienne). */
export type JiraCursor = { token: string } | { startAt: number };

export class JiraParse {
  /* --------------------------------------------------------------------------
     1) ENVELOPPE ET PAGINATION (logique PURE)
     -------------------------------------------------------------------------- */

  /** Décode l'enveloppe d'une réponse de recherche. TOLÉRANT : accepte `{ issues: [...] }` (les
      deux formes d'API), un TABLEAU nu, ou n'importe quoi d'autre (→ page vide). Les marqueurs de
      pagination ne sont lus que s'ils ont le bon type — une valeur exotique vaut « non remonté »,
      jamais une exception. */
  static page(json: any): JiraPage {
    if (Array.isArray(json)) return { items: json, nextPageToken: null, isLast: null, startAt: null, total: null };
    if (!json || typeof json !== "object") return { items: [], nextPageToken: null, isLast: null, startAt: null, total: null };
    const items = Array.isArray(json.issues) ? json.issues : Array.isArray(json.values) ? json.values : [];
    const token = typeof json.nextPageToken === "string" && json.nextPageToken.trim() !== "" ? json.nextPageToken : null;
    return {
      items,
      nextPageToken: token,
      isLast: typeof json.isLast === "boolean" ? json.isLast : null,
      startAt: JiraParse.nonNegativeInt(json.startAt),
      total: JiraParse.nonNegativeInt(json.total),
    };
  }

  /** DÉCIDE s'il faut demander une page de plus, et COMMENT. Fonction PURE, extraite exprès de la
      boucle réseau : c'est LA règle qui, mal écrite, boucle à l'infini.

      Rend le curseur de la page suivante, ou `null` pour ARRÊTER. On s'arrête dès que l'UNE de ces
      conditions tient — chacune est un garde-fou INDÉPENDANT, et c'est voulu : l'API peut mentir
      sur `total`, ignorer `maxResults`, ou omettre `isLast` :
      1. `limit` non strictement positif → configuration absurde, on ne boucle pas ;
      2. la page est VIDE → plus rien à lire (le cas nominal de fin) ;
      3. `isLast` est explicitement vrai → le tracker a parlé, on le croit ;
      4. un `nextPageToken` est présent → forme actuelle, on continue AVEC lui (prioritaire sur les
         heuristiques de décalage ci-dessous : un jeton est une information EXACTE, pas une déduction) ;
      5. la page rend MOINS que la limite demandée → c'était la dernière (ancienne forme) ;
      6. le total est connu et déjà atteint → fini ;
      7. sinon on repart au décalage suivant.
      @param page          la page décodée (cf. `page`)
      @param sentStartAt   le décalage qu'on VIENT de demander (référence de progression : on
                           n'utilise PAS celui renvoyé par l'API, qui peut manquer ou dériver)
      @param limit         la taille de page demandée */
  static nextCursor(page: JiraPage, sentStartAt: number, limit: number): JiraCursor | null {
    if (!Number.isFinite(limit) || limit <= 0) return null;              // 1
    const received = page.items.length;
    if (received === 0) return null;                                     // 2
    if (page.isLast === true) return null;                               // 3
    if (page.nextPageToken !== null) return { token: page.nextPageToken };// 4
    if (received < limit) return null;                                   // 5
    const next = sentStartAt + received;
    if (page.total !== null && next >= page.total) return null;          // 6
    return { startAt: next };                                            // 7
  }

  /* --------------------------------------------------------------------------
     2) TICKETS — item brut → pivot `TrackerTicketState`
     -------------------------------------------------------------------------- */

  /** Décode l'ÉTAT d'UN ticket. Rend `null` quand l'item est inexploitable — c'est-à-dire quand il
      n'offre pas d'identité INTERNE (cf. 🚨 en tête de fichier) : le réconcilier sous sa clé
      produirait un doublon au premier déplacement de projet.

      ⚠ Ce que ce décodeur NE lit PAS, et pourquoi : ni titre, ni description, ni type de ticket.
      DC Manager fait FOI sur le contenu (il l'a poussé) — les rapatrier créerait deux vérités
      concurrentes sur les mêmes champs, et la première divergence serait impossible à arbitrer.

      @param baseUrl URL de base de l'instance, pour COMPOSER le lien d'interface (jamais `self`). */
  static ticketState(raw: any, baseUrl: string): TrackerTicketState | null {
    if (!raw || typeof raw !== "object") return null;
    const extId = JiraParse.firstString(raw, FIELD_ALIASES.id);
    if (!extId) return null;   // aucune identité STABLE → inréconciliable

    // Champs métier : sous `fields` chez Jira, mais on accepte un objet aplati (cf. FIELD_ALIASES).
    const fieldsValue = JiraParse.firstValue(raw, FIELD_ALIASES.fields);
    const fields = fieldsValue && typeof fieldsValue === "object" && !Array.isArray(fieldsValue) ? fieldsValue : raw;

    const key = JiraParse.firstString(raw, FIELD_ALIASES.key) || "";
    const status = JiraParse.firstValue(fields, FIELD_ALIASES.status);

    return {
      ext_id: extId,
      key,
      status: JiraParse.namedLabel(status) || "",
      status_category: JiraParse.statusCategory(status),
      assignee: JiraParse.personName(JiraParse.firstValue(fields, FIELD_ALIASES.assignee)),
      url: JiraParse.browseUrl(baseUrl, key),
      labels: JiraParse.labels(JiraParse.firstValue(fields, FIELD_ALIASES.labels)),
    };
  }

  /** Décode une LISTE d'états, en écartant les inexploitables et les DOUBLONS d'`ext_id` (une
      recherche paginée peut ramener deux fois le même ticket si des données bougent entre deux
      pages — le premier gagne). */
  static ticketStates(items: any[], baseUrl: string): TrackerTicketState[] {
    const out: TrackerTicketState[] = [];
    const seen = new Set<string>();
    if (!Array.isArray(items)) return out;
    for (const item of items) {
      const state = JiraParse.ticketState(item, baseUrl);
      if (!state || seen.has(state.ext_id)) continue;
      seen.add(state.ext_id);
      out.push(state);
    }
    return out;
  }

  /** Catégorie d'état NORMALISÉE depuis l'objet `status` d'un ticket (cf.
      `STATUS_CATEGORY_BY_JIRA_KEY`). Absente, exotique ou inconnue → `unknown` : la classification
      sert aux couleurs et aux tris, elle ne doit JAMAIS faire échouer une passe. */
  static statusCategory(status: any): string {
    if (!status || typeof status !== "object") return TRACKER_STATUS_CATEGORY_FALLBACK;
    const category = JiraParse.firstValue(status, FIELD_ALIASES.statusCategory);
    if (!category || typeof category !== "object") return TRACKER_STATUS_CATEGORY_FALLBACK;
    const key = JiraParse.firstString(category, CATEGORY_KEY_ALIASES);
    if (!key) return TRACKER_STATUS_CATEGORY_FALLBACK;
    return STATUS_CATEGORY_BY_JIRA_KEY[key.trim().toLowerCase()] || TRACKER_STATUS_CATEGORY_FALLBACK;
  }

  /** Compose le lien d'INTERFACE d'un ticket : `<base>/browse/<clé>` (⚠ jamais le champ `self`, qui
      pointe l'API — cf. l'en-tête). Rend `null` si la base ou la clé manquent : un lien mort est
      pire qu'une colonne vide, l'utilisateur cliquerait pour rien. */
  static browseUrl(baseUrl: string, key: string): string | null {
    const base = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
    const issueKey = typeof key === "string" ? key.trim() : "";
    if (base === "" || issueKey === "") return null;
    return base + "/browse/" + encodeURIComponent(issueKey);
  }

  /* --------------------------------------------------------------------------
     3) RÉFÉRENCES SAISIES ET JQL
     -------------------------------------------------------------------------- */

  /** Traduit une RÉFÉRENCE saisie par l'utilisateur (action « Lier un ticket existant ») en quelque
      chose que l'API sait résoudre : une clé lisible, un identifiant interne, ou l'un des deux
      extrait d'une URL COLLÉE depuis le navigateur. Rend `null` si rien d'exploitable.

      Formes acceptées, et pourquoi celles-là : l'utilisateur copie ce qu'il a sous les yeux —
      soit la clé qu'il lit dans Jira, soit l'URL de la page du ticket (`…/browse/INFRA-123`), soit
      celle d'un tableau (`…?selectedIssue=INFRA-123`), soit — plus rarement — une URL d'API
      (`…/rest/api/3/issue/10042`). Refuser l'URL l'obligerait à extraire la clé lui-même, ce qui
      est exactement le genre de friction qui fait renoncer à une fonctionnalité.
      Pure → testable, et volontairement AVARE : ce qui n'est pas reconnu rend `null` plutôt qu'une
      supposition (une supposition fausse ferait lier le mauvais ticket). */
  static referenceToIdOrKey(reference: string): string | null {
    const raw = typeof reference === "string" ? reference.trim() : "";
    if (raw === "") return null;
    if (/^https?:\/\//i.test(raw)) {
      let url: URL;
      try { url = new URL(raw); } catch { return null; }
      const segments = url.pathname.split("/").filter((s) => s !== "");
      // Segment suivant « browse » ou « issue(s) » : c'est la convention des liens Jira, d'interface
      // comme d'API. On prend le PREMIER marqueur rencontré, jamais le dernier segment en aveugle
      // (une URL peut se terminer par un onglet, un commentaire, un fragment…).
      for (let i = 0; i < segments.length - 1; i++) {
        const marker = segments[i].toLowerCase();
        if (marker === "browse" || marker === "issue" || marker === "issues") {
          return JiraParse.normalizeIdOrKey(decodeURIComponent(segments[i + 1]));
        }
      }
      const selected = url.searchParams.get("selectedIssue");
      return selected ? JiraParse.normalizeIdOrKey(selected) : null;
    }
    return JiraParse.normalizeIdOrKey(raw);
  }

  /** Construit la LISTE d'identifiants d'une clause JQL `id IN (…)`. Les identifiants NUMÉRIQUES
      passent nus (c'est leur forme naturelle) ; tout le reste est CITÉ, guillemets et
      contre-obliques échappés.
      ⚠ Ce n'est pas de la coquetterie : ces valeurs viennent de la base des interventions (donc, à
      la source, d'une réponse de tracker). Les concaténer telles quelles laisserait une valeur
      forgée refermer la parenthèse et poursuivre la requête — la version JQL d'une injection. Les
      valeurs vides sont écartées. Pure → testable. */
  static jqlIdList(ids: string[]): string {
    const parts: string[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const raw = typeof id === "string" ? id.trim() : typeof id === "number" ? String(id) : "";
      if (raw === "") continue;
      parts.push(/^\d+$/.test(raw) ? raw : '"' + raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"');
    }
    return parts.join(", ");
  }

  /* --------------------------------------------------------------------------
     4) POUSSÉE — priorité, échéance, ADF et lecture des REFUS
     -------------------------------------------------------------------------- */

  /** Nom de priorité JIRA pour un slug DC Manager (`low`/`normal`/`high`/`critical`), ou `null` si
      le slug est absent/inconnu (cf. `JIRA_PRIORITY_BY_SLUG`). Pure → testable. */
  static priorityName(slug: unknown): string | null {
    const raw = typeof slug === "string" ? slug.trim().toLowerCase() : "";
    return raw === "" ? null : (JIRA_PRIORITY_BY_SLUG[raw] || null);
  }

  /** Convertit un TEXTE BRUT en document ADF minimal — le format qu'exige l'API v3 pour une
      description (elle n'accepte PAS une chaîne : c'est le piège d'implémentation n°1 de la
      création, et il se manifeste par un 400 peu lisible).

      Forme produite : un paragraphe par LIGNE. Une ligne vide devient un paragraphe SANS contenu
      (`content: []`) et surtout PAS un nœud `text` de chaîne vide — un `text` vide est INVALIDE au
      schéma ADF, et c'est l'erreur qu'on commet naturellement en mappant les lignes sans y penser.
      Un texte VIDE produit donc un document VALIDE d'un seul paragraphe vide (`String.split` rend
      toujours au moins un élément), jamais un document sans contenu.
      Les caractères spéciaux ne demandent aucun traitement : c'est la sérialisation JSON de la
      requête qui les échappe — les échapper ici les doublerait.
      Pure → testable par fixtures. */
  static toAdf(text: unknown): { type: "doc"; version: 1; content: any[] } {
    const raw = typeof text === "string" ? text : "";
    const lines = raw.split(/\r\n|\r|\n/);
    return { type: "doc", version: 1, content: lines.map((line) => JiraParse.adfParagraph(line)) };
  }

  /** UN paragraphe ADF (vide ⇒ sans nœud `text`, cf. `toAdf`). */
  private static adfParagraph(line: string): any {
    return line === "" ? { type: "paragraph", content: [] } : { type: "paragraph", content: [{ type: "text", text: line }] };
  }

  /** 🚨 LE REFUS DU TRACKER DÉSIGNE-T-IL LE CHAMP `field` ? Sert au repli « priorité refusée par le
      projet » (risque n°2 du cadrage) : beaucoup de projets team-managed n'ont PAS de champ
      priorité, et Jira répond alors `{ errors: { priority: "…" } }`. Sans cette lecture, la
      réplication serait purement et simplement impossible sur ces projets-là.

      DEUX sources, dans cet ordre, et l'union des deux (TOLÉRANCE assumée) :
      1. le CORPS BRUT de la réponse, s'il est joint à l'erreur (`.body`) : la lecture est alors
         EXACTE — les clés de `errors` sont littéralement les noms de champs refusés ;
      2. à défaut, le MESSAGE — où le client HTTP a déjà composé « <champ> : <explication> ». Le
         repli existe parce que le transport est INJECTÉ : un stub de test (ou une autre
         implémentation) n'est pas tenu de joindre le corps.
      On ne cherche PAS le nom du champ n'importe où dans le texte (« priority » peut apparaître
      dans un titre d'intervention recopié par le tracker) : on exige la forme « champ : », qui est
      celle d'une erreur PAR CHAMP.
      Pure et statique → testable par fixtures. */
  static errorMentionsField(error: unknown, field: string): boolean {
    const wanted = String(field || "").trim().toLowerCase();
    if (wanted === "") return false;

    const body = (error as { body?: unknown } | null | undefined)?.body;
    if (typeof body === "string" && body.trim() !== "") {
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const errors = parsed && typeof parsed === "object" ? parsed.errors : null;
      if (errors && typeof errors === "object" && !Array.isArray(errors)) {
        if (Object.keys(errors).some((name) => String(name).trim().toLowerCase() === wanted)) return true;
      }
    }

    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message === "") return false;
    // Échappement du nom de champ : il vient d'une constante du code aujourd'hui, mais une regex
    // construite sans échappement est une bombe à retardement le jour où il vient d'ailleurs.
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?:^|[^A-Za-z0-9_])" + escaped + "\\s*:", "i").test(message);
  }

  /* --------------------------------------------------------------------------
     Helpers internes (privés) — décodage tolérant de valeurs
     -------------------------------------------------------------------------- */

  /** Normalise une référence NON-URL : identifiant numérique tel quel, clé mise en CAPITALES (les
      clés Jira le sont toujours, et l'utilisateur tape souvent en minuscules), sinon `null`. */
  private static normalizeIdOrKey(raw: string): string | null {
    const value = String(raw || "").trim();
    if (/^\d+$/.test(value)) return value;
    if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value)) return value.toUpperCase();
    return null;
  }

  /** Libellé d'un objet nommé de Jira (`{ name: "Bug" }`) — `null` si absent ou inexploitable.
      Accepte aussi une CHAÎNE nue : une API allégée peut rendre `"status": "Done"`. */
  private static namedLabel(value: any): string | null {
    if (typeof value === "string") return value.trim() === "" ? null : value.trim();
    if (!value || typeof value !== "object") return null;
    return JiraParse.firstString(value, NAMED_ALIASES);
  }

  /** Nom AFFICHABLE d'une personne (`{ displayName: "A. Dupont" }`) — jamais son `accountId`. */
  private static personName(value: any): string | null {
    if (typeof value === "string") return value.trim() === "" ? null : value.trim();
    if (!value || typeof value !== "object") return null;
    return JiraParse.firstString(value, PERSON_ALIASES);
  }

  /** Étiquettes : uniquement les CHAÎNES non vides, rognées. Ni tri ni déduplication ici — le
      décodeur rend ce qu'il a LU. La canonisation (préfixe `DCM-`, normalisation, dédup) appartient
      au module PUR `TrackerLabels`, qui est aussi celui qui calcule le diff : la faire deux fois de
      deux façons est précisément ce qui produirait un faux delta à chaque poussée. */
  private static labels(value: any): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      const label = item.trim();
      if (label !== "") out.push(label);
    }
    return out;
  }

  /** Première valeur BRUTE non vide parmi une liste d'alias de clés. */
  private static firstValue(raw: any, keys: readonly string[]): any {
    if (!raw || typeof raw !== "object") return null;
    for (const key of keys) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  }

  /** Première valeur CHAÎNE non vide parmi une liste d'alias (les nombres sont acceptés et
      convertis : l'`id` d'un ticket peut arriver en numérique selon la route). null si aucune. */
  private static firstString(raw: any, keys: readonly string[]): string | null {
    const value = JiraParse.firstValue(raw, keys);
    if (typeof value === "string") return value.trim() === "" ? null : value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  }

  /** Entier ≥ 0, sinon null (accepte une chaîne numérique). */
  private static nonNegativeInt(value: any): number | null {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
  }
}

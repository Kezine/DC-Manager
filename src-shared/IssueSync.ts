/* =============================================================================
   SYNCHRO TICKETS — FRONTIÈRE SOURCE / LOCAUX (code PARTAGÉ front ⇄ back, TS pur).

   Miroir de `WifiSync.ts` / `VmSync.ts` pour la collection `issues` (cadrage
   `.notes/toDos/remote-issue-tracker-jira-cadrage-2026-08-06.md`, D1) : la
   collection sépare deux familles de champs —
   - champs SOURCE : alimentés par la synchro d'un provider de tickets (Atlassian
     Jira Cloud en première implémentation — la marque n'est QU'un adaptateur, cf.
     D9 du chantier wifi repris ici), ÉCRASÉS à chaque passe ;
   - champs LOCAUX : enrichissements utilisateur (`notes`, `description` héritée
     d'`Entity`, et surtout `targets` — le rattachement MANUEL aux objets du
     modèle, cf. `IssueTargets`), JAMAIS touchés par la synchro.

   Ce fichier est la SOURCE DE VÉRITÉ de cette frontière : le modèle client
   (`src-client/models/Issue.ts`) normalise ses champs source ICI, et le moteur de
   réconciliation serveur (lot ultérieur) n'écrasera QUE les champs listés ici.
   ⚠ Sans cette délégation, le modèle client normaliserait autrement que le diff
   serveur et la synchro trouverait un FAUX DELTA à chaque passe : elle réécrirait
   le document EN BOUCLE (révision qui monte, SSE, bruit d'undo) sans qu'aucune
   donnée n'ait changé. Un test d'invariant compare les deux CHAMP PAR CHAMP.

   ── L'ASSIETTE EST INVERSÉE par rapport à vm/ et wifi/ (§3 du cadrage) ─────────
   Là-bas, la SOURCE énumère et le document suit. Ici, le DOCUMENT énumère (les
   tickets SUIVIS) et la source est interrogée sur ces clés-là. Conséquence portée
   par le pivot ci-dessous : `orphan` ne veut PAS dire « disparu d'un inventaire
   qu'on relit en entier », mais « ticket NON RÉSOLU à la dernière passe » —
   suppression, projet archivé ou permission perdue. D'où le libellé UI
   « introuvable » (et non « orphelin » ni « déconnecté »), et l'interdiction
   absolue de supprimer l'enregistrement local d'office : il porte des notes et
   des liens que le tracker ne connaît pas.

   ── AGNOSTIQUE DE LA MARQUE ───────────────────────────────────────────────────
   Aucun champ propre à Jira. `status`, `issue_type`, `priority`, `resolution`
   restent des CHAÎNES TOLÉRANTES affichées telles quelles : un workflow Jira est
   configurable par projet (« En recette », « Attente client »…) et un autre
   tracker nommera encore autrement. Seule `status_category` est une énumération
   FERMÉE (décision D3) : c'est elle — et elle seule — qui porte les couleurs, les
   tris et les filtres SÉMANTIQUES, donc l'abstraction multi-providers.

   Portée `src-shared/` : TS PUR (ni DOM ni Node), compilé des DEUX côtés — front
   (résolution *bundler*) et serveur (NodeNext). Ce fichier n'importe rien : c'est
   un CONSTAT, pas une contrainte (l'ISOLEMENT du dossier, lui, reste permanent —
   cf. `CLAUDE.md` § « Code partagé front/back »). Un import relatif vers un autre
   fichier partagé serait AUTORISÉ, à condition IMPÉRATIVE d'écrire le
   spécificateur avec l'extension `.js`.
   ============================================================================= */

/** CATÉGORIES d'état d'un ticket — énumération FERMÉE (décision D3), commune à TOUS les providers.
    C'est l'adaptateur qui produit la valeur : Jira l'expose nativement (`statusCategory`), une marque
    qui n'en aurait pas la déduit chez elle (GitHub : `closed` → `done`). `unknown` n'est pas un
    bouche-trou honteux mais la valeur qui rend la tolérance POSSIBLE : un état que l'adaptateur ne
    sait pas classer est ACCEPTÉ et rangé ici, plutôt que de faire échouer la passe entière.

    ⚠ Déclarée ICI et non parmi les énumérations de `DataValidation.ts` : celles-là sont « alignées au
    domaine FRONT » (registres `domain/constants.ts`, verrouillées par un test anti-divergence), alors
    que celle-ci n'a aucun pendant côté registres — elle naît de la frontière de synchro et y reste.
    `DataValidation` (spec `issues.status_category`) et `src-client/core/IssueStatus` l'IMPORTENT donc
    d'ici : une seule liste, jamais trois. */
export const ISSUE_STATUS_CATEGORIES = ["todo", "in_progress", "done", "unknown"] as const;

/** Catégorie d'état (type littéral dérivé de la liste fermée). */
export type IssueStatusCategory = (typeof ISSUE_STATUS_CATEGORIES)[number];

/** Les 17 champs SOURCE de l'entité `issues`, sous leur forme normalisée. */
export interface IssueSourceFields {
  /** Identité STABLE côté tracker — clé de RÉCONCILIATION.
      🚨 C'est l'identifiant INTERNE du ticket (« 10042 » chez Jira), JAMAIS la clé lisible
      (décision D2, risque n°1 du cadrage) : une clé `INFRA-123` CHANGE quand le ticket est déplacé
      d'un projet à l'autre (il devient `OPS-45`). La prendre pour identité produirait, au premier
      déplacement, un DOUBLON (le « nouveau » ticket) PLUS un orphelin (l'ancien, introuvable) — et
      le défaut resterait silencieux jusqu'au jour où il frappe. */
  ext_id: string;
  /** Instance d'adaptateur d'origine (`id` du provider) — multi-trackers par document. */
  provider_id: string;
  /** Clé LISIBLE du ticket (« INFRA-123 ») — champ d'AFFICHAGE re-synchronisé à chaque passe.
      Mobile par nature (cf. `ext_id`) : un renommage de projet se reflète donc tout seul. */
  key: string;
  /** Titre du ticket. "" toléré (un tracker peut rendre un ticket sans résumé exploitable). */
  summary: string;
  /** Libellé BRUT du statut, AFFICHÉ TEL QUEL et JAMAIS traduit (D3, doctrine `VmStatus`). */
  status: string;
  /** Classification FERMÉE du statut (`ISSUE_STATUS_CATEGORIES`) — la seule base des couleurs,
      des tris et des filtres sémantiques. Toute valeur hors de la liste est ramenée à `unknown`. */
  status_category: string;
  /** Type de ticket côté tracker (Bug / Tâche / …) — libellé brut, tolérant. */
  issue_type: string;
  /** Priorité (libellé brut) — `null` quand le tracker n'en expose pas. */
  priority: string | null;
  /** Personne assignée, sous forme AFFICHABLE (un nom, pas un identifiant de compte). */
  assignee: string | null;
  /** Auteur du ticket, sous forme AFFICHABLE. */
  reporter: string | null;
  /** Étiquettes du ticket — ∈ `Schema.ARRAY_FIELDS` (le `where` y teste l'APPARTENANCE, patron
      `tags_src`). NORMALISÉES DE FAÇON DÉTERMINISTE (rognées, vidées des blancs, dédupliquées,
      TRIÉES) : sans tri, un simple réordonnancement côté tracker produirait un faux delta à
      CHAQUE passe — la comparaison des états source se fait par sérialisation. */
  labels: string[];
  /** Libellé de résolution — `null` tant que le ticket est ouvert. */
  resolution: string | null;
  /** Horodatage ISO de création CÔTÉ TRACKER (suffixe `_src` comme `vms.description_src` :
      distinct de `created_date`, qui date l'enregistrement LOCAL). */
  created_src: string | null;
  /** Horodatage ISO de dernière modification CÔTÉ TRACKER. */
  updated_src: string | null;
  /** Lien CANONIQUE du ticket, composé UNE FOIS par l'adaptateur et persisté au pivot (décision
      D6 : surtout PAS reconstruit depuis une variable d'environnement serveur). C'est ce qui rend
      la feature utile en MODE FICHIER — un document synchronisé puis exporté garde des tickets
      ouvrables d'un clic, sans serveur ni configuration — et ce qui rend le multi-instances natif. */
  url: string | null;
  /** Ticket NON RÉSOLU à la dernière passe (cf. l'en-tête : suppression, projet archivé, permission
      perdue). ⚠ Ce n'est PAS un événement banal, contrairement au « déconnecté » du wifi : libellé
      UI « introuvable », couleur d'avertissement, et JAMAIS de suppression automatique. */
  orphan: boolean;
  /** Horodatage ISO de la dernière synchro ayant touché cet enregistrement. */
  last_sync: string;
}

/** Liste CANONIQUE des champs source — le périmètre EXACT de ce que la synchro a le droit d'écraser.
    Tout champ de l'entité `issues` HORS de cette liste est LOCAL et n'est JAMAIS touché par une passe :
    `notes`, `description` (héritée d'`Entity`) et `targets` (rattachement MANUEL, cf. `IssueTargets`).
    ⚠ Aucune exception « champ DÉRIVÉ » ici, contrairement à `vms.host_equipment_id` et
    `wifiClients.ap_equipment_id` : le rattachement aux objets du modèle est SAISI (arbitrage A4), donc
    la synchro n'a rien à re-résoudre. Un test d'invariant vérifie la cohérence de cette liste avec le
    modèle client `Issue`. */
export const ISSUE_SOURCE_FIELDS: readonly (keyof IssueSourceFields)[] = [
  "ext_id", "provider_id", "key", "summary", "status", "status_category", "issue_type",
  "priority", "assignee", "reporter", "labels", "resolution", "created_src", "updated_src",
  "url", "orphan", "last_sync",
];

export class IssueSync {
  /** Chaîne NON nullable : `undefined`/`null`/"" → "", sinon la valeur convertie en chaîne.
      ⚠ Forme choisie pour COÏNCIDER EXACTEMENT avec `DataValidator.normalizeField` d'un champ
      `{ type: "string", default: "" }` (vide absorbé par `isEmpty`, sinon `String(valeur)`) : le
      modèle client et la normalisation de spec doivent produire la MÊME valeur, sinon un simple
      aller-retour d'écriture déplacerait les données. (Le raccourci `p.x || ""` des frontières VM et
      wifi diverge, lui, sur `0`/`false` — sans effet mesurable là-bas, mais on ne le reproduit pas.) */
  private static text(value: unknown): string {
    return value === undefined || value === null || value === "" ? "" : String(value);
  }

  /** Chaîne NULLABLE : vide → `null` (jamais ""), sinon la valeur convertie en chaîne. Coïncide de
      même avec `normalizeField` d'un champ `{ type: "string", nullable: true, default: null }`.
      Pourquoi `null` plutôt que "" ici : « non renseigné par le tracker » et « renseigné à vide »
      ne sont pas la même chose pour une priorité ou une résolution, et la colonne le montre. */
  private static nullableText(value: unknown): string | null {
    return value === undefined || value === null || value === "" ? null : String(value);
  }

  /** Ramène une catégorie d'état dans l'ensemble FERMÉ, `unknown` par défaut.
      ⚠ ÉCART ASSUMÉ avec `normalizeField` (qui laisserait passer une valeur hors enum, à charge de
      la validation de la refuser) : ici on CLAMPE, et c'est le point. La synchro écrit un LOT — un
      seul ticket dont l'adaptateur aurait mal classé l'état ferait rejeter la passe ENTIÈRE
      (`normalizeAndValidate` refuse en bloc) pour une donnée d'affichage. Le clamp garantit que
      TOUT ce que la synchro produit satisfait l'`enum` de la spec PAR CONSTRUCTION, tandis que la
      porte d'écriture directe (API/import) reste STRICTE, elle, et refuse la valeur inventée. */
  static normalizeCategory(value: unknown): string {
    const category = IssueSync.text(value);
    return (ISSUE_STATUS_CATEGORIES as readonly string[]).includes(category) ? category : "unknown";
  }

  /** Étiquettes sous forme CANONIQUE : chaînes seulement, rognées, vides écartées, DÉDUPLIQUÉES et
      TRIÉES. Le tri n'est pas de la coquetterie : `sourceEquals` compare par sérialisation, donc deux
      listes aux mêmes étiquettes dans un ORDRE différent passeraient pour un écart, et la synchro
      réécrirait le ticket à chaque passe (le tracker ne garantit aucun ordre stable). Le tri est
      celui de `Array.prototype.sort` (ordre des unités de code) : arbitraire mais DÉTERMINISTE, ce
      qui est la seule propriété dont on ait besoin ici. */
  static normalizeLabels(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const raw of value) {
      if (typeof raw !== "string") continue;
      const label = raw.trim();
      if (label) seen.add(label);
    }
    return [...seen].sort();
  }

  /** Normalise les 17 champs SOURCE depuis des propriétés brutes (pivot d'adaptateur,
      désérialisation, formulaire). Utilisée par le constructeur d'`Issue` (client) ET par le diff de
      réconciliation (serveur) : comparer deux états passés par cette normalisation élimine les faux
      écarts (undefined vs "", null vs "", ordre des étiquettes…) qui feraient réécrire le document
      à chaque passe. */
  static normalizeSource(p: { [k: string]: any }): IssueSourceFields {
    return {
      ext_id: IssueSync.text(p.ext_id),
      provider_id: IssueSync.text(p.provider_id),
      key: IssueSync.text(p.key),
      summary: IssueSync.text(p.summary),
      status: IssueSync.text(p.status),
      status_category: IssueSync.normalizeCategory(p.status_category),
      issue_type: IssueSync.text(p.issue_type),
      priority: IssueSync.nullableText(p.priority),
      assignee: IssueSync.nullableText(p.assignee),
      reporter: IssueSync.nullableText(p.reporter),
      labels: IssueSync.normalizeLabels(p.labels),
      resolution: IssueSync.nullableText(p.resolution),
      created_src: IssueSync.nullableText(p.created_src),
      updated_src: IssueSync.nullableText(p.updated_src),
      url: IssueSync.nullableText(p.url),
      // Booléen STRICT, aligné sur `normalizeField` d'un `{ type: "boolean", default: false }` :
      // `true` ou la chaîne "true" (round-trip d'un formulaire/JSON), tout le reste est faux.
      orphan: p.orphan === true || p.orphan === "true",
      last_sync: IssueSync.text(p.last_sync),
    };
  }

  /** Égalité d'UN champ source entre deux états NORMALISÉS. Comparaison par JSON : correcte ici
      parce que `normalizeSource` garantit des valeurs canoniques (chaînes jamais `undefined`,
      booléen strict, étiquettes triées et dédupliquées). Forme IDENTIQUE à `WifiSync.sourceEquals`
      et `VmSync.sourceEquals` — les trois frontières restent lisibles côte à côte. */
  static sourceEquals(a: IssueSourceFields, b: IssueSourceFields, field: keyof IssueSourceFields): boolean {
    return JSON.stringify(a[field]) === JSON.stringify(b[field]);
  }
}

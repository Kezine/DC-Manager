/* =============================================================================
   IssueStatus — ÉTAT d'un ticket (statut source + catégorie + « introuvable ») :
   classification, couleurs, clés de tri et libellés. Classe PURE : aucun DOM,
   aucun store, aucun réseau.

   POURQUOI CE MODULE (principes n°2/n°3) : la même règle sera lue par le LISTING
   (« Tickets »), la FICHE et la PALETTE de recherche. C'est exactement la
   duplication que `core/VmStatus` a eu à résorber APRÈS coup, en trois
   exemplaires, et que `core/WifiStatus` a évitée d'emblée ; on ne la recrée pas.

   ── LA DÉCISION QUI FAIT TENIR L'ABSTRACTION MULTI-PROVIDERS (D3) ─────────────
   Un tracker n'a pas « des statuts » : il a CEUX DE SES WORKFLOWS, configurables
   par projet (« En recette », « Attente client », « À valider par le client »…),
   et un autre tracker en a d'autres (GitHub n'en a que deux). Donc :
   - `status` est le libellé BRUT, AFFICHÉ TEL QUEL et JAMAIS TRADUIT — le montrer
     vaut infiniment mieux que le masquer derrière une énumération que la prochaine
     configuration démentira (même doctrine que `VmStatus` pour Proxmox et
     `WifiStatus` pour les types de raccordement) ;
   - `status_category` est une énumération FERMÉE à 4 valeurs, produite par
     l'adaptateur, et c'est la SEULE chose qui pilote couleur, clé de tri et
     filtre. C'est ce partage — libellé libre / catégorie fermée — qui permet à un
     futur provider d'entrer sans toucher une ligne de vue.

   ── LE VOCABULAIRE (cadrage §3) ──────────────────────────────────────────────
   Le champ persisté s'appelle `orphan` — MÊME mécanique que les VMs et les clients
   wifi (patch, jamais de suppression, retour couvert), ce qui permet de partager
   toute la chaîne de synchro. Mais le SENS diffère encore une fois : un ticket
   suivi qui cesse d'être résolu signale une SUPPRESSION, un PROJET ARCHIVÉ ou une
   PERMISSION PERDUE. Ce n'est ni « orphelin » (VM détruite) ni « déconnecté »
   (événement quotidien du wifi) : c'est « INTROUVABLE ». D'où un libellé propre et
   une couleur d'AVERTISSEMENT — quelque chose est à regarder, mais l'enregistrement
   local reste intact et reviendra tout seul si l'accès est rétabli.
   L'orphelinat PRIME sur la catégorie (patron `VmStatus.swatchColor`) : c'est
   l'information dominante — l'état affiché date de la dernière résolution réussie.

   ── PÉRIMÈTRE ────────────────────────────────────────────────────────────────
   Ce module rend des DONNÉES (catégorie, couleur, clé de tri), des LIBELLÉS
   localisés et les PASTILLES (patron `VmStatus.pills`/`WifiStatus.pills`),
   consommées par le LISTING, la FICHE et la palette. Les pastilles vivent ICI et
   nulle part ailleurs : c'est la source unique, on n'ouvre pas un second endroit.

   ÉCHAPPEMENT : les pastilles sont posées en `innerHTML`. Tout ce qui sort d'ici
   est du HTML SÛR — les couleurs sont un ensemble FERMÉ de constantes internes
   (aucune donnée du tracker n'entre jamais dans un attribut `style`) et le libellé
   BRUT du statut, lui, passe systématiquement par `Html.escape`.

   ── ⚠ SANS CONSOMMATEUR POUR L'INSTANT, ET C'EST VOULU (pivot du 2026-08-07) ──
   Le miroir de tickets qui lisait ce module (collection `issues`, onglet dédié) a
   été DÉMOLI : le chantier réplique désormais les interventions DC Manager DANS
   Jira, dans l'autre sens. La classification et les pastilles, elles, restent
   EXACTEMENT ce qu'il faut pour afficher le statut Jira d'une intervention
   répliquée — d'où leur conservation en l'état plutôt qu'une suppression suivie
   d'une réécriture à l'identique. Cf. `.notes/toDos/jira-replication-interventions-cadrage-2026-08-07.md`.
   ============================================================================= */
import { Html } from "./Html";
import { I18n } from "../i18n/I18n";

/** CATÉGORIES d'état d'un ticket — énumération FERMÉE, commune à tous les trackers. C'est
    l'adaptateur serveur qui produit la valeur : Jira l'expose nativement (`statusCategory`), une
    marque qui n'en aurait pas la déduit chez elle (GitHub : `closed` → `done`). `unknown` n'est pas
    un bouche-trou honteux mais la valeur qui rend la TOLÉRANCE possible : un état que l'adaptateur
    ne sait pas classer est ACCEPTÉ et rangé ici, plutôt que de faire échouer la passe entière.

    ⚠ DÉCLARÉE ICI depuis le pivot du 2026-08-07. Elle vivait dans la frontière de synchro partagée
    `src-shared/IssueSync.ts`, supprimée avec la collection `issues` : plus aucune COLLECTION du
    document ne porte cette énumération, donc plus rien à partager front ⇄ back par ce canal. Le pont
    `tracker/` (lot P2) persistera la catégorie dans `interventions.db`, base SERVEUR hors du schéma
    partagé — c'est à ce moment-là, et seulement s'il apparaît un second lecteur, qu'il faudra
    décider où la faire remonter. Dupliquer une liste de 4 littéraux « au cas où » serait la faute
    inverse (principe n°3). */
export const ISSUE_STATUS_CATEGORIES = ["todo", "in_progress", "done", "unknown"] as const;

/** Catégorie d'état (type littéral dérivé de la liste fermée). */
export type IssueStatusCategory = (typeof ISSUE_STATUS_CATEGORIES)[number];

/** Vue MINIMALE d'un ticket — le module ne dépend NI du modèle `Issue`, NI du store.
    Forme TOLÉRANTE (champs optionnels) : les enregistrements arrivent d'une synchro tierce. */
export interface IssueStatusIssue {
  /** Libellé BRUT du statut côté tracker (affiché tel quel, jamais traduit). */
  status?: string | null;
  /** Catégorie normalisée — hors de l'ensemble fermé, elle est lue comme `unknown`. */
  status_category?: string | null;
  /** Ticket non résolu à la dernière passe = INTROUVABLE (cf. en-tête). */
  orphan?: boolean;
}

export class IssueStatus {
  /** La catégorie de repli quand rien n'est exploitable — membre à part entière de l'ensemble fermé
      (cf. `ISSUE_STATUS_CATEGORIES`), pas un bouche-trou : c'est elle qui rend la tolérance possible. */
  static readonly UNKNOWN = "unknown";

  /** Ordre SÉMANTIQUE des catégories, et donc l'ordre de tri des listings : ce qui reste à faire
      d'abord, ce qui est terminé ensuite, l'inclassable en dernier. Repris tel quel de la liste
      ci-dessus — l'ordre de déclaration EST l'ordre de traitement, il n'y a pas de seconde table. */
  static readonly CATEGORIES: readonly string[] = ISSUE_STATUS_CATEGORIES;

  /** Couleur d'un ticket INTROUVABLE : AVERTISSEMENT et non ERREUR. Un ticket qu'on ne résout plus
      demande un coup d'œil (droits ? projet archivé ?), il ne signale pas une panne de l'app — et
      surtout l'enregistrement local, lui, est intact. Même arbitrage que le « déconnecté » du wifi,
      pour une raison différente. */
  static readonly COLOR_NOT_FOUND = "var(--warn)";

  /** Couleur PAR CATÉGORIE — variables SÉMANTIQUES du thème, jamais de valeur littérale.
      `todo` informatif (le ticket existe, rien n'est engagé), `in_progress` sur la couleur d'accent
      (c'est là que se porte l'attention), `done` au vert de succès, `unknown` neutre : on ne colore
      pas ce qu'on n'a pas su classer. */
  private static readonly COLOR_BY_CATEGORY: Readonly<Record<string, string>> = {
    todo: "var(--info)",
    in_progress: "var(--accent)",
    done: "var(--ok)",
    unknown: "var(--fg-dimmer)",
  };

  /** Rendu du « pas de valeur » — MÊME chaîne que le `dim("—")` des listings et que `DetailForms.MUTED`. */
  private static readonly MUTED = `<span style="color:var(--fg-dimmer)">—</span>`;

  /** Statut BRUT (rogné), "" si absent — sert à l'affichage ET au départage du tri.
      ROGNÉ comme chez `VmStatus` : un libellé entouré d'espaces trierait à part sans raison. */
  static raw(issue: IssueStatusIssue | null | undefined): string {
    return issue && typeof issue.status === "string" ? issue.status.trim() : "";
  }

  /** Catégorie NORMALISÉE (toujours l'une des 4 valeurs fermées). Une valeur absente ou inconnue
      devient `unknown` : le module ne fait jamais confiance à ce qui vient d'un tiers, même si la
      synchro serveur clampe déjà ce qu'elle écrit — l'affichage peut aussi lire une valeur arrivée
      par une autre porte (import, écriture directe). */
  static categoryOf(issue: IssueStatusIssue | null | undefined): string {
    const category = issue && typeof issue.status_category === "string" ? issue.status_category.trim() : "";
    return IssueStatus.CATEGORIES.includes(category) ? category : IssueStatus.UNKNOWN;
  }

  /** Le ticket est-il INTROUVABLE côté tracker (non résolu à la dernière passe) ? */
  static isNotFound(issue: IssueStatusIssue | null | undefined): boolean {
    return !!(issue && issue.orphan);
  }

  /** Le ticket est-il OUVERT, c'est-à-dire « pas encore réglé » ? Défini par la NÉGATION de `done`
      et non par une liste blanche (`todo` + `in_progress`), pour une raison de fond : `unknown` est
      le repli de tout ce qu'on n'a pas su classer — le compter comme CLOS le ferait disparaître des
      badges alors que c'est précisément ce qui mérite un coup d'œil. Mieux vaut un ticket signalé de
      trop qu'un ticket ouvert invisible.
      ⚠ L'orphelinat n'entre PAS dans la décision : un ticket devenu introuvable garde l'état de sa
      dernière résolution réussie — s'il était en cours, il reste OUVERT chez nous jusqu'à preuve du
      contraire. Sa pastille « introuvable », elle, dit à part que quelque chose est à regarder.
      Règle UNIQUE, consommée par le badge des fiches (`core/IssueTargetSummary`) : la dupliquer
      laisserait un compteur et une couleur se contredire au premier ajustement. */
  static isOpen(issue: IssueStatusIssue | null | undefined): boolean {
    return IssueStatus.categoryOf(issue) !== "done";
  }

  /** Couleur de l'état — l'ORPHELINAT PRIME sur la catégorie (patron `VmStatus.swatchColor`) :
      la catégorie affichée est celle de la dernière résolution réussie, donc potentiellement
      périmée ; « introuvable » est, lui, l'état COURANT et c'est l'information dominante. */
  static color(issue: IssueStatusIssue | null | undefined): string {
    if (IssueStatus.isNotFound(issue)) return IssueStatus.COLOR_NOT_FOUND;
    return IssueStatus.COLOR_BY_CATEGORY[IssueStatus.categoryOf(issue)] || IssueStatus.COLOR_BY_CATEGORY.unknown;
  }

  /** Clé de tri de la colonne « État » : introuvables GROUPÉS à part (l'anomalie se regarde en bloc),
      puis ordre SÉMANTIQUE des catégories, puis libellé brut pour départager à l'intérieur d'une
      catégorie (deux statuts « En recette » et « À valider » de la même catégorie restent voisins et
      dans un ordre stable). Le rang est écrit sur un chiffre : les 4 catégories tiennent largement,
      et une comparaison de chaînes suffit — pas de comparateur composite à maintenir. */
  static sortKey(issue: IssueStatusIssue | null | undefined): string {
    const rank = IssueStatus.CATEGORIES.indexOf(IssueStatus.categoryOf(issue));
    return (IssueStatus.isNotFound(issue) ? "1_" : "0_") + rank + "_" + IssueStatus.raw(issue);
  }

  /** Libellé localisé de la CATÉGORIE (« Ouvert », « En cours », « Clos », « Inconnu »).
      ⚠ Seule la catégorie est traduisible ; le libellé `status`, lui, s'affiche TEL QUEL (D3).
      Tolère une valeur non normalisée : elle est ramenée à `unknown` avant résolution, donc la clé
      i18n demandée existe TOUJOURS. */
  static categoryLabel(category: string | null | undefined): string {
    const known = IssueStatus.CATEGORIES.includes(String(category || "")) ? String(category) : IssueStatus.UNKNOWN;
    return I18n.t("domain.issueStatusCategory." + known);
  }

  /** Libellé localisé de l'état « introuvable » — PAS « orphelin » (cf. en-tête). Verrouillé par
      test contre le catalogue de recherche partagé `SEARCH_CATALOGS.issueNotFound`, pour que le mot
      AFFICHÉ et le mot CHERCHABLE ne puissent pas diverger en silence. */
  static notFoundLabel(): string {
    return I18n.t("lists.ph.notFound");
  }

  /* --------------------------------------------------------------------------
     PASTILLES (HTML SÛR — cf. l'en-tête § ÉCHAPPEMENT)
     -------------------------------------------------------------------------- */

  /** Pastille « introuvable » SEULE, suivie d'une ESPACE séparatrice — "" si le ticket est résolu.
      `title` est l'infobulle facultative : la FICHE en pose une (elle a la place d'EXPLIQUER que
      l'enregistrement local reste intact et reviendra si l'accès est rétabli), le LISTING non
      (colonne étroite, pastille répétée à chaque ligne). Même partage des rôles que
      `VmStatus.orphanPill` et `WifiStatus.disconnectedPill`. */
  static notFoundPill(issue: IssueStatusIssue | null | undefined, title?: string): string {
    if (!IssueStatus.isNotFound(issue)) return "";
    const titleAttr = title ? ` title="${Html.escape(title)}"` : "";
    return `<span class="pill" style="border-color:${IssueStatus.COLOR_NOT_FOUND};color:${IssueStatus.COLOR_NOT_FOUND}"${titleAttr}>${Html.escape(IssueStatus.notFoundLabel())}</span> `;
  }

  /** Pastille du STATUT seule — libellé BRUT du tracker, ÉCHAPPÉ et jamais traduit (D3), coloré par
      sa CATÉGORIE (la seule chose qui puisse porter une sémantique commune à tous les providers).
      ⚠ La couleur vient de la CATÉGORIE et non de `color()` : l'orphelinat a déjà SA pastille, qui
      s'affiche À CÔTÉ — les deux sont rendues, jamais l'une À LA PLACE de l'autre (savoir qu'un
      ticket introuvable était « En cours » est précisément ce qui aide à décider quoi en faire).
      Statut vide (toléré par le pivot) → on retombe sur le LIBELLÉ DE CATÉGORIE, qui est, lui,
      traduisible : montrer « Ouvert » vaut mieux qu'une pastille vide, et cela ne contredit pas D3
      (on n'a PAS traduit un libellé du tracker, on affiche la classification normalisée). */
  static statusPill(issue: IssueStatusIssue | null | undefined): string {
    const category = IssueStatus.categoryOf(issue);
    const color = IssueStatus.COLOR_BY_CATEGORY[category] || IssueStatus.COLOR_BY_CATEGORY.unknown;
    const text = IssueStatus.raw(issue) || IssueStatus.categoryLabel(category);
    if (!text) return IssueStatus.MUTED;   // ceinture : `categoryLabel` rend toujours quelque chose
    return `<span class="pill" style="border-color:${color};color:${color}">${Html.escape(text)}</span>`;
  }

  /** Rendu COMPLET de la colonne « Statut » : introuvable EN TÊTE puis statut du tracker. */
  static pills(issue: IssueStatusIssue | null | undefined, notFoundTitle?: string): string {
    return IssueStatus.notFoundPill(issue, notFoundTitle) + IssueStatus.statusPill(issue);
  }
}

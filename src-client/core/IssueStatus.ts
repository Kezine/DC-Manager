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

   ── PÉRIMÈTRE (lot L1 : socle de données, aucune UI) ──────────────────────────
   Ce module rend des DONNÉES (catégorie, couleur, clé de tri) et des LIBELLÉS
   localisés — jamais du HTML. Les PASTILLES (`innerHTML`, patron
   `VmStatus.pills`/`WifiStatus.pills`) viendront avec le listing et la fiche, DANS
   CE FICHIER : il reste la source unique, on n'ouvrira pas un second endroit.
   Quand elles arriveront, la règle d'échappement des deux aînés s'appliquera : les
   couleurs sont un ensemble FERMÉ de constantes internes, aucune donnée du tracker
   n'entre jamais dans un attribut `style`, et le libellé brut passe par `Html.escape`.

   FEATURE TICKETS AMOVIBLE : supprimer l'inventaire des tickets = supprimer ce
   fichier avec le modèle `Issue` et les blocs `issues` des vues.
   ============================================================================= */
import { I18n } from "../i18n/I18n";
import { ISSUE_STATUS_CATEGORIES } from "../../src-shared/IssueSync";

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
      partagée — l'ordre de déclaration EST l'ordre de traitement, il n'y a pas de seconde table. */
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

  /** Statut BRUT (rogné), "" si absent — sert à l'affichage ET au départage du tri.
      ROGNÉ comme chez `VmStatus` : un libellé entouré d'espaces trierait à part sans raison. */
  static raw(issue: IssueStatusIssue | null | undefined): string {
    return issue && typeof issue.status === "string" ? issue.status.trim() : "";
  }

  /** Catégorie NORMALISÉE (toujours l'une des 4 valeurs fermées). Une valeur absente ou inconnue
      devient `unknown` : le module ne fait jamais confiance à ce qui vient d'un tiers, même si la
      normalisation partagée (`IssueSync.normalizeCategory`) a déjà clampé ce que la synchro écrit —
      la fiche peut aussi lire un enregistrement importé, écrit par une autre porte. */
  static categoryOf(issue: IssueStatusIssue | null | undefined): string {
    const category = issue && typeof issue.status_category === "string" ? issue.status_category.trim() : "";
    return IssueStatus.CATEGORIES.includes(category) ? category : IssueStatus.UNKNOWN;
  }

  /** Le ticket est-il INTROUVABLE côté tracker (non résolu à la dernière passe) ? */
  static isNotFound(issue: IssueStatusIssue | null | undefined): boolean {
    return !!(issue && issue.orphan);
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
}

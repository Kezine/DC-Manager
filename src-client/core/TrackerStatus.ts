/* =============================================================================
   TrackerStatus — ÉTAT d'un ticket chez un tracker distant (statut source +
   catégorie + « introuvable ») : classification, couleurs, clé de tri, libellés
   et PASTILLES. Classe PURE : aucun DOM, aucun store, aucun réseau.

   POURQUOI CE MODULE (principes n°2/n°3) : la même règle est lue par le LISTING
   des interventions (colonne du ticket) et par le bloc « Ticket » de leur fiche.
   C'est exactement la duplication que `core/VmStatus` a eu à résorber APRÈS
   coup, en trois exemplaires, et que `core/WifiStatus` a évitée d'emblée ; on ne
   la recrée pas.

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

   ── « INTROUVABLE » : LA SEULE EXCEPTION À « ON NE TRADUIT PAS LE STATUT » ─────
   Quand le retour d'état ne résout plus un ticket (supprimé, projet archivé,
   permission perdue), le PONT SERVEUR écrit un statut SENTINELLE et retombe sur
   la catégorie `unknown`. Ce n'est ni « orphelin » (VM détruite) ni « déconnecté »
   (événement quotidien du wifi) : c'est un FAIT constaté par DC Manager, pas un
   libellé de workflow — d'où deux traitements à part, et parfaitement compatibles
   avec D3 :
   - il est TRADUIT (`lists.ph.notFound`), là où un statut de workflow ne l'est
     jamais : traduire notre propre constat n'est pas traduire le tracker, et un
     utilisateur anglophone n'a aucune raison de lire « introuvable » ;
   - il est coloré en AVERTISSEMENT et non en neutre : quelque chose est à
     regarder (droits ? projet archivé ?), même si l'intervention locale, elle,
     reste intacte et reviendra toute seule si l'accès est rétabli.
   ⚠ `NOT_FOUND_STATUS` est un MIROIR de `TrackerSyncService.NOT_FOUND_STATUS`
   (serveur). Duplication ASSUMÉE et signalée des deux côtés (principe n°3) : le
   client ne peut pas importer de code serveur, et faire remonter une sentinelle
   d'affichage dans `src-shared/` pour une chaîne coûterait plus qu'elle ne
   rapporte. Elle est VERROUILLÉE par test (les deux constantes sont comparées) —
   une divergence silencieuse afficherait la sentinelle brute au lieu du libellé.

   ── PÉRIMÈTRE ────────────────────────────────────────────────────────────────
   Ce module rend des DONNÉES (catégorie, couleur, clé de tri), des LIBELLÉS
   localisés et la PASTILLE de statut (patron `VmStatus.pills`/`WifiStatus.pills`).
   La pastille vit ICI et nulle part ailleurs : c'est la source unique, on n'ouvre
   pas un second endroit. L'état de RÉPLICATION d'une intervention (répliquée ou
   non, état de poussée, choix du lien) vit, lui, dans `core/TrackerReplication` :
   ce module-ci ne connaît que le TICKET.

   ÉCHAPPEMENT : la pastille est posée en `innerHTML`. Tout ce qui sort d'ici est
   du HTML SÛR — les couleurs sont un ensemble FERMÉ de constantes internes
   (aucune donnée du tracker n'entre jamais dans un attribut `style`) et le libellé
   BRUT du statut, lui, passe systématiquement par `Html.escape`.
   ============================================================================= */
import { Html } from "./Html";
import { I18n } from "../i18n/I18n";

/** CATÉGORIES d'état d'un ticket — énumération FERMÉE, commune à tous les trackers. C'est
    l'adaptateur serveur qui produit la valeur : Jira l'expose nativement (`statusCategory`), une
    marque qui n'en aurait pas la déduit chez elle (GitHub : `closed` → `done`). `unknown` n'est pas
    un bouche-trou honteux mais la valeur qui rend la TOLÉRANCE possible : un état que l'adaptateur
    ne sait pas classer est ACCEPTÉ et rangé ici, plutôt que de faire échouer la passe entière.

    ⚠ MIROIR de `TRACKER_STATUS_CATEGORIES` (serveur, `tracker/TrackerProvider.ts`) : la catégorie est
    persistée dans `interventions.db`, une base SERVEUR hors du schéma partagé — il n'y a donc aucun
    canal `src-shared/` par où la faire transiter. Les deux listes sont comparées par test, ORDRE
    compris (c'est lui qui porte le tri sémantique). */
export const TRACKER_STATUS_CATEGORIES = ["todo", "in_progress", "done", "unknown"] as const;

/** Catégorie d'état (type littéral dérivé de la liste fermée). */
export type TrackerStatusCategory = (typeof TRACKER_STATUS_CATEGORIES)[number];

/** Vue MINIMALE d'un ticket — le module ne dépend NI du modèle des interventions, NI du store.
    Forme TOLÉRANTE (champs optionnels) : l'état vient d'une synchro tierce. */
export interface TrackerStatusTicket {
  /** Libellé BRUT du statut côté tracker (affiché tel quel, jamais traduit — sauf la sentinelle). */
  status?: string | null;
  /** Catégorie normalisée — hors de l'ensemble fermé, elle est lue comme `unknown`. */
  status_category?: string | null;
}

export class TrackerStatus {
  /** La catégorie de repli quand rien n'est exploitable — membre à part entière de l'ensemble fermé
      (cf. `TRACKER_STATUS_CATEGORIES`), pas un bouche-trou : c'est elle qui rend la tolérance possible. */
  static readonly UNKNOWN = "unknown";

  /** Ordre SÉMANTIQUE des catégories, et donc l'ordre de tri des listings : ce qui reste à faire
      d'abord, ce qui est terminé ensuite, l'inclassable en dernier. Repris tel quel de la liste
      ci-dessus — l'ordre de déclaration EST l'ordre de traitement, il n'y a pas de seconde table. */
  static readonly CATEGORIES: readonly string[] = TRACKER_STATUS_CATEGORIES;

  /** 🚨 SENTINELLE de statut écrite par le pont quand le ticket n'est plus résolu — MIROIR de
      `TrackerSyncService.NOT_FOUND_STATUS` (cf. l'en-tête), verrouillé par test. */
  static readonly NOT_FOUND_STATUS = "introuvable";

  /** Couleur d'un ticket INTROUVABLE : AVERTISSEMENT et non ERREUR. Un ticket qu'on ne résout plus
      demande un coup d'œil (droits ? projet archivé ?), il ne signale pas une panne de l'app — et
      surtout l'intervention locale, elle, est intacte. Même arbitrage que le « déconnecté » du wifi,
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
  static raw(ticket: TrackerStatusTicket | null | undefined): string {
    return ticket && typeof ticket.status === "string" ? ticket.status.trim() : "";
  }

  /** Catégorie NORMALISÉE (toujours l'une des 4 valeurs fermées). Une valeur absente ou inconnue
      devient `unknown` : le module ne fait jamais confiance à ce qui vient d'un tiers, même si la
      synchro serveur clampe déjà ce qu'elle écrit — l'affichage peut aussi lire une valeur arrivée
      par une autre porte (base éditée à la main, version antérieure). */
  static categoryOf(ticket: TrackerStatusTicket | null | undefined): string {
    const category = ticket && typeof ticket.status_category === "string" ? ticket.status_category.trim() : "";
    return TrackerStatus.CATEGORIES.includes(category) ? category : TrackerStatus.UNKNOWN;
  }

  /** Le ticket est-il INTROUVABLE côté tracker (non résolu à la dernière passe) ? Reconnu à la
      SENTINELLE posée par le pont — le seul signal disponible : `interventions.db` ne porte pas de
      drapeau dédié, et la catégorie `unknown` seule ne suffirait pas (un statut de workflow que
      l'adaptateur n'a pas su classer y retombe aussi, alors que ce ticket-là est bien résolu). */
  static isNotFound(ticket: TrackerStatusTicket | null | undefined): boolean {
    return TrackerStatus.raw(ticket) === TrackerStatus.NOT_FOUND_STATUS;
  }

  /** Couleur de l'état — l'INTROUVABLE PRIME sur la catégorie (patron `VmStatus.swatchColor`) :
      c'est l'information dominante, et sa catégorie `unknown` la peindrait sinon en neutre, c'est-
      à-dire exactement comme un statut inclassable ordinaire. */
  static color(ticket: TrackerStatusTicket | null | undefined): string {
    if (TrackerStatus.isNotFound(ticket)) return TrackerStatus.COLOR_NOT_FOUND;
    return TrackerStatus.COLOR_BY_CATEGORY[TrackerStatus.categoryOf(ticket)] || TrackerStatus.COLOR_BY_CATEGORY.unknown;
  }

  /** Clé de tri d'une colonne d'état : introuvables GROUPÉS à part (l'anomalie se regarde en bloc),
      puis ordre SÉMANTIQUE des catégories, puis libellé brut pour départager à l'intérieur d'une
      catégorie (deux statuts « En recette » et « À valider » de la même catégorie restent voisins et
      dans un ordre stable). Le rang est écrit sur un chiffre : les 4 catégories tiennent largement,
      et une comparaison de chaînes suffit — pas de comparateur composite à maintenir. */
  static sortKey(ticket: TrackerStatusTicket | null | undefined): string {
    const rank = TrackerStatus.CATEGORIES.indexOf(TrackerStatus.categoryOf(ticket));
    return (TrackerStatus.isNotFound(ticket) ? "1_" : "0_") + rank + "_" + TrackerStatus.raw(ticket);
  }

  /** Libellé localisé de la CATÉGORIE (« Ouvert », « En cours », « Clos », « Inconnu »).
      ⚠ Seule la catégorie est traduisible ; le libellé `status`, lui, s'affiche TEL QUEL (D3).
      Tolère une valeur non normalisée : elle est ramenée à `unknown` avant résolution, donc la clé
      i18n demandée existe TOUJOURS. */
  static categoryLabel(category: string | null | undefined): string {
    const known = TrackerStatus.CATEGORIES.includes(String(category || "")) ? String(category) : TrackerStatus.UNKNOWN;
    return I18n.t("domain.trackerStatusCategory." + known);
  }

  /** Libellé localisé de l'état « introuvable » — PAS « orphelin », PAS « déconnecté » (cf. en-tête).
      C'est LUI qui s'affiche à la place de la sentinelle brute du pont. */
  static notFoundLabel(): string {
    return I18n.t("lists.ph.notFound");
  }

  /* --------------------------------------------------------------------------
     PASTILLE (HTML SÛR — cf. l'en-tête § ÉCHAPPEMENT)
     -------------------------------------------------------------------------- */

  /** Pastille du STATUT : libellé BRUT du tracker, ÉCHAPPÉ et jamais traduit (D3), coloré par sa
      CATÉGORIE (la seule chose qui puisse porter une sémantique commune à tous les providers).
      DEUX replis, dans cet ordre :
      - ticket INTROUVABLE → libellé LOCALISÉ « introuvable » en couleur d'avertissement (la
        sentinelle est notre constat, pas un libellé de workflow — cf. l'en-tête) ;
      - statut vide (jamais synchronisé) → LIBELLÉ DE CATÉGORIE, qui est, lui, traduisible : montrer
        « Ouvert » vaut mieux qu'une pastille vide, et cela ne contredit pas D3 (on n'a PAS traduit un
        libellé du tracker, on affiche la classification normalisée).
      `title` est l'infobulle facultative : la FICHE en pose une (elle a la place d'EXPLIQUER que
      l'intervention locale reste intacte et que le ticket reviendra si l'accès est rétabli), le
      LISTING non (colonne étroite, pastille répétée à chaque ligne). */
  static statusPill(ticket: TrackerStatusTicket | null | undefined, title?: string): string {
    const notFound = TrackerStatus.isNotFound(ticket);
    const color = notFound ? TrackerStatus.COLOR_NOT_FOUND
      : (TrackerStatus.COLOR_BY_CATEGORY[TrackerStatus.categoryOf(ticket)] || TrackerStatus.COLOR_BY_CATEGORY.unknown);
    const text = notFound ? TrackerStatus.notFoundLabel()
      : (TrackerStatus.raw(ticket) || TrackerStatus.categoryLabel(TrackerStatus.categoryOf(ticket)));
    if (!text) return TrackerStatus.MUTED;   // ceinture : `categoryLabel` rend toujours quelque chose
    const titleAttr = title ? ` title="${Html.escape(title)}"` : "";
    return `<span class="pill" style="border-color:${color};color:${color}"${titleAttr}>${Html.escape(text)}</span>`;
  }
}

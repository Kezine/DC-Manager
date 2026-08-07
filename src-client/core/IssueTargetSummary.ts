/* =============================================================================
   IssueTargetSummary — « QUELS TICKETS parlent de CET objet ? », en logique PURE.

   Alimente la rangée « Tickets » des fiches détail (équipement / VM / spare /
   sous-équipement) : le nombre de tickets OUVERTS et les N derniers, à partir d'un
   simple TABLEAU d'enregistrements. Aucune dépendance au DOM, au Store ni au
   réseau — d'où sa présence dans `core/` et ses tests en isolation (principe n°2).

   ── 🚨 CE QUI DIFFÈRE RADICALEMENT DES INTERVENTIONS, ET POURQUOI C'EST UN GAIN ──
   La rangée « Interventions » des fiches interroge le SERVEUR (`/counts`,
   `latestFor`) : les interventions vivent dans une base SÉPARÉE (`interventions.db`)
   que le client ne possède pas. D'où, là-bas, deux chargements ASYNCHRONES, un état
   d'échec réseau à absorber, et une rangée qui n'existe PAS en mode fichier.

   Ici, `issues` est une COLLECTION DU DOCUMENT : le client la porte déjà, en entier.
   Le comptage et les « N derniers » sont donc un simple FILTRE EN MÉMOIRE — d'où :
   - AUCUNE route de comptage à écrire côté serveur ;
   - AUCUN chargement asynchrone, donc aucun clignotement ni état d'échec ;
   - et surtout la rangée FONCTIONNE EN MODE FICHIER (principe n°15), contrairement à
     celle des interventions. Seule l'action « Ouvrir un ticket » reste conditionnée
     au mode API, parce qu'elle, elle parle au tracker.
   C'est un bénéfice DIRECT de la décision A1 du cadrage (les tickets sont une
   collection du document, pas une base à part) : il méritait d'être écrit noir sur
   blanc plutôt que constaté par hasard.

   RÈGLE D'« OUVERT » : elle n'est PAS ici — c'est `IssueStatus.isOpen` (source unique
   de l'état d'un ticket, déjà consommée par le listing, la fiche et la palette).
   RÈGLE DE COMPOSITION DE CLÉ : elle n'est pas ici non plus — c'est le module PARTAGÉ
   `IssueTargets.key`, le même qu'utilisent la validation, la cascade, le filtre du
   listing et l'éditeur de liens. Ce module ne fait que SÉLECTIONNER et ORDONNER.
   ============================================================================= */
import { IssueStatus } from "./IssueStatus";
import { IssueTargets } from "../../src-shared/IssueTargets";

/** Vue MINIMALE d'un ticket telle que ce module la consomme. Forme TOLÉRANTE (tout est facultatif) :
    les enregistrements viennent d'une synchro tierce ou d'un document importé, et un champ manquant
    ne doit jamais faire échouer un badge de fiche. */
export interface IssueTargetRecord {
  id?: string;
  key?: string;
  summary?: string;
  status?: string | null;
  status_category?: string | null;
  orphan?: boolean;
  /** Dernière modification CÔTÉ TRACKER (ISO) — la récence qui compte pour un suivi de tickets. */
  updated_src?: string | null;
  /** Dernière modification de l'enregistrement LOCAL (ISO) — repli quand le tracker n'a rien daté. */
  updated_date?: string;
  /** Clés « famille:id » des objets visés (rattachement MANUEL). */
  targets?: unknown;
}

/** Ce que la rangée d'une fiche a besoin de savoir sur une cible, en UN passage sur la collection. */
export interface IssueTargetDigest {
  /** Tickets liés à la cible dont l'état n'est pas « clos » (cf. `IssueStatus.isOpen`) — le badge. */
  openCount: number;
  /** Tickets liés à la cible, TOUS états confondus. Décide de l'affichage du « Afficher plus » :
      une cible dont tous les tickets sont clos a bien quelque chose à montrer, même sans badge. */
  total: number;
  /** Les plus récemment modifiés, TOUS états confondus, bornés. Ce sont les enregistrements
      D'ORIGINE (jamais des copies) : l'appelant y lit ce qu'il affiche. */
  latest: IssueTargetRecord[];
}

export class IssueTargetSummary {
  /** Tickets liés à UNE cible. La clé est RECOMPOSÉE par le module partagé, jamais concaténée ici :
      c'est la même règle que la validation, la cascade et le filtre « Cible » du listing.
      Comparaison par ÉGALITÉ de chaîne dans le tableau `targets` (et non par préfixe) — un test de
      préfixe ferait matcher « equipment:E1 » sur « equipment:E10 », le piège classique de ce genre
      de clés composées, déjà couvert par le filtre du listing. */
  static of(issues: readonly IssueTargetRecord[] | null | undefined, kind: string, id: string): IssueTargetRecord[] {
    if (!Array.isArray(issues) || !IssueTargets.isKind(kind) || !id) return [];
    const key = IssueTargets.key(kind, id);
    return issues.filter((issue) => !!issue && Array.isArray(issue.targets) && (issue.targets as unknown[]).indexOf(key) >= 0);
  }

  /** Nombre de tickets OUVERTS d'un ensemble déjà filtré (règle d'ouverture : `IssueStatus.isOpen`). */
  static openCount(issues: readonly IssueTargetRecord[] | null | undefined): number {
    if (!Array.isArray(issues)) return 0;
    let count = 0;
    for (const issue of issues) if (IssueStatus.isOpen(issue)) count++;
    return count;
  }

  /** Les `limit` tickets les plus récemment modifiés, du plus récent au plus ancien.
      RÉCENCE = `updated_src` (le tracker) et, à défaut, `updated_date` (l'enregistrement local) :
      c'est l'activité CHEZ LE TRACKER qui intéresse ici, l'horodatage local ne bougeant que quand la
      synchro écrit. Départage par la CLÉ puis par l'id, pour que l'ordre soit total et STABLE — deux
      tickets non datés ne doivent pas changer de place d'un rendu à l'autre.
      Le tableau d'entrée n'est jamais muté (`slice` avant tri) : il vient du Store. */
  static latest(issues: readonly IssueTargetRecord[] | null | undefined, limit: number): IssueTargetRecord[] {
    if (!Array.isArray(issues) || limit <= 0) return [];
    return issues.slice().sort((a, b) => {
      const ra = IssueTargetSummary.recencyOf(a), rb = IssueTargetSummary.recencyOf(b);
      if (ra !== rb) return ra < rb ? 1 : -1;   // décroissant : le plus récent en tête
      const ka = (a && a.key) || "", kb = (b && b.key) || "";
      if (ka !== kb) return ka.localeCompare(kb);
      return ((a && a.id) || "").localeCompare((b && b.id) || "");
    }).slice(0, limit);
  }

  /** Tout ce dont la rangée a besoin, en UN appel : compte d'ouverts, total, et les `limit` derniers. */
  static digest(issues: readonly IssueTargetRecord[] | null | undefined, kind: string, id: string, limit: number): IssueTargetDigest {
    const linked = IssueTargetSummary.of(issues, kind, id);
    return { openCount: IssueTargetSummary.openCount(linked), total: linked.length, latest: IssueTargetSummary.latest(linked, limit) };
  }

  /** Horodatage de RÉCENCE d'un ticket, "" si aucun (les non datés trient donc en dernier, ce qui est
      la bonne réponse : on ne peut rien affirmer de leur actualité). Les ISO se comparent
      lexicographiquement comme chronologiquement — contrat déjà retenu par les colonnes de date des
      listings, donc aucune conversion en `Date` à faire ici. */
  private static recencyOf(issue: IssueTargetRecord | null | undefined): string {
    if (!issue) return "";
    if (typeof issue.updated_src === "string" && issue.updated_src !== "") return issue.updated_src;
    return typeof issue.updated_date === "string" ? issue.updated_date : "";
  }
}

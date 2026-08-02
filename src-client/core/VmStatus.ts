/* =============================================================================
   VmStatus — ÉTAT d'une VM (statut source + orphelinat) : classification,
   couleurs, clé de tri, termes de recherche et PASTILLES.
   Classe PURE : aucun DOM, aucun store, aucun réseau.

   POURQUOI CE MODULE (principes n°2/n°3). La même règle — « l'orphelinat PRIME
   sur le statut ; running est vert, stopped neutre, tout le reste est affiché
   tel quel » — vivait RÉÉCRITE dans TROIS fichiers :
     • `ListConfigs.vms`      → pastilles du listing + clé de tri + terme de recherche ;
     • `DetailForms.vmDetail` → pastilles de la fiche (mêmes pastilles, plus un `title`) ;
     • `core/VmHostTip`       → pastille de COULEUR de la bulle d'équipement.
   Les deux premiers produisaient un HTML rigoureusement IDENTIQUE — `dim("—")`
   de `ListConfigs` et `DetailForms.MUTED` sont la même chaîne, au caractère près —
   ce qui est la définition d'une duplication : deux copies qui ne divergent
   qu'accidentellement, et qui divergeront au premier correctif appliqué d'un seul côté.

   VOCABULAIRE : le statut est affiché TEL QUEL, jamais traduit (« running »,
   « stopped », ou toute valeur inconnue d'une release Proxmox future). Seul
   l'ORPHELINAT est un concept de l'app, donc localisé (`lists.ph.orphan`).

   ÉCHAPPEMENT : `status` est une donnée SOURCE remontée d'un cluster tiers
   (cf. docs/vm-proxmox.md) et les pastilles sont posées en `innerHTML`. Tout ce
   qui sort d'ici est du HTML SÛR. Les couleurs sont un ensemble FERMÉ de
   constantes internes : AUCUNE donnée du provider n'entre dans un attribut
   `style`, ce qui rend l'injection impossible par cette voie.

   ⚠ UNE convergence assumée au regroupement : le statut est désormais ROGNÉ
   (trim) aux TROIS endroits. `VmHostTip` le faisait déjà ; le listing et la fiche
   comparaient la chaîne BRUTE, si bien qu'un « running » entouré d'espaces y
   serait tombé dans la branche « valeur inconnue » (pastille neutre) alors que la
   bulle l'aurait montré vert. Aucun provider n'émet de statut espacé — la sortie
   est donc inchangée sur toute donnée réelle — mais l'incohérence n'avait aucune
   raison de survivre au regroupement.

   FEATURE VM AMOVIBLE : supprimer l'inventaire VM = supprimer ce fichier avec
   `VmHostTip` et les blocs VM de `ListConfigs`/`DetailForms` (cf. docs/vm-proxmox.md,
   §Suppression).
   ============================================================================= */
import { Html } from "./Html";
import { I18n } from "../i18n/I18n";

/** Classification FERMÉE d'un statut source. `none` = aucun statut remonté (≠ « inconnu »,
    qui est un statut bien présent mais hors des deux valeurs que l'app sait colorer). */
export type VmStatusKind = "running" | "stopped" | "other" | "none";

/** Vue MINIMALE d'une VM — le module ne dépend NI du modèle `Vm`, NI du store.
    Forme TOLÉRANTE (champs optionnels) : les enregistrements arrivent d'une synchro tierce. */
export interface VmStatusVm {
  /** Statut BRUT du provider (« running » | « stopped » | valeur inconnue). */
  status?: string | null;
  /** VM disparue du dernier inventaire (jamais supprimée automatiquement). */
  orphan?: boolean;
}

export class VmStatus {
  /* Les deux SEULS statuts que l'app reconnaît. Tout le reste traverse tel quel — c'est
     délibéré : une release Proxmox peut introduire un statut que ce code ne connaît pas,
     et le montrer vaut mieux que le masquer. */
  static readonly RUNNING = "running";
  static readonly STOPPED = "stopped";

  /* Couleurs — variables SÉMANTIQUES du thème, jamais de valeur littérale. */
  static readonly COLOR_ORPHAN = "var(--err)";
  static readonly COLOR_RUNNING = "var(--ok)";
  /** Neutre : sert de bordure à « stopped », et de pastille de bulle à TOUT ce qui n'est pas running. */
  static readonly COLOR_OTHER = "var(--fg-dimmer)";
  /** Texte de la pastille « stopped » : un cran plus lisible que sa bordure (contraste voulu). */
  private static readonly COLOR_STOPPED_TEXT = "var(--fg-dim)";
  /** Rendu du « pas de valeur » — MÊME chaîne que le `dim("—")` des listings et que `DetailForms.MUTED`. */
  private static readonly MUTED = `<span style="color:var(--fg-dimmer)">—</span>`;

  /** Statut BRUT (rogné), "" si absent — sert à la classification, au tri et à l'affichage. */
  static raw(vm: VmStatusVm | null | undefined): string {
    return vm && typeof vm.status === "string" ? vm.status.trim() : "";
  }

  /** VM disparue du dernier inventaire. */
  static isOrphan(vm: VmStatusVm | null | undefined): boolean {
    return !!(vm && vm.orphan);
  }

  /** Classification du statut source — l'orphelinat n'entre PAS ici : c'est une dimension INDÉPENDANTE
      (une VM orpheline conserve le statut qu'elle avait au dernier inventaire, information utile pour
      décider de la purger). Les deux se composent au rendu, jamais dans la classification. */
  static kindOf(vm: VmStatusVm | null | undefined): VmStatusKind {
    const status = VmStatus.raw(vm);
    if (status === VmStatus.RUNNING) return "running";
    if (status === VmStatus.STOPPED) return "stopped";
    return status ? "other" : "none";
  }

  /** Couleur de PASTILLE RONDE (bulle de survol d'un équipement). L'ORPHELINAT PRIME : c'est
      l'information dominante — la VM n'existe plus au cluster. Trois couleurs seulement : la bulle
      n'a pas la place d'un dégradé de nuances, contrairement aux pastilles de listing. */
  static swatchColor(vm: VmStatusVm | null | undefined): string {
    if (VmStatus.isOrphan(vm)) return VmStatus.COLOR_ORPHAN;
    return VmStatus.kindOf(vm) === "running" ? VmStatus.COLOR_RUNNING : VmStatus.COLOR_OTHER;
  }

  /** Clé de tri de la colonne « Statut » : les orphelines GROUPÉES à part (l'orphelinat est
      l'info dominante de la colonne), puis l'ordre alphabétique des statuts. */
  static sortKey(vm: VmStatusVm | null | undefined): string {
    return (VmStatus.isOrphan(vm) ? "1_" : "0_") + VmStatus.raw(vm);
  }

  // ⚠ `searchTerms` (statut brut + mot « orpheline » localisé) a été RETIRÉ au lot 4 : plus aucun
  // consommateur depuis que les listings ont perdu leurs `searchFields` (lot 3) et boivent à la spec
  // PARTAGÉE `src-shared/SearchTerms` (catalogue `vmOrphan` fr+en — « orphan » reste cherchable dans les
  // deux langues, en mode fichier comme serveur, cf. docs/recherche.md et l'invariant n°15 testé).
  // L'AFFICHAGE des statuts VM (pastilles ci-dessous) n'a PAS bougé.

  /** Pastille de STATUT seule — HTML SÛR. Reprend le style de `kindPill` (classe `.pill` + variables
      sémantiques du thème). Sans statut : le tiret discret, pas une pastille vide. */
  static statusPill(vm: VmStatusVm | null | undefined): string {
    switch (VmStatus.kindOf(vm)) {
      case "running": return `<span class="pill" style="border-color:${VmStatus.COLOR_RUNNING};color:${VmStatus.COLOR_RUNNING}">${VmStatus.RUNNING}</span>`;
      case "stopped": return `<span class="pill" style="border-color:${VmStatus.COLOR_OTHER};color:${VmStatus.COLOR_STOPPED_TEXT}">${VmStatus.STOPPED}</span>`;
      case "other":   return `<span class="pill">${Html.escape(VmStatus.raw(vm))}</span>`;
      default:        return VmStatus.MUTED;
    }
  }

  /** Pastille « orpheline » seule, suivie d'une ESPACE séparatrice — "" si la VM n'est pas orpheline.
      `title` est l'infobulle facultative (la FICHE en pose une, le LISTING non : la colonne est déjà
      étroite et la pastille y est répétée à chaque ligne). */
  static orphanPill(vm: VmStatusVm | null | undefined, title?: string): string {
    if (!VmStatus.isOrphan(vm)) return "";
    const titleAttr = title ? ` title="${Html.escape(title)}"` : "";
    return `<span class="pill" style="border-color:${VmStatus.COLOR_ORPHAN};color:${VmStatus.COLOR_ORPHAN}"${titleAttr}>${Html.escape(I18n.t("lists.ph.orphan"))}</span> `;
  }

  /** Rendu COMPLET de la colonne/ligne « Statut » : orphelinat EN TÊTE puis statut — HTML SÛR.
      Les deux sont rendus, jamais l'un À LA PLACE de l'autre : savoir qu'une orpheline était
      « running » à sa disparition est ce qui permet de décider de la purger. */
  static pills(vm: VmStatusVm | null | undefined, orphanTitle?: string): string {
    return VmStatus.orphanPill(vm, orphanTitle) + VmStatus.statusPill(vm);
  }
}

import { CertsFormat, type CertLifecycle } from "./CertsFormat";

/* =============================================================================
   CertTree — logique PURE du listing HIÉRARCHIQUE des certificats (aucun DOM,
   aucun réseau, aucun store) → testable headless (Tests/modules/test-certs.js).

   Lot 0 (cadrage `.notes/toDos/certs-ca-intermediaires-cadrage-2026-07-23.md`) :
   la vue « Certificats » passe de DEUX listings paginés serveur (racines / sous-arbre)
   à UN SEUL arbre déployable, chargé en une fois côté client (métadonnées SEULES —
   jamais `key_enc`, invariant Q5). Tout le filtre/tri/aplatissement se fait donc ICI,
   en mémoire, à partir de la liste plate des `CertificateListItem` reliés par `parent_id`.

   Décisions Lot 0 portées par ce module :
   - Filtre TYPE = par FAMILLE de racine (le `kind` de la RACINE de l'arbre : root-ca /
     ssh-ca / ssh-keypair) — il sélectionne QUELS arbres s'affichent, pas un niveau.
   - Filtre ÉTAT (CertsFormat.lifecycle) + RECHERCHE : filtrent des LIGNES en gardant les
     ANCÊTRES pour le contexte (un parent non-matchant reste visible si un descendant matche).
   - TRI intra-fratrie (préserve la hiérarchie) sur libellé ou échéance.
   La VUE (CertsAdminView) ne fait qu'assembler le DOM à partir de l'ordre/profondeur produits ici.
   ============================================================================= */

/** Forme MINIMALE dont l'arbre a besoin — sous-ensemble structurel de `CertificateListItem`
    (CertsClient). On ne dépend pas du DTO complet : le module reste pur et testable, et le générique
    `T` rend l'item d'origine (avec ses champs de rendu : has_key, sans, etc.) à la vue. */
export interface CertTreeItem {
  id: string;
  /** Famille brute (root-ca / intermediate-ca / leaf-tls / ssh-ca / ssh-keypair / ssh-cert). */
  kind: string;
  /** Émetteur (CA) pour un dérivé ; null pour une racine/objet autonome. */
  parent_id: string | null;
  label: string;
  subject: string;
  serial: string | null;
  not_after: string | null;
  revoked_at: string | null;
}

/** Nœud de l'arbre : l'item d'origine + ses liens (parent/enfants), sa PROFONDEUR (0 = racine) et le
    `kind` de la RACINE de son arbre (pour le filtre FAMILLE, testé sur la racine sans la remonter à chaque fois). */
export interface CertTreeNode<T extends CertTreeItem = CertTreeItem> {
  item: T;
  parent: CertTreeNode<T> | null;
  children: CertTreeNode<T>[];
  depth: number;
  rootKind: string;
}

/** Critères de filtrage (tous optionnels ; vide = pas de filtre sur cette dimension). */
export interface CertTreeFilter {
  /** Famille de racine (kind de la racine) : root-ca | ssh-ca | ssh-keypair. */
  family?: string;
  /** État (cycle de vie CertsFormat.lifecycle). */
  state?: CertLifecycle | "";
  /** Recherche libre (libellé + sujet + série + libellé de l'émetteur), insensible à la casse. */
  query?: string;
  /** Horloge injectable (tests). */
  now?: number;
}

export class CertTree {
  /** Construit la FORÊT (liste des racines) à partir de la liste plate reliée par `parent_id`. Un nœud dont
      l'émetteur est ABSENT du jeu (orphelin toléré : renouvellement dont l'original a été supprimé, ou sous-arbre
      partiel) devient une RACINE de son propre arbre — on ne PERD jamais un nœud. Anti-cycle : la descente est
      bornée par un jeu d'ids visités, et tout nœud jamais atteint (pris dans un cycle) est détaché en racine. */
  static build<T extends CertTreeItem>(items: readonly T[]): CertTreeNode<T>[] {
    const byId = new Map<string, CertTreeNode<T>>();
    for (const item of items) {
      if (item && typeof item.id === "string" && item.id !== "") {
        byId.set(item.id, { item, parent: null, children: [], depth: 0, rootKind: item.kind });
      }
    }
    const roots: CertTreeNode<T>[] = [];
    for (const node of byId.values()) {
      const pid = node.item.parent_id;
      const parent = pid && pid !== node.item.id ? byId.get(pid) : undefined;
      if (parent) { node.parent = parent; parent.children.push(node); }
      else roots.push(node);   // racine (parent_id nul) OU orphelin (émetteur absent) → racine de son arbre
    }
    const seen = new Set<string>();
    for (const root of roots) CertTree.assign(root, 0, root.item.kind, seen);
    // Rescousse anti-cycle : un nœud jamais visité est pris dans une boucle (chaque membre a un parent dans le
    // jeu) → on le détache de son parent et on en fait une racine, brisant le cycle sans perdre de données.
    for (const node of byId.values()) {
      if (seen.has(node.item.id)) continue;
      if (node.parent) { node.parent.children = node.parent.children.filter((c) => c !== node); node.parent = null; }
      roots.push(node);
      CertTree.assign(node, 0, node.item.kind, seen);
    }
    return roots;
  }

  /** Fixe profondeur + kind de racine par descente, bornée par `seen` (garde anti-cycle / anti-récursion infinie). */
  private static assign<T extends CertTreeItem>(node: CertTreeNode<T>, depth: number, rootKind: string, seen: Set<string>): void {
    if (seen.has(node.item.id)) { node.children = []; return; }
    seen.add(node.item.id);
    node.depth = depth;
    node.rootKind = rootKind;
    for (const child of node.children) CertTree.assign(child, depth + 1, rootKind, seen);
  }

  /** Tous les descendants d'un nœud (pré-ordre, hors le nœud lui-même) — sert au comptage « Dérivés » et,
      plus tard, à la sélection en cascade (Lot 2c). Borné par la structure déjà acyclique produite par `build`. */
  static descendants<T extends CertTreeItem>(node: CertTreeNode<T>): CertTreeNode<T>[] {
    const out: CertTreeNode<T>[] = [];
    const walk = (n: CertTreeNode<T>) => { for (const c of n.children) { out.push(c); walk(c); } };
    walk(node);
    return out;
  }

  /** Ensemble des ids de nœuds à AFFICHER sous les filtres, ou `null` si AUCUN filtre (tout est visible).
      Règles (Lot 0) :
      - FAMILLE : élague l'arbre ENTIER dont la racine n'est pas de la famille (aucun de ses nœuds n'est visible) ;
      - ÉTAT + RECHERCHE : un nœud est visible s'il matche LUI-MÊME, ou si un DESCENDANT matche (les ancêtres
        restent pour le contexte hiérarchique). La recherche porte aussi sur le libellé de l'ÉMETTEUR (parent). */
  static visibleIds<T extends CertTreeItem>(forest: readonly CertTreeNode<T>[], filter: CertTreeFilter): Set<string> | null {
    const family = filter.family || "";
    const state = filter.state || "";
    const query = (filter.query || "").trim().toLowerCase();
    if (!family && !state && !query) return null;   // aucun filtre → tout visible (flatten respecte l'état d'ouverture)
    const now = typeof filter.now === "number" ? filter.now : Date.now();
    const visible = new Set<string>();

    // Match PROPRE d'un nœud sur ÉTAT + RECHERCHE (la famille est traitée par élagage d'arbre en amont).
    const matchesSelf = (node: CertTreeNode<T>): boolean => {
      if (state && CertsFormat.lifecycle(node.item, now) !== state) return false;
      if (query) {
        const issuer = node.parent ? node.parent.item.label : "";
        const hay = (node.item.label + " " + node.item.subject + " " + (node.item.serial || "") + " " + issuer).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    };
    // Visible si LUI ou un descendant matche ; renvoie true si le sous-arbre (nœud inclus) contient un match.
    const walk = (node: CertTreeNode<T>): boolean => {
      let anyDescendant = false;
      for (const child of node.children) if (walk(child)) anyDescendant = true;
      if (matchesSelf(node) || anyDescendant) { visible.add(node.item.id); return true; }
      return false;
    };
    for (const root of forest) {
      if (family && root.item.kind !== family) continue;   // FAMILLE : arbre entier élagué
      walk(root);
    }
    return visible;
  }

  /** Trie les FRÈRES (récursivement) par `key` sans casser la hiérarchie. `not_after` : chronologique, les
      objets SANS échéance (paire/CA SSH) TOUJOURS en fin (indépendamment de `dir`, comme les tris NULL du serveur).
      `label` : ordre naturel insensible casse/accents. Mutation EN PLACE de la forêt (structure conservée). */
  static sortSiblings<T extends CertTreeItem>(forest: CertTreeNode<T>[], key: "label" | "not_after", dir: "asc" | "desc"): void {
    const mul = dir === "desc" ? -1 : 1;
    const byLabel = (a: CertTreeNode<T>, b: CertTreeNode<T>) =>
      a.item.label.localeCompare(b.item.label, undefined, { numeric: true, sensitivity: "base" }) * mul;
    const cmp = (a: CertTreeNode<T>, b: CertTreeNode<T>): number => {
      if (key !== "not_after") return byLabel(a, b);
      const ta = a.item.not_after ? Date.parse(a.item.not_after) : NaN;
      const tb = b.item.not_after ? Date.parse(b.item.not_after) : NaN;
      const na = Number.isFinite(ta), nb = Number.isFinite(tb);
      if (!na && !nb) return byLabel(a, b);   // deux sans échéance → départage stable par libellé
      if (!na) return 1;                       // sans échéance → toujours EN FIN
      if (!nb) return -1;
      return (ta - tb) * mul;
    };
    const rec = (nodes: CertTreeNode<T>[]) => { nodes.sort(cmp); for (const n of nodes) rec(n.children); };
    rec(forest);
  }

  /** APLATIT la forêt en lignes ordonnées prêtes à rendre (pré-ordre). Deux modes selon `visible` :
      - `visible === null` (pas de filtre) : on respecte l'état d'ouverture `open` (une racine est toujours
        rendue ; ses enfants seulement si elle est dépliée, récursivement) ;
      - `visible` fourni (filtrage actif) : seuls les nœuds visibles sont rendus, et le chemin est FORCÉ ouvert
        (on montre le contexte des matches sans avoir à déplier à la main).
      Les nœuds portent déjà `depth` (indentation) et `children` (présence d'un chevron). */
  static flatten<T extends CertTreeItem>(
    forest: readonly CertTreeNode<T>[],
    opts: { open: ReadonlySet<string>; visible: ReadonlySet<string> | null },
  ): CertTreeNode<T>[] {
    const out: CertTreeNode<T>[] = [];
    const filtering = opts.visible !== null;
    const walk = (nodes: readonly CertTreeNode<T>[]) => {
      for (const node of nodes) {
        if (opts.visible && !opts.visible.has(node.item.id)) continue;
        out.push(node);
        const expanded = filtering ? true : opts.open.has(node.item.id);
        if (node.children.length && expanded) walk(node.children);
      }
    };
    walk(forest);
    return out;
  }
}

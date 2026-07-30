/* =============================================================================
   GlobalSearch — logique PURE de la recherche GLOBALE (modale dédiée, Ctrl+K).

   POURQUOI un module dédié (principes n°2/n°7) : le SCORE, le REGROUPEMENT par
   famille, les COMPTES par famille, l'analyse des PRÉFIXES de portée (« eq: »,
   « cb: »…) et le SURLIGNAGE du fragment trouvé forment une logique testable
   headless, indépendante du Store (qui fournit le corpus — cf.
   `views/GlobalSearchSources`) et de la modale (qui rend les résultats). La
   NORMALISATION est INJECTÉE : l'appelant passe `Schema.normSearch`
   (insensibilité casse/accents, partagée front ⇄ serveur).

   SÉMANTIQUE (celle de la maquette validée par l'utilisateur, POC 2026-07-30) :
   - SCORE à paliers : libellé EXACT (100) > libellé PRÉFIXE (80) > libellé
     CONTIENT (60) > seul le RESTE contient (30 — sous-ligne, chemin, termes
     annexes : n° de série, IP, description… l'objet matche sans que son titre
     le montre) ;
   - GROUPES par famille, JAMAIS entrelacés, ordonnés par leur MEILLEUR score
     (la famille la plus pertinente d'abord), à égalité par l'ordre canonique
     injecté ; dans un groupe : score décroissant puis alphabétique du libellé ;
   - PAS de plafond : la modale a sa propre zone défilante, les COMPTES par
     famille (pastilles de portée) disent l'ampleur — rien n'est tronqué.

   PARENTÉ : même position architecturale que `TargetSearch` (cibles
   d'intervention), qu'il ne réutilise pas — TargetSearch ne matche que le
   libellé et n'a ni paliers ni groupes ; le tordre lui ferait porter deux
   contrats.
   ============================================================================= */

/** Un élément du corpus : famille (= collection), identifiant, libellé, et son HABILLAGE de résultat. */
export interface GlobalSearchItem {
  kind: string;
  id: string;
  /** Titre du résultat — c'est LUI que les paliers 100/80/60 regardent. */
  label: string;
  /** Sous-ligne (détails : type, marque, état…) — affichée, cherchable au palier 30. */
  sub?: string;
  /** Chemin MÉTIER (localisation, extrémités d'un câble…) — affiché, cherchable au palier 30. */
  path?: string;
  /** Termes de recherche NON affichés (les `searchFields` du listing). Valeurs brutes :
      la normalisation et le filtrage des null/vides sont l'affaire de ce module. */
  terms: readonly unknown[];
}

/** Options du classement (tout injecté). */
export interface GlobalSearchOptions {
  /** Normalisation appliquée à LA REQUÊTE et à tous les textes (ex. `Schema.normSearch`). */
  normalize: (value: unknown) => string;
  /** Ordre CANONIQUE des familles — le DÉPARTAGE des groupes à meilleur score ÉGAL (l'ordre
      premier est la pertinence). Une famille absente de la liste passe après, par nom. */
  kindOrder: readonly string[];
}

/** Un groupe de résultats : une famille, ses items classés. */
export interface GlobalSearchGroup {
  kind: string;
  items: GlobalSearchItem[];
}

/** Fragment du texte ORIGINAL correspondant à la requête — pour le surlignage (<mark>). */
export interface GlobalSearchMatch {
  start: number;
  end: number;
}

export class GlobalSearch {
  /** Score d'UN item pour une requête DÉJÀ normalisée. Paliers de la maquette :
      100 exact · 80 préfixe · 60 le libellé contient · 30 seul le reste contient · 0 rien. */
  static score(item: GlobalSearchItem, needle: string, normalize: (v: unknown) => string): number {
    if (needle === "") return 0;
    const label = normalize(item.label);
    if (label === needle) return 100;
    if (label.startsWith(needle)) return 80;
    if (label.includes(needle)) return 60;
    // Palier 30 : sous-ligne + chemin + termes annexes. `some` court-circuite — on ne normalise
    // pas tout le corpus, seulement jusqu'au premier fragment qui matche.
    const rest: readonly unknown[] = [item.sub, item.path, ...item.terms];
    return rest.some((t) => t != null && t !== "" && normalize(t).includes(needle)) ? 30 : 0;
  }

  /** Filtre, classe et REGROUPE par famille (jamais entrelacé). Requête vide → []. */
  static rank(items: readonly GlobalSearchItem[], query: string, opts: GlobalSearchOptions): GlobalSearchGroup[] {
    const normalize = opts.normalize;
    const needle = normalize(query);
    if (needle === "") return [];

    type Scored = { item: GlobalSearchItem; score: number; norm: string };
    const byKind = new Map<string, Scored[]>();
    for (const item of items) {
      const score = GlobalSearch.score(item, needle, normalize);
      if (score <= 0) continue;
      let bucket = byKind.get(item.kind);
      if (!bucket) { bucket = []; byKind.set(item.kind, bucket); }
      bucket.push({ item, score, norm: normalize(item.label) });
    }

    // Ordre des GROUPES : meilleur score décroissant (la famille la plus pertinente d'abord),
    // départage par l'ordre canonique — jamais par l'ordre d'arrivée du corpus. `kindOrder`
    // inconnu → après les connues (défensif : le corpus ne peut pas casser l'affichage).
    const orderOf = (kind: string): number => {
      const at = opts.kindOrder.indexOf(kind);
      return at < 0 ? opts.kindOrder.length : at;
    };
    const kinds = [...byKind.keys()].sort((a, b) => {
      const bestA = Math.max(...byKind.get(a)!.map((s) => s.score));
      const bestB = Math.max(...byKind.get(b)!.map((s) => s.score));
      return (bestB - bestA) || (orderOf(a) - orderOf(b)) || (a < b ? -1 : a > b ? 1 : 0);
    });

    return kinds.map((kind) => {
      const bucket = byKind.get(kind)!;
      bucket.sort((a, b) => (b.score - a.score) || (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
      return { kind, items: bucket.map((s) => s.item) };
    });
  }

  /** Comptes par famille pour une requête (les pastilles de portée). `score > 0` seulement —
      la portée ACTIVE ne change pas les comptes (ils disent « ce que chaque portée offrirait »). */
  static countByKind(items: readonly GlobalSearchItem[], query: string, normalize: (v: unknown) => string): Record<string, number> {
    const needle = normalize(query);
    const out: Record<string, number> = {};
    if (needle === "") return out;
    for (const item of items) {
      if (GlobalSearch.score(item, needle, normalize) > 0) out[item.kind] = (out[item.kind] || 0) + 1;
    }
    return out;
  }

  /** Analyse un PRÉFIXE de portée en tête de saisie (« eq:sw-01 » → portée eq + requête « sw-01 »).
      `prefixes` = préfixe (minuscule, avec son séparateur) → id de portée. Insensible à la casse ;
      les espaces après le préfixe sont mangés. Sans préfixe reconnu → portée null, requête intacte. */
  static parsePrefix(raw: string, prefixes: Readonly<Record<string, string>>): { scope: string | null; query: string } {
    const low = raw.toLowerCase();
    for (const [prefix, scope] of Object.entries(prefixes)) {
      if (low.startsWith(prefix)) return { scope, query: raw.slice(prefix.length).replace(/^\s+/, "") };
    }
    return { scope: null, query: raw };
  }

  /** Position du fragment CORRESPONDANT dans le texte ORIGINAL — pour le <mark> du rendu ; null si
      le texte ne contient pas la requête. ⚠ APPROXIMATION documentée (celle de la maquette) : l'index
      est calculé sur le texte NORMALISÉ puis appliqué à l'original — exact tant qu'un caractère
      normalisé en vaut un d'origine (vrai pour du NFC composé, le cas de toutes nos données) ; sur un
      texte DÉCOMPOSÉ l'index dériverait d'un cran par diacritique. Un surlignage décalé d'un caractère
      dans ce cas limite est un moindre mal face à une table d'index par caractère. */
  static matchRange(text: string, query: string, normalize: (v: unknown) => string): GlobalSearchMatch | null {
    const needle = normalize(query);
    if (needle === "") return null;
    const at = normalize(text).indexOf(needle);
    return at < 0 ? null : { start: at, end: at + needle.length };
  }
}

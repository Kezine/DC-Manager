import { Schema } from "../constants.js";   // normalisation de recherche PARTAGÉE (minuscules + accents retirés)

/* =============================================================================
   ÉTIQUETTES `DCM-*` DES OBJETS LIÉS — module PUR (ni DB, ni réseau, ni horloge).

   Les objets liés à une intervention (équipements, VMs, spares, sous-équipements,
   applications) sont poussés vers le tracker sous forme d'ÉTIQUETTES lisibles — `DCM-EQ-SOS13`,
   `DCM-VM-SOSVM` (demande utilisateur explicite). Elles servent de TAG DE
   RECHERCHE côté tracker : « tous les tickets qui touchent SOS13 ».

   ── 🚨 LE PROJET EST PARTAGÉ : ON NE GÈRE QUE LE SOUS-ENSEMBLE `DCM-*` ───────
   D'autres sources écrivent dans le même projet et y posent LEURS étiquettes.
   D'où la règle qui gouverne tout ce fichier : le pont ne connaît, ne compare et
   ne retire QUE les étiquettes qu'il a lui-même pu poser (préfixe `DCM-`). Tout le
   reste est INVISIBLE pour lui — `diff` ne peut pas produire un `remove` sur une
   étiquette étrangère, par construction et non par vigilance. C'est le risque n°1
   du cadrage, et c'est ici qu'il se neutralise.

   ── POURQUOI LE NOM, ET PAS L'IDENTIFIANT ────────────────────────────────────
   Choix utilisateur explicite : une étiquette `DCM-EQ-SOS13` se lit et se cherche
   dans Jira, `DCM-EQ-9f3c1e…` non. Contrepartie ASSUMÉE : un objet RENOMMÉ change
   d'étiquette à la prochaine poussée (l'ancienne est retirée, la nouvelle ajoutée)
   — l'étiquette est un TAG, jamais une clé étrangère.

   ── CONTRAINTE DE FORME (Jira, et vraisemblablement tout tracker) ────────────
   Une étiquette n'admet PAS d'espace. On normalise donc : accents retirés,
   CAPITALES, tout caractère hors `[A-Z0-9-]` remplacé par `-`, tirets multiples
   fondus, tirets de bord retirés, longueur du NOM bornée. Deux objets aux noms
   voisins peuvent donc produire la même étiquette — c'est acceptable pour un tag
   de recherche, et documenté comme tel.
   ============================================================================= */

/** UNE cible liée, telle que le service la présente après résolution contre le document. */
export interface TrackerLabelTarget {
  /** Famille de la cible (`equipment` | `vm` | `spare` | `sub_equipment` | `application`). */
  kind: string;
  /** Nom AFFICHÉ de l'objet (déjà résolu — une cible disparue ne parvient pas jusqu'ici). */
  name: string;
}

/** Diff d'étiquettes exprimé en VERBES d'édition — la seule forme non destructrice sur un projet
    partagé (cf. `TrackerProviderAdapter.updateIssue`). */
export interface TrackerLabelDiff {
  add: string[];
  remove: string[];
}

export class TrackerLabels {
  /** Préfixe des étiquettes GÉRÉES par DC Manager. C'est la FRONTIÈRE : ce qui commence par lui
      nous appartient, tout le reste appartient aux autres sources du projet.
      ⚠ Limite ASSUMÉE : une source tierce qui poserait délibérément des étiquettes `DCM-*` verrait
      les siennes retirées. Aucun préfixe ne peut être garanti unique dans un projet partagé — le
      seul remède serait de mémoriser localement les étiquettes posées, c'est-à-dire d'ajouter un
      état à resynchroniser à chaque divergence. Le préfixe est le bon compromis. */
  static readonly PREFIX = "DCM";

  /** FAMILLES liables : code d'étiquette + collection du document où résoudre le NOM.
      UNE seule table pour les deux usages — ajouter une famille se fait ici, en une entrée, et un
      slug absent est simplement IGNORÉ (aucun label, aucune exception : les liens d'intervention
      sont des couples opaques, sans FK, et tolèrent l'inconnu par conception). */
  static readonly FAMILIES: Readonly<Record<string, { code: string; collection: string }>> = {
    equipment: { code: "EQ", collection: "equipments" },
    vm: { code: "VM", collection: "vms" },
    spare: { code: "SP", collection: "spares" },
    sub_equipment: { code: "SEQ", collection: "subEquipments" },
    application: { code: "APP", collection: "applications" },
  };

  /** Longueur maximale de la partie NOM d'une étiquette. Bornée bien en dessous de ce qu'un tracker
      accepte (Jira : 255 caractères) : une étiquette est faite pour être LUE et cliquée dans une
      liste, pas pour transporter un nom de 200 signes. Le total reste sous ~90 caractères. */
  static readonly MAX_NAME_CHARS = 80;

  /** Collection du document où vit une famille de cibles — `null` si la famille est inconnue. */
  static collectionOf(targetKind: string): string | null {
    const family = TrackerLabels.FAMILIES[String(targetKind || "").trim()];
    return family ? family.collection : null;
  }

  /** LIGATURES latines → leur digramme. `Schema.normSearch` décompose les accents (NFD puis retrait
      des diacritiques) mais une LIGATURE n'est pas un caractère accentué : « œ » n'a aucune
      décomposition canonique et survit intacte. Sans cette table, « SW Cœur 01 » produirait
      « SW-C-UR-01 » — une étiquette qu'aucun opérateur ne reconnaîtrait ni ne retrouverait. Table
      minuscule et explicite (les deux ligatures du français) : on ne devine rien de plus. */
  private static readonly LIGATURES: ReadonlyArray<[RegExp, string]> = [
    [/œ/g, "oe"],
    [/æ/g, "ae"],
  ];

  /** Normalise un NOM d'objet en segment d'étiquette (cf. la contrainte de forme en tête).
      La minuscule + le retrait des accents viennent de `Schema.normSearch`, la MÊME règle que la
      recherche du cœur (principe n°3 : une seule normalisation d'accents dans l'application) ; les
      LIGATURES, le passage en capitales et le remplacement des caractères non admis sont propres
      aux étiquettes.
      Rend "" quand il ne reste rien d'exploitable — l'appelant n'émet alors aucune étiquette. */
  static normalizeName(name: unknown): string {
    let lowered = Schema.normSearch(typeof name === "string" ? name : "");
    for (const [pattern, replacement] of TrackerLabels.LIGATURES) lowered = lowered.replace(pattern, replacement);
    const folded = lowered.toUpperCase();
    const cleaned = folded
      .replace(/[^A-Z0-9-]+/g, "-")   // espaces, ponctuation, symboles… → séparateur
      .replace(/-{2,}/g, "-")          // tirets fondus (« A / B » ne doit pas donner « A---B »)
      .replace(/^-+|-+$/g, "");        // tirets de bord (« (SOS13) » ne doit pas donner « -SOS13- »)
    return cleaned.slice(0, TrackerLabels.MAX_NAME_CHARS).replace(/-+$/, "");
  }

  /** Étiquette d'UNE cible, ou `null` si la famille est inconnue / le nom inexploitable. */
  static labelFor(targetKind: string, name: unknown): string | null {
    const family = TrackerLabels.FAMILIES[String(targetKind || "").trim()];
    if (!family) return null;
    const segment = TrackerLabels.normalizeName(name);
    if (segment === "") return null;
    return TrackerLabels.PREFIX + "-" + family.code + "-" + segment;
  }

  /** Jeu DÉSIRÉ d'étiquettes pour une liste de cibles RÉSOLUES : normalisées, DÉDUPLIQUÉES, ordre
      d'apparition conservé (l'ordre des liens de l'intervention fait foi).
      ⚠ Une cible DISPARUE (lien orphelin) ne doit pas parvenir ici : c'est l'appelant qui l'écarte
      en la résolvant contre le document — une étiquette bâtie sur un identifiant brut serait
      illisible, et en inventer une (« introuvable ») polluerait le projet. */
  static compose(targets: readonly TrackerLabelTarget[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const target of Array.isArray(targets) ? targets : []) {
      const label = TrackerLabels.labelFor(target && target.kind, target && target.name);
      if (label === null || seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
    return out;
  }

  /** L'étiquette est-elle GÉRÉE par DC Manager (préfixe `DCM-`) ? Comparaison insensible à la casse :
      un tracker peut normaliser la casse des étiquettes, et une étiquette qu'on ne reconnaîtrait
      plus se ré-ajouterait à chaque poussée sans que l'ancienne parte jamais. */
  static isManaged(label: unknown): boolean {
    const raw = typeof label === "string" ? label.trim() : "";
    return raw.toUpperCase().startsWith(TrackerLabels.PREFIX + "-");
  }

  /** DIFF en verbes : ce qu'il faut AJOUTER et ce qu'il faut RETIRER pour que le sous-ensemble
      `DCM-*` du ticket devienne exactement `desired`.

      🚨 `remove` ne peut contenir QUE des étiquettes gérées : les étrangères sont filtrées AVANT
      toute comparaison, elles n'entrent donc jamais dans le calcul. C'est la garantie testée du
      chantier — un test explicite prouve qu'une étiquette d'une autre source ne ressort d'aucun
      des deux verbes.
      ⚠ `desired` est également filtré : une étiquette désirée qui ne porterait pas le préfixe
      serait ajoutée sans jamais pouvoir être retirée (le diff suivant ne la verrait pas), c'est-à-
      dire une fuite permanente dans le projet d'autrui.
      La comparaison est faite sur la forme CANONIQUE (capitales) mais les verbes portent la forme
      DÉSIRÉE pour l'ajout et la forme LUE pour le retrait — on retire au tracker exactement la
      chaîne qu'il nous a rendue. */
  static diff(desired: readonly string[], current: readonly string[]): TrackerLabelDiff {
    const canonical = (label: string): string => label.trim().toUpperCase();

    const wanted = new Map<string, string>();
    for (const label of Array.isArray(desired) ? desired : []) {
      if (typeof label !== "string" || !TrackerLabels.isManaged(label)) continue;
      const key = canonical(label);
      if (!wanted.has(key)) wanted.set(key, label.trim());
    }
    const managedNow = new Map<string, string>();
    for (const label of Array.isArray(current) ? current : []) {
      if (typeof label !== "string" || !TrackerLabels.isManaged(label)) continue;   // ⬅ étiquettes ÉTRANGÈRES écartées ICI
      const key = canonical(label);
      if (!managedNow.has(key)) managedNow.set(key, label.trim());
    }

    const add: string[] = [];
    for (const [key, label] of wanted) if (!managedNow.has(key)) add.push(label);
    const remove: string[] = [];
    for (const [key, label] of managedNow) if (!wanted.has(key)) remove.push(label);
    return { add, remove };
  }
}

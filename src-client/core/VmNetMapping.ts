/* =============================================================================
   MAPPING RÉSEAUX VIRTUELS — logique PURE (aucun DOM, aucun store, aucun réseau).

   Table de correspondance MANUELLE « (bridge, vlan_tag) → réseau logique »
   (décision de cadrage n°3, .notes/vm-proxmox-cadrage-2026-07-12.md). Chaque
   vNIC embarquée d'une VM asserte un couple bridge/tag ; ce couple n'est résolu
   vers un réseau logique (`networks`) QUE via cette table. Un couple absent
   reste « non raccordé » — AUCUNE création de réseau automatique, et la synchro
   serveur n'écrit JAMAIS dans cette table (édition purement cliente).

   La table VIT dans `store.meta` sous la clé `META_KEY`, exactement comme
   `meta.graphFrames` : lecture TOLÉRANTE (clé absente → liste vide) et écriture
   via le mécanisme de méta existant (`store.persistMeta()`, valable en mode
   fichier ET en mode API — les autres clients sont notifiés par le SSE méta).

   Ce module ne connaît NI le store NI le DOM : il opère sur des tableaux nus, ce
   qui le rend testable en isolation (principes n°2/n°7). L'accès concret à la
   méta (lecture via `read`, écriture par l'appelant) reste dans l'UI — le même
   `read` sert la modale d'édition ET la résolution des vNIC en fiche VM (T3.2),
   une SEULE source de vérité pour la clé et la forme (principe n°3).
   ============================================================================= */

/** Une entrée de la table : un couple (bridge, vlan_tag) mappé vers un réseau logique.
    `vlan_tag === null` = interface NON taguée — sémantiquement distincte d'un tag numérique
    (cf. `resolve` : « sans tag » ne se confond jamais avec un tag précis). */
export interface VmNetMapEntry {
  /** Pont hôte (ex. « vmbr0 ») — jamais vide dans une entrée NORMALISÉE. */
  bridge: string;
  /** Étiquette VLAN entière, ou `null` si non taguée. */
  vlan_tag: number | null;
  /** FK → networks (réseau logique) — jamais vide dans une entrée NORMALISÉE. */
  network_id: string;
}

/** Un couple bridge/tag NU (sans réseau) — sortie de `unmappedPairs`, aide au remplissage de la modale. */
export interface VmNetPair {
  bridge: string;
  vlan_tag: number | null;
}

export class VmNetMapping {
  /** Clé DÉDIÉE dans `store.meta`. Choisie hors des clés existantes (docName, theme, graphLayout,
      graphLayouts, activeLayoutId, graphFrames, app_release) → aucune collision avec la méta actuelle. */
  static readonly META_KEY = "vmNetMappings";

  /** Normalise un tag brut → ENTIER nullable. `""` / non-fini / `null` → `null` (interface non taguée).
      Troncature volontaire (`Math.trunc`) : un tag VLAN n'est jamais fractionnaire — on garantit un entier. */
  private static normTag(raw: any): number | null {
    return (raw != null && raw !== "" && Number.isFinite(+raw)) ? Math.trunc(+raw) : null;
  }

  /** Clé de DÉDOUBLONNAGE d'un couple bridge+tag. Le séparateur `\u0000` (jamais dans un nom de pont)
      évite toute collision d'agglutination (ex. « vmbr0 » + tag 1 vs « vmbr01 » + sans tag). */
  private static pairKey(bridge: string, tag: number | null): string {
    return bridge + "\u0000" + (tag === null ? "" : tag);
  }

  /** Liste brute (méta, lignes de la modale, import…) → entrées VALIDES et dédoublonnées.
      Règles : `bridge` non vide, `network_id` non vide, `vlan_tag` entier ou `null` ; dédoublonnage
      par couple (bridge, vlan_tag) — la DERNIÈRE occurrence gagne (l'édition la plus récente prime,
      comme une réaffectation manuelle qui écrase la précédente). */
  static normalize(raw: any): VmNetMapEntry[] {
    const byPair = new Map<string, VmNetMapEntry>();
    (Array.isArray(raw) ? raw : []).forEach((item: any) => {
      const r = item || {};
      const bridge = (typeof r.bridge === "string") ? r.bridge.trim() : "";
      const network_id = (typeof r.network_id === "string") ? r.network_id.trim() : "";
      if (!bridge || !network_id) return;   // entrée incomplète → ignorée
      const vlan_tag = VmNetMapping.normTag(r.vlan_tag);
      byPair.set(VmNetMapping.pairKey(bridge, vlan_tag), { bridge, vlan_tag, network_id });   // set() → « dernière gagne »
    });
    return [...byPair.values()];
  }

  /** Lit + normalise la table depuis un objet méta (tolérant : `null`/clé absente → `[]`).
      Point d'accès UNIQUE à la clé pour la modale ET la fiche VM (T3.2). */
  static read(meta: { [k: string]: any } | null | undefined): VmNetMapEntry[] {
    return VmNetMapping.normalize(meta ? meta[VmNetMapping.META_KEY] : null);
  }

  /** Résout un couple (bridge, vlan_tag) → `network_id`, ou `null` si non mappé.
      Correspondance EXACTE : bridge identique ET tag identique (42 ≠ 43), la présence/absence de tag
      devant coïncider (tag 42 ≠ sans-tag). AUCUN repli approximatif. Le tag entrant est normalisé de la
      même façon que la table → une valeur « 42 » (chaîne) résout comme 42 (entier). */
  static resolve(entries: VmNetMapEntry[], bridge: string, vlan_tag: number | null): string | null {
    const b = (typeof bridge === "string") ? bridge.trim() : "";
    if (!b) return null;
    const tag = VmNetMapping.normTag(vlan_tag);
    const hit = (entries || []).find((e) => e.bridge === b && e.vlan_tag === tag);
    return hit ? hit.network_id : null;
  }

  /** Couples bridge/tag PRÉSENTS dans les vNIC des VMs mais ABSENTS de la table — aide au remplissage.
      Dédoublonnés, triés par bridge puis tag (les interfaces « sans tag » d'abord). Une vNIC sans bridge
      est ignorée (rien à mapper). `vms` est volontairement typé lâche (`any[]`) : le module ne dépend pas
      du modèle `Vm` — il lit seulement `vm.nics[].{bridge,vlan_tag}` (tolérance de forme). */
  static unmappedPairs(entries: VmNetMapEntry[], vms: any[]): VmNetPair[] {
    const mapped = new Set((entries || []).map((e) => VmNetMapping.pairKey(e.bridge, e.vlan_tag)));
    const byPair = new Map<string, VmNetPair>();
    (vms || []).forEach((vm: any) => {
      ((vm && Array.isArray(vm.nics)) ? vm.nics : []).forEach((nic: any) => {
        const bridge = (nic && typeof nic.bridge === "string") ? nic.bridge.trim() : "";
        if (!bridge) return;
        const vlan_tag = VmNetMapping.normTag(nic ? nic.vlan_tag : null);
        const key = VmNetMapping.pairKey(bridge, vlan_tag);
        if (mapped.has(key) || byPair.has(key)) return;   // déjà mappé, ou déjà collecté
        byPair.set(key, { bridge, vlan_tag });
      });
    });
    // Tri : bridge (alpha) puis tag croissant, « sans tag » (-Infinity) placé avant tout tag numérique.
    // Comme deux couples de MÊME bridge+tag sont dédoublonnés, on ne compare jamais null à null ici.
    return [...byPair.values()].sort((a, b) =>
      a.bridge.localeCompare(b.bridge)
      || ((a.vlan_tag === null ? -Infinity : a.vlan_tag) - (b.vlan_tag === null ? -Infinity : b.vlan_tag)));
  }
}

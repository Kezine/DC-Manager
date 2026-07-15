/* =============================================================================
   SYNCHRO VM — FRONTIÈRE SOURCE / LOCAUX (code PARTAGÉ front ⇄ back, TS pur).

   La collection `vms` sépare deux familles de champs (décision de cadrage,
   cf. DC Manager docs & .notes/vm-proxmox-cadrage-2026-07-12.md) :
   - champs SOURCE : alimentés par la synchro provider (Proxmox…), ÉCRASÉS à
     chaque réconciliation — l'utilisateur ne les édite jamais ;
   - champs LOCAUX : enrichissements utilisateur (notes, hôte hébergeur,
     groupes, description héritée d'Entity), JAMAIS touchés par la synchro.

   Ce fichier est la SOURCE DE VÉRITÉ de cette frontière : le modèle client
   (`src-client/models/Vm.ts`) normalise ses champs source ici, et le moteur de
   réconciliation serveur (`src-server/src/vm/VmReconcile.ts`) n'écrase QUE les
   champs listés ici — une divergence de sémantique entre les deux côtés est
   ainsi impossible par construction (principe n°3, réutilisation).

   Contrainte src-shared : fichier AUTO-SUFFISANT (aucun import), ni DOM ni Node.
   ============================================================================= */

/** vNIC EMBARQUÉE telle que STOCKÉE dans le document (forme normalisée : chaînes
    jamais nulles, tag nullable, IPs filtrées). À distinguer du pivot d'adaptateur
    (`VmRecord.nics`, côté serveur) dont les champs inconnus restent `null` :
    `VmSync.normalizeNic` fait précisément cette conversion pivot → document. */
export interface VmNic {
  /** Nom de l'interface (ex. « net0 » côté QEMU, « eth0 » côté LXC). */
  name: string;
  /** Adresse MAC — pivot de rapprochement vers l'IPAM. "" = inconnue. */
  mac: string;
  /** Pont hôte (ex. « vmbr0 ») — clé (avec `vlan_tag`) du mapping vers un réseau logique. */
  bridge: string;
  /** Étiquette VLAN, ou `null` si l'interface n'est pas taguée. */
  vlan_tag: number | null;
  /** Adresses IP CONSTATÉES (agent QEMU / config statique LXC) — donnée source informative. */
  ips: string[];
}

/** Les 14 champs SOURCE de l'entité `vms`, sous leur forme normalisée. */
export interface VmSourceFields {
  ext_id: string;
  provider_id: string;
  vm_type: string;
  name: string;
  description_src: string;
  status: string;
  host_node: string;
  cpu: number | null;
  ram_mb: number | null;
  disk_gb: number | null;
  tags_src: string[];
  nics: VmNic[];
  orphan: boolean;
  last_sync: string;
}

/** Liste CANONIQUE des champs source — le périmètre exact de ce que la synchro a le
    droit d'écraser. Tout champ de l'entité `vms` HORS de cette liste est LOCAL
    (jamais touché), sauf `host_equipment_id` : champ DÉRIVÉ par la réconciliation,
    re-résolu du nom de nœud à CHAQUE synchro (décision 2026-07-13 — la synchro est
    la source de vérité de l'hôte, plus d'édition utilisateur, cf. VmReconcile).
    Un test d'invariant vérifie la cohérence de cette liste avec le modèle `Vm`. */
export const VM_SOURCE_FIELDS: readonly (keyof VmSourceFields)[] = [
  "ext_id", "provider_id", "vm_type", "name", "description_src", "status", "host_node",
  "cpu", "ram_mb", "disk_gb", "tags_src", "nics", "orphan", "last_sync",
];

export class VmSync {
  /** Normalise une vNIC brute (pivot d'adaptateur, désérialisation, formulaire) vers la
      forme DOCUMENT : chaînes `|| ""`, tag numérique nullable, IPs filtrées. Définition
      UNIQUE — `Vm.normalizeNic` (client) et la réconciliation (serveur) délèguent ici. */
  static normalizeNic(raw: any): VmNic {
    const nic = raw || {};
    return {
      name: nic.name || "",
      mac: nic.mac || "",
      bridge: nic.bridge || "",
      vlan_tag: (nic.vlan_tag != null && nic.vlan_tag !== "" && Number.isFinite(+nic.vlan_tag)) ? +nic.vlan_tag : null,
      ips: Array.isArray(nic.ips) ? nic.ips.filter((ip: any) => typeof ip === "string" && ip) : [],
    };
  }

  /** Normalise les 14 champs SOURCE depuis des propriétés brutes — MÊMES patterns que
      les constructeurs d'entités (strings `|| ""`, nombres nullables clampés ≥ 0,
      booléens `=== true`, tableaux filtrés). Utilisée par le constructeur de `Vm`
      (client) ET par le diff de réconciliation (serveur) : comparer deux états passés
      par cette normalisation élimine les faux écarts (undefined vs "", "2" vs 2…). */
  static normalizeSource(p: { [k: string]: any }): VmSourceFields {
    return {
      ext_id: p.ext_id || "",
      provider_id: p.provider_id || "",
      vm_type: p.vm_type || "qemu",
      name: p.name || "",
      description_src: p.description_src || "",
      status: p.status || "",
      host_node: p.host_node || "",
      cpu: VmSync.normNumber(p.cpu),
      ram_mb: VmSync.normNumber(p.ram_mb),
      disk_gb: VmSync.normNumber(p.disk_gb),
      tags_src: Array.isArray(p.tags_src) ? p.tags_src.filter((t: any) => typeof t === "string" && t) : [],
      nics: Array.isArray(p.nics) ? p.nics.map((n: any) => VmSync.normalizeNic(n)) : [],
      orphan: p.orphan === true,
      last_sync: p.last_sync || "",
    };
  }

  /** Égalité d'UN champ source entre deux états NORMALISÉS. Comparaison par JSON :
      correcte ici car normalizeSource garantit des structures canoniques (ordres de
      clés fixes pour les nics, tableaux filtrés, null explicites). */
  static sourceEquals(a: VmSourceFields, b: VmSourceFields, field: keyof VmSourceFields): boolean {
    return JSON.stringify(a[field]) === JSON.stringify(b[field]);
  }

  /** Nombre nullable clampé ≥ 0 (pattern des constructeurs d'entités). */
  private static normNumber(value: any): number | null {
    return (value != null && value !== "") ? Math.max(0, +value || 0) : null;
  }
}

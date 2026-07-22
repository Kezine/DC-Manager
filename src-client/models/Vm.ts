import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";
import { VmSync, VmNic } from "../../src-shared/VmSync";

/** Interface réseau VIRTUELLE (vNIC) d'une VM — EMBARQUÉE dans l'entité (tableau `nics`), PAS un enregistrement
    `ports` : impossible à câbler PAR CONSTRUCTION (l'exigence « port spécial réseau-seulement » devient gratuite).
    Une vNIC n'asserte qu'un réseau LOGIQUE via son couple `bridge`/`vlan_tag` (résolu par la table de mapping du
    store, ajoutée plus tard). Le TYPE et sa normalisation vivent dans `src-shared/VmSync` (définition unique,
    partagée avec la réconciliation serveur) — ré-exporté ici pour les consommateurs du modèle. */
export type { VmNic } from "../../src-shared/VmSync";

/** Équipement VIRTUEL (VM QEMU ou conteneur LXC) alimenté par la synchro d'un cluster de management (Proxmox
    en première implémentation) — collection AMOVIBLE (le cœur n'en dépend jamais). Ne porte QUE des informations
    pertinentes pour une VM ; ni placée en 2D/3D, ni câblée, ni comptée dans le power ou les spares.

    Frontière SOURCE / LOCAUX (décision de cadrage) :
    - champs SOURCE : ÉCRASÉS à chaque synchro (réconciliation par `ext_id` = « provider/vmid ») ;
    - champs LOCAUX : enrichissements JAMAIS touchés par la synchro (notes, hôte hébergeur, groupes). */
export class Vm extends Entity implements Records.Vm {
  /* ---- champs SOURCE (écrasés par la synchro) ---- */
  /** Identité STABLE côté provider (« provider/vmid ») — clé de RÉCONCILIATION create/update/orphelin. */
  ext_id: string;
  /** Instance d'adaptateur/cluster d'origine (multi-clusters). */
  provider_id: string;
  /** Nature : « qemu » (VM) | « lxc » (conteneur) — champ TOLÉRANT (une valeur inconnue est conservée telle quelle). */
  vm_type: string;
  /** Nom d'affichage (remonté par le provider). */
  name: string;
  /** Description/notes libres CÔTÉ PROVIDER (distincte de `notes`, l'enrichissement local). */
  description_src: string;
  /** État : « running » | « stopped » | … — champ TOLÉRANT (statut inconnu accepté : résilience aux releases Proxmox). */
  status: string;
  /** Nom du NŒUD hôte côté provider (rapproché de l'équipement hôte par nom au 1er sync — cf. `host_equipment_id`). */
  host_node: string;
  /** vCPU alloués. `null` = non renseigné. */
  cpu: number | null;
  /** Mémoire (Mo). `null` = non renseigné. */
  ram_mb: number | null;
  /** Disque (Go). `null` = non renseigné. */
  disk_gb: number | null;
  /** Étiquettes CÔTÉ PROVIDER (Proxmox `tags`) — tableau de scalaires filtrable (cf. Schema.ARRAY_FIELDS). */
  tags_src: string[];
  /** Interfaces réseau virtuelles EMBARQUÉES (normalisées par `Vm.normalizeNic`). */
  nics: VmNic[];
  /** VM DISPARUE à la dernière synchro (jamais supprimée brutalement — l'utilisateur a pu l'enrichir). */
  orphan: boolean;
  /** Horodatage ISO de la dernière synchro ayant touché cette VM. */
  last_sync: string;

  /* ---- champs LOCAUX (jamais touchés par la synchro) ---- */
  /** Note libre d'enrichissement (saisie utilisateur). */
  notes: string;
  /** FK → equipments : équipement HÔTE hébergeur. Champ DÉRIVÉ par la synchro (décision 2026-07-13 :
      re-résolu du nom de nœud à CHAQUE passe — non éditable, la synchro est la source de vérité).
      Détaché en cascade à la suppression de l'équipement (re-résolu au sync suivant si homonyme). */
  host_equipment_id: string | null;
  /** FK → groups : groupe PRIMAIRE (parité Equipment). `null` = aucun. TOUJOURS ∈ `group_ids`. */
  group_id: string | null;
  /** FK[] → groups : TOUS les groupes (primaire + secondaires) — parité Equipment. */
  group_ids: string[];

  constructor(p: Props = {}) {
    super(p);
    /* --- SOURCE --- normalisation PARTAGÉE (VmSync.normalizeSource : mêmes patterns qu'Equipment.ts).
       Une SEULE définition de la sémantique, commune au modèle client et au diff de réconciliation
       serveur : un écart de normalisation entre les deux côtés créerait de FAUX deltas de synchro. */
    const src = VmSync.normalizeSource(p);
    this.ext_id = src.ext_id;
    this.provider_id = src.provider_id;
    this.vm_type = src.vm_type;
    this.name = src.name;
    this.description_src = src.description_src;
    this.status = src.status;
    this.host_node = src.host_node;
    this.cpu = src.cpu;
    this.ram_mb = src.ram_mb;
    this.disk_gb = src.disk_gb;
    this.tags_src = src.tags_src;
    this.nics = src.nics;
    this.orphan = src.orphan;
    this.last_sync = src.last_sync;
    /* --- LOCAUX --- */
    this.notes = p.notes || "";
    this.host_equipment_id = p.host_equipment_id || null;
    // GROUPES : parité STRICTE avec Equipment — le primaire est TOUJOURS membre de group_ids (invariant partagé),
    // en TÊTE de liste ; migration d'un enregistrement legacy (group_id seul) → group_ids semé à [group_id].
    this.group_id = p.group_id || null;
    let gids: string[] = Array.isArray(p.group_ids) ? p.group_ids.filter((x: any) => typeof x === "string" && x) : [];
    if (this.group_id) gids = [this.group_id, ...gids.filter((x) => x !== this.group_id)];
    this.group_ids = [...new Set(gids)];
  }

  /** Normalise une vNIC brute — DÉLÉGATION à la définition partagée (compatibilité d'API :
      les consommateurs du modèle appellent `Vm.normalizeNic`, la sémantique vit dans VmSync). */
  static normalizeNic(raw: any): VmNic {
    return VmSync.normalizeNic(raw);
  }
}

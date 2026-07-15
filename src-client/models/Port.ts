import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { EQUIP_FACE_IDS } from "../domain/constants";

/** Port d'un équipement (peut être un trunk éclaté en lanes — breakout). */
export class Port extends Entity {
  /** FK → equipments (l'équipement porteur). */
  equipment_id: string | null;
  /** Nom du port (ex. "Gi1/0/1"). */
  name: string;
  /** FK → portTypes (famille + connecteur). */
  port_type_id: string | null;
  /** Rôle : "data" | "power" | … */
  role: string;
  /** FK → aggregates. null = pas dans un agrégat. */
  aggregate_id: string | null;
  /** BREAKOUT : FK → ports (le trunk parent). null = port normal/trunk. */
  parent_port_id: string | null;
  /** Index de lane (1..N) si breakout. null = non-lane. */
  lane: number | null;
  /** Position X normalisée (0..1) sur la façade. null = non placé. */
  face_x: number | null;
  /** Position Y normalisée (0..1) sur la façade. */
  face_y: number | null;
  /** Face de l'équipement (front/rear + top/bottom/left/right pour le libre). */
  face_side: string;

  /* ---- TERMINAISON DE FAISCEAU (ports de PATCH) ----
     Un port de patch termine des brins d'un faisceau : il en « pioche » 1 (simplex) ou 2 (duplex Tx/Rx)
     dans le pool du faisceau. `strand_a`/`strand_b` sont des n° de FIBRE PHYSIQUE (1..fiber_count) ; l'homologue
     à l'autre extrémité du trunk se retrouve par « quel port pioche ce même brin ». null partout = port normal. */
  /** FK → cableBundles : le faisceau dont ce port termine des brins. null = port non-patch. */
  bundle_id: string | null;
  /** 1er brin physique pioché (n° de fibre dans le pool). null = aucun. */
  strand_a: number | null;
  /** 2e brin physique (duplex Tx/Rx). null = simplex ou aucun. */
  strand_b: number | null;

  /* ---- RÉSEAU (source UNIQUE, assertée sur les ports d'équipement TERMINAL) ----
     Le réseau ne vit PLUS sur le câble : il est asserté ici (port d'un switch/serveur/HBA — là où un VLAN/une
     fabric se configure vraiment) et DÉDUIT partout ailleurs le long du chemin (cf. Store.cableNetworkIds).
     Vide = JOKER : le port n'impose rien et adopte le réseau déduit de son chemin. Un port de PATCH n'assert
     jamais (il déduit) → laissé vide. `network_id` ⊆ `network_ids` (réseau principal, pilote la couleur). */
  /** Tous les réseaux assertés par ce port terminal (ex. plusieurs VLAN). Vide = joker. */
  network_ids: string[];
  /** Réseau PRINCIPAL asserté (miroir de `network_ids`). null = aucun (joker). */
  network_id: string | null;

  /* ---- POWER : sens de l'énergie + capacité + phase (ports role="power") ----
     Un port power a un SENS : "source" (fournit — outlet PDU, départ de tableau) ou "sink" (consomme — inlet PSU).
     Un câble power relie une source à un sink. `power_max_a` = plafond en AMPÈRES (délivrance pour une source,
     rating de la PSU pour un sink) — le disjoncteur déclenche sur le courant. `phase` (L1/L2/L3) est assertée sur
     les départs d'un tableau et DÉDUITE en aval (PDU monophasée = 1 inlet ⇒ phase héritée). Vide = non applicable. */
  /** "" (data / non applicable) | "source" (fournit) | "sink" (consomme). */
  direction: string;
  /** Plafond de courant du port (A) : délivrance (source) ou rating PSU (sink). null = non renseigné. */
  power_max_a: number | null;
  /** Phase assertée sur un départ (source) : "" | "L1" | "L2" | "L3". Déduite en aval. */
  phase: string;

  constructor(p: Props = {}) {
    super(p);
    this.equipment_id = p.equipment_id || null;
    this.name = p.name || "";
    this.port_type_id = p.port_type_id || null;
    this.role = p.role || "data";
    this.aggregate_id = p.aggregate_id || null;
    this.parent_port_id = p.parent_port_id || null;
    this.lane = (p.lane != null) ? (p.lane | 0) : null;
    this.face_x = (p.face_x != null) ? p.face_x : null;
    this.face_y = (p.face_y != null) ? p.face_y : null;
    this.face_side = EQUIP_FACE_IDS.includes(p.face_side) ? p.face_side : "front";
    this.bundle_id = p.bundle_id || null;
    this.strand_a = (p.strand_a != null) ? Math.max(1, p.strand_a | 0) : null;
    this.strand_b = (p.strand_b != null) ? Math.max(1, p.strand_b | 0) : null;
    // réseau : network_ids (assertion) + principal ⊆ network_ids — mutualisé avec Cable via Normalize.networkRefs.
    const nr = Normalize.networkRefs(p);
    this.network_ids = nr.network_ids;
    this.network_id = nr.network_id;
    this.direction = (p.direction === "source" || p.direction === "sink") ? p.direction : "";
    this.power_max_a = (p.power_max_a != null && p.power_max_a !== "") ? Math.max(0, +p.power_max_a || 0) : null;
    this.phase = (p.phase === "L1" || p.phase === "L2" || p.phase === "L3") ? p.phase : "";
  }
}

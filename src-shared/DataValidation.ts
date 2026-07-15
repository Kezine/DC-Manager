/* ============================================================================
   NORMALISATION & VALIDATION DES DONNÉES — code PARTAGÉ front ⇄ back (TS pur).

   Garantit qu'un enregistrement écrit dans un document respecte le schéma, QUEL QUE
   SOIT le client (UI packagée ou autre interface postant au serveur). Appliqué aux deux
   points : saisie (UI, via le Store) et écriture (serveur, autorité → 400). Cf. docs/validation.md.

   API publique = DEUX classes sémantiques (méthodes statiques regroupées, cf. CLAUDE.md) :
     - `Ipv4`          : primitives IPv4 / CIDR pures (parité avec src/core/Ip).
     - `DataValidator` : normalisation + validation (intrinsèque V1, référentiel V2,
                         invariants V3, cross-entité V5, dépendance inverse V5b).
   Les énumérations, types et la table `COLLECTION_SPECS` restent des exports de données.

   Contrainte `shared/` : fichier AUTO-SUFFISANT (aucun import) → compile sous le front
   (résolution bundler) ET le serveur (NodeNext). Les enums sont donc déclarés ICI comme
   source canonique ; un test anti-divergence vérifie l'alignement avec les constantes front.
   ============================================================================ */

/* ---- énumérations canoniques (alignées au domaine front — cf. test anti-divergence) ---- */
/** Statuts de câble (cycle de vie). = `CABLE_STATUSES.map(s => s.id)` côté front. */
export const CABLE_STATUS_IDS = ["brouillon", "planifie", "cable", "a-remplacer", "casse"] as const;
/** Profondeurs d'équipement (drapeau de face). = `EQUIP_DEPTHS` côté front. */
export const EQUIPMENT_DEPTHS = ["full", "half", "quarter"] as const;
/** Modes de placement d'un équipement. */
export const EQUIPMENT_PLACEMENT_MODES = ["manual", "rack", "side", "wall", "floor", "tray"] as const;
/** Alignements d'un boîtier U RÉTRÉCI dans la baie (vu de face). */
export const EQUIPMENT_U_ALIGNS = ["left", "center", "right"] as const;
/** Largeur UTILE du corps 19″ (mm) = RACK_MOUNT_WIDTH − 2·RACK_EAR_MM (réplique des constantes front —
    parité avec RackGeometry.mountBodyWidth, à maintenir ensemble) : borne SUP d'un `u_width_mm`. */
export const EQUIPMENT_U_BODY_MAX_MM = 482.6 - 2 * 15;
/** Configurations de faces d'une baie. */
export const RACK_SIDE_CONFIGS = ["single", "dual"] as const;
/** Faces d'un équipement (où poser un port). = `EQUIP_FACE_IDS` côté front. */
export const EQUIPMENT_FACE_IDS = ["front", "rear", "top", "bottom", "left", "right"] as const;
/** Nature « données » vs « énergie » (réseaux, types de port/câble). */
export const DATA_OR_POWER = ["data", "power"] as const;
/** Types de groupe. = `GROUP_TYPES.map(t => t.id)` côté front. */
export const GROUP_TYPE_IDS = ["stack", "system", "general"] as const;
/** Genres de pseudo-occupant de baie. = `RACK_ITEM_KINDS.map(k => k.id)` côté front. */
export const RACK_ITEM_KIND_IDS = ["blank", "tray", "keepblank"] as const;
/** Variantes d'étagère (tray). = `TRAY_TYPES.map(t => t.id)` côté front. */
export const TRAY_TYPE_IDS = ["dual", "cantilever"] as const;
/** Côtés d'occupation d'une baie. */
export const RACK_OCCUPANT_SIDES = ["front", "rear"] as const;
/** Genres de waypoint. */
export const WAYPOINT_KINDS = ["point", "segment", "brush"] as const;
/** Catégories de waypoint (en salle vs sortie). */
export const WAYPOINT_TYPES = ["datacenter", "exit"] as const;
/** Sources d'alimentation d'un réseau power. */
export const POWER_SOURCES = ["ups", "ups_gen", "grid"] as const;
/** Types de pièce de rechange. = `SPARE_TYPES.map(t => t.id)` côté front. */
export const SPARE_TYPE_IDS = ["hdd", "ssd", "transceiver", "other"] as const;
/** Statuts de pièce de rechange. = `SPARE_STATUSES.map(s => s.id)` côté front. */
export const SPARE_STATUS_IDS = ["available", "assigned", "decommissioned"] as const;

/* ---- types de la spécification ---- */
export type FieldType = "string" | "number" | "boolean" | "string[]";

/** Règle déclarative pour UN champ d'une collection. */
export interface FieldSpec {
  type: FieldType;
  /** Champ obligatoire : `undefined` / `null` / chaîne vide interdits. */
  required?: boolean;
  /** `null` explicitement autorisé (FK optionnelle, mesure non renseignée…). */
  nullable?: boolean;
  /** Valeur posée par la normalisation quand le champ est absent / vide. */
  default?: unknown;
  /** Retire les espaces de tête/queue à la normalisation (type `string`). Sert à fiabiliser une IDENTITÉ :
      un `name` d'équipement « srv37 » et « srv37 » ne doivent pas être considérés distincts par l'unicité. */
  trim?: boolean;
  /** Ensemble fermé de valeurs autorisées. */
  enum?: readonly string[];
  /** Borne inférieure (type `number`). */
  min?: number;
  /** Format attendu (chaîne) : `ipv4` (« a.b.c.d ») ou `cidr` (« a.b.c.d/n », n ∈ 0..32). */
  format?: "ipv4" | "cidr";
  /** Collection cible d'une clé étrangère (exploité par l'intégrité référentielle — V2). */
  ref?: string;
}

/** Spécification d'une collection : ses champs déclarés (partielle — seuls les champs porteurs de règles
    sont listés ; les autres traversent) + invariants inter-champs (V3) + règles cross-entité (V5). */
export interface CollectionSpec {
  fields: Record<string, FieldSpec>;
  invariants?: Invariant[];
  crossEntity?: CrossEntityRule[];
  /** Règles de PORTÉE (V6) : unicité / non-chevauchement contre les pairs (nécessitent le `find`). */
  scope?: ScopeRule[];
  /** Dépendances INVERSES (V5b) : collections-enfants à re-valider quand CETTE entité change (ex. un réseau IP
      dont le `cidr` change → re-vérifier ses adresses/plages). Les enfants sont re-validés via LEURS propres
      règles cross-entité, contre le nouvel état du parent. */
  dependents?: Array<{ collection: string; fkField: string }>;
}

/** Erreur de validation — contrat partagé UI ⇄ serveur. */
export interface ValidationError {
  collection: string;
  id?: string;
  path: string;            // champ concerné
  code: "required" | "type" | "enum" | "min" | "format" | "ref_missing" | "invariant" | "cross_entity" | "scope";
  message: string;         // message humain (français)
}

/** Invariant INTER-CHAMPS d'une collection (V3) : règle qui dépend de PLUSIEURS champs du même
    enregistrement (impossible à exprimer champ par champ). Pure → testable. */
export interface Invariant {
  path: string;            // champ auquel rattacher l'erreur (pour le surlignage UI)
  message: string;         // message humain (français)
  holds: (record: Record<string, any>) => boolean;   // true = respecté · false = violé
}

/** Lecteur d'entité (V2 référentiel + V5 cross-entité) : renvoie l'enregistrement pointé, ou `null` s'il
    n'existe pas. INJECTÉ pour garder `shared/` pur — l'UI l'adosse au `Store`, le serveur au `Repository`.
    Subsume l'ancien résolveur d'existence : « existe ? » = `fetch(coll, id) != null`. */
export type EntityFetcher = (collection: string, id: string) => Record<string, any> | null;

/** Règle CROSS-ENTITÉ (V5) : valide un enregistrement d'après les DONNÉES d'une entité liée (lue via `fetch`),
    pas seulement ses propres champs. Renvoie l'erreur (champ + message) ou `null` si respectée / non applicable. */
export type CrossEntityRule = (record: Record<string, any>, fetch: EntityFetcher) => { path: string; message: string } | null;

/** Recherche d'enregistrements par champ INDEXÉ (dépendance inverse V5b + portée V6) : tous les enregistrements
    de `collection` dont `field` vaut `value`. INJECTÉ — l'UI l'adosse aux index du `Store`, le serveur à une
    requête. `ChildFinder` (V5b, recherche par FK) en est un cas particulier — même signature. */
export type RecordFinder = (collection: string, field: string, value: string) => Record<string, any>[];
export type ChildFinder = RecordFinder;

/** Règle de PORTÉE (V6) : valide un enregistrement contre l'ENSEMBLE de ses pairs (unicité, non-chevauchement),
    via un `find` par champ (+ `fetch` optionnel pour lire une entité de contexte, ex. la baie). Doit EXCLURE
    l'enregistrement lui-même (par `id`). Renvoie l'erreur ou `null`. */
export type ScopeRule = (record: Record<string, any>, find: RecordFinder, fetch?: EntityFetcher) => { path: string; message: string } | null;

/** Forme minimale d'un lot atomique (mêmes champs que la transaction serveur). */
export interface BatchOps {
  creates?: Array<{ collection: string; record: Record<string, any> }>;
  updates?: Array<{ collection: string; record: Record<string, any> }>;
  deletes?: Array<{ collection: string; id: string }>;
}

/** Sous-réseau IPv4 analysé (sous-ensemble de `core/Ip.Cidr` : ce dont la validation a besoin). */
export interface ParsedCidr { base: number; prefix: number; mask: number; network: number; }

/** Brins (fibres physiques) piochés par un port de patch = ses `strand_a`/`strand_b` non nuls. Concept PARTAGÉ entre
    la VALIDATION (unicité/capacité des brins — V6/T6) et la DÉDUCTION réseau (arête « même fibre » — Store) : d'où sa
    place ici (shared/, auto-suffisant). Évite le motif `[p.strand_a, p.strand_b].filter(v => v != null)` répété. */
export class PortStrands {
  static of(port: { strand_a?: number | null; strand_b?: number | null }): number[] {
    return [port.strand_a, port.strand_b].filter((v): v is number => v != null);
  }
}

/* ============================================================================
   Ipv4 — primitives IPv4 / CIDR PURES (parité stricte avec src/core/Ip ; `core/Ip` y délègue).
   ============================================================================ */
export class Ipv4 {
  /** « a.b.c.d » → entier non signé, ou `null` si invalide (octets ≤ 255). */
  static toInt(value: string): number | null {
    const match = typeof value === "string" ? value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/) : null;
    if (!match) return null;
    let result = 0;
    for (let i = 1; i <= 4; i++) { const octet = +match[i]; if (octet > 255) return null; result = result * 256 + octet; }
    return result >>> 0;
  }

  /** « a.b.c.d/n » → sous-réseau analysé, ou `null` si invalide. */
  static parseCidr(value: string): ParsedCidr | null {
    const match = typeof value === "string" ? value.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/) : null;
    if (!match) return null;
    const base = Ipv4.toInt(match[1]); const prefix = +match[2];
    if (base == null || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
    return { base, prefix, mask, network: (base & mask) >>> 0 };
  }

  /** Vrai si `value` est un CIDR IPv4 valide (« a.b.c.d/n », n ∈ 0..32). */
  static isCidr(value: string): boolean {
    return Ipv4.parseCidr(value) != null;
  }

  /** L'entier d'IP appartient-il au sous-réseau ? */
  static inCidr(ipInt: number | null, cidr: ParsedCidr | null): boolean {
    return cidr != null && ipInt != null && ((ipInt & cidr.mask) >>> 0) === cidr.network;
  }
}

/* ============================================================================
   RackOccupancy — empilement en baie (V6c). Réplique FIDÈLE de RackGeometry.mountSides /
   RackScene.occupants : un occupant (équipement racké, rackItem, brosse) occupe des cellules
   « U:face » ; deux occupants entrent en COLLISION s'ils partagent une cellule.
   ============================================================================ */
type RackSpan = { top: number; height: number; sides: string[] };

class RackOccupancy {
  /** Faces occupées par un occupant selon le type de baie (réplique `RackGeometry.mountSides`). */
  private static sides(record: Record<string, any>, collection: string, rack: Record<string, any>): string[] {
    if (rack.sides !== "dual") return ["front"];                                  // baie simple face → tout sur « front »
    if (collection === "rackItems") return [record.side === "rear" ? "rear" : "front"];
    if (collection === "waypoints") return ["front", "rear"];                     // brosse → pleine profondeur
    // locks_u fait foi ; l'enum legacy « full » n'implique les 2 faces QUE pré-migration (depth_mm absent).
    // Parité avec RackGeometry.mountLocksU (front) — à maintenir ensemble.
    const locksU = record.locks_u === true || (record.depth_mm == null && record.depth === "full");
    return locksU ? ["front", "rear"] : [record.rack_side === "rear" ? "rear" : "front"];
  }

  /** Étendue U×faces d'un occupant de baie, ou `null` si l'enregistrement n'occupe pas de U dans une baie. */
  private static span(record: Record<string, any>, collection: string, rack: Record<string, any>): RackSpan | null {
    let top: number | null = null, height = 1;
    if (collection === "equipments") {
      if (record.placement_mode !== "rack" || record.rack_u == null) return null;
      top = record.rack_u | 0; height = Math.max(1, (record.u_height | 0) || 1);
    } else if (collection === "rackItems") {
      if (record.u == null) return null;
      top = record.u | 0; height = Math.max(1, (record.u_height | 0) || 1);
    } else if (collection === "waypoints") {
      if (record.kind !== "brush" || !record.rack_id) return null;
      top = Math.max(1, record.rack_u | 0); height = Math.max(1, record.u_height | 0);
    } else return null;
    if (top == null || top < 1) return null;
    return { top, height, sides: RackOccupancy.sides(record, collection, rack) };
  }

  /** Cellules « U:face » couvertes par une étendue. */
  private static cells(span: RackSpan): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i < span.height; i++) for (const side of span.sides) set.add((span.top + i) + ":" + side);
    return set;
  }

  /** Règle de PORTÉE : l'occupant ne doit pas COLLIDER (même cellule U:face) avec un autre occupant de SA baie. */
  static collision(record: Record<string, any>, collection: string, find: RecordFinder, fetch?: EntityFetcher): { path: string; message: string } | null {
    const rackId = record.rack_id;
    if (!rackId || !fetch) return null;
    const rack = fetch("racks", rackId);
    if (!rack) return null;                                                        // baie absente → l'intégrité réf. le signale
    const self = RackOccupancy.span(record, collection, rack);
    if (!self) return null;                                                        // pas un occupant de baie
    const selfCells = RackOccupancy.cells(self);
    const path = collection === "rackItems" ? "u" : "rack_u";
    const others: Array<[string, Record<string, any>]> = [
      ...find("equipments", "rack_id", rackId).map((o) => ["equipments", o] as [string, Record<string, any>]),
      ...find("rackItems", "rack_id", rackId).map((o) => ["rackItems", o] as [string, Record<string, any>]),
      ...find("waypoints", "rack_id", rackId).map((o) => ["waypoints", o] as [string, Record<string, any>]),
    ];
    for (const [otherCollection, other] of others) {
      if (other.id === record.id) continue;                                        // « sauf moi-même »
      const span = RackOccupancy.span(other, otherCollection, rack);
      if (!span) continue;
      for (const cell of RackOccupancy.cells(span)) {
        if (selfCells.has(cell)) return { path, message: `Emplacement en collision avec « ${other.name || other.label || other.id} » (U${span.top}${span.height > 1 ? "–" + (span.top + span.height - 1) : ""}).` };
      }
    }
    return null;
  }
}

/* ============================================================================
   PROFONDEUR de montage en baie (mm) — l'équipement doit TENIR dans l'espace
   disponible, et deux montages DOS À DOS au même U ne doivent pas se cumuler
   au-delà de la cage. Formules RÉPLIQUÉES de RackGeometry (front) : shared/
   est auto-suffisant (pas d'import du front) — duplication ASSUMÉE, documentée
   des deux côtés, à maintenir en parité (mountAvailDepth / sharedMountDepth).
   Les règles ne s'appliquent qu'aux enregistrements MIGRÉS (depth_mm présent) :
   un legacy (enum fractionnaire) tient par construction — et le sanctionner
   rendrait d'anciens documents invalides à la première édition.
   ============================================================================ */
const RACK_DEPTH_SAFETY = 100;    // = RACK_DEPTH_SAFETY_MM (front) : marge de sécurité derrière une porte
const RACK_DEPTH_FALLBACK = 1000; // = RACK_DEPTH_DEFAULT (front) : profondeur extérieure par défaut

class RackDepth {
  private static doorExtra(rack: Record<string, any>, face: string): number {
    const d = face === "rear" ? rack.door_rear : rack.door_front;
    return (d && d.enabled && d.hollow) ? Math.max(0, d.hollow_mm | 0) : 0;
  }
  private static hasDoor(rack: Record<string, any>): boolean {
    const f = rack.door_front, r = rack.door_rear;
    return !!((f && f.enabled) || (r && r.enabled));
  }
  /** Profondeur de cage — aussi utilisée par TrayFit (plateau « dual » = pleine cage). */
  static cage(rack: Record<string, any>): number {
    const d = rack.depth || RACK_DEPTH_FALLBACK;
    return (rack.cage_depth_mm > 0) ? Math.min(d, rack.cage_depth_mm | 0) : d;
  }
  private static frontMargin(rack: Record<string, any>): number {
    const d = rack.depth || RACK_DEPTH_FALLBACK;
    const fm = (rack.front_margin_mm != null && rack.front_margin_mm !== "") ? Math.max(0, rack.front_margin_mm | 0) : 0;
    return Math.min(fm, Math.max(0, d - RackDepth.cage(rack)));
  }
  private static rearMargin(rack: Record<string, any>): number {
    const d = rack.depth || RACK_DEPTH_FALLBACK;
    return Math.max(0, d - RackDepth.cage(rack) - RackDepth.frontMargin(rack));
  }
  /** Dispo pour un montage ancré à `side` (av/ar) : jusqu'à la face opposée + cavités − sécurité derrière porte. */
  private static avail(rack: Record<string, any>, side: string): number {
    const d = rack.depth || RACK_DEPTH_FALLBACK;
    const extras = RackDepth.doorExtra(rack, "front") + RackDepth.doorExtra(rack, "rear");
    return d - (side === "rear" ? RackDepth.rearMargin(rack) : RackDepth.frontMargin(rack)) + extras - (RackDepth.hasDoor(rack) ? RACK_DEPTH_SAFETY : 0);
  }
  /** Espace PARTAGÉ par deux montages dos à dos au même U : cage + cavités − sécurité derrière porte. */
  private static shared(rack: Record<string, any>): number {
    return RackDepth.cage(rack) + RackDepth.doorExtra(rack, "front") + RackDepth.doorExtra(rack, "rear") - (RackDepth.hasDoor(rack) ? RACK_DEPTH_SAFETY : 0);
  }
  /** Profondeur EFFECTIVE d'un occupant : depth_mm, sinon estimation legacy (fraction de cage). */
  private static effDepth(record: Record<string, any>, rack: Record<string, any>): number {
    if (record.depth_mm != null) return Math.max(1, record.depth_mm | 0);
    const frac: Record<string, number> = { full: 1, half: 0.5, quarter: 0.25 };
    return Math.round((frac[record.depth] != null ? frac[record.depth] : 1) * RackDepth.cage(rack));
  }

  /** T2c (cross-entité) : un équipement racké (migré) doit TENIR dans la profondeur dispo de sa baie. */
  static fits(eq: Record<string, any>, fetch: EntityFetcher): { path: string; message: string } | null {
    if (eq.placement_mode !== "rack" || !eq.rack_id || eq.depth_mm == null) return null;
    const rack = fetch("racks", eq.rack_id);
    if (!rack) return null;                                                        // baie absente → intégrité réf. ailleurs
    const limit = RackDepth.avail(rack, eq.rack_side === "rear" ? "rear" : "front");
    return eq.depth_mm <= limit ? null
      : { path: "depth_mm", message: `La profondeur (${eq.depth_mm} mm) dépasse l'espace disponible de la baie (${Math.round(limit)} mm${RackDepth.hasDoor(rack) ? ", marge de sécurité de porte déduite" : ""}).` };
  }

  /** V6d (portée) : DOS À DOS au même U (baie double, deux faces opposées non verrouillantes) —
      la somme des profondeurs ne doit pas dépasser l'espace partagé (cage + cavités). */
  static backToBack(eq: Record<string, any>, find: RecordFinder, fetch?: EntityFetcher): { path: string; message: string } | null {
    if (eq.placement_mode !== "rack" || !eq.rack_id || eq.rack_u == null || eq.depth_mm == null || !fetch) return null;
    if (eq.locks_u === true) return null;                                          // occupe les 2 faces → la collision U:face couvre
    const rack = fetch("racks", eq.rack_id);
    if (!rack || rack.sides !== "dual") return null;
    const side = eq.rack_side === "rear" ? "rear" : "front";
    const top = eq.rack_u | 0, height = Math.max(1, (eq.u_height | 0) || 1);
    const limit = RackDepth.shared(rack);
    for (const other of find("equipments", "rack_id", eq.rack_id)) {
      if (other.id === eq.id || other.placement_mode !== "rack" || other.rack_u == null) continue;
      const oLocks = other.locks_u === true || (other.depth_mm == null && other.depth === "full");
      if (oLocks || (other.rack_side === "rear" ? "rear" : "front") === side) continue;   // même face / verrouillant → couvert par la collision
      const oTop = other.rack_u | 0, oHeight = Math.max(1, (other.u_height | 0) || 1);
      if (oTop + oHeight <= top || top + height <= oTop) continue;                 // aucun U commun
      const sum = Math.max(1, eq.depth_mm | 0) + RackDepth.effDepth(other, rack);
      if (sum > limit) return { path: "depth_mm", message: `Dos-à-dos trop profond avec « ${other.name || other.id} » : ${sum} mm cumulés > ${Math.round(limit)} mm d'espace partagé dans la baie.` };
    }
    return null;
  }
}

/* ============================================================================
   ÉQUIPEMENT POSÉ SUR UNE ÉTAGÈRE (placement_mode "tray") — l'empreinte doit
   tenir dans la boîte utile du plateau, et deux colocataires ne doivent pas se
   chevaucher. Formules RÉPLIQUÉES de RackGeometry (trayBoxLocal /
   trayEquipFitsWhy) — duplication ASSUMÉE (shared/ auto-suffisant), à
   maintenir en parité. Le repère est le PLATEAU (x = largeur depuis le bord
   gauche, y = profondeur depuis la face de montage) → le chevauchement se
   calcule sans repère de baie.
   ============================================================================ */
const TRAY_U_MM = 44.45;          // = U_MM (front)
const TRAY_MOUNT_W = 482.6;       // = RACK_MOUNT_WIDTH (front)
const TRAY_LEN_FALLBACK = 450;    // = TRAY_DEPTH_DEFAULT_MM (front)
const TRAY_SHEET_RESERVE = 5;     // = TRAY_SHEET_RESERVE_MM (front) : tôle + renforts transversaux au ras du plateau
const TRAY_EAR = 15;              // = RACK_EAR_MM (front) : le plateau = corps 19″ (les oreilles s'accrochent aux rails)
const TRAY_STANDOFF = 3;          // = RACK_EAR_STANDOFF_MM (front) : le tray est posé DEVANT la cage (réserve d'oreilles)
const TRAY_GUSSET_CLEAR = 4;      // = TRAY_GUSSET_CLEARANCE_MM (front) : garde latérale des renforts (porte-à-faux)

class TrayFit {
  /** Empreinte au plateau (mm) — l'orientation 90/270 permute largeur/longueur (défauts 200×200×100). */
  private static footprint(eq: Record<string, any>): { w: number; d: number; h: number } {
    const fw = Math.max(1, eq.free_w_mm || 200), fl = Math.max(1, eq.free_l_mm || 200), fh = Math.max(1, eq.free_h_mm || 100);
    const o = (((+eq.dc_orientation || 0) % 360) + 360) % 360;
    return (o === 90 || o === 270) ? { w: fl, d: fw, h: fh } : { w: fw, d: fl, h: fh };
  }
  /** Plateau : largeur UTILISABLE (corps 19″ moins la garde des renforts en porte-à-faux), longueur
      effective, hauteur UTILE au-dessus = TOUTE la réservation moins la réserve de tôle (tray_u = pure
      indication de dessin, n'exclut rien). Parité RackGeometry.trayBoxLocal/trayLength. */
  private static plank(rack: Record<string, any>, tray: Record<string, any>): { W: number; L: number; availH: number } {
    const cage = RackDepth.cage(rack);
    const uh = Math.max(1, tray.u_height | 0 || 1);
    const cant = tray.tray_type === "cantilever";
    // dual : de plan de façade à plan de façade (cage + 2 réserves) — parité RackGeometry.trayLength
    const L = cant ? Math.min(Math.max(50, tray.depth_mm || TRAY_LEN_FALLBACK), cage) : cage + 2 * TRAY_STANDOFF;
    const inset = cant ? TRAY_GUSSET_CLEAR : 0;   // garde latérale réservée aux renforts
    return { W: TRAY_MOUNT_W - 2 * TRAY_EAR - 2 * inset, L, availH: uh * TRAY_U_MM - TRAY_SHEET_RESERVE };
  }
  /** Rect au plateau d'un équipement posé (position null = centré). */
  private static box(eq: Record<string, any>, plank: { W: number; L: number }): { x0: number; x1: number; y0: number; y1: number } {
    const fp = TrayFit.footprint(eq);
    const tx = (eq.tray_x != null) ? +eq.tray_x : Math.max(0, (plank.W - fp.w) / 2);
    const ty = (eq.tray_y != null) ? +eq.tray_y : Math.max(0, (plank.L - fp.d) / 2);
    return { x0: tx, x1: tx + fp.w, y0: ty, y1: ty + fp.d };
  }
  /** Contexte résolu (étagère + baie) d'un équipement posé — null si la règle ne s'applique pas. */
  private static ctx(eq: Record<string, any>, fetch?: EntityFetcher): { tray: Record<string, any>; rack: Record<string, any> } | null {
    if (eq.placement_mode !== "tray" || !eq.tray_item_id || !fetch) return null;
    const tray = fetch("rackItems", eq.tray_item_id);
    if (!tray || tray.kind !== "tray" || !tray.rack_id) return null;   // réf. absente/étrangère → autres règles
    const rack = fetch("racks", tray.rack_id);
    return rack ? { tray, rack } : null;
  }

  /** T2d (cross-entité) : l'équipement TIENT sur l'étagère (empreinte, position, hauteur réservée). */
  static fits(eq: Record<string, any>, fetch: EntityFetcher): { path: string; message: string } | null {
    if (eq.placement_mode === "tray" && eq.tray_item_id && fetch) {
      const tray = fetch("rackItems", eq.tray_item_id);
      if (tray && tray.kind !== "tray") return { path: "tray_item_id", message: "L'élément visé n'est pas une étagère (tray)." };
    }
    const c = TrayFit.ctx(eq, fetch);
    if (!c) return null;
    const plank = TrayFit.plank(c.rack, c.tray), fp = TrayFit.footprint(eq), b = TrayFit.box(eq, plank);
    if (plank.availH < 1) return { path: "tray_item_id", message: "Aucun espace réservé au-dessus du plateau (hauteur réservée = structure du tray)." };
    if (fp.h > plank.availH + 0.5) return { path: "free_h_mm", message: `Hauteur ${fp.h} mm > ${Math.round(plank.availH)} mm réservés au-dessus du plateau.` };
    if (b.x1 > plank.W + 0.5) return { path: "tray_x", message: `Dépasse le plateau en largeur (${Math.round(b.x1)} > ${Math.round(plank.W)} mm).` };
    if (b.y1 > plank.L + 0.5) return { path: "tray_y", message: `Dépasse le plateau en profondeur (${Math.round(b.y1)} > ${Math.round(plank.L)} mm).` };
    return null;
  }

  /** V6e (portée) : pas de CHEVAUCHEMENT entre équipements posés sur la MÊME étagère. */
  static overlap(eq: Record<string, any>, find: RecordFinder, fetch?: EntityFetcher): { path: string; message: string } | null {
    const c = TrayFit.ctx(eq, fetch);
    if (!c) return null;
    const plank = TrayFit.plank(c.rack, c.tray), me = TrayFit.box(eq, plank);
    for (const other of find("equipments", "tray_item_id", eq.tray_item_id)) {
      if (other.id === eq.id || other.placement_mode !== "tray") continue;
      const ob = TrayFit.box(other, plank);
      if (me.x0 < ob.x1 - 0.5 && ob.x0 < me.x1 - 0.5 && me.y0 < ob.y1 - 0.5 && ob.y0 < me.y1 - 0.5) {
        return { path: "tray_x", message: `Chevauche « ${other.name || other.id} » sur l'étagère.` };
      }
    }
    return null;
  }
}

/* ---- spécifications des collections (couverture 19/19 — cf. docs/validation.md) ---- */
export const COLLECTION_SPECS: Record<string, CollectionSpec> = {
  equipments: {
    fields: {
      name:           { type: "string", required: true, trim: true },   // identité : trimé (unicité fiable — V6g)
      type:           { type: "string", default: "switch" },
      depth:          { type: "string", enum: EQUIPMENT_DEPTHS, default: "full" },   // LEGACY passif (repli pré-migration)
      depth_mm:       { type: "number", nullable: true, default: null, min: 1 },     // profondeur RÉELLE (mm) — la seule saisie par l'UI
      locks_u:        { type: "boolean", default: false },                           // occupe les 2 faces (découplé de la profondeur)
      face_offset_mm: { type: "number", min: 0, default: 0 },                        // DÉBORD de façade au-delà des oreilles (rare)
      placement_mode: { type: "string", enum: EQUIPMENT_PLACEMENT_MODES, default: "manual" },
      u_height:       { type: "number", min: 1, default: 1 },
      u_width_mm:     { type: "number", nullable: true, default: null, min: 1 },   // largeur RÉELLE du boîtier U (null = pleine largeur)
      u_align:        { type: "string", enum: EQUIPMENT_U_ALIGNS, default: "center" },
      inventory_only: { type: "boolean", default: false },
      locked:         { type: "boolean", default: false },                           // positionnement verrouillé (vues 2D/3D) — cf. PlacementLock
      // GROUPES : `group_id` = groupe PRIMAIRE (pilote la couleur héritée) ⊂ `group_ids` (TOUS les groupes,
      // primaire + secondaires). Même modèle que cables.network_id ⊂ cables.network_ids (multi-valué + principal).
      group_id:       { type: "string", nullable: true, default: null, ref: "groups" },
      group_ids:      { type: "string[]", default: [], ref: "groups" },
      rack_id:        { type: "string", nullable: true, default: null, ref: "racks" },        // baie hôte (placement racké)
      dc_id:          { type: "string", nullable: true, default: null, ref: "datacenters" },  // salle hôte (placement libre)
      tray_item_id:   { type: "string", nullable: true, default: null, ref: "rackItems" },    // étagère hôte (placement posé)
      tray_x:         { type: "number", nullable: true, default: null, min: 0 },              // position sur la largeur du plateau (mm)
      tray_y:         { type: "number", nullable: true, default: null, min: 0 },              // profondeur depuis la face de montage (mm)
      pdu_max_a:      { type: "number", nullable: true, default: null },
      // CONSOMMATION (W) d'un équipement consommateur — courant dérivé de la tension du circuit (cf. Store).
      power_nominal_w: { type: "number", nullable: true, default: null, min: 0 },
      power_max_w:     { type: "number", nullable: true, default: null, min: 0 },
      // NB : les FK face_image_* visent le magasin d'images (hors modèle) → pas de `ref` (collection non modélisée).
    },
    invariants: [
      // T1 : PLACÉ à un U d'une baie (rack_u renseigné) ⇒ doit référencer une baie. On teste la POSITION
      // (rack_u), PAS le placement_mode : la convention app-wide est qu'un équipement U NON PLACÉ vit en
      // « pool » avec placement_mode "rack" + rack_id/rack_u null (cf. Store.unrackedEquipments, le retrait
      // de baie, le formulaire sans baie choisie). Tester placement_mode rejetait à tort cet état pool.
      { path: "rack_id", message: "Un équipement placé à un emplacement U doit référencer une baie.", holds: (eq) => eq.rack_u == null || !!eq.rack_id },
      // T1b : monté sur le FLANC (side) ou la PAROI (wall) d'une baie ⇒ doit référencer cette baie (rack_id).
      // Parité avec T1 : ces deux modes sont ancrés aux marges latérales d'une baie précise (cf. Equipment.ts) ;
      // un rack_id manquant est un état incohérent. (floor = plan d'étage via floor_x/y ; manual/dc_id = autres modes.)
      { path: "rack_id", message: "Un équipement monté sur le flanc ou la paroi d'une baie doit référencer une baie.", holds: (eq) => !["side", "wall"].includes(eq.placement_mode) || !!eq.rack_id },
      // T1c : posé sur une étagère ⇒ doit référencer l'étagère (rackItem).
      { path: "tray_item_id", message: "Un équipement posé sur une étagère doit référencer l'étagère (tray).", holds: (eq) => eq.placement_mode !== "tray" || !!eq.tray_item_id },
      // T1d : le groupe PRIMAIRE doit faire partie des groupes de l'équipement (parité avec le réseau principal
      // d'un câble, cf. cables.network_id ∈ network_ids). Garantit que la couleur héritée pointe un groupe membre.
      { path: "group_id", message: "Le groupe primaire doit faire partie des groupes de l'équipement.", holds: (eq) => !eq.group_id || (Array.isArray(eq.group_ids) && eq.group_ids.includes(eq.group_id)) },
      // T1e : la largeur d'un boîtier U rétréci reste STRICTEMENT dans le corps utile 19″ (les oreilles
      // s'étendent des rails jusqu'au boîtier — un boîtier plus large qu'elles serait incohérent).
      { path: "u_width_mm", message: `La largeur du boîtier U dépasse le corps utile 19″ (${EQUIPMENT_U_BODY_MAX_MM} mm max).`, holds: (eq) => eq.u_width_mm == null || eq.u_width_mm <= EQUIPMENT_U_BODY_MAX_MM },
    ],
    crossEntity: [
      // T2 : un équipement racké doit TENIR dans la hauteur de sa baie (U de tête + hauteur ≤ U de la baie).
      (eq, fetch) => {
        if (eq.placement_mode !== "rack" || !eq.rack_id || eq.rack_u == null) return null;
        const rack = fetch("racks", eq.rack_id);
        if (!rack || !rack.u_count) return null;   // baie absente / sans hauteur → couvert ailleurs
        const top = eq.rack_u | 0, height = Math.max(1, (eq.u_height | 0) || 1);
        return (top >= 1 && top + height - 1 <= rack.u_count) ? null
          : { path: "rack_u", message: `L'équipement (U${top}${height > 1 ? "–" + (height - 1 + top) : ""}) dépasse la baie (${rack.u_count} U).` };
      },
      // T2c : la PROFONDEUR (mm) doit tenir dans l'espace disponible de la baie (portes/cavités/sécurité incluses).
      (eq, fetch) => RackDepth.fits(eq, fetch),
      // T2d : un équipement POSÉ tient sur son étagère (empreinte, position, hauteur réservée).
      (eq, fetch) => TrayFit.fits(eq, fetch),
    ],
    scope: [
      // V6g : NOM d'équipement UNIQUE dans le document (post-trim, comparaison EXACTE). MÊME mécanisme que
      // l'unicité d'adresse IP (V6a) : lecture par `find` (conscient du lot), l'entité s'EXCLUANT elle-même (`id`).
      // La casse reste DISCRIMINANTE ici : deux équipements « srv37 »/« SRV37 » restent légaux — l'ambiguïté de
      // casse est traitée par le RAPPROCHEMENT d'hôte VM (insensible à la casse), jamais par l'unicité.
      (eq, find) => {
        if (!eq.name) return null;
        const duplicate = find("equipments", "name", eq.name).some((other) => other.id !== eq.id);
        return duplicate ? { path: "name", message: `Le nom « ${eq.name} » est déjà utilisé par un autre équipement.` } : null;
      },
      // V6c : pas de collision de U avec un autre occupant de la baie.
      (eq, find, fetch) => RackOccupancy.collision(eq, "equipments", find, fetch),
      // V6d : dos-à-dos au même U — somme des profondeurs ≤ espace partagé (cage + cavités).
      (eq, find, fetch) => RackDepth.backToBack(eq, find, fetch),
      // V6e : pas de chevauchement entre équipements posés sur la MÊME étagère.
      (eq, find, fetch) => TrayFit.overlap(eq, find, fetch),
    ],
    // V5b (P4a) : re-typer un équipement en « patch_panel » par API/import alors que ses ports assertent un réseau
    // les laisserait porteurs → contamine la déduction (T7 : un patch n'assert rien). On re-valide donc ses ports au
    // changement d'équipement (T7 rejoué contre le nouveau type). L'UI, elle, vide les ports AVANT cet update (le save
    // du formulaire pré-vide les ports persistés au passage patch — cf. EquipmentForms.onSave).
    // V5b (T11 inverse) : re-typer un PATCH en autre chose alors qu'un faisceau s'y termine invaliderait le trunk en
    // silence → re-valider les faisceaux ancrés sur cet équipement (T11 rejoué contre le nouveau type), par extrémité.
    dependents: [
      { collection: "ports", fkField: "equipment_id" },
      { collection: "cableBundles", fkField: "endpoint_a_equipment_id" },
      { collection: "cableBundles", fkField: "endpoint_b_equipment_id" },
    ],
  },
  cables: {
    fields: {
      cable_type_id: { type: "string", nullable: true, default: null, ref: "cableTypes" },
      from_port_id:  { type: "string", nullable: true, default: null, ref: "ports" },
      to_port_id:    { type: "string", nullable: true, default: null, ref: "ports" },
      network_ids:   { type: "string[]", default: [], ref: "networks" },
      network_id:    { type: "string", nullable: true, default: null, ref: "networks" },
      waypoint_ids:  { type: "string[]", default: [], ref: "waypoints" },
      length_m:      { type: "number", nullable: true, default: null, min: 0 },
      status:        { type: "string", required: true, enum: CABLE_STATUS_IDS, default: "brouillon" },
      // NB : l'ancien mécanisme « câble-brin » (bundle_id/strand_no sur le câble) a été RETIRÉ — les brins d'un
      // faisceau sont piochés par les PORTS de patch (Port.bundle_id/strand_a/strand_b), source unique.
    },
    invariants: [
      {
        path: "to_port_id",
        message: "Un câble ne peut pas relier un port à lui-même.",
        holds: (cable) => !(cable.from_port_id && cable.to_port_id && cable.from_port_id === cable.to_port_id),
      },
      {
        path: "network_id",
        message: "Le réseau principal doit faire partie des réseaux du câble.",
        holds: (cable) => !cable.network_id || (Array.isArray(cable.network_ids) && cable.network_ids.includes(cable.network_id)),
      },
    ],
    crossEntity: [
      // T9 : un câble d'ALIMENTATION relie une SOURCE à un SINK. Si les 2 ports ont un sens power identique
      //      (source↔source, sink↔sink), le lien est physiquement faux — et l'analyse énergie l'ignorerait en
      //      silence (charges fausses, faux « non alimenté »). On le refuse à l'écriture (front + serveur/import).
      //      SOURCE DE VÉRITÉ de la règle : CableForms la pré-vérifie (message clair, cf. son onSave) et
      //      `ports.dependents` la REJOUE si on change la direction d'un port déjà câblé.
      (cable, fetch) => {
        if (!cable.from_port_id || !cable.to_port_id) return null;
        const a = fetch("ports", cable.from_port_id), b = fetch("ports", cable.to_port_id);
        if (!a || !b) return null;
        const da = a.direction, db = b.direction;
        const bothPower = (da === "source" || da === "sink") && (db === "source" || db === "sink");
        return (bothPower && da === db) ? { path: "to_port_id", message: "Un câble d'alimentation relie une source à un sink (pas deux prises de même sens)." } : null;
      },
    ],
    scope: [
      // PORTÉE (V6b) : 1 câble par port — aucun AUTRE câble ne référence ce port (côté `from` OU `to`).
      (cable, find) => {
        for (const [path, portId] of [["from_port_id", cable.from_port_id], ["to_port_id", cable.to_port_id]] as const) {
          if (!portId) continue;
          const usingPort = [...find("cables", "from_port_id", portId), ...find("cables", "to_port_id", portId)];
          if (usingPort.some((other) => other.id !== cable.id)) return { path, message: "Ce port est déjà relié par un autre câble (1 câble par port)." };
        }
        return null;
      },
    ],
  },
  racks: {
    fields: {
      name:          { type: "string", required: true },
      location:      { type: "string", default: "" },
      u_count:       { type: "number", min: 1, default: 42 },
      width_mm:      { type: "number", min: 1 },
      depth:         { type: "number", min: 1 },
      sides:         { type: "string", enum: RACK_SIDE_CONFIGS, default: "single" },
      has_caps:      { type: "boolean", default: true },   // habillage toit/fond — false = châssis OUVERT
      locked:        { type: "boolean", default: false },  // positionnement verrouillé (vues 2D/3D) — cf. PlacementLock
      datacenter_id: { type: "string", nullable: true, default: null, ref: "datacenters" },
      dc_x:          { type: "number", nullable: true, default: null },
      dc_y:          { type: "number", nullable: true, default: null },
    },
    invariants: [
      // T3 : une baie SANS capots (châssis ouvert) ne peut pas porter de portes (rien où les fixer).
      { path: "has_caps", message: "Une baie sans capots ne peut pas avoir de portes.", holds: (r) => r.has_caps !== false || !((r.door_front && r.door_front.enabled) || (r.door_rear && r.door_rear.enabled)) },
      // T3b : sans capots ⇒ pas d'emplacements waypoint sur le TOIT (les pins/brosses se posent SUR le capot).
      //       Le SOL (floor_cells) reste autorisé : le fond ouvert peut être traversé par un waypoint (faux-plancher).
      { path: "has_caps", message: "Une baie sans capots ne peut pas avoir d'emplacements waypoint sur le toit.", holds: (r) => r.has_caps !== false || !(Array.isArray(r.roof_cells) && r.roof_cells.length) },
    ],
    crossEntity: [
      // T2 : baie posée dans une salle ⇒ sa position doit tomber DANS les bornes de la salle.
      (rack, fetch) => {
        if (!rack.datacenter_id || rack.dc_x == null || rack.dc_y == null) return null;
        const dc = fetch("datacenters", rack.datacenter_id);
        if (!dc) return null;
        const width = dc.width_mm || 0, depth = dc.depth_mm || 0;
        return (rack.dc_x >= 0 && rack.dc_x <= width && rack.dc_y >= 0 && rack.dc_y <= depth) ? null
          : { path: "dc_x", message: `La position (${rack.dc_x}, ${rack.dc_y}) mm est hors de la salle (${width}×${depth} mm).` };
      },
    ],
    scope: [
      // V6f : convertir une baie en « sans capots » exige qu'AUCUN waypoint ne soit encore posé sur son TOIT
      // (sinon le pin perd son support — retirer d'abord les waypoints du capot supérieur).
      (rack, find) => {
        if (rack.has_caps !== false) return null;
        const onRoof = find("waypoints", "rack_id", rack.id).some((w) => w.cap_face === "roof");
        return onRoof ? { path: "has_caps", message: "Retirez d'abord les waypoints posés sur le toit avant de passer la baie « sans capots »." } : null;
      },
    ],
  },

  /* ---- collections ÉTENDUES — specs PARTIELLES : champs d'identité, énumérations, et surtout les FK (`ref`). ---- */
  ports: {
    fields: {
      name:           { type: "string" },
      equipment_id:   { type: "string", nullable: true, default: null, ref: "equipments" },
      port_type_id:   { type: "string", nullable: true, default: null, ref: "portTypes" },
      parent_port_id: { type: "string", nullable: true, default: null, ref: "ports" },
      aggregate_id:   { type: "string", nullable: true, default: null, ref: "aggregates" },
      face_side:      { type: "string", enum: EQUIPMENT_FACE_IDS, default: "front" },
      // TERMINAISON DE FAISCEAU (ports de patch) : quel faisceau, quels brins physiques piochés.
      bundle_id:      { type: "string", nullable: true, default: null, ref: "cableBundles" },
      strand_a:       { type: "number", nullable: true, default: null, min: 1 },
      strand_b:       { type: "number", nullable: true, default: null, min: 1 },
      // RÉSEAU asserté par un port TERMINAL (source unique ; déduit ailleurs). Vide = joker.
      network_ids:    { type: "string[]", default: [], ref: "networks" },
      network_id:     { type: "string", nullable: true, default: null, ref: "networks" },
      // POWER : sens de l'énergie, plafond de courant (A), phase (départ de tableau). Enum souples (vide toléré).
      direction:      { type: "string", default: "", enum: ["", "source", "sink"] },
      power_max_a:    { type: "number", nullable: true, default: null, min: 0 },
      phase:          { type: "string", default: "", enum: ["", "L1", "L2", "L3"] },
    },
    invariants: [
      // T1 : position de façade complète (X ET Y) ou absente (aucun des deux).
      { path: "face_y", message: "La position de façade doit avoir X et Y (ou aucun des deux).", holds: (p) => (p.face_x == null) === (p.face_y == null) },
      // T4 : on ne pioche des brins que si un faisceau est désigné.
      { path: "bundle_id", message: "Un brin ne peut être affecté sans faisceau désigné.", holds: (p) => !!p.bundle_id || (p.strand_a == null && p.strand_b == null) },
      // T4b : le 2e brin (duplex) n'existe pas sans le 1er.
      { path: "strand_b", message: "Le second brin (Rx) nécessite un premier brin (Tx).", holds: (p) => p.strand_b == null || p.strand_a != null },
      // T4c : une même fibre physique ne peut pas être à la fois Tx ET Rx d'un port.
      { path: "strand_b", message: "Les deux brins d'un port duplex doivent être distincts.", holds: (p) => p.strand_b == null || p.strand_b !== p.strand_a },
      // T5 : le réseau principal du port doit faire partie de ses réseaux (miroir de la règle câble).
      { path: "network_id", message: "Le réseau principal doit faire partie des réseaux du port.", holds: (p) => !p.network_id || (Array.isArray(p.network_ids) && p.network_ids.includes(p.network_id)) },
      // T8 : une phase ne se déclare que sur un départ (source) — pas sur un sink.
      { path: "phase", message: "La phase ne s'applique qu'à un port source (départ).", holds: (p) => !p.phase || p.direction === "source" },
    ],
    crossEntity: [
      // T2 : un port-lane et son port PARENT (breakout) appartiennent au même équipement.
      (port, fetch) => {
        if (!port.parent_port_id || !port.equipment_id) return null;
        const parent = fetch("ports", port.parent_port_id);
        return (parent && parent.equipment_id && parent.equipment_id !== port.equipment_id)
          ? { path: "parent_port_id", message: "Le port parent doit appartenir au même équipement." } : null;
      },
      // T2 : un port et son AGRÉGAT (LAG) appartiennent au même équipement.
      (port, fetch) => {
        if (!port.aggregate_id || !port.equipment_id) return null;
        const aggregate = fetch("aggregates", port.aggregate_id);
        return (aggregate && aggregate.equipment_id && aggregate.equipment_id !== port.equipment_id)
          ? { path: "aggregate_id", message: "L'agrégat doit appartenir au même équipement." } : null;
      },
      // T6 : les brins piochés ne dépassent pas la capacité (fiber_count) du faisceau.
      (port, fetch) => {
        if (!port.bundle_id || (port.strand_a == null && port.strand_b == null)) return null;
        const bundle = fetch("cableBundles", port.bundle_id);
        if (!bundle || bundle.fiber_count == null) return null;
        const over = PortStrands.of(port).find((v) => v > bundle.fiber_count);
        return over != null ? { path: "strand_a", message: `Un brin (${over}) dépasse la capacité du faisceau (${bundle.fiber_count} fibres).` } : null;
      },
      // T7 : un port d'un équipement PATCH n'assert JAMAIS de réseau (il le DÉDUIT) — sinon la déduction serait
      //      contaminée par une fausse assertion (write API/import). La source du réseau vit sur les ports actifs.
      (port, fetch) => {
        if (!port.equipment_id || !(Array.isArray(port.network_ids) && port.network_ids.length)) return null;
        const eq = fetch("equipments", port.equipment_id);
        return (eq && eq.type === "patch_panel") ? { path: "network_ids", message: "Un port de patch ne porte pas de réseau (il le déduit du chemin)." } : null;
      },
    ],
    scope: [
      // V6 : dans un faisceau, un brin PHYSIQUE n'est pioché qu'une fois PAR EXTRÉMITÉ (équipement). Deux ports du
      //      MÊME patch sur le même brin fusionneraient à tort deux circuits dans la déduction réseau (arête « même
      //      fibre » entre eux, alors qu'une fibre n'a que 2 bouts, un par extrémité du trunk).
      (port, find) => {
        if (!port.bundle_id) return null;
        const mine = PortStrands.of(port);
        if (!mine.length) return null;
        // collision avec un AUTRE PORT de la MÊME extrémité (équipement).
        for (const other of find("ports", "bundle_id", port.bundle_id)) {
          if (other.id === port.id || other.equipment_id !== port.equipment_id) continue;
          const theirs = PortStrands.of(other);
          if (mine.some((s) => theirs.includes(s))) return { path: "strand_a", message: "Ce brin est déjà pioché par un autre port de ce patch." };
        }
        return null;
      },
    ],
    // V5b (P4c) : changer la `direction` d'un port CÂBLÉ par API/import peut créer un lien source↔source / sink↔sink
    // PERSISTANT → re-valider les câbles branchés sur ce port (crossEntity T9). Un port est référencé par `from_port_id`
    // OU `to_port_id` : deux déclarations (le mécanisme dependents est mono-champ). Sans ça, T9 ne tourne qu'à
    // l'écriture du CÂBLE, jamais au changement de direction du port (trou serveur/import — la garde n'existe qu'en UI).
    dependents: [
      { collection: "cables", fkField: "from_port_id" },
      { collection: "cables", fkField: "to_port_id" },
    ],
  },
  aggregates: {
    fields: {
      name:         { type: "string" },
      equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
    },
  },
  networks: {
    fields: {
      label:         { type: "string", required: true },
      kind:          { type: "string", enum: DATA_OR_POWER, default: "data" },
      power_source:  { type: "string", nullable: true, default: null, enum: POWER_SOURCES },
      ip_network_id: { type: "string", nullable: true, default: null, ref: "ipNetworks" },
    },
    invariants: [
      {
        path: "ip_network_id",
        message: "Un réseau d'énergie (power) ne peut pas être rattaché à un réseau IP.",
        holds: (network) => network.kind !== "power" || !network.ip_network_id,
      },
    ],
  },
  groups: {
    fields: {
      label: { type: "string", required: true },
      type:  { type: "string", enum: GROUP_TYPE_IDS },
    },
  },
  rackItems: {
    fields: {
      label:     { type: "string" },
      rack_id:   { type: "string", nullable: true, default: null, ref: "racks" },
      kind:      { type: "string", enum: RACK_ITEM_KIND_IDS, default: "blank" },
      side:      { type: "string", enum: RACK_OCCUPANT_SIDES, default: "front" },
      u_height:  { type: "number", min: 1, default: 1 },
      // configuration TRAY (étagère) — sans effet pour les autres kinds
      tray_type: { type: "string", enum: TRAY_TYPE_IDS, default: "dual" },
      tray_u:    { type: "number", min: 1, default: 1 },
      depth_mm:  { type: "number", nullable: true, default: null, min: 1 },
    },
    invariants: [
      // TRAY : la structure (tray_u) tient dans la hauteur totale RÉSERVÉE (u_height).
      { path: "tray_u", message: "La hauteur du tray (structure) dépasse la hauteur réservée totale.", holds: (it) => it.kind !== "tray" || Math.max(1, it.tray_u | 0) <= Math.max(1, it.u_height | 0) },
    ],
    // V6c : pas de collision de U avec un autre occupant de la baie.
    scope: [(item, find, fetch) => RackOccupancy.collision(item, "rackItems", find, fetch)],
  },
  portTypes: {
    fields: {
      name:   { type: "string" },
      kind:   { type: "string", enum: DATA_OR_POWER, default: "data" },
      duplex: { type: "boolean", default: false },
    },
  },
  cableTypes: {
    fields: {
      name: { type: "string" },
      kind: { type: "string", enum: DATA_OR_POWER, default: "data" },
    },
  },
  cableBundles: {
    fields: {
      name:                    { type: "string" },
      cable_type_id:           { type: "string", nullable: true, default: null, ref: "cableTypes" },
      waypoint_ids:            { type: "string[]", default: [], ref: "waypoints" },
      // 2 extrémités (des PATCHS — T11) où le trunk est terminé — cf. Port.bundle_id (affectation des brins).
      endpoint_a_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
      endpoint_b_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
    },
    invariants: [
      // T10 : un faisceau relie deux équipements DISTINCTS (miroir du self-loop câble). Un trunk bouclé sur le
      // même patch n'a pas de sens physique (le pool de brins relierait un équipement à lui-même) et casserait
      // la déduction réseau (arête BRIN intra-équipement).
      {
        path: "endpoint_b_equipment_id",
        message: "Un faisceau ne peut pas relier un patch à lui-même.",
        holds: (bundle) => !(bundle.endpoint_a_equipment_id && bundle.endpoint_b_equipment_id && bundle.endpoint_a_equipment_id === bundle.endpoint_b_equipment_id),
      },
    ],
    crossEntity: [
      // T11 : les extrémités d'un faisceau sont des PATCHS (type "patch_panel"). Le modèle faisceau repose
      // dessus : les brins sont piochés par des PORTS DE PATCH (arête BRIN de la déduction réseau, T4/T6/V6),
      // et le rendu ancre le trunk sur l'uplink du patch (centre de la face arrière). Un équipement d'un autre
      // type comme extrémité rendrait ces mécanismes incohérents. Une règle PAR extrémité (chemin d'erreur ciblé).
      // NB : l'équipement re-typé APRÈS coup est couvert par la dépendance inverse `equipments.dependents`.
      ...(["endpoint_a_equipment_id", "endpoint_b_equipment_id"] as const).map((path): CrossEntityRule =>
        (bundle, fetch) => {
          if (!bundle[path]) return null;
          const eq = fetch("equipments", bundle[path]);
          return (eq && eq.type !== "patch_panel")
            ? { path, message: "L'extrémité d'un faisceau doit être un patch panel." }
            : null;
        }),
    ],
    // V5b (P4b) : réduire `fiber_count` par API/import peut faire tomber des brins de port HORS plage → re-valider les
    // ports du faisceau (crossEntity T6 : brin ≤ fiber_count). En UI c'est déjà gardé (CableForms refuse de descendre
    // sous le n° max pioché) ; ceci ferme le même trou côté serveur/import (où la garde UI n'existe pas).
    dependents: [
      { collection: "ports", fkField: "bundle_id" },
    ],
  },
  datacenters: {
    fields: {
      name: { type: "string", required: true },
    },
  },
  waypoints: {
    fields: {
      name:          { type: "string" },
      kind:          { type: "string", enum: WAYPOINT_KINDS, default: "point" },
      wp_type:       { type: "string", enum: WAYPOINT_TYPES, default: "datacenter" },
      locked:        { type: "boolean", default: false },   // positionnement verrouillé (vues 2D/3D) — cf. PlacementLock
      rack_id:       { type: "string", nullable: true, default: null, ref: "racks" },
      datacenter_id: { type: "string", nullable: true, default: null, ref: "datacenters" },
    },
    invariants: [
      // T1 : une brosse est montée DANS une baie (rack_id obligatoire pour ce genre).
      { path: "rack_id", message: "Une brosse doit être montée dans une baie.", holds: (wp) => wp.kind !== "brush" || !!wp.rack_id },
    ],
    crossEntity: [
      // T2 : un waypoint posé sur le TOIT d'une baie exige que la baie ait des capots (le pin se pose SUR le capot).
      // Le SOL reste autorisé sur une baie sans capots (fond ouvert traversé par le waypoint).
      (wp, fetch) => {
        if (wp.cap_face !== "roof" || !wp.rack_id) return null;
        const rack = fetch("racks", wp.rack_id);
        return (rack && rack.has_caps === false) ? { path: "cap_face", message: "Cette baie est sans capots : aucun waypoint ne peut être posé sur son toit." } : null;
      },
    ],
    // V6c : une brosse ne doit pas collisionner d'autres occupants de la baie.
    scope: [(wp, find, fetch) => RackOccupancy.collision(wp, "waypoints", find, fetch)],
  },
  floors: {
    fields: {
      location: { type: "string" },
    },
  },
  ipNetworks: {
    fields: {
      label:          { type: "string", required: true },
      cidr:           { type: "string", required: true, format: "cidr" },
      gateway:        { type: "string", nullable: true, default: null, format: "ipv4" },   // passerelle (∈ CIDR — invariant ci-dessous)
      dns_servers:    { type: "string[]", default: [] },                                    // résolveurs DNS (IPv4, HORS CIDR admis — cf. invariant)
      dhcp_server_id: { type: "string", nullable: true, default: null, ref: "equipments" }, // serveur DHCP du réseau (parité dhcpRanges.server_id)
    },
    invariants: [
      // La passerelle (si définie) est l'interface locale du routeur → DOIT appartenir au sous-réseau.
      { path: "gateway", message: "La passerelle doit appartenir au sous-réseau.", holds: (n) => {
          if (!n.gateway) return true;
          const cidr = Ipv4.parseCidr(n.cidr), ip = Ipv4.toInt(n.gateway);
          return ip == null || cidr == null ? true : Ipv4.inCidr(ip, cidr);   // format/CIDR invalides déjà signalés par leurs propres contrôles
        } },
      // Chaque serveur DNS doit être une IPv4 valide — le moteur ne valide PAS le format élément par élément d'un
      // `string[]`, on le fait donc ici. Pas de contrainte ∈ CIDR (les résolveurs externes sont hors sous-réseau).
      { path: "dns_servers", message: "Chaque serveur DNS doit être une adresse IPv4 valide.", holds: (n) => !Array.isArray(n.dns_servers) || n.dns_servers.every((ip) => typeof ip === "string" && Ipv4.toInt(ip) != null) },
    ],
    // V5b : changer le CIDR d'un réseau peut faire sortir ses adresses/plages → re-valider ces enfants.
    dependents: [
      { collection: "ipAddresses", fkField: "network_id" },
      { collection: "dhcpRanges", fkField: "network_id" },
    ],
  },
  ipAddresses: {
    fields: {
      address:      { type: "string", required: true, format: "ipv4" },
      network_id:   { type: "string", nullable: true, default: null, ref: "ipNetworks" },
      equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
      // rattachement à une VM (parité equipment_id) — FK contrôlée (V2) et détachée en cascade (Cascade.vms).
      vm_id:        { type: "string", nullable: true, default: null, ref: "vms" },
    },
    invariants: [
      // EXCLUSIVITÉ SOUPLE : une adresse vise un ÉQUIPEMENT **ou** une VM, jamais les deux. Invariant INTRA-champs
      // (dépend de equipment_id ET vm_id du même enregistrement) — souple : les DEUX vides restent permis (adresse
      // simplement « non attribuée », cf. cadrage décision 4 : rapprochement informatif, pas de rattachement forcé).
      { path: "vm_id", message: "Une adresse IP vise un équipement OU une VM, pas les deux (equipment_id et vm_id mutuellement exclusifs).", holds: (addr) => !(addr.equipment_id && addr.vm_id) },
    ],
    crossEntity: [
      // CROSS-ENTITÉ (V5) : l'adresse doit appartenir au sous-réseau de SON réseau IP (lecture du `cidr` du réseau lié).
      (addr, fetch) => {
        if (!addr.network_id) return null;                                  // pas de réseau → règle non applicable
        const network = fetch("ipNetworks", addr.network_id);
        const cidr = network ? Ipv4.parseCidr(network.cidr) : null;
        if (!cidr) return null;                                             // réseau absent / CIDR invalide → déjà couvert ailleurs
        return Ipv4.inCidr(Ipv4.toInt(addr.address), cidr) ? null
          : { path: "address", message: `L'adresse ${addr.address} n'appartient pas au sous-réseau ${network!.cidr}.` };
      },
    ],
    scope: [
      // PORTÉE (V6a) : adresse UNIQUE dans le document (aucune autre adresse n'a la même valeur).
      (addr, find) => {
        if (!addr.address) return null;
        const duplicate = find("ipAddresses", "address", addr.address).some((other) => other.id !== addr.id);
        return duplicate ? { path: "address", message: `L'adresse ${addr.address} est déjà attribuée.` } : null;
      },
      // PORTÉE (V6b) : l'adresse statique ne doit pas tomber DANS une plage DHCP de son réseau.
      (addr, find) => {
        if (!addr.network_id) return null;
        const ip = Ipv4.toInt(addr.address);
        if (ip == null) return null;
        for (const range of find("dhcpRanges", "network_id", addr.network_id)) {
          const start = Ipv4.toInt(range.start_ip), end = Ipv4.toInt(range.end_ip);
          if (start != null && end != null && ip >= start && ip <= end) return { path: "address", message: `L'adresse est dans la plage DHCP ${range.start_ip}→${range.end_ip}.` };
        }
        return null;
      },
    ],
  },
  dhcpRanges: {
    fields: {
      start_ip:   { type: "string", required: true, format: "ipv4" },
      end_ip:     { type: "string", required: true, format: "ipv4" },
      network_id: { type: "string", nullable: true, default: null, ref: "ipNetworks" },
      server_id:  { type: "string", nullable: true, default: null, ref: "equipments" },
    },
    invariants: [
      {
        path: "end_ip",
        message: "La fin de plage doit être ≥ au début.",
        holds: (range) => {
          const start = Ipv4.toInt(range.start_ip), end = Ipv4.toInt(range.end_ip);
          return start == null || end == null || start <= end;   // bornes invalides → déjà signalées par le format
        },
      },
    ],
    crossEntity: [
      // CROSS-ENTITÉ (V5) : les deux bornes doivent appartenir au sous-réseau du réseau IP rattaché.
      (range, fetch) => {
        if (!range.network_id) return null;
        const network = fetch("ipNetworks", range.network_id);
        const cidr = network ? Ipv4.parseCidr(network.cidr) : null;
        if (!cidr) return null;
        for (const field of ["start_ip", "end_ip"] as const) {
          if (!Ipv4.inCidr(Ipv4.toInt(range[field]), cidr)) return { path: field, message: `La borne ${range[field]} n'appartient pas au sous-réseau ${network!.cidr}.` };
        }
        return null;
      },
    ],
    scope: [
      // PORTÉE (V6b) : pas de CHEVAUCHEMENT avec une autre plage du même réseau ; pas d'IP STATIQUE dans l'intervalle.
      (range, find) => {
        if (!range.network_id) return null;
        const start = Ipv4.toInt(range.start_ip), end = Ipv4.toInt(range.end_ip);
        if (start == null || end == null) return null;   // format déjà signalé en amont
        for (const other of find("dhcpRanges", "network_id", range.network_id)) {
          if (other.id === range.id) continue;
          const os = Ipv4.toInt(other.start_ip), oe = Ipv4.toInt(other.end_ip);
          if (os != null && oe != null && start <= oe && os <= end) return { path: "start_ip", message: `Chevauche la plage ${other.start_ip}→${other.end_ip}.` };
        }
        for (const addr of find("ipAddresses", "network_id", range.network_id)) {
          const ip = Ipv4.toInt(addr.address);
          if (ip != null && ip >= start && ip <= end) return { path: "start_ip", message: `L'adresse statique ${addr.address} est dans cette plage.` };
        }
        return null;
      },
    ],
  },
  spares: {
    fields: {
      name:                  { type: "string" },
      type:                  { type: "string", enum: SPARE_TYPE_IDS },
      status:                { type: "string", enum: SPARE_STATUS_IDS },
      assigned_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
    },
  },
  sites: {
    fields: {
      name:    { type: "string", required: true },
      address: { type: "string" },
    },
  },
  vms: {
    fields: {
      name:              { type: "string", required: true },
      // vm_type / status TOLÉRANTS : PAS de contrainte `enum` — une valeur inconnue (nouveau type/statut d'une
      // release Proxmox) est ACCEPTÉE telle quelle (résilience : le pivot isole l'app, on ne rejette pas une nouveauté).
      vm_type:           { type: "string", default: "qemu" },
      status:            { type: "string", default: "" },
      provider_id:       { type: "string", default: "" },
      // hôte hébergeur (champ LOCAL) — FK vers un équipement, détachée en cascade (cf. Cascade.equipments).
      host_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
      // GROUPES (champs LOCAUX) : PARITÉ STRICTE avec la spec equipments — primaire `group_id` ⊂ `group_ids`
      // (TOUS les groupes), FK contrôlées (V2) et détachées en cascade (Cascade.groups balaie aussi vms).
      group_id:          { type: "string", nullable: true, default: null, ref: "groups" },
      group_ids:         { type: "string[]", default: [], ref: "groups" },
    },
    invariants: [
      // Chaque IP d'une vNIC doit être une IPv4 valide : le moteur ne valide PAS élément par élément un tableau
      // d'OBJETS (`nics`), on le fait donc ici — même style que l'invariant `ipNetworks.dns_servers`.
      { path: "nics", message: "Chaque adresse IP d'une vNIC doit être une adresse IPv4 valide.", holds: (vm) =>
          !Array.isArray(vm.nics) || vm.nics.every((nic: any) => !nic || !Array.isArray(nic.ips) || nic.ips.every((ip: any) => typeof ip === "string" && Ipv4.toInt(ip) != null)) },
      // Parité equipments (T1d) : le groupe primaire doit être MEMBRE de group_ids. La cascade groups repointe le
      // primaire en cohérence ; l'invariant garantit qu'aucune écriture (API/import) ne casse la relation.
      { path: "group_id", message: "Le groupe primaire doit faire partie des groupes de la VM.", holds: (vm) => !vm.group_id || (Array.isArray(vm.group_ids) && vm.group_ids.includes(vm.group_id)) },
    ],
  },
  contacts: {
    // Carnet de destinataires des NOTIFICATIONS (email/sms), tenu PAR DOCUMENT — cf. Contact.ts / cadrage
    // notifications 2026-07-14 §2 (Q4). AUCUNE FK (`ref`) : rien dans le document ne pointe vers un contact
    // (le lien abonnement→contact est une référence souple `contact_id` HORS document), d'où l'absence de
    // cascade et d'index secondaire. `name` est le seul champ REQUIS ; `email`/`phone` sont validés EN DOUCEUR.
    fields: {
      name:  { type: "string", required: true, trim: true },   // identité du contact — trimée (fiabilise le libellé)
      email: { type: "string", trim: true },                   // optionnel — format contrôlé en douceur (invariant)
      phone: { type: "string", trim: true },                   // optionnel — quasi libre (invariant)
      notes: { type: "string" },                               // notes libres (multi-lignes) — aucune contrainte
    },
    invariants: [
      // E-MAIL TOLÉRANT (décision utilisateur : « valider en douceur ») — on ne contrôle le format QUE s'il est
      // renseigné, et on ne refuse que ce qui est CLAIREMENT invalide (pas de « @ » entouré de parties non vides
      // sans espace). Un vide passe (champ optionnel) ; « nom@exemple.test » passe ; « pasunemail » (aucun @) est
      // refusé. On reste VOLONTAIREMENT permissif — un hôte interne sans TLD (« ops@intranet ») est accepté : le
      // but est de ne JAMAIS bloquer une saisie raisonnable, pas d'imposer la RFC 5322.
      { path: "email", message: "L'adresse e-mail semble invalide (format attendu : nom@domaine).", holds: (c) => !c.email || /^[^\s@]+@[^\s@]+$/.test(String(c.email)) },
      // TÉLÉPHONE quasi libre : chiffres, « + », espaces, points, tirets, parenthèses (numéros internationaux,
      // extensions, séparateurs de lisibilité). On ne refuse qu'un contenu HORS de ce jeu (typiquement des
      // lettres). Un vide passe (champ optionnel). Reste tolérant par principe (cf. e-mail ci-dessus).
      { path: "phone", message: "Le téléphone ne doit contenir que des chiffres et les séparateurs + . - ( ) et espaces.", holds: (c) => !c.phone || /^[0-9+\s().-]+$/.test(String(c.phone)) },
    ],
  },
};

/* ============================================================================
   DataValidator — normalisation + validation (niveaux V1/V2/V3/V5/V5b).
   ============================================================================ */
export class DataValidator {
  /** `true` si une spécification existe pour cette collection (sinon : ni normalisation ni validation). */
  static hasSpec(collection: string): boolean {
    return collection in COLLECTION_SPECS;
  }

  /* ---- normalisation ---- */
  /** Renvoie une COPIE normalisée de `record` selon la spec de `collection`. Les champs non déclarés
      traversent inchangés (specs partielles) ; sans spec, l'enregistrement est renvoyé tel quel. */
  static normalizeRecord(collection: string, record: Record<string, any>): Record<string, any> {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) return { ...record };
    const normalized: Record<string, any> = { ...record };
    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      normalized[field] = DataValidator.normalizeField(record[field], fieldSpec);
    }
    return normalized;
  }

  /* ---- validation ---- */
  /** Valide un enregistrement (supposé déjà normalisé) contre la spec de sa collection. Renvoie la liste des
      erreurs (vide = valide). Sans spec → aucune erreur. Si `fetch` est fourni, ajoute l'INTÉGRITÉ RÉFÉRENTIELLE
      (FK existantes — V2) et les règles CROSS-ENTITÉ (d'après les données de l'entité liée — V5). */
  static validateRecord(collection: string, record: Record<string, any>, fetch?: EntityFetcher, find?: RecordFinder): ValidationError[] {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) return [];
    const errors: ValidationError[] = [];
    const id = typeof record.id === "string" ? record.id : undefined;
    const fail = (path: string, code: ValidationError["code"], message: string) =>
      errors.push({ collection, id, path, code, message });

    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      const value = record[field];

      if (DataValidator.isEmpty(value)) {
        if (fieldSpec.required) fail(field, "required", `Le champ « ${field} » est obligatoire.`);
        continue;   // vide non requis → rien d'autre à vérifier
      }
      if (value === null) {
        if (!fieldSpec.nullable) fail(field, "type", `Le champ « ${field} » ne peut pas être null.`);
        continue;
      }
      if (!DataValidator.matchesType(value, fieldSpec.type)) {
        fail(field, "type", `Le champ « ${field} » doit être de type ${fieldSpec.type}.`);
        continue;   // mauvais type → enum/min/ref non pertinents
      }
      if (fieldSpec.enum && !fieldSpec.enum.includes(value as string)) {
        fail(field, "enum", `Valeur « ${value} » invalide pour « ${field} » (attendu : ${fieldSpec.enum.join(", ")}).`);
      }
      if (fieldSpec.min != null && typeof value === "number" && value < fieldSpec.min) {
        fail(field, "min", `Le champ « ${field} » doit être ≥ ${fieldSpec.min}.`);
      }
      if (fieldSpec.format && typeof value === "string" && !DataValidator.matchesFormat(value, fieldSpec.format)) {
        fail(field, "format", `Le champ « ${field} » n'est pas ${fieldSpec.format === "cidr" ? "un CIDR IPv4 (ex. 10.0.0.0/24)" : "une adresse IPv4 (ex. 10.0.0.5)"}.`);
      }
      // intégrité référentielle (si `fetch`) : la (ou les) FK doivent désigner une entité existante (fetch ≠ null).
      if (fetch && fieldSpec.ref) {
        const referencedIds = fieldSpec.type === "string[]" ? (value as string[]) : [value as string];
        for (const referencedId of referencedIds) {
          if (typeof referencedId === "string" && referencedId && fetch(fieldSpec.ref, referencedId) == null) {
            fail(field, "ref_missing", `Référence « ${referencedId} » introuvable dans « ${fieldSpec.ref} ».`);
          }
        }
      }
    }
    // invariants INTER-CHAMPS (V3) : règles dépendant de plusieurs champs (ex. réseau principal ∈ réseaux du câble).
    for (const invariant of spec.invariants || []) {
      if (!invariant.holds(record)) fail(invariant.path, "invariant", invariant.message);
    }
    // règles CROSS-ENTITÉ (V5, si `fetch`) : dépendent des données d'une entité liée (ex. IP ∈ CIDR de son réseau).
    if (fetch) {
      for (const rule of spec.crossEntity || []) {
        const violation = rule(record, fetch);
        if (violation) fail(violation.path, "cross_entity", violation.message);
      }
    }
    // règles de PORTÉE (V6, si `find`) : unicité / non-chevauchement contre les pairs (ex. adresse IP unique).
    if (find) {
      for (const rule of spec.scope || []) {
        const violation = rule(record, find, fetch);
        if (violation) fail(violation.path, "scope", violation.message);
      }
    }
    return errors;
  }

  /** Normalise PUIS valide — l'enchaînement appliqué au serveur avant écriture. `fetch` (optionnel) active
      l'intégrité référentielle (V2) et les règles cross-entité (V5). */
  static normalizeAndValidate(collection: string, record: Record<string, any>, fetch?: EntityFetcher, find?: RecordFinder): { record: Record<string, any>; errors: ValidationError[] } {
    const normalized = DataValidator.normalizeRecord(collection, record);
    return { record: normalized, errors: DataValidator.validateRecord(collection, normalized, fetch, find) };
  }

  /** DÉPENDANCE INVERSE (V5b) : écrire `parentRecord` peut invalider ses ENFANTS (ex. réseau dont le `cidr` change
      → des adresses tombent hors sous-réseau). Pour chaque collection-enfant déclarée (`spec.dependents`), retrouve
      les enfants (`findChildren`) et re-joue LEURS règles cross-entité CONTRE LE NOUVEL ÉTAT du parent (pas encore
      persisté → on l'injecte via `fetch`). Renvoie les violations (rattachées à l'enfant fautif). Sur une création,
      l'id du parent est neuf → aucun enfant → no-op. */
  static validateDependents(parentCollection: string, parentRecord: Record<string, any>, findChildren: ChildFinder, fetch: EntityFetcher): ValidationError[] {
    const spec = COLLECTION_SPECS[parentCollection];
    if (!spec || !spec.dependents || !parentRecord.id) return [];
    // le parent en cours d'écriture n'est pas encore persisté : on le superpose à l'état lu pour que les règles
    // des enfants voient le NOUVEAU parent (ex. le nouveau `cidr`).
    const fetchWithNewParent: EntityFetcher = (collection, id) =>
      (collection === parentCollection && id === parentRecord.id) ? parentRecord : fetch(collection, id);
    const errors: ValidationError[] = [];
    for (const dependent of spec.dependents) {
      for (const child of findChildren(dependent.collection, dependent.fkField, parentRecord.id)) {
        for (const error of DataValidator.validateRecord(dependent.collection, child, fetchWithNewParent)) {
          if (error.code === "cross_entity") errors.push({ ...error, message: error.message + ` — incohérent avec la modification de « ${parentCollection} ».` });
        }
      }
    }
    return errors;
  }

  /** Construit un lecteur d'entité CONSCIENT DU LOT : une FK / règle cross-entité peut viser une entité créée ou
      modifiée dans le MÊME lot (on renvoie alors le CONTENU du lot, ex. un `cidr` modifié), ou supprimée (→ `null`).
      Sans cela, un `/transact` légitime (créer un réseau ET une adresse qui s'y rattache) serait rejeté à tort.
      Ordre d'application = suppressions → màj → créations, donc un upsert l'emporte sur une suppression du même id. */
  static buildBatchFetcher(base: EntityFetcher, batch: BatchOps): EntityFetcher {
    const upsertedInBatch = new Map<string, Record<string, any>>();
    const deletedInBatch = new Set<string>();
    for (const entry of [...(batch.creates || []), ...(batch.updates || [])]) {
      if (entry && entry.collection && entry.record && entry.record.id) upsertedInBatch.set(DataValidator.refKey(entry.collection, entry.record.id), entry.record);
    }
    for (const entry of (batch.deletes || [])) {
      if (entry && entry.collection && entry.id) deletedInBatch.add(DataValidator.refKey(entry.collection, entry.id));
    }
    return (collection: string, id: string): Record<string, any> | null => {
      const key = DataValidator.refKey(collection, id);
      if (upsertedInBatch.has(key)) return upsertedInBatch.get(key)!;   // créé/màj dans le lot → son CONTENU
      if (deletedInBatch.has(key)) return null;                         // supprimé dans le lot → n'existe plus
      return base(collection, id);                                      // sinon : état persisté
    };
  }

  /** Lecteur d'enfants CONSCIENT DU LOT (dépendance inverse V5b dans un `/transact`) : renvoie l'ensemble EFFECTIF
      des enfants APRÈS application du lot — état persisté, moins les enfants supprimés / déplacés hors du parent,
      plus ceux créés ou déplacés VERS le parent dans le lot. Sans cela, un lot qui change un `cidr` ET crée/déplace
      des adresses raterait des incohérences (ou en signalerait de fausses). */
  static buildBatchChildFinder(base: ChildFinder, batch: BatchOps): ChildFinder {
    return (collection: string, fkField: string, parentId: string): Record<string, any>[] => {
      const childrenById = new Map<string, Record<string, any>>();
      for (const child of base(collection, fkField, parentId)) if (child && child.id) childrenById.set(child.id, child);
      for (const del of (batch.deletes || [])) if (del && del.collection === collection) childrenById.delete(del.id);
      for (const entry of [...(batch.creates || []), ...(batch.updates || [])]) {
        if (!entry || entry.collection !== collection || !entry.record || !entry.record.id) continue;
        if (entry.record[fkField] === parentId) childrenById.set(entry.record.id, entry.record);   // (post-lot) rattaché à ce parent
        else childrenById.delete(entry.record.id);                                                  // déplacé / détaché du parent
      }
      return [...childrenById.values()];
    };
  }

  /* ---- helpers internes ---- */
  private static isEmpty(value: unknown): boolean {
    return value === undefined || value === null || value === "";
  }

  /** Met un champ en forme canonique selon sa règle de type. */
  private static normalizeField(rawValue: unknown, spec: FieldSpec): unknown {
    // Absent / vide : valeur par défaut si fournie, sinon `null` si nullable, sinon on laisse tel quel
    // (la validation signalera un éventuel `required`).
    if (DataValidator.isEmpty(rawValue)) {
      if ("default" in spec) return spec.default;
      if (spec.nullable) return null;
      return rawValue;
    }
    switch (spec.type) {
      case "number": {
        const coerced = Number(rawValue);
        return Number.isFinite(coerced) ? coerced : rawValue;   // non convertible → laissé (validation → "type")
      }
      case "boolean":
        return rawValue === true || rawValue === "true";
      case "string[]":
        return Array.isArray(rawValue) ? rawValue.filter((item) => typeof item === "string") : [];
      case "string":
      default:
        // `trim` (opt-in par champ) : espaces de tête/queue retirés — une chaîne « tout espaces »
        // devient "" et sera alors signalée par un éventuel `required` (comportement voulu).
        return spec.trim ? String(rawValue).trim() : String(rawValue);
    }
  }

  /** Vrai si la valeur correspond bien au type déclaré (hors `null`, géré à part par `nullable`). */
  private static matchesType(value: unknown, type: FieldType): boolean {
    switch (type) {
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "boolean": return typeof value === "boolean";
      case "string[]": return Array.isArray(value) && value.every((item) => typeof item === "string");
      case "string": default: return typeof value === "string";
    }
  }

  private static matchesFormat(value: string, format: NonNullable<FieldSpec["format"]>): boolean {
    return format === "cidr" ? Ipv4.isCidr(value) : Ipv4.toInt(value) != null;
  }

  private static refKey(collection: string, id: string): string {
    return collection + " " + id;
  }
}

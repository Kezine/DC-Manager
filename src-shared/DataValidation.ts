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

   Portée `shared/` : compile sous le front (résolution bundler) ET le serveur (NodeNext).
   Les enums sont déclarés ICI comme source canonique ; un test anti-divergence vérifie
   l'alignement avec les constantes front.

   COLLABORATEURS partagés : `RackDepthPolicy` (profondeur de baie) et `TrayGeometry` (géométrie
   d'étagère, règles T2d/V6e) sont désormais **IMPORTÉS** — l'auto-suffisance de `src-shared/` a
   été levée, un import relatif entre fichiers partagés est autorisé À CONDITION d'écrire le
   spécificateur avec l'extension `.js` (NodeNext l'exige côté serveur). `TrayGeometry` était
   auparavant INJECTÉ (`ValidationCollaborators`, garde-fou d'échec fermé), patron choisi à
   l'époque où un fichier partagé ne pouvait rien importer ; le point de substitution n'a jamais
   servi (tous les appelants injectaient la vraie géométrie) et exposait à l'oubli d'injection —
   retiré le 2026-07-31 sur demande, import direct comme `RackDepthPolicy` (cf. `docs/placement.md`
   §6.14 pour le précédent `RackDepthPolicy`).
   ============================================================================ */

// POLITIQUE DE PROFONDEUR de baie : SOURCE UNIQUE partagée avec le rendu (`RackGeometry` délègue).
// ⚠ L'extension `.js` est IMPÉRATIVE — un import sans extension compile côté front et CASSE le serveur.
import { RackDepthPolicy } from "./RackDepthPolicy.js";
// GÉOMÉTRIE D'ÉTAGÈRE : SOURCE UNIQUE partagée avec le rendu (`RackGeometry` la réutilise).
// ⚠ Extension `.js` IMPÉRATIVE (même raison que ci-dessus).
import { TrayGeometry } from "./TrayGeometry.js";

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
/** `json` = STRUCTURE non exprimable par les types scalaires (objet value-object ou tableau d'objets :
    portes de baie/salle, vNICs). Sémantique MINIMALE et VOULUE ainsi (décision migration DB 2026-07-31) :
    la normalisation laisse la valeur TELLE QUELLE (défaut posé si absente), la validation intrinsèque ne
    vérifie que « c'est bien un objet/tableau, pas un scalaire » — le CONTENU reste validé par les
    invariants (ex. `vms.nics`) et normalisé côté client (`Normalize.rackDoor`/`dcDoors`, `VmSync`).
    Au DDL (générateur L1), un champ `json` devient une colonne TEXT JSON. */
export type FieldType = "string" | "number" | "boolean" | "string[]" | "json";

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
  /** Borne inférieure INCLUSIVE (type `number`) : seul `value < min` est rejeté. */
  min?: number;
  /** Borne supérieure INCLUSIVE (type `number`) : seul `value > max` est rejeté. Miroir strict de `min` —
      les deux bornes encadrent une grandeur physique dont les EXTRÊMES sont légitimes (une latitude de ±90
      est un pôle, pas une erreur), d'où l'inclusivité des deux côtés. */
  max?: number;
  /** Format attendu (chaîne) : `ipv4` (« a.b.c.d »), `cidr` (« a.b.c.d/n », n ∈ 0..32) ou `hostname`
      (nom d'hôte / FQDN RFC 1123 : labels alphanumériques + tirets, insensible à la casse). */
  format?: "ipv4" | "cidr" | "hostname";
  /** Collection cible d'une clé étrangère (exploité par l'intégrité référentielle — V2). */
  ref?: string;
}

/* ---- TYPES d'ENREGISTREMENT dérivés de la SPEC (point 1 « Direction MODÈLE » — cf. .notes/toDos/db-relational-decision) :
   la spec déclarative EST la définition canonique du modèle → on en DÉRIVE des types d'échange REST nommés, au lieu
   d'écrire des DTO par collection à la main (jetables, 3ᵉ source de vérité). `RecordOf<Fields>` mappe un bloc de champs
   `as const` (SPEC_FIELDS) vers la forme NORMALISÉE de l'enregistrement : les défauts étant posés à la normalisation,
   chaque champ déclaré est présent ; `nullable: true` ⇒ `| null`. Étape qui SURVIT à la migration relationnelle (plus
   tard : la MÊME spec générera colonnes + FK). ---- */
type FieldTs<F> =
  F extends { type: "string" }   ? (F extends { nullable: true } ? string | null   : string)  :
  F extends { type: "number" }   ? (F extends { nullable: true } ? number | null   : number)  :
  F extends { type: "boolean" }  ? (F extends { nullable: true } ? boolean | null  : boolean) :
  F extends { type: "string[]" } ? (F extends { nullable: true } ? string[] | null : string[]) :
  // `json` → `unknown` (qui absorbe `| null`, pas de branche nullable) : le typage RICHE de ces structures
  // reste côté client (`RackDoor`, `DcDoor`, `VmSync.VmNic`) — on ne partage pas les types métier du client,
  // et `unknown` laisse les classes modèles déclarer le leur (`implements` reste satisfait).
  F extends { type: "json" }     ? unknown :
  unknown;
/** Forme d'un enregistrement NORMALISÉ dérivée d'un bloc de champs `as const`. Mutable (DTO d'échange) via `-readonly`. */
export type RecordOf<Fields> = { -readonly [K in keyof Fields]: FieldTs<Fields[K]> };

/** Spécification d'une collection : ses champs déclarés + invariants inter-champs (V3) + règles
    cross-entité (V5).
    DOCTRINE (régularisation migration DB 2026-07-31, D3a — remplace la doctrine « spec partielle » de
    l'audit 2026-07-20) : la spec est COMPLÈTE — TOUT champ réellement persisté d'une collection est
    déclaré ici, parce que la future dérivation du DDL relationnel (colonnes strictes) PERDRAIT tout champ
    non déclaré à l'écriture. Le mécanisme de traversée des champs inconnus subsiste (la normalisation ne
    retire rien), mais il ne couvre plus QUE deux cas ASSUMÉS :
    - les 4 champs d'AUDIT `created_by`/`updated_by`/`created_date`/`updated_date` : posés/écrasés PAR LE
      SERVEUR (AuditStamp) APRÈS validation — les déclarer n'apporterait aucune règle côté client, leur
      traversée est éprouvée par test, et le générateur DDL les pose en colonnes standard ;
    - 2 champs LEGACY d'équipement, `face_image`/`face_image_rear` (ancêtres inline des FK `face_image_*_id`,
      toujours null dans les corpus) : à PURGER à la migration L4, PAS à déclarer.
    Un verrou de complétude (`Tests/modules/test-spec-completude.js`) confronte le corpus de démo à cette
    spec : tout champ persisté hors de la liste fermée ci-dessus doit être déclaré, sinon le test échoue en
    nommant collection + champ — un champ ne peut plus redevenir passthrough en silence. */
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
  code: "required" | "type" | "enum" | "min" | "max" | "format" | "ref_missing" | "invariant" | "cross_entity" | "scope";
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
    place ici, dans `src-shared/`. Évite le motif `[p.strand_a, p.strand_b].filter(v => v != null)` répété. */
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
    // rackItem : un TRAY pleine profondeur (type "dual") occupe les 2 faces ; cantilever/blank → sa seule face de montage.
    // Parité avec RackGeometry.mountSides (front) — à maintenir ensemble.
    if (collection === "rackItems") return (record.kind === "tray" && record.tray_type !== "cantilever") ? ["front", "rear"] : [record.side === "rear" ? "rear" : "front"];
    // brosse : ancrée au plan de montage AVANT (elle s'étend de depth_mm vers l'arrière, cf. Resolver3D.brushGeom) ;
    // la face ARRIÈRE n'est bloquée que par la PROFONDEUR (règle V6d-brosse, RackDepth ci-dessous), comme entre équipements.
    if (collection === "waypoints") return ["front"];
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
   au-delà de la cage.

   La POLITIQUE DE PROFONDEUR (profondeur extérieure, cage, marges avant/arrière,
   cavités de portes) ne vit plus ici : elle est écrite UNE SEULE FOIS dans
   `src-shared/RackDepthPolicy`, IMPORTÉE ci-dessus et consommée aussi par le RENDU
   (`RackGeometry`, qui délègue). Elle était RÉPLIQUÉE, et les deux copies
   DIVERGEAIENT — cf. `docs/placement.md` §6.14 pour l'arbitrage.

   Ce qui reste ICI est ce qui appartient VRAIMENT à la validation : la marge de
   SÉCURITÉ derrière une porte, qui n'est pas une lecture de la géométrie mais une
   règle de PRUDENCE — le rendu, lui, dessine ce qui existe physiquement et ne la
   retranche pas. Ce n'est donc pas une divergence, et elle n'est pas mutualisée.

   Les règles ne s'appliquent qu'aux enregistrements MIGRÉS (depth_mm présent) :
   un legacy (enum fractionnaire) tient par construction — et le sanctionner
   rendrait d'anciens documents invalides à la première édition.
   ============================================================================ */
const RACK_DEPTH_SAFETY = 100;    // = RACK_DEPTH_SAFETY_MM (front) : marge de sécurité derrière une porte

class RackDepth {
  /** Profondeur de cage — aussi utilisée par TrayFit (plateau « dual » = pleine cage). */
  static cage(rack: Record<string, any>): number { return RackDepthPolicy.cage(rack); }
  /** Dispo pour un montage ancré à `side` (av/ar) : jusqu'à la face opposée + cavités − sécurité derrière porte. */
  private static avail(rack: Record<string, any>, side: string): number {
    const d = RackDepthPolicy.outerDepth(rack);
    const extras = RackDepthPolicy.doorExtra(rack, "front") + RackDepthPolicy.doorExtra(rack, "rear");
    return d - (side === "rear" ? RackDepthPolicy.rearMargin(rack) : RackDepthPolicy.frontMargin(rack)) + extras - (RackDepthPolicy.hasDoor(rack) ? RACK_DEPTH_SAFETY : 0);
  }
  /** Espace PARTAGÉ par deux montages dos à dos au même U : cage + cavités − sécurité derrière porte. */
  private static shared(rack: Record<string, any>): number {
    return RackDepthPolicy.cage(rack) + RackDepthPolicy.doorExtra(rack, "front") + RackDepthPolicy.doorExtra(rack, "rear") - (RackDepthPolicy.hasDoor(rack) ? RACK_DEPTH_SAFETY : 0);
  }
  /** Profondeur EFFECTIVE d'un occupant : depth_mm, sinon estimation legacy (fraction de cage). */
  private static effDepth(record: Record<string, any>, rack: Record<string, any>): number {
    if (record.depth_mm != null) return Math.max(1, record.depth_mm | 0);
    const frac: Record<string, number> = { full: 1, half: 0.5, quarter: 0.25 };
    return Math.round((frac[record.depth] != null ? frac[record.depth] : 1) * RackDepthPolicy.cage(rack));
  }
  /** Profondeur d'une BROSSE (waypoint kind "brush"). ⚠ Défaut 100 EN PARITÉ avec le constructeur
      client (`src-client/models/Waypoint.ts`, champ `depth_mm`) — à maintenir ensemble : un record
      venu d'une interface tierce sans `depth_mm` doit être jugé comme le client le dessinerait. */
  private static brushDepth(waypoint: Record<string, any>): number {
    return waypoint.depth_mm != null ? Math.max(1, waypoint.depth_mm | 0) : 100;
  }

  /** T2c (cross-entité) : un équipement racké (migré) doit TENIR dans la profondeur dispo de sa baie. */
  static fits(eq: Record<string, any>, fetch: EntityFetcher): { path: string; message: string } | null {
    if (eq.placement_mode !== "rack" || !eq.rack_id || eq.depth_mm == null) return null;
    const rack = fetch("racks", eq.rack_id);
    if (!rack) return null;                                                        // baie absente → intégrité réf. ailleurs
    const limit = RackDepth.avail(rack, eq.rack_side === "rear" ? "rear" : "front");
    return eq.depth_mm <= limit ? null
      : { path: "depth_mm", message: `La profondeur (${eq.depth_mm} mm) dépasse l'espace disponible de la baie (${Math.round(limit)} mm${RackDepthPolicy.hasDoor(rack) ? ", marge de sécurité de porte déduite" : ""}).` };
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
    // V6d-brosse : une brosse est ancrée au plan de montage AVANT et n'occupe QUE cette face
    // (RackOccupancy.sides) — un équipement ARRIÈRE au même U ne la collisionne donc plus (V6c) et c'est
    // CETTE arithmétique qui protège l'espace, exactement comme entre deux équipements dos à dos. Un
    // équipement côté FRONT au même U reste couvert par la collision de cellule `U:front` (V6c), et un
    // verrouillant (`locks_u`) est sorti en tête de fonction — couvert par V6c aussi.
    if (side === "rear") {
      for (const waypoint of find("waypoints", "rack_id", eq.rack_id)) {
        if (waypoint.kind !== "brush" || waypoint.rack_u == null) continue;
        const wTop = Math.max(1, waypoint.rack_u | 0), wHeight = Math.max(1, waypoint.u_height | 0);
        if (wTop + wHeight <= top || top + height <= wTop) continue;                // aucun U commun
        const sum = Math.max(1, eq.depth_mm | 0) + RackDepth.brushDepth(waypoint);
        if (sum > limit) return { path: "depth_mm", message: `Dos-à-dos trop profond avec la brosse « ${waypoint.name || waypoint.id} » : ${sum} mm cumulés > ${Math.round(limit)} mm d'espace partagé dans la baie.` };
      }
    }
    return null;
  }

  /** V6d-brosse (portée, SYMÉTRIQUE de l'extension ci-dessus) : jouée quand on ÉDITE la brosse — la somme
      brosse (ancrée à l'avant) + équipement monté ARRIÈRE au même U ne doit pas dépasser l'espace partagé.
      Un équipement verrouillant (`locks_u`, ou legacy « full » non migré) occupe les DEUX faces : la
      collision de cellule V6c couvre déjà ce cas, on ne le re-juge pas ici. */
  static brushBackToBack(wp: Record<string, any>, find: RecordFinder, fetch?: EntityFetcher): { path: string; message: string } | null {
    if (wp.kind !== "brush" || !wp.rack_id || !fetch) return null;
    const rack = fetch("racks", wp.rack_id);
    if (!rack || rack.sides !== "dual") return null;                               // baie simple face : pas de dos-à-dos possible
    const top = Math.max(1, wp.rack_u | 0), height = Math.max(1, wp.u_height | 0);
    const limit = RackDepth.shared(rack);
    for (const other of find("equipments", "rack_id", wp.rack_id)) {
      if (other.placement_mode !== "rack" || other.rack_u == null) continue;
      const oLocks = other.locks_u === true || (other.depth_mm == null && other.depth === "full");
      if (oLocks || (other.rack_side === "rear" ? "rear" : "front") !== "rear") continue;   // front / verrouillant → couvert par V6c
      const oTop = other.rack_u | 0, oHeight = Math.max(1, (other.u_height | 0) || 1);
      if (oTop + oHeight <= top || top + height <= oTop) continue;                 // aucun U commun
      const sum = RackDepth.brushDepth(wp) + RackDepth.effDepth(other, rack);      // effDepth ESTIME les legacy (fraction de cage)
      if (sum > limit) return { path: "depth_mm", message: `Dos-à-dos trop profond avec « ${other.name || other.id} » : ${sum} mm cumulés > ${Math.round(limit)} mm d'espace partagé dans la baie.` };
    }
    return null;
  }
}

/* ============================================================================
   ÉQUIPEMENT POSÉ SUR UNE ÉTAGÈRE (placement_mode "tray") — l'empreinte doit
   tenir dans la boîte utile du plateau, et deux colocataires ne doivent pas se
   chevaucher.

   La GÉOMÉTRIE du plateau ne vit plus ici : elle est écrite UNE SEULE FOIS dans
   `src-shared/TrayGeometry`, IMPORTÉE directement (comme `RackDepthPolicy`). Ce qui
   reste ici est ce qui appartient VRAIMENT à la validation : résoudre le contexte
   (étagère + baie) via `fetch`, énumérer les colocataires via `find`, et traduire
   un refus géométrique en `path` + message de FORMULAIRE.
   Cf. `docs/placement.md` §6.7 et `docs/validation.md` (T2d / V6e).
   ============================================================================ */
class TrayFit {
  /** Message d'un refus géométrique, en termes de CHAMP DE FORMULAIRE (le front, lui, en fait une
      phrase d'aide à la saisie — même verdict, deux présentations). Sous rotation, la largeur fautive
      vient de `free_l_mm` et réciproquement : on désigne donc le champ RÉELLEMENT saisi. */
  private static explain(problem: NonNullable<ReturnType<typeof TrayGeometry.fitProblem>>): { path: string; message: string } {
    const { footprint, plank } = problem;
    switch (problem.code) {
      case "no_space":
        return { path: "tray_item_id", message: "Aucun espace réservé au-dessus du plateau (hauteur réservée = structure du tray)." };
      case "too_high":
        return { path: "free_h_mm", message: `Hauteur ${footprint.h} mm > ${Math.round(plank.availH)} mm réservés au-dessus du plateau.` };
      case "footprint": {
        const tooWide = footprint.w > plank.W;
        const path = tooWide ? (footprint.rotated ? "free_l_mm" : "free_w_mm") : (footprint.rotated ? "free_w_mm" : "free_l_mm");
        return { path, message: `Empreinte ${footprint.w} × ${footprint.d} mm > plateau ${Math.round(plank.W)} × ${Math.round(plank.L)} mm.` };
      }
      case "over_width":
        return { path: "tray_x", message: `Dépasse le plateau en largeur (${Math.round(problem.reached)} > ${Math.round(plank.W)} mm).` };
      default:
        return { path: "tray_y", message: `Dépasse le plateau en profondeur (${Math.round(problem.reached)} > ${Math.round(plank.L)} mm).` };
    }
  }

  /** Contexte résolu (plateau utile) d'un équipement posé — null si la règle ne s'applique pas.
      La profondeur de CAGE est calculée ici (politique de baie) et passée en NOMBRE à la géométrie. */
  private static plank(eq: Record<string, any>, fetch: EntityFetcher | undefined): { W: number; L: number; availH: number } | null {
    if (eq.placement_mode !== "tray" || !eq.tray_item_id || !fetch) return null;
    const tray = fetch("rackItems", eq.tray_item_id);
    if (!tray || tray.kind !== "tray" || !tray.rack_id) return null;   // réf. absente/étrangère → autres règles
    const rack = fetch("racks", tray.rack_id);
    return rack ? TrayGeometry.plank(RackDepth.cage(rack), tray) : null;
  }

  /** T2d (cross-entité) : l'équipement TIENT sur l'étagère (empreinte, position, hauteur réservée). */
  static fits(eq: Record<string, any>, fetch: EntityFetcher): { path: string; message: string } | null {
    if (eq.placement_mode === "tray" && eq.tray_item_id && fetch) {
      const tray = fetch("rackItems", eq.tray_item_id);
      if (tray && tray.kind !== "tray") return { path: "tray_item_id", message: "L'élément visé n'est pas une étagère (tray)." };
    }
    const plank = TrayFit.plank(eq, fetch);
    if (!plank) return null;
    const problem = TrayGeometry.fitProblem(eq, plank);
    return problem ? TrayFit.explain(problem) : null;
  }

  /** V6e (portée) : pas de CHEVAUCHEMENT entre équipements posés sur la MÊME étagère. */
  static overlap(eq: Record<string, any>, find: RecordFinder, fetch?: EntityFetcher): { path: string; message: string } | null {
    const plank = TrayFit.plank(eq, fetch);
    if (!plank) return null;
    const me = TrayGeometry.box(eq, plank);
    for (const other of find("equipments", "tray_item_id", eq.tray_item_id)) {
      if (other.id === eq.id || other.placement_mode !== "tray") continue;
      if (TrayGeometry.overlap(me, TrayGeometry.box(other, plank))) {
        return { path: "tray_x", message: `Chevauche « ${other.name || other.id} » sur l'étagère.` };
      }
    }
    return null;
  }
}

/* ---- spécifications des collections (couverture 19/19 — cf. docs/validation.md) ---- */
/* ---- CHAMPS des collections, isolés `as const` : SOURCE UNIQUE des types d'enregistrement (RecordOf) ET
   des specs de validation (COLLECTION_SPECS y référence ses `fields`). `as const` préserve les littéraux de
   `type`/`enum`/défauts pour l'inférence ; les fonctions (invariants/règles) restent dans COLLECTION_SPECS,
   typées contextuellement par l'annotation (les mettre `as const` ici les rendrait `any` implicites).
   ⚠ `as const` SEUL ne vérifie RIEN : sans annotation de type, TypeScript n'inspecte aucune propriété
   excédentaire — c'est ainsi que `sites.lat`/`lon` ont pu déclarer un `max:` que `FieldSpec` et le moteur
   ignoraient (contrainte inerte, corrigée depuis). D'où le `satisfies` en fin de bloc : il CONTRÔLE la forme
   de chaque champ contre `FieldSpec` tout en PRÉSERVANT le type littéral dont `RecordOf` dérive les types
   `Records.*` (une simple annotation `: Record<...>` élargirait les littéraux et casserait cette dérivation). ---- */
const SPEC_FIELDS = {
  equipments: {
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
      // POE : équipement capable de PoE (déverrouille le rôle "poe") + budget POE TOTAL partagé (W).
      poe_device:      { type: "boolean", default: false },
      poe_budget_w:    { type: "number", nullable: true, default: null, min: 0 },
      // FICHE D'INVENTAIRE (chaînes libres, vides par défaut — parité constructeur Equipment.ts).
      brand:          { type: "string", default: "" },
      model:          { type: "string", default: "" },
      serial:         { type: "string", default: "" },
      description:    { type: "string", default: "" },
      // ADMINISTRATIF (achat / garantie / attribution) — dates ISO courtes en TEXTE (aucun tri/filtre serveur).
      purchase_date:  { type: "string", default: "" },
      po_ref:         { type: "string", default: "" },
      warranty_end:   { type: "string", default: "" },
      assigned_date:  { type: "string", default: "" },
      assigned_to:    { type: "string", default: "" },
      // MODE MANUEL (lieu libre) — chaînes héritables, vides par défaut (parité datacenters.location/floor/room).
      location:       { type: "string", default: "" },
      floor:          { type: "string", default: "" },
      room:           { type: "string", default: "" },
      // POSITION EN BAIE : U de bas (null = pool non placé — cf. T1) + face de montage. `rack_side` reprend
      // l'enum partagé des côtés d'occupation (même ensemble que rackItems.side). LUS par la validation
      // elle-même (T1/T2/V6c/V6d) — les déclarer était la condition de la dérivation DDL.
      rack_u:         { type: "number", nullable: true, default: null },
      rack_side:      { type: "string", enum: RACK_OCCUPANT_SIDES, default: "front" },
      // PLACEMENT LIBRE EN SALLE (mode manual/dc) : centre au sol (mm), hauteur (NÉGATIF autorisé —
      // sous-plancher), rotation 0/90/180/270 (contrainte exprimable : min 0 — cf. floor_orientation de salle).
      dc_x:           { type: "number", nullable: true, default: null },
      dc_y:           { type: "number", nullable: true, default: null },
      dc_z:           { type: "number", default: 0 },
      dc_orientation: { type: "number", min: 0, default: 0 },
      // PLAN D'ÉTAGE (mode floor) : position sur le plan (mm). null = non localisé.
      floor_x:        { type: "number", nullable: true, default: null },
      floor_y:        { type: "number", nullable: true, default: null },
      // MODE DE DIMENSIONNEMENT ("u" | "free") — champ DÉRIVÉ CÔTÉ CLIENT quand il manque (le constructeur
      // Equipment.ts choisit d'après placement_mode) : le défaut "" signifie « non renseigné, le client
      // dérive » — on ne fige PAS un mode ici (un défaut statique trahirait la dérivation conditionnelle).
      // Pas d'enum : l'ensemble {"u","free"} n'existe pas en constante partagée (client seul).
      dim_mode:       { type: "string", default: "" },
      // DIMENSIONS LIBRES (mm) — boîtier hors baie. null = non renseigné (JAMAIS 0 : un défaut numérique
      // inventerait une dimension).
      free_l_mm:      { type: "number", nullable: true, default: null, min: 0 },
      free_w_mm:      { type: "number", nullable: true, default: null, min: 0 },
      free_h_mm:      { type: "number", nullable: true, default: null, min: 0 },
      // MONTAGE SUR FLANC (mode side) — valeurs fermées CÔTÉ CLIENT seulement (pas de constante partagée →
      // pas d'enum ici) ; défauts = parité stricte avec le constructeur Equipment.ts.
      side_face:      { type: "string", default: "front" },
      side_lr:        { type: "string", default: "left" },
      side_u:         { type: "number", min: 1, default: 1 },
      side_col:       { type: "number", min: 0, default: 0 },
      side_snap:      { type: "string", default: "post" },
      // MONTAGE PAROI (mode wall) — mêmes remarques que le flanc.
      wall_lr:        { type: "string", default: "left" },
      wall_margin:    { type: "string", default: "front" },
      wall_u:         { type: "number", min: 1, default: 1 },
      wall_col:       { type: "number", min: 0, default: 0 },
      wall_orient:    { type: "string", default: "center" },
      // IMAGES DE FAÇADE : FK vers la BIBLIOTHÈQUE d'images (magasin HORS modèle) → pas de `ref` (l'intégrité
      // V2 ne connaît que les collections du modèle). Une par face (cf. Schema.EQUIPMENT_FACE_IMAGE_FIELDS).
      face_image_id:        { type: "string", nullable: true, default: null },
      face_image_rear_id:   { type: "string", nullable: true, default: null },
      face_image_top_id:    { type: "string", nullable: true, default: null },
      face_image_bottom_id: { type: "string", nullable: true, default: null },
      face_image_left_id:   { type: "string", nullable: true, default: null },
      face_image_right_id:  { type: "string", nullable: true, default: null },
      // NB : `face_image`/`face_image_rear` (legacy inline, toujours null) restent VOLONTAIREMENT hors spec —
      // à PURGER à la migration L4, pas à déclarer (cf. doctrine en tête de CollectionSpec).
  },
  cables: {
      // IDENTITÉ : nom du câble — trimé pour une unicité FIABLE (V6h, même raison que le nom d'équipement V6g).
      // PAS `required` : des câbles sans nom existent et restent légaux — seule l'UNICITÉ des noms NON VIDES est imposée.
      name:          { type: "string", trim: true },
      cable_type_id: { type: "string", nullable: true, default: null, ref: "cableTypes" },
      from_port_id:  { type: "string", nullable: true, default: null, ref: "ports" },
      to_port_id:    { type: "string", nullable: true, default: null, ref: "ports" },
      network_ids:   { type: "string[]", default: [], ref: "networks" },
      network_id:    { type: "string", nullable: true, default: null, ref: "networks" },
      waypoint_ids:  { type: "string[]", default: [], ref: "waypoints" },
      length_m:      { type: "number", nullable: true, default: null, min: 0 },
      status:        { type: "string", required: true, enum: CABLE_STATUS_IDS, default: "brouillon" },
      description:   { type: "string", default: "" },   // notes libres (héritées d'Entity, présentes sur toute collection)
      // NB : l'ancien mécanisme « câble-brin » (bundle_id/strand_no sur le câble) a été RETIRÉ — les brins d'un
      // faisceau sont piochés par les PORTS de patch (Port.bundle_id/strand_a/strand_b), source unique.
  },
  racks: {
      name:          { type: "string", required: true },
      location:      { type: "string", default: "" },
      floor:         { type: "string", default: "" },
      room:          { type: "string", default: "" },
      row:           { type: "string", default: "" },      // rangée (libellé libre) — layers / groupement
      description:   { type: "string", default: "" },
      u_count:       { type: "number", min: 1, default: 42 },
      width_mm:      { type: "number", min: 1 },
      depth:         { type: "number", min: 1 },
      sides:         { type: "string", enum: RACK_SIDE_CONFIGS, default: "single" },
      has_caps:      { type: "boolean", default: true },   // habillage toit/fond — false = châssis OUVERT
      locked:        { type: "boolean", default: false },  // positionnement verrouillé (vues 2D/3D) — cf. PlacementLock
      datacenter_id: { type: "string", nullable: true, default: null, ref: "datacenters" },
      dc_x:          { type: "number", nullable: true, default: null },
      dc_y:          { type: "number", nullable: true, default: null },
      // ORIENTATION au sol : valeurs métier 0/90/180/270 (cf. Normalize.rackOrientation) — même contrainte
      // exprimable que datacenters.floor_orientation (l'enum de FieldSpec est textuel) : min 0.
      orientation:   { type: "number", min: 0, default: 0 },
      // GÉOMÉTRIE / MARGES (mm). ⚠ `lmargin_mm`/`vmargin_mm` ont un défaut CONDITIONNEL côté client (repli
      // sur mount_margin_mm — Rack.ts) : on déclare null = « non renseigné, le client replie », JAMAIS un
      // nombre inventé. `mount_margin_mm` a, lui, un défaut FIXE : 50 (= RACK_MOUNT_MARGIN_DEFAULT front —
      // constante client inimportable ici, valeur répliquée, à maintenir ensemble).
      mount_margin_mm:   { type: "number", min: 0, default: 50 },
      lmargin_mm:        { type: "number", nullable: true, default: null, min: 0 },
      vmargin_mm:        { type: "number", nullable: true, default: null, min: 0 },
      vmargin_bottom_mm: { type: "number", nullable: true, default: null, min: 0 },   // null = identique à la haute
      cage_depth_mm:     { type: "number", nullable: true, default: null, min: 1 },   // null = profondeur extérieure (RackDepthPolicy)
      front_margin_mm:   { type: "number", min: 0, default: 0 },                      // 0 = montants au ras de la façade
      height_mm:         { type: "number", nullable: true, default: null, min: 1 },   // null = hauteur mini dérivée
      // SIDE-MOUNT autorisé sur les marges latérales (façade / arrière).
      allow_side_front:  { type: "boolean", default: false },
      allow_side_rear:   { type: "boolean", default: false },
      // PORTES en saillie (value-objects — épaisseur, charnière, creuse) : structures `json`, null = pas de
      // porte déclarée. Contenu normalisé côté client (Normalize.rackDoor) et lu null-safe par RackDepthPolicy.
      door_front:        { type: "json", nullable: true, default: null },
      door_rear:         { type: "json", nullable: true, default: null },
      // CELLULES waypoint autorisées sur les capots (clés « cx,cy ») — string[] ORDINAIRES : PAS dans
      // Schema.ARRAY_FIELDS (cette liste gouverne la sémantique des filtres `where`, personne ne filtre par cellule).
      roof_cells:        { type: "string[]", default: [] },
      floor_cells:       { type: "string[]", default: [] },
  },
  ports: {
      name:           { type: "string" },
      description:    { type: "string", default: "" },
      equipment_id:   { type: "string", nullable: true, default: null, ref: "equipments" },
      port_type_id:   { type: "string", nullable: true, default: null, ref: "portTypes" },
      // RÔLE du port ("data" | "power" | "poe") — LU par la validation (T12, T-POE1) et le tri client, donc
      // colonne PERSISTÉE. Pas d'enum : la source de vérité PortRoles vit côté CLIENT (cf. la note T12
      // ci-dessous — un fichier partagé ne peut pas l'importer) ; le défaut "data" est celui du constructeur
      // Port.ts. La dérivation du rôle depuis le type de port reste un comportement CLIENT.
      role:           { type: "string", default: "data" },
      parent_port_id: { type: "string", nullable: true, default: null, ref: "ports" },
      // BREAKOUT : index de lane (1..N) sous le trunk parent. null = port normal. Champ réel du modèle
      // (Port.ts), non peuplé dans les corpus — déclaré depuis le CODE (décision migration DB, arbitrage 2).
      lane:           { type: "number", nullable: true, default: null },
      aggregate_id:   { type: "string", nullable: true, default: null, ref: "aggregates" },
      // SOUS-ÉQUIPEMENT DESSERVI par ce port (drive d'une librairie, carte d'un châssis). Le port reste celui du
      // MAÎTRE — c'est une ÉTIQUETTE de destination, pas un déplacement de connectique : le câble, le réseau
      // déduit, l'analyse énergie et le graphe sont INCHANGÉS. Même forme qu'`aggregate_id` juste au-dessus
      // (N ports → 1 sous-équipement), et même règle cross-entité d'appartenance (T2c).
      sub_equipment_id: { type: "string", nullable: true, default: null, ref: "subEquipments" },
      // POSITION DE FAÇADE (normalisée 0..1 par le client) — LUE par l'invariant T1 (X et Y vont ensemble).
      // Pas de bornes : le constructeur Port.ts ne clampe pas, on n'invente pas une contrainte.
      face_x:         { type: "number", nullable: true, default: null },
      face_y:         { type: "number", nullable: true, default: null },
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
      // POE (rôle "poe") : budget max du port en WATTS (délivré si producteur / tiré si consommateur).
      poe_budget_w:   { type: "number", nullable: true, default: null, min: 0 },
      // POE : injection (PSE) / consommation (PD) ACTIVÉE sur ce port. Un câble ne porte l'éclair d'énergie que si
      // les DEUX extrémités PoE sont activées (cf. Store.cableCarriesPower). Défaut true (un port PoE injecte/tire).
      poe_enabled:    { type: "boolean", default: true },
  },
  aggregates: {
      name:         { type: "string" },
      description:  { type: "string", default: "" },
      equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
  },
  // SOUS-ÉQUIPEMENT : contenu LOGIQUE d'un équipement maître (drive d'une librairie à bandes, carte d'un
  // châssis…). Il n'a AUCUNE existence physique propre — c'est le maître qui la lui donne. Ce que cette spec
  // NE contient PAS est aussi important que ce qu'elle contient : ni `type` (la sémantique vit dans le NOM),
  // ni champ d'attribution, ni placement, ni dimension, ni port propre. Ces absences ne sont pas des oublis :
  // elles sont la RAISON d'être d'une collection séparée plutôt qu'un drapeau sur `equipments` — un champ
  // absent n'a besoin d'être neutralisé nulle part, alors qu'un drapeau doit être testé par chaque
  // consommateur (cf. `inventory_only`, vérifié À LA MAIN dans 6 sites). ⚠ L'ACHAT/GARANTIE, eux, ne sont
  // PLUS de cette liste d'absences depuis D5(c) (décision utilisateur 2026-08-03, cf. cadrage
  // `sous-equipements-achat-garantie-listing-cadrage-2026-08-03.md`) : ils sont déclarés plus bas, juste
  // après `serial`. Seule l'ATTRIBUTION (assigned_to/assigned_date) reste interdite (C2).
  // ⚠ Hiérarchie PLATE, un seul niveau (arbitrage utilisateur) : AUCUNE FK vers `subEquipments` elle-même —
  // ni ici, ni ailleurs. D'où l'absence de garde anti-cycle : il ne peut pas y avoir de cycle.
  subEquipments: {
      name:         { type: "string", required: true, trim: true },   // identité : la SÉMANTIQUE est ici (pas de champ `type`)
      // Le MAÎTRE. `required` (et non `nullable`) : un sous-équipement sans maître n'a par définition aucune
      // existence — c'est l'énoncé même du besoin. ⚠ Divergence VOULUE avec `aggregates.equipment_id`, qui est
      // nullable par héritage historique et non par décision ; ne pas « harmoniser » les deux.
      equipment_id: { type: "string", required: true, ref: "equipments" },
      // IDENTITÉ MATÉRIELLE (D5) : le NUMÉRO DE SÉRIE est souvent la raison même d'inventorier un drive
      // (SAV, RMA, garantie constructeur).
      brand:        { type: "string", default: "" },
      model:        { type: "string", default: "" },
      serial:       { type: "string", default: "" },
      // ADMINISTRATIF (achat / garantie) — D5(c), décision utilisateur du 2026-08-03 : la décision d'origine
      // (D5, 2026-07-29) écartait ces champs faute d'onglet de listing pour les trier/filtrer ; l'onglet arrive
      // au lot C du même cadrage, ce qui lève l'objection. Dates ISO courtes en TEXTE (le tri lexicographique
      // EST le tri chronologique, même contrat que sur `equipments`) — PAS d'attribution (C2 : `assigned_to`/
      // `assigned_date` restent hors de cette spec, volontairement, cf. verrou de test dédié).
      purchase_date: { type: "string", default: "" },
      po_ref:        { type: "string", default: "" },
      warranty_end:  { type: "string", default: "" },
      // REPÈRE dans le maître (D6) : TEXTE LIBRE (« Étagère A / baie 3 »), jamais une coordonnée. C'est une
      // ÉTIQUETTE, pas une géométrie — la contrainte « aucun placement » tient. Ne pas le transformer en
      // index numérique contraint : ce serait rouvrir la porte que la collection séparée referme.
      slot:         { type: "string", default: "", trim: true },
      // ⚠ `default: ""` DÉLIBÉRÉ, et non décoratif : sans lui, `normalizeField` renvoie un `null` explicite
      // TEL QUEL (il n'est ni `required`, ni `nullable`, ni pourvu d'un défaut) et ce `null` traverse
      // normalisation ET validation alors que le type dérivé promet `string`. C'est l'exposition que compte le
      // verrou « champs exposés au null silencieux » de `test-shared-validation.js` — il a mordu à l'écriture
      // de ce champ. On ne monte pas le compte verrouillé : on retire l'exposition.
      description:  { type: "string", default: "" },
      // GROUPES (champs LOCAUX) : PARITÉ STRICTE avec les specs equipments et vms — primaire `group_id`
      // ⊂ `group_ids` (TOUS les groupes), FK contrôlées (V2), détachées en cascade. ⚠ C'est la TROISIÈME
      // collection porteuse de groupes : le `custom` de `Cascade.groups` ÉNUMÈRE les collections à balayer,
      // il DOIT donc la connaître — un oubli laisserait des ids de groupe fantômes (le piège a déjà mordu
      // une fois pour `vms`). Un test DÉRIVE la liste attendue de cette spec et la confronte à la cascade.
      group_id:     { type: "string", nullable: true, default: null, ref: "groups" },
      group_ids:    { type: "string[]", default: [], ref: "groups" },
  },
  networks: {
      label:         { type: "string", required: true },
      description:   { type: "string", default: "" },
      color:         { type: "string", nullable: true, default: null },   // couleur d'affichage des câbles — null = auto
      kind:          { type: "string", enum: DATA_OR_POWER, default: "data" },
      // POWER uniquement : tension (V) et capacité max (A) du circuit. null = non renseigné.
      voltage:       { type: "number", nullable: true, default: null, min: 0 },
      max_amp:       { type: "number", nullable: true, default: null, min: 0 },
      power_source:  { type: "string", nullable: true, default: null, enum: POWER_SOURCES },
      ip_network_id: { type: "string", nullable: true, default: null, ref: "ipNetworks" },
  },
  groups: {
      label: { type: "string", required: true },
      description: { type: "string", default: "" },
      color: { type: "string", nullable: true, default: null },   // couleur partagée par les membres — null = auto
      type:  { type: "string", enum: GROUP_TYPE_IDS },
  },
  rackItems: {
      label:     { type: "string" },
      description: { type: "string", default: "" },
      rack_id:   { type: "string", nullable: true, default: null, ref: "racks" },
      u:         { type: "number", nullable: true, default: null },   // U de bas — null = non placé (parité equipments.rack_u)
      kind:      { type: "string", enum: RACK_ITEM_KIND_IDS, default: "blank" },
      side:      { type: "string", enum: RACK_OCCUPANT_SIDES, default: "front" },
      u_height:  { type: "number", min: 1, default: 1 },
      // profondeur : TOUJOURS "none" (pseudo-équipement no-depth, le constructeur RackItem.ts l'écrit en dur).
      depth:     { type: "string", default: "none" },
      // configuration TRAY (étagère) — sans effet pour les autres kinds
      tray_type: { type: "string", enum: TRAY_TYPE_IDS, default: "dual" },
      tray_u:    { type: "number", min: 1, default: 1 },
      depth_mm:  { type: "number", nullable: true, default: null, min: 1 },
  },
  portTypes: {
      name:   { type: "string" },
      description: { type: "string", default: "" },
      // FAMILLE de compatibilité + CONNECTEUR physique + débit — chaînes libres. ⚠ Le connecteur a un défaut
      // CONDITIONNEL côté client (repli sur `family` — PortType.ts) : "" = « non renseigné, le client replie ».
      family:    { type: "string", default: "" },
      connector: { type: "string", default: "" },
      speed:     { type: "string", default: "" },
      kind:   { type: "string", enum: DATA_OR_POWER, default: "data" },
      duplex: { type: "boolean", default: false },
  },
  cableTypes: {
      name: { type: "string" },
      description: { type: "string", default: "" },
      family: { type: "string", default: "" },   // compatibilité (doit matcher la famille des 2 ports reliés)
      medium: { type: "string", default: "" },   // médium physique (cuivre, fibre OM4, …)
      kind: { type: "string", enum: DATA_OR_POWER, default: "data" },
  },
  cableBundles: {
      name:                    { type: "string" },
      description:             { type: "string", default: "" },
      cable_type_id:           { type: "string", nullable: true, default: null, ref: "cableTypes" },
      // CAPACITÉ = nombre de brins — LUE par la validation (T6 : brin ≤ fiber_count). Défaut 12 en PARITÉ
      // avec le constructeur client (CableBundle.ts) — à maintenir ensemble.
      fiber_count:             { type: "number", min: 1, default: 12 },
      length_m:                { type: "number", nullable: true, default: null, min: 0 },   // longueur du trunk (m) — parité cables.length_m
      waypoint_ids:            { type: "string[]", default: [], ref: "waypoints" },
      // 2 extrémités (des PATCHS — T11) où le trunk est terminé — cf. Port.bundle_id (affectation des brins).
      endpoint_a_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
      endpoint_b_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
  },
  datacenters: {
      name: { type: "string", required: true },
      // DIMENSIONS de la salle (grille au sol) — défauts ALIGNÉS sur le formulaire de salle (RackForms.datacenter :
      // largeur 6000 / profondeur 4000 / maille 600 mm). NB : le constructeur front Datacenter.ts emploie
      // DC_DEPTH_DEFAULT = 6000 pour la profondeur ; ce défaut de spec ne s'applique qu'à une écriture OMETTANT le
      // champ (le formulaire, lui, poste toujours une valeur), et le rendu lit la valeur RÉELLE du record — la
      // divergence de défaut est donc sans incidence. Trou de spec comblé (V6h pour l'existant : régularisation).
      width_mm: { type: "number", min: 1, default: 6000 },
      depth_mm: { type: "number", min: 1, default: 4000 },
      cell_mm:  { type: "number", min: 1, default: 600 },
      // LOCALISATION (héritée par les baies / équipements LIBRES posés dans la salle) — chaînes libres, vides par défaut.
      location: { type: "string", default: "" },
      floor:    { type: "string", default: "" },
      room:     { type: "string", default: "" },
      // PLACEMENT sur le PLAN D'ÉTAGE (coin haut-gauche de l'emprise). null = auto (centré par FloorLayout).
      floor_x:  { type: "number", nullable: true, default: null },
      floor_y:  { type: "number", nullable: true, default: null },
      // ORIENTATION sur le plan d'étage : valeurs MÉTIER 0/90/180/270 (cf. Normalize.rackOrientation). Le validateur
      // ne gère pas l'enum NUMÉRIQUE (FieldSpec.enum = chaînes) → contrainte la PLUS PROCHE exprimable : min 0 (angle
      // non négatif). La normalisation FINE aux 4 quadrants reste faite côté client (Datacenter.ts / Normalize).
      floor_orientation: { type: "number", min: 0, default: 0 },
      // HAUTEUR DE LA SALLE (plafond, mm) — stockée pour usage FUTUR, AUCUN comportement de rendu. DISTINCTE de
      // floors.height_mm (hauteur d'ÉTAGE, collection SÉPARÉE) : aucune collision de nom, sémantiques différentes.
      height_mm:     { type: "number", nullable: true, default: null, min: 1 },
      // HAUTEUR SOUS PLANCHER technique (mm) — le faux-plancher surélevé où posent les baies ; null = pas de plancher
      // technique. Consommée par le rendu 3D (dalle structurelle bleutée sous la salle — cf. DcThreeScene.buildUnderfloorSlab).
      underfloor_mm: { type: "number", nullable: true, default: null, min: 1 },
      description:   { type: "string", default: "" },
      // PORTES de la salle (tableau d'OBJETS value-object) : structure `json` — la normalisation partagée la
      // laisse telle quelle, le CONTENU reste normalisé par Normalize.dcDoors côté client (régularisé
      // 2026-07-31 : c'était un passthrough assumé, la dérivation DDL exige la déclaration).
      doors:         { type: "json", default: [] },
      // CELLULES inaccessibles de la grille (clés « cx,cy ») — string[] ORDINAIRE, PAS dans Schema.ARRAY_FIELDS
      // (liste des filtres `where` par appartenance, personne ne filtre par cellule). Contenu : Normalize.cellList.
      blocked_cells: { type: "string[]", default: [] },
  },
  waypoints: {
      name:          { type: "string" },
      description:   { type: "string", default: "" },
      kind:          { type: "string", enum: WAYPOINT_KINDS, default: "point" },
      wp_type:       { type: "string", enum: WAYPOINT_TYPES, default: "datacenter" },
      locked:        { type: "boolean", default: false },   // positionnement verrouillé (vues 2D/3D) — cf. PlacementLock
      rack_id:       { type: "string", nullable: true, default: null, ref: "racks" },
      datacenter_id: { type: "string", nullable: true, default: null, ref: "datacenters" },
      // BROSSE (kind "brush") : U de départ, hauteur, profondeur de passage. Défauts en PARITÉ avec le
      // constructeur Waypoint.ts — le 100 de depth_mm est AUSSI celui de RackDepth.brushDepth (V6d-brosse),
      // déjà annoncé « à maintenir ensemble » : la spec rejoint cette parité au lieu de la laisser implicite.
      rack_u:        { type: "number", min: 1, default: 1 },
      u_height:      { type: "number", min: 1, default: 1 },
      depth_mm:      { type: "number", min: 1, default: 100 },
      // PIN DE MARGE latérale (side_*) — null = pas un pin de marge. Valeurs fermées côté CLIENT seulement
      // (front/rear, left/right, colonne 0|1) : pas de constante partagée → pas d'enum ici.
      side_face:     { type: "string", nullable: true, default: null },
      side_lr:       { type: "string", nullable: true, default: null },
      side_col:      { type: "number", nullable: true, default: null },
      side_u:        { type: "number", nullable: true, default: null, min: 1 },
      // PIN DE CAPOT ("roof" | "floor" — ensemble côté client) + cellule visée. null = pas un pin de capot.
      cap_face:      { type: "string", nullable: true, default: null },
      cap_cx:        { type: "number", nullable: true, default: null },
      cap_cy:        { type: "number", nullable: true, default: null },
      // POSITION EN SALLE (mm) : pin = (dc_x, dc_y) ; segment = 2 extrémités. null = pool (non posé).
      dc_x:          { type: "number", nullable: true, default: null },
      dc_y:          { type: "number", nullable: true, default: null },
      dc_x2:         { type: "number", nullable: true, default: null },
      dc_y2:         { type: "number", nullable: true, default: null },
      // HAUTEUR (mm) — défaut CONDITIONNEL côté client (2400, mais 3000 pour un pin d'étage ex-OOB —
      // Waypoint.ts) : null = « non renseignée, le client dérive ». Un défaut statique trahirait une branche.
      dc_z:          { type: "number", nullable: true, default: null },
      // SEGMENT : section du conduit (mm). Défauts fixes en parité avec le client (CONDUIT_W/H_DEFAULT,
      // constantes front inimportables ici — valeurs répliquées, à maintenir ensemble).
      width_mm:      { type: "number", min: 0, default: 300 },
      height_mm:     { type: "number", min: 0, default: 100 },
      // PIN : rayon de répartition des câbles (mm) + répartition activée.
      radius:        { type: "number", min: 0, default: 0 },
      spread:        { type: "boolean", default: false },
      // PIN D'ÉTAGE (ex-OOB) : rattachement bâtiment/étage + position sur le plan. null = centré.
      location:      { type: "string", default: "" },
      floor:         { type: "string", default: "" },
      floor_x:       { type: "number", nullable: true, default: null },
      floor_y:       { type: "number", nullable: true, default: null },
  },
  floors: {
      location: { type: "string" },
      floor:    { type: "string", default: "" },   // niveau (2e partie de la clé logique location+floor)
      description: { type: "string", default: "" },
      // PLAN DU BÂTIMENT (mm) : dimensions + maille. Défauts fixes en parité avec le constructeur Floor.ts
      // (FLOOR_*_DEFAULT, constantes front inimportables ici — valeurs répliquées, à maintenir ensemble).
      width_mm: { type: "number", min: 1, default: 20000 },
      depth_mm: { type: "number", min: 1, default: 20000 },
      cell_mm:  { type: "number", min: 1, default: 1000 },
      // ANCRAGE du plan dans la pile 3D (mm) — LU par la contrainte T13 (débordement de bâtiment, qui
      // traite déjà l'absence comme 0) ; défaut 0 = celui du constructeur client.
      anchor_x: { type: "number", default: 0 },
      anchor_y: { type: "number", default: 0 },
      // HAUTEUR d'étage (mm) dans la pile 3D — 0 = auto (hauteur du contenu). DISTINCTE de
      // datacenters.height_mm (plafond de salle).
      height_mm: { type: "number", min: 0, default: 0 },
      // CASES inaccessibles (clés « cx,cy ») — string[] ordinaire, hors ARRAY_FIELDS (cf. racks.roof_cells).
      blocked_cells: { type: "string[]", default: [] },
  },
  ipNetworks: {
      label:          { type: "string", required: true },
      cidr:           { type: "string", required: true, format: "cidr" },
      gateway:        { type: "string", nullable: true, default: null, format: "ipv4" },   // passerelle (∈ CIDR — invariant ci-dessous)
      dns_servers:    { type: "string[]", default: [] },                                    // résolveurs DNS (IPv4, HORS CIDR admis — cf. invariant)
      dhcp_server_id: { type: "string", nullable: true, default: null, ref: "equipments" }, // serveur DHCP du réseau (parité dhcpRanges.server_id)
      description:    { type: "string", default: "" },
  },
  ipAddresses: {
      address:      { type: "string", required: true, format: "ipv4" },
      // Nom d'hôte auquel l'IP résout (saisi dans IpamForms, affiché en liste et dans les fiches). RÉGULARISÉ
      // 2026-07-20 : le champ vivait HORS spec (traversée tolérée) alors que c'est une IDENTITÉ — base des
      // rapprochements par hostname (VM↔hôte via VmClusterFormat, certificats↔cibles à venir). DURCI (décision
      // utilisateur, aucune donnée en conflit) : format `hostname` STRICT (RFC 1123, nom court ou FQDN) — une
      // valeur mal formée est désormais rejetée (400 serveur / erreur UI). Optionnel (non requis) : une IP peut
      // n'avoir aucun nom d'hôte ; trim conservé (fiabilise l'identité pour les rapprochements).
      hostname:     { type: "string", trim: true, format: "hostname" },
      network_id:   { type: "string", nullable: true, default: null, ref: "ipNetworks" },
      equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
      // rattachement à une VM (parité equipment_id) — FK contrôlée (V2) et détachée en cascade (Cascade.vms).
      vm_id:        { type: "string", nullable: true, default: null, ref: "vms" },
      description:  { type: "string", default: "" },
  },
  dhcpRanges: {
      start_ip:   { type: "string", required: true, format: "ipv4" },
      end_ip:     { type: "string", required: true, format: "ipv4" },
      network_id: { type: "string", nullable: true, default: null, ref: "ipNetworks" },
      server_id:  { type: "string", nullable: true, default: null, ref: "equipments" },
      description: { type: "string", default: "" },
  },
  spares: {
      name:                  { type: "string" },
      type:                  { type: "string", enum: SPARE_TYPE_IDS },
      status:                { type: "string", enum: SPARE_STATUS_IDS },
      assigned_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
      // FICHE (chaînes libres, vides par défaut — parité constructeur Spare.ts). `assigned_free` =
      // attribution LIBRE (hors modèle), alternative à la FK ci-dessus.
      brand:            { type: "string", default: "" },
      model_pn:         { type: "string", default: "" },
      serial:           { type: "string", default: "" },
      assigned_free:    { type: "string", default: "" },
      assigned_date:    { type: "string", default: "" },
      purchase_date:    { type: "string", default: "" },
      po_ref:           { type: "string", default: "" },
      storage_location: { type: "string", default: "" },
      comment:          { type: "string", default: "" },
      description:      { type: "string", default: "" },
      // DISQUE (HDD/SSD) : capacité + interface + facteur de forme + vitesse. L'unité "GB" est le défaut du
      // constructeur client ; capacity_value/rpm SANS bornes (le client ne clampe pas — on n'invente rien).
      capacity_value:   { type: "number", nullable: true, default: null },
      capacity_unit:    { type: "string", default: "GB" },
      interface:        { type: "string", default: "" },
      form_factor:      { type: "string", default: "" },
      rpm:              { type: "number", nullable: true, default: null },
      // TRANSCEIVER : forme / débit / média / portée (textes libres).
      tx_form:          { type: "string", default: "" },
      tx_speed:         { type: "string", default: "" },
      tx_media:         { type: "string", default: "" },
      tx_reach:         { type: "string", default: "" },
      // AUTRE : caractéristiques en texte libre.
      specs:            { type: "string", default: "" },
  },
  sites: {
      name:    { type: "string", required: true },
      address: { type: "string" },
      // COORDONNÉES GPS — OPTIONNELLES (doctrine `docs/placement.md` §6.9). Le site était le seul niveau de
      // la hiérarchie de placement SANS géométrie : faute de position déclarée, la vue 3D rangeait les
      // bâtiments côte à côte, donc dérivait une géométrie de l'ensemble AFFICHÉ. Renseignées, elles donnent
      // au site sa position RÉELLE ; absentes, un repli déterministe s'applique (5 km du site précédent).
      // ⚠ Ce sont des coordonnées du MODÈLE : l'échelle de rendu, elle, est un réglage de VUE non persisté.
      lat:     { type: "number", nullable: true, default: null, min: -90,  max: 90  },
      lon:     { type: "number", nullable: true, default: null, min: -180, max: 180 },
      // TAILLE DÉCLARÉE du bâtiment (mm) — OPTIONNELLE (doctrine `docs/placement.md` §6.8, dernier
      // paragraphe). Le bâtiment épousait jusqu'ici son plus grand plan d'étage : il n'avait pas de
      // dimension propre. Déclarée, elle FAIT l'emprise du bâtiment et devient une CONTRAINTE — un plan
      // d'étage ne peut pas en déborder (cf. règle cross-entité de `floors`). Étant OPT-IN, elle ne peut
      // pas rétro-invalider un document : seuls les bâtiments qu'on a choisi de fixer sont contrôlés.
      // INDISSOCIABLES (invariant ci-dessous), comme lat/lon : une demi-dimension ne décrit aucune emprise.
      width_mm: { type: "number", nullable: true, default: null, min: 1 },
      depth_mm: { type: "number", nullable: true, default: null, min: 1 },
      description: { type: "string", default: "" },
  },
  vms: {
      name:              { type: "string", required: true },
      // vm_type / status TOLÉRANTS : PAS de contrainte `enum` — une valeur inconnue (nouveau type/statut d'une
      // release Proxmox) est ACCEPTÉE telle quelle (résilience : le pivot isole l'app, on ne rejette pas une nouveauté).
      vm_type:           { type: "string", default: "qemu" },
      status:            { type: "string", default: "" },
      provider_id:       { type: "string", default: "" },
      // CHAMPS SOURCE restants (écrasés à chaque synchro — frontière et défauts : VmSync.normalizeSource,
      // source de vérité PARTAGÉE). Déclarés depuis le CODE (la collection est vide dans les deux corpus —
      // rapport L0, risque n°2) : en colonnes strictes, un champ non déclaré serait perdu.
      ext_id:            { type: "string", default: "" },      // identité stable « provider/vmid » (clé de réconciliation)
      description_src:   { type: "string", default: "" },      // notes côté PROVIDER (distinctes de `description`, locale)
      host_node:         { type: "string", default: "" },      // nom du nœud hôte côté provider
      cpu:               { type: "number", nullable: true, default: null, min: 0 },   // vCPU — null = non renseigné
      ram_mb:            { type: "number", nullable: true, default: null, min: 0 },
      disk_gb:           { type: "number", nullable: true, default: null, min: 0 },
      tags_src:          { type: "string[]", default: [] },    // étiquettes Proxmox (∈ Schema.ARRAY_FIELDS — filtrables)
      // vNICs EMBARQUÉES (tableau d'OBJETS — VmSync.VmNic) : structure `json`. Le CONTENU reste validé par
      // l'invariant « IPv4 des vNIC » ci-dessous et normalisé par VmSync.normalizeNic (régularisé 2026-07-31 :
      // c'était le passthrough intentionnel historique, la dérivation DDL exige la déclaration).
      nics:              { type: "json", default: [] },
      orphan:            { type: "boolean", default: false },  // disparue à la dernière synchro (jamais supprimée d'office)
      last_sync:         { type: "string", default: "" },      // horodatage ISO de la dernière synchro
      // CHAMPS LOCAUX (jamais touchés par la synchro) : note libre + hôte + groupes.
      notes:             { type: "string", default: "" },
      description:       { type: "string", default: "" },
      // hôte hébergeur (champ LOCAL) — FK vers un équipement, détachée en cascade (cf. Cascade.equipments).
      host_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
      // GROUPES (champs LOCAUX) : PARITÉ STRICTE avec la spec equipments — primaire `group_id` ⊂ `group_ids`
      // (TOUS les groupes), FK contrôlées (V2) et détachées en cascade (Cascade.groups balaie aussi vms).
      group_id:          { type: "string", nullable: true, default: null, ref: "groups" },
      group_ids:         { type: "string[]", default: [], ref: "groups" },
  },
  wifiClients: {
      // CLIENT WIFI vu par un contrôleur (UniFi en 1re implémentation — la marque n'est QU'un
      // adaptateur, cf. cadrage D9). Frontière SOURCE/LOCAUX : `src-shared/WifiSync.ts`, source de
      // vérité PARTAGÉE des défauts ci-dessous (une divergence produirait de faux deltas de synchro).
      // ⚠ TOUS les champs texte portent `default: ""` — jamais de `null` silencieux : en colonnes
      // strictes, un champ non normalisé laisserait un NULL que ni l'UI ni la recherche ne savent lire.
      // `name` n'est PAS `required` (contrairement à `vms.name`) : un client sans hostname est le cas
      // NOMINAL côté wifi — l'UI replie l'affichage sur la MAC (cf. ListConfigs.wifiClients).
      name:            { type: "string", default: "" },
      // client_type TOLÉRANT : PAS de contrainte `enum` — « wireless »/« wired » côté UniFi, mais une
      // autre marque nommera autrement ; une valeur inconnue est ACCEPTÉE telle quelle (parité vms.status).
      client_type:     { type: "string", default: "" },
      provider_id:     { type: "string", default: "" },   // instance d'adaptateur d'origine (multi-contrôleurs)
      ext_id:          { type: "string", default: "" },   // identité stable côté contrôleur (clé de réconciliation)
      mac:             { type: "string", default: "" },
      ip:              { type: "string", default: "" },   // bail CONSTATÉ — informatif (aucune écriture IPAM, cadrage §5)
      ssid:            { type: "string", default: "" },
      ap_mac:          { type: "string", default: "" },
      ap_name:         { type: "string", default: "" },   // nom du point d'accès côté contrôleur (base du rapprochement D4)
      connected_since: { type: "string", default: "" },   // ISO — distingue un RETOUR d'une présence continue
      // « orphelin » = DÉCONNECTÉ (décision D2) : l'API ne liste que les clients CONNECTÉS, disparaître
      // est quotidien. Mécanique identique aux VMs (patch, jamais de delete), seul le LIBELLÉ UI diffère.
      orphan:          { type: "boolean", default: false },
      last_sync:       { type: "string", default: "" },
      // CHAMPS LOCAUX (jamais touchés par la synchro) : note libre + description héritée d'Entity.
      // PAS de groupes en v1 (décision D1 : n'ouvre pas un 4ᵉ balayage du `custom` de Cascade.groups).
      notes:           { type: "string", default: "" },
      description:     { type: "string", default: "" },
      // Point d'accès rapproché — champ DÉRIVÉ par la synchro (nom d'équipement ⇄ ap_name, D4),
      // FK vers un équipement, détachée en cascade (cf. Cascade.equipments) — parité vms.host_equipment_id.
      ap_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
  },
  contacts: {
      name:  { type: "string", required: true, trim: true },   // identité du contact — trimée (fiabilise le libellé)
      email: { type: "string", trim: true },                   // optionnel — format contrôlé en douceur (invariant)
      phone: { type: "string", trim: true },                   // optionnel — quasi libre (invariant)
      notes: { type: "string" },                               // notes libres (multi-lignes) — aucune contrainte
      description: { type: "string", default: "" },            // héritée d'Entity (présente sur tout enregistrement)
  },
} as const satisfies Record<string, Record<string, FieldSpec>>;

/* Types d'ENREGISTREMENT (formes REST partagées, NORMALISÉES) dérivés de SPEC_FIELDS — SOURCE UNIQUE = la spec.
   Regroupés en NAMESPACE (type-only, effacé au build) pour NE PAS entrer en collision avec les CLASSES de modèle
   (`src-client/models/*`, comportement client) ni avec le pivot serveur `VmRecord` (module vm/). ⚠ On ne partage
   QUE le CONTRAT DE FORME : les classes client `implements Records.X` (garde-fou de dérive), le serveur se type
   dessus là où il LIT des champs. Usage : `Records.Equipment`, `Records.Contact`, … */
export namespace Records {
  export type Equipment  = RecordOf<typeof SPEC_FIELDS.equipments>;
  export type Cable      = RecordOf<typeof SPEC_FIELDS.cables>;
  export type Rack       = RecordOf<typeof SPEC_FIELDS.racks>;
  export type Port       = RecordOf<typeof SPEC_FIELDS.ports>;
  export type Aggregate  = RecordOf<typeof SPEC_FIELDS.aggregates>;
  export type SubEquipment = RecordOf<typeof SPEC_FIELDS.subEquipments>;
  export type Network    = RecordOf<typeof SPEC_FIELDS.networks>;
  export type Group      = RecordOf<typeof SPEC_FIELDS.groups>;
  export type RackItem   = RecordOf<typeof SPEC_FIELDS.rackItems>;
  export type PortType   = RecordOf<typeof SPEC_FIELDS.portTypes>;
  export type CableType  = RecordOf<typeof SPEC_FIELDS.cableTypes>;
  export type CableBundle = RecordOf<typeof SPEC_FIELDS.cableBundles>;
  export type Datacenter = RecordOf<typeof SPEC_FIELDS.datacenters>;
  export type Waypoint   = RecordOf<typeof SPEC_FIELDS.waypoints>;
  export type Floor      = RecordOf<typeof SPEC_FIELDS.floors>;
  export type IpNetwork  = RecordOf<typeof SPEC_FIELDS.ipNetworks>;
  export type IpAddress  = RecordOf<typeof SPEC_FIELDS.ipAddresses>;
  export type DhcpRange  = RecordOf<typeof SPEC_FIELDS.dhcpRanges>;
  export type Spare      = RecordOf<typeof SPEC_FIELDS.spares>;
  export type Site       = RecordOf<typeof SPEC_FIELDS.sites>;
  export type Vm         = RecordOf<typeof SPEC_FIELDS.vms>;
  export type WifiClient = RecordOf<typeof SPEC_FIELDS.wifiClients>;
  export type Contact    = RecordOf<typeof SPEC_FIELDS.contacts>;
}

export const COLLECTION_SPECS: Record<string, CollectionSpec> = {
  equipments: {
    fields: SPEC_FIELDS.equipments,
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
      //       Géométrie du plateau IMPORTÉE (src-shared/TrayGeometry) — cf. docs/placement.md §6.7.
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
      // V6e : pas de chevauchement entre équipements posés sur la MÊME étagère (géométrie importée).
      (eq, find, fetch) => TrayFit.overlap(eq, find, fetch),
      // T-POE2 : on ne peut pas RETIRER la capacité POE (poe_device faux) tant qu'un port POE est défini sur
      //          l'équipement (message clair côté équipement ; T-POE1 verrouille aussi côté port via les dependents).
      (eq, find) => {
        if (eq.poe_device === true) return null;
        const poePort = find("ports", "equipment_id", eq.id).find((p: any) => p.role === "poe");
        return poePort ? { path: "poe_device", message: "Retirez d'abord les ports POE avant de désactiver la capacité POE." } : null;
      },
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
    fields: SPEC_FIELDS.cables,
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
      // T9b : un câble d'ÉNERGIE relie deux ports de MÊME GENRE — power↔power ou PoE↔PoE, jamais poe↔power. Même
      //       prédicat `bothPower` que T9 (les deux ports ont un sens power). Un lien PSE PoE (poe+source) ↔ inlet
      //       secteur (power+sink) passerait T9 (source ≠ sink) mais ferait FUITER le port PoE dans le graphe SECTEUR :
      //       isFedSink / rootSourcesOf / downstreamLeafSinks ne filtrent PAS le rôle de l'AUTRE extrémité → charges
      //       faussées, faux « non alimenté ». On l'interdit à l'écriture (front + serveur/import). Le rejeu au
      //       changement de rôle/direction d'un port DÉJÀ câblé est assuré par les dependents ports→cables (V5b, ci-dessous).
      (cable, fetch) => {
        if (!cable.from_port_id || !cable.to_port_id) return null;
        const a = fetch("ports", cable.from_port_id), b = fetch("ports", cable.to_port_id);
        if (!a || !b) return null;
        const da = a.direction, db = b.direction;
        const bothPower = (da === "source" || da === "sink") && (db === "source" || db === "sink");
        return (bothPower && (a.role === "poe") !== (b.role === "poe"))
          ? { path: "to_port_id", message: "Un câble d'énergie relie deux ports de même genre (power↔power ou PoE↔PoE)." }
          : null;
      },
    ],
    scope: [
      // V6h : NOM de câble UNIQUE (non vide) dans le document — post-trim, comparaison EXACTE. MÊME mécanisme que
      // V6g (nom d'équipement) / V6a (adresse IP) : lecture par `find` (conscient du lot), l'entité s'EXCLUANT
      // elle-même par `id`. La casse reste DISCRIMINANTE (« Patch-A » / « patch-a » restent deux noms légaux) —
      // l'unicité ne juge que l'égalité exacte. Un nom VIDE est toléré en multiple (câbles sans nom légaux, cf.
      // champ `name` non `required`) : d'où le `if (!name) return null`.
      (cable, find) => {
        if (!cable.name) return null;
        const duplicate = find("cables", "name", cable.name).some((other) => other.id !== cable.id);
        return duplicate ? { path: "name", message: `Le nom « ${cable.name} » est déjà utilisé par un autre câble.` } : null;
      },
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
    fields: SPEC_FIELDS.racks,
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

  /* ---- collections ÉTENDUES — identité, énumérations, FK (`ref`), et depuis la régularisation D3a la
     TOTALITÉ des champs persistés (cf. doctrine en tête de CollectionSpec). ---- */
  ports: {
    fields: SPEC_FIELDS.ports,
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
      // T12 : la DIRECTION (source/sink) ne se déclare que sur un port d'ÉNERGIE (rôle power ou poe). Sans ça, un port
      //       de rôle « data » avec une direction résiduelle écrite par API/import devient un faux départ / une fausse
      //       charge SECTEUR : PowerAnalysis.eqPortsByDir sélectionne les ports par `direction` en n'excluant QUE le
      //       rôle "poe" (le PoE vit sur son propre graphe) — un data+source passerait donc pour un départ secteur.
      //       Rôles en DUR ici : la source de vérité PortRoles vit côté CLIENT (`src-client/registries/`), et c'est
      //       ÇA qui la rend inimportable — un fichier partagé ne peut pas dépendre du front. (Rien à voir avec
      //       l'auto-suffisance de `src-shared/`, LEVÉE : un autre fichier PARTAGÉ, lui, s'importerait très bien —
      //       cf. `RackDepthPolicy` en tête de fichier.) Leurs ids ("power"/"poe") sont STABLES.
      //       L'UI neutralise déjà la direction au save
      //       (EquipmentForms, au changement de rôle) — cette règle ferme le même trou côté serveur/import.
      { path: "direction", message: "La direction (source/sink) ne se déclare que sur un port d'énergie (rôle power ou poe).", holds: (p) => !p.direction || p.role === "power" || p.role === "poe" },
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
      // T2c : un port et le SOUS-ÉQUIPEMENT auquel il est assigné appartiennent au même équipement.
      //       Décalque exact de la règle d'agrégat ci-dessus, et pour la même raison : sans elle, on assigne
      //       le port du switch A au drive de la librairie B — la FK reste VALIDE (l'enregistrement existe) et
      //       le modèle devient faux EN SILENCE. Le sélecteur de l'UI ne propose que les sous-équipements du
      //       maître, mais un sélecteur n'est pas une garantie : l'API et l'import écrivent sans lui.
      //       ⚠ Cette règle est aussi rejouée DEPUIS `subEquipments` (ses `dependents`) : elle est vérifiée à
      //       l'écriture du PORT, or c'est le SOUS-ÉQUIPEMENT qui peut changer de maître et la casser sans
      //       qu'on ait touché au port.
      (port, fetch) => {
        if (!port.sub_equipment_id || !port.equipment_id) return null;
        const subEquipment = fetch("subEquipments", port.sub_equipment_id);
        return (subEquipment && subEquipment.equipment_id && subEquipment.equipment_id !== port.equipment_id)
          ? { path: "sub_equipment_id", message: "Le sous-équipement doit appartenir au même équipement." } : null;
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
      // T-POE1 : un port POE (role "poe") EXIGE un équipement porteur marqué « POE » (poe_device). Rejoué au
      //          changement d'équipement (dependents equipments→ports) → désactiver poe_device avec des ports POE échoue.
      (port, fetch) => {
        if (port.role !== "poe" || !port.equipment_id) return null;
        const eq = fetch("equipments", port.equipment_id);
        return (eq && eq.poe_device !== true) ? { path: "role", message: "Un port POE exige un équipement marqué « POE »." } : null;
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
    fields: SPEC_FIELDS.aggregates,
  },
  subEquipments: {
    fields: SPEC_FIELDS.subEquipments,
    // `equipment_id` est déjà couvert par `required` (V1) et par l'intégrité référentielle `ref` (V2).
    // La règle d'APPARTENANCE d'un port à un sous-équipement de SON équipement viendra avec
    // `ports.sub_equipment_id` (lot 4, cf. le cadrage §8.2) — elle n'a pas de sens tant que le champ n'existe pas.
    invariants: [
      // Parité equipments (T1d) / vms : le groupe primaire doit être MEMBRE de group_ids. La cascade groups
      // repointe le primaire en cohérence ; l'invariant garantit qu'aucune écriture (API/import) ne casse la
      // relation. ⚠ Troisième copie de la même règle : duplication ASSUMÉE (une par collection porteuse),
      // pas un oubli de factorisation — c'est le choix déjà fait entre equipments et vms.
      { path: "group_id", message: "Le groupe primaire doit faire partie des groupes du sous-équipement.", holds: (se) => !se.group_id || (Array.isArray(se.group_ids) && se.group_ids.includes(se.group_id)) },
    ],
    // V5b — LE cas que la règle T2c des ports ne peut PAS attraper seule (cf. le cadrage §8.3, décision D10) :
    // T2c est vérifiée à l'écriture du PORT, mais c'est le SOUS-ÉQUIPEMENT qui peut changer de maître. Sans ce
    // `dependents`, déplacer un drive vers une autre librairie laisserait ses ports assignés à un
    // sous-équipement d'un AUTRE équipement — incohérence muette, exactement ce que la doctrine proscrit.
    // Le choix est de REFUSER le mouvement (l'erreur remonte à l'écriture du sous-équipement) plutôt que de
    // nettoyer la liaison en silence : on ne détruit pas une saisie sans le dire.
    dependents: [
      { collection: "ports", fkField: "sub_equipment_id" },
    ],
  },
  networks: {
    fields: SPEC_FIELDS.networks,
    invariants: [
      {
        path: "ip_network_id",
        message: "Un réseau d'énergie (power) ne peut pas être rattaché à un réseau IP.",
        holds: (network) => network.kind !== "power" || !network.ip_network_id,
      },
    ],
  },
  groups: {
    fields: SPEC_FIELDS.groups,
  },
  rackItems: {
    fields: SPEC_FIELDS.rackItems,
    invariants: [
      // TRAY : la structure (tray_u) tient dans la hauteur totale RÉSERVÉE (u_height).
      { path: "tray_u", message: "La hauteur du tray (structure) dépasse la hauteur réservée totale.", holds: (it) => it.kind !== "tray" || Math.max(1, it.tray_u | 0) <= Math.max(1, it.u_height | 0) },
    ],
    // V6c : pas de collision de U avec un autre occupant de la baie.
    scope: [(item, find, fetch) => RackOccupancy.collision(item, "rackItems", find, fetch)],
  },
  portTypes: {
    fields: SPEC_FIELDS.portTypes,
  },
  cableTypes: {
    fields: SPEC_FIELDS.cableTypes,
  },
  cableBundles: {
    fields: SPEC_FIELDS.cableBundles,
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
    fields: SPEC_FIELDS.datacenters,
  },
  waypoints: {
    fields: SPEC_FIELDS.waypoints,
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
    // V6c : une brosse ne doit pas collisionner d'autres occupants de la baie (face AVANT seule).
    // V6d-brosse : la profondeur de la brosse + un montage ARRIÈRE au même U ≤ espace partagé (symétrique
    // de l'extension jouée quand on édite l'ÉQUIPEMENT — cf. RackDepth.backToBack).
    scope: [
      (wp, find, fetch) => RackOccupancy.collision(wp, "waypoints", find, fetch),
      (wp, find, fetch) => RackDepth.brushBackToBack(wp, find, fetch),
    ],
  },
  floors: {
    fields: SPEC_FIELDS.floors,
    crossEntity: [
      // T13 — CROSS-ENTITÉ (V5) : CONTRAINTE DE TAILLE DE BÂTIMENT (doctrine `docs/placement.md` §6.8, dernier
      // paragraphe) : un plan d'étage ne peut pas DÉBORDER du bâtiment qui le porte. La règle est
      // cross-entité et non un invariant (V3) parce qu'elle lit le SITE PARENT, hors de l'enregistrement.
      //
      // ⚠ DÉFENSIVE PAR CONSTRUCTION. `floors.location` n'est VOLONTAIREMENT pas déclaré `ref: "sites"` :
      // le dépôt contient des `location` HISTORIQUES (slugs de la table LOCATIONS, cf. Store.siteLabel)
      // sans enregistrement `sites` correspondant. Déclarer la FK ferait rejeter ces documents par
      // l'intégrité référentielle (V2) — une rétro-invalidation massive, que la doctrine interdit. Un site
      // introuvable rend donc la règle NON APPLICABLE, jamais une erreur.
      //
      // OPT-IN : sans taille déclarée sur le site, aucune vérification. Un document existant ne peut pas
      // devenir invalide du fait de cette règle — c'est la condition posée par la doctrine.
      //
      // PORTÉE : la collection `floors` n'existe que pour les étages CONFIGURÉS ; un étage non configuré
      // n'a pas d'enregistrement (FloorLayout.config lui rend un défaut virtuel à `id: null`). La
      // contrainte ne porte donc que sur les étages configurés — c'est correct et voulu : on ne contraint
      // que ce que l'utilisateur a effectivement déclaré.
      (floor, fetch) => {
        const site = floor.location ? fetch("sites", floor.location) : null;
        if (!site || site.width_mm == null || site.depth_mm == null) return null;
        // L'ANCRE fait partie de l'emprise : un plan ancré à 5 000 mm dans un bâtiment de 20 000 mm ne peut
        // mesurer que 15 000 mm. Contrôler la seule dimension laisserait passer un plan poussé hors du
        // bâtiment par son ancrage.
        const axes = [
          { dim: "width_mm", anchor: "anchor_x", limit: Number(site.width_mm), label: "largeur" },
          { dim: "depth_mm", anchor: "anchor_y", limit: Number(site.depth_mm), label: "profondeur" },
        ];
        for (const axis of axes) {
          const size = Number(floor[axis.dim]);
          if (!Number.isFinite(size) || !Number.isFinite(axis.limit)) continue;   // plan sans dimension sur cet axe → rien à comparer
          const anchor = Number(floor[axis.anchor]) || 0, end = anchor + size;
          if (end > axis.limit) return { path: axis.dim, message: `Le plan d'étage déborde du bâtiment en ${axis.label} : ancre ${anchor} + ${axis.label} ${size} = ${end} mm, pour un bâtiment de ${axis.limit} mm.` };
        }
        return null;
      },
    ],
  },
  ipNetworks: {
    fields: SPEC_FIELDS.ipNetworks,
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
    fields: SPEC_FIELDS.ipAddresses,
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
    fields: SPEC_FIELDS.dhcpRanges,
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
    fields: SPEC_FIELDS.spares,
  },
  sites: {
    fields: SPEC_FIELDS.sites,
    invariants: [
      // Les coordonnées vont PAR PAIRE : une latitude sans longitude (ou l'inverse) ne désigne aucun point,
      // elle désigne un parallèle ou un méridien. Le rendu retomberait silencieusement sur le repli 5 km en
      // laissant croire le site géolocalisé — on rejette donc la saisie à moitié faite plutôt que de l'ignorer.
      { path: "lon", message: "Latitude et longitude vont ensemble : renseignez les deux, ou aucune des deux.", holds: (s) => (s.lat == null) === (s.lon == null) },
      // Même raisonnement pour la TAILLE : une largeur sans profondeur (ou l'inverse) ne décrit aucune
      // emprise. Le rendu retomberait silencieusement sur l'emprise déduite des plans d'étage en laissant
      // croire le bâtiment dimensionné, et la CONTRAINTE de débordement ne s'appliquerait que sur un axe.
      { path: "depth_mm", message: "Largeur et profondeur du bâtiment vont ensemble : renseignez les deux, ou aucune des deux.", holds: (s) => (s.width_mm == null) === (s.depth_mm == null) },
    ],
    // T13 / V5b : RÉTRÉCIR un site (ou lui déclarer une taille pour la première fois) peut faire déborder des
    // plans d'étage déjà saisis → re-valider ses étages contre le NOUVEL état du bâtiment. Sans cela la
    // contrainte ne tiendrait qu'à un bout : on refuserait l'étage trop grand, mais on laisserait
    // silencieusement rapetisser le bâtiment sous ses propres étages.
    dependents: [
      { collection: "floors", fkField: "location" },
    ],
  },
  vms: {
    // NB : `nics` (tableau d'OBJETS source Proxmox, normalisé par VmSync.normalizeNic) est déclaré `json`
    // depuis la régularisation 2026-07-31 (il était le passthrough intentionnel historique — l'audit
    // 2026-07-20 ne pouvait pas l'exprimer, FieldType ne couvrait pas les tableaux d'objets). La déclaration
    // ne valide que « c'est un tableau/objet » : le CONTENU reste validé par l'INVARIANT « IPv4 des vNIC »
    // ci-dessous, inchangé.
    fields: SPEC_FIELDS.vms,
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
  wifiClients: {
    // CLIENTS WIFI synchronisés depuis un contrôleur (collection AMOVIBLE, comme `vms`). AUCUN invariant
    // inter-champs : tous les champs source sont des chaînes TOLÉRANTES (le pivot isole l'app des
    // marques — cf. cadrage D9) et il n'y a NI groupes (D1) NI structure `json` à contraindre. La seule
    // règle référentielle est le `ref: "equipments"` d'`ap_equipment_id`, portée par V2 (déclarative).
    // On n'ajoute PAS d'invariant « ip est une IPv4 » : l'adresse vient d'un tiers, elle est INFORMATIVE
    // (aucune écriture IPAM), et refuser une IPv6 ou une valeur exotique ferait ÉCHOUER la synchro entière
    // (`normalizeAndValidate` refuse le lot en bloc) pour une donnée d'affichage — le contraire de la
    // tolérance exigée par le cadrage.
    fields: SPEC_FIELDS.wifiClients,
  },
  contacts: {
    // Carnet de destinataires des NOTIFICATIONS (email/sms), tenu PAR DOCUMENT — cf. Contact.ts / cadrage
    // notifications 2026-07-14 §2 (Q4). AUCUNE FK (`ref`) : rien dans le document ne pointe vers un contact
    // (le lien abonnement→contact est une référence souple `contact_id` HORS document), d'où l'absence de
    // cascade et d'index secondaire. `name` est le seul champ REQUIS ; `email`/`phone` sont validés EN DOUCEUR.
    fields: SPEC_FIELDS.contacts,
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
      traversent inchangés — depuis la régularisation D3a (2026-07-31), seuls l'AUDIT serveur et les deux
      legacy `equipments.face_image*` sont dans ce cas (cf. doctrine en tête de `CollectionSpec`) ; sans
      spec, l'enregistrement est renvoyé tel quel. */
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

      // `isEmpty` ABSORBE `null` (avec `undefined` et `""`) : passé ce point, `value` n'est plus jamais `null`.
      // Une branche `if (value === null) { if (!fieldSpec.nullable) fail(…) }` a longtemps suivi ce bloc —
      // INATTEIGNABLE, donc `nullable` n'a JAMAIS été vérifié à la validation (il ne gouverne que la
      // normalisation, cf. `normalizeField`, et le TYPE dérivé `FieldValue`).
      // ⚠ CONSÉQUENCE MESURÉE, laissée en l'état À DESSEIN — ce n'est pas un oubli : 20 champs ne sont ni
      // `required`, ni `nullable`, ni pourvus d'un `default` (cables.name, racks.width_mm, racks.depth,
      // ports.name, contacts.email…). Sur ceux-là un `null` EXPLICITE traverse normalisation ET validation,
      // alors que leur type dérivé promet du non-null. Aucun enregistrement réel ou de démonstration n'est dans
      // ce cas (0 sur les deux corpus, mesuré le 2026-07-28), mais une écriture API/import pourrait l'être.
      // RÉTABLIR la règle est un CHANGEMENT DE COMPORTEMENT sur une porte d'écriture (à arbitrer, pas à glisser
      // dans un nettoyage) : il faudrait tester `value === null` AVANT `isEmpty`. Le comportement actuel est
      // verrouillé par un test explicite (`test-shared-validation.js`, « null sur champ non-nullable »), pour
      // qu'un rétablissement soit un choix ASSUMÉ et non un effet de bord.
      if (DataValidator.isEmpty(value)) {
        if (fieldSpec.required) fail(field, "required", `Le champ « ${field} » est obligatoire.`);
        continue;   // vide non requis → rien d'autre à vérifier
      }
      if (!DataValidator.matchesType(value, fieldSpec.type)) {
        fail(field, "type", `Le champ « ${field} » doit être de type ${fieldSpec.type}.`);
        continue;   // mauvais type → enum/bornes/ref non pertinents
      }
      if (fieldSpec.enum && !fieldSpec.enum.includes(value as string)) {
        fail(field, "enum", `Valeur « ${value} » invalide pour « ${field} » (attendu : ${fieldSpec.enum.join(", ")}).`);
      }
      if (fieldSpec.min != null && typeof value === "number" && value < fieldSpec.min) {
        fail(field, "min", `Le champ « ${field} » doit être ≥ ${fieldSpec.min}.`);
      }
      // Borne HAUTE — miroir strict de `min` (même mécanisme `fail`, même inclusivité). Elle a longtemps été
      // DÉCLARÉE sans être appliquée : `sites.lat`/`lon` portaient `max: 90` / `max: 180` alors que ni l'interface
      // `FieldSpec` ni le moteur ne connaissaient `max` — une latitude de 200 était donc acceptée à l'écriture
      // (API comprise). Une contrainte déclarée mais inerte est PIRE que pas de contrainte : elle se lit comme
      // appliquée. Le défaut passait la compilation parce que `SPEC_FIELDS` est `as const` — d'où le `satisfies`
      // posé sur ce bloc, qui fait désormais échouer `tsc` sur toute propriété de spec inconnue.
      if (fieldSpec.max != null && typeof value === "number" && value > fieldSpec.max) {
        fail(field, "max", `Le champ « ${field} » doit être ≤ ${fieldSpec.max}.`);
      }
      if (fieldSpec.format && typeof value === "string" && !DataValidator.matchesFormat(value, fieldSpec.format)) {
        const formatLabel = fieldSpec.format === "cidr" ? "un CIDR IPv4 (ex. 10.0.0.0/24)"
          : fieldSpec.format === "hostname" ? "un nom d'hôte valide (ex. srv1 ou srv1.dom.local)"
          : "une adresse IPv4 (ex. 10.0.0.5)";
        fail(field, "format", `Le champ « ${field} » n'est pas ${formatLabel}.`);
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
        for (const error of DataValidator.validateRecord(dependent.collection, child, fetchWithNewParent, undefined)) {
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
      case "json":
        // STRUCTURE opaque (sémantique minimale VOULUE — cf. FieldType) : la valeur présente traverse TELLE
        // QUELLE ; c'est la validation qui refusera un scalaire, et les invariants/normaliseurs client qui
        // jugent le CONTENU. Ne pas « nettoyer » ici : la forme riche appartient au client.
        return rawValue;
      case "string":
      default:
        // `trim` (opt-in par champ) : espaces de tête/queue retirés — une chaîne « tout espaces »
        // devient "" et sera alors signalée par un éventuel `required` (comportement voulu).
        return spec.trim ? String(rawValue).trim() : String(rawValue);
    }
  }

  /** Vrai si la valeur correspond bien au type déclaré. `null` n'arrive JAMAIS ici : il est absorbé en amont
      par `isEmpty` (cf. la note du bloc de validation) — et NON « géré à part par `nullable` », comme
      l'affirmait cette ligne du temps où une branche `value === null`, en réalité inatteignable, la suivait. */
  private static matchesType(value: unknown, type: FieldType): boolean {
    switch (type) {
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "boolean": return typeof value === "boolean";
      case "string[]": return Array.isArray(value) && value.every((item) => typeof item === "string");
      // `json` : objet OU tableau — on ne refuse que les SCALAIRES (le contenu relève des invariants).
      // `null` n'arrive jamais ici (absorbé par `isEmpty`, comme pour tous les types).
      case "json": return typeof value === "object" && value !== null;
      case "string": default: return typeof value === "string";
    }
  }

  private static matchesFormat(value: string, format: NonNullable<FieldSpec["format"]>): boolean {
    if (format === "cidr") return Ipv4.isCidr(value);
    if (format === "hostname") return DataValidator.isHostname(value);
    return Ipv4.toInt(value) != null;
  }

  /** Nom d'hôte / FQDN valide (RFC 1123, insensible à la casse) : un ou plusieurs LABELS séparés par des points ;
      chaque label fait 1 à 63 caractères alphanumériques ou tirets, SANS tiret en tête ni en queue ; longueur
      totale ≤ 253. Refuse espaces, underscores, `_`, accents, ponctuation libre. Accepte aussi bien un nom court
      (« srv1 ») qu'un FQDN (« srv1.dom.local ») — les deux sont des hôtes légitimes, ce n'est pas de la souplesse. */
  private static isHostname(value: string): boolean {
    if (value.length === 0 || value.length > 253) return false;
    const label = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    return value.split(".").every((part) => label.test(part));
  }

  private static refKey(collection: string, id: string): string {
    return collection + " " + id;
  }
}

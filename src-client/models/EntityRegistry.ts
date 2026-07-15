import { Entity, Props } from "./Entity";
import { Equipment } from "./Equipment";
import { Port } from "./Port";
import { Aggregate } from "./Aggregate";
import { Cable } from "./Cable";
import { Network } from "./Network";
import { Group } from "./Group";
import { Rack } from "./Rack";
import { RackItem } from "./RackItem";
import { PortType } from "./PortType";
import { CableType } from "./CableType";
import { CableBundle } from "./CableBundle";
import { Datacenter } from "./Datacenter";
import { Waypoint } from "./Waypoint";
import { Floor } from "./Floor";
import { IpNetwork } from "./IpNetwork";
import { IpAddress } from "./IpAddress";
import { DhcpRange } from "./DhcpRange";
import { Spare } from "./Spare";
import { Site } from "./Site";
import { Vm } from "./Vm";
import { Contact } from "./Contact";

type EntityCtor = new (p?: Props) => Entity;

/* Table collection → classe (pour (dé)sérialisation et fabrique).
   faceImages N'EST PLUS une collection du modèle (les images vivent dans
   imageStore / IndexedDB) ; la classe FaceImage reste utile au boot.
   Déclarée SANS annotation `Record<…>` pour préserver les types LITTÉRAUX
   (clés + classes) dont dérivent `CollectionName` / `EntityOf` ci-dessous. */
const CLASSES_TYPED = {
  equipments: Equipment,
  ports: Port,
  aggregates: Aggregate,
  cables: Cable,
  networks: Network,
  groups: Group,
  racks: Rack,
  rackItems: RackItem,
  portTypes: PortType,
  cableTypes: CableType,
  cableBundles: CableBundle,
  datacenters: Datacenter,
  waypoints: Waypoint,
  floors: Floor,
  ipNetworks: IpNetwork,
  ipAddresses: IpAddress,
  dhcpRanges: DhcpRange,
  spares: Spare,
  sites: Site,
  vms: Vm,
  contacts: Contact,
};
const CLASSES: Record<string, EntityCtor> = CLASSES_TYPED;   // vue « indexable par chaîne » (entrées non fiables)

/** Nom de collection CONNU (type littéral) — permet aux lectures du Store d'être typées. */
export type CollectionName = keyof typeof CLASSES_TYPED;
/** Type d'entité d'une collection (ex. `EntityOf<"racks">` = `Rack`). */
export type EntityOf<C extends CollectionName> = InstanceType<(typeof CLASSES_TYPED)[C]>;

/** Registre des collections d'entités : nom ↔ classe, hydratation. */
export class EntityRegistry {
  static readonly CLASSES = CLASSES;
  static readonly COLLECTIONS = Object.keys(CLASSES);

  /** Constructeur d'une collection (ou undefined si inconnue). */
  static classOf(collection: string): EntityCtor | undefined {
    return CLASSES[collection];
  }

  /** La chaîne désigne-t-elle une collection connue ? (garde pour les entrées non fiables : réseau, import…). */
  static isCollection(collection: string): boolean {
    return Object.prototype.hasOwnProperty.call(CLASSES, collection);
  }

  /** Hydrate un enregistrement brut en instance de la bonne classe. */
  static hydrate(collection: string, props: Props): Entity {
    const Ctor = CLASSES[collection];
    if (!Ctor) throw new Error(`Collection inconnue : ${collection}`);
    return new Ctor(props);
  }
}

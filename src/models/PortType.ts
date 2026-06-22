import { Entity, Props } from "./Entity";

/** Type de port : famille (compatibilité signal/médium) + connecteur physique. */
export class PortType extends Entity {
  name: string;
  family: string;
  connector: string;
  speed: string;
  kind: string;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.family = p.family || "";
    this.connector = p.connector || p.family || "";
    this.speed = p.speed || "";
    this.kind = (p.kind === "power") ? "power" : "data";
  }
}

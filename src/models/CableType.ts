import { Entity, Props } from "./Entity";

/** Type de câble : famille + médium. Data ou Power. */
export class CableType extends Entity {
  name: string;
  family: string;
  medium: string;
  kind: string;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.family = p.family || "";
    this.medium = p.medium || "";
    this.kind = (p.kind === "power") ? "power" : "data";
  }
}

import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";

/** Type de câble : famille + médium. Data ou Power. */
export class CableType extends Entity implements Records.CableType {
  /** Nom affiché (ex. "Cat6a U/FTP"). */
  name: string;
  /** Famille de compatibilité (doit matcher la famille des 2 ports reliés). */
  family: string;
  /** Médium physique (cuivre, fibre OM4, …). */
  medium: string;
  /** "data" | "power". */
  kind: string;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.family = p.family || "";
    this.medium = p.medium || "";
    this.kind = (p.kind === "power") ? "power" : "data";
  }
}

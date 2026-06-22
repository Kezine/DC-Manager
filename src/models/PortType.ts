import { Entity, Props } from "./Entity";

/** Type de port : famille (compatibilité signal/médium) + connecteur physique. */
export class PortType extends Entity {
  /** Nom affiché (ex. "SFP+ 10G"). */
  name: string;
  /** Clé de COMPATIBILITÉ (signal/médium) : un câble relie 2 ports de même famille. */
  family: string;
  /** Connecteur PHYSIQUE (RJ45, SFP+, LC, ST…) — pilote la taille 3D ; défaut = `family`. */
  connector: string;
  /** Débit (libellé libre, ex. "10G"). */
  speed: string;
  /** "data" | "power". */
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

import { Entity, Props } from "./Entity";
import { GroupTypes } from "../domain/GroupTypes";

/** Groupe d'équipements (stack | system | general). */
export class Group extends Entity {
  label: string;
  color: string | null;
  type: string;

  constructor(p: Props = {}) {
    super(p);
    this.label = p.label || "";
    this.color = p.color || null;
    this.type = GroupTypes.isType(p.type) ? p.type : GroupTypes.DEFAULT;
  }
}

import { IDX_NULL } from "./config";
import { RawRecord, Where } from "./types";

/* Index d'égalité d'UNE collection : champ → Map(valeur → Set(id)).
   Maintenance incrémentale : add(obj) / remove(obj). IMPORTANT : remove() doit
   être appelé AVANT de muter les champs indexés (il désindexe d'après les
   valeurs COURANTES), puis add() après mutation.
   Un champ tableau est indexé élément par élément ; une valeur vide tombe sous
   IDX_NULL → ids(field, null) = « éléments non rattachés ». */
export class FieldIndex {
  fields: string[];
  maps: Record<string, Map<any, Set<string>>>;

  constructor(fields?: string[]) {
    this.fields = fields || [];
    this.maps = {};
    this.fields.forEach((f) => { this.maps[f] = new Map(); });
  }

  static norm(v: any): any {
    return (v === null || v === undefined || v === "") ? IDX_NULL : v;
  }

  private _vals(obj: RawRecord, field: string): any[] {
    const v = obj[field];
    if (Array.isArray(v)) return v.length ? v : [null];
    return [v];
  }

  add(obj: RawRecord): void {
    this.fields.forEach((f) => {
      const m = this.maps[f];
      this._vals(obj, f).forEach((x) => {
        const k = FieldIndex.norm(x);
        let s = m.get(k);
        if (!s) { s = new Set(); m.set(k, s); }
        s.add(obj.id);
      });
    });
  }

  remove(obj: RawRecord): void {
    this.fields.forEach((f) => {
      const m = this.maps[f];
      this._vals(obj, f).forEach((x) => {
        const k = FieldIndex.norm(x);
        const s = m.get(k);
        if (s) { s.delete(obj.id); if (!s.size) m.delete(k); }
      });
    });
  }

  has(field: string): boolean {
    return !!this.maps[field];
  }

  /** Ids correspondant à `champ == valeur` (null → « valeur vide »). */
  ids(field: string, value: any): string[] {
    const m = this.maps[field];
    if (!m) return [];
    const s = m.get(FieldIndex.norm(value));
    return s ? [...s] : [];
  }

  /* ---- sémantique d'égalité partagée (alignée sur l'index) ---- */

  /** Une valeur d'enregistrement satisfait-elle un critère ?
      null/undefined ⇔ vide ; un tableau ⇔ contient la valeur. */
  static valueMatches(rv: any, v: any): boolean {
    const empty = (x: any) => x === null || x === undefined || x === "" || (Array.isArray(x) && !x.length);
    if (v === null || v === undefined) return empty(rv);
    return Array.isArray(rv) ? rv.includes(v) : rv === v;
  }

  /** Un enregistrement satisfait-il TOUS les critères d'égalité d'un `where` ? */
  static recordMatches(r: RawRecord, where: Where): boolean {
    if (!where) return true;
    return Object.keys(where).every((f) => FieldIndex.valueMatches(r[f], where[f]));
  }
}

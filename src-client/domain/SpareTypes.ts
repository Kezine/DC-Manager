import { SPARE_TYPES, SPARE_TYPE_DEFAULT, SpareTypeDef } from "./constants";
import { I18n } from "../i18n/I18n";

const BY_ID: Record<string, SpareTypeDef> = Object.fromEntries(SPARE_TYPES.map((t) => [t.id, t]));

/** Registre des types de spare (hdd_ssd | transceiver | other). */
export class SpareTypes {
  static readonly ALL = SPARE_TYPES;
  static readonly DEFAULT = SPARE_TYPE_DEFAULT;

  static isType(x: unknown): boolean { return !!BY_ID[x as string]; }
  static label(id: string): string { const t = BY_ID[id]; return t ? I18n.t(t.labelKey) : (id || "—"); }
  /** INNER markup SVG du type (paths seuls) — à envelopper. Vide si type inconnu. */
  static icon(id: string): string { const t = BY_ID[id]; return t ? t.icon : ""; }
  /** Icône PRÊTE À INSÉRER (span.gi + svg enveloppé), pour les pastilles/listes. Vide si inconnu.
      NB : inutilisable dans une <option> (texte seul) — y passer `label()` nu. */
  static svg(id: string): string { const inner = SpareTypes.icon(id); return inner ? `<span class="gi"><svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg></span>` : ""; }
}

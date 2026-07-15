import { RACK_ORIENTATIONS } from "../domain/constants";
import { DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DOOR_DEFAULT_HEIGHT_MM, DOOR_DEFAULT_FRAME_MM } from "../domain/Doors";
import { Id } from "./Id";

/** Porte de rack normalisée (value-object).
    Définie ICI, et non dans models/Rack, par RESPECT DES COUCHES : c'est la forme
    PRODUITE par `Normalize.rackDoor()` ci-dessous. Comme `core/` ne doit jamais
    importer `models/`, on place le type près de sa fabrique ; `Rack` l'importe
    « vers le bas » (models → core). (Si on préfère regrouper les value-objects,
    les déplacer dans un `core/valueObjects.ts` — mais surtout pas dans models/.) */
export interface RackDoor {
  enabled: boolean;
  thickness_mm: number;
  /** Côté charnière (vantail SIMPLE ; ignoré en double battant — charnières aux DEUX bords). */
  hinge: "left" | "right";
  /** Nombre de VANTAUX : 1 (simple) ou 2 (double battant — deux demi-vantaux, loquets au centre). */
  leaves: 1 | 2;
  hollow: boolean;
  hollow_mm: number;
}

/** Porte de SALLE (datacenter) — value-object stocké dans `datacenters.doors` (la porte « vit dans la salle »,
    pas de collection/listing externe). Collée à un MUR (left/right/top/bottom), positionnée par `offset` (centre le
    long du mur, mm). `frame_mm` = épaisseur du listel (cadre) → passage libre = width_mm − 2·frame_mm. `hinge` (côté
    charnière) est défini depuis le côté d'OUVERTURE (`opening` = interior/exterior) : observateur du côté où s'ouvre
    la porte, regardant le mur → charnière à sa gauche/droite. */
export interface DcDoor {
  id: string;
  wall: "left" | "right" | "top" | "bottom";
  offset: number;
  width_mm: number;
  height_mm: number;
  frame_mm: number;
  /** Côté charnière (vantail SIMPLE ; ignoré en double battant — charnières aux DEUX extrémités). */
  hinge: "left" | "right";
  /** Nombre de VANTAUX : 1 (simple) ou 2 (double battant — deux demi-vantaux, loquets au centre). */
  leaves: 1 | 2;
  opening: "interior" | "exterior";
}

/* Normalisations partagées par plusieurs entités (orientation, portes, cellules,
   listes d'ids). Regroupées en méthodes statiques plutôt qu'en fonctions libres. */
export class Normalize {
  /** Déduplique une liste d'identifiants en préservant l'ordre. */
  static uniqIds<T>(arr: T[]): T[] {
    return arr.filter((id, i) => arr.indexOf(id) === i);
  }

  /** Normalise une paire réseau { network_ids, network_id } : dédup + le PRINCIPAL doit être ∈ ids (sinon 1er de la
      liste, sinon null). Point unique de NORMALISATION de l'invariant « principal ⊆ ids » À LA CONSTRUCTION des
      entités — mutualisé Cable (réseaux portés, legacy dormants) ⇄ Port (assertion terminale). NB : l'invariant est
      AUSSI validé ailleurs (DataValidation T5) et d'autres producteurs de valeurs le respectent sans passer par ici —
      le save d'EquipmentForms (netPrimary/netIds) et l'éditeur de principal (Normalize.mergePrincipal) : ce n'est donc
      pas le SEUL endroit qui touche ces champs, seulement le seul qui les NORMALISE à la construction. */
  static networkRefs(p: any): { network_ids: string[]; network_id: string | null } {
    let ids = Array.isArray(p.network_ids) ? p.network_ids.filter(Boolean) : (p.network_id ? [p.network_id] : []);
    ids = Normalize.uniqIds(ids);
    let primary = p.network_id || null;
    if (primary && !ids.includes(primary)) primary = null;
    if (!primary && ids.length) primary = ids[0];
    return { network_ids: ids, network_id: primary };
  }

  /** FUSION RÉSEAU — change le PRINCIPAL d'un port par un éditeur mono-valeur, SANS écraser un multi préexistant
      (anti-clobber #14 / P5). Fonction PURE (testable hors DOM). Entrées : réseaux actuels `prevIds` + leur principal
      `prevPrincipal`, et le nouveau principal `next` ("" / null = joker). Sortie : la nouvelle paire + `removed` (nb de
      réseaux retirés, pour signaler une perte). Règles :
      - JOKER (`next` vide) → aucun réseau : un « joker + réseaux » est irreprésentable (cf. networkRefs) ; on ne
        l'efface donc PAS en douce → `removed = prevIds.length` (l'appelant le signale) ;
      - port MONO (rien au-delà du seul principal) → le changement REMPLACE (pas d'ancien principal ajouté en
        additionnel INAMOVIBLE faute d'éditeur multi) ;
      - MULTI préexistant → on préserve les additionnels, nouveau principal en tête. */
  static mergePrincipal(prevIds: string[], prevPrincipal: string | null, next: string | null): { network_ids: string[]; network_id: string | null; removed: number } {
    const prev = Array.isArray(prevIds) ? prevIds.filter(Boolean) : [];
    const nextId = next || null;
    if (!nextId) return { network_id: null, network_ids: [], removed: prev.length };
    const hadExtras = prev.some((n) => n !== (prevPrincipal || null));
    const ids = hadExtras ? [nextId, ...prev.filter((n) => n !== nextId)] : [nextId];
    return { network_id: nextId, network_ids: Normalize.uniqIds(ids), removed: 0 };
  }

  /** Ramène une orientation à {0,90,180,270} (0 par défaut). */
  static rackOrientation(o: unknown): number {
    const n = (((o as number) | 0) % 360 + 360) % 360;
    return RACK_ORIENTATIONS.includes(n) ? n : 0;
  }

  /** Liste de cellules « cx,cy » valides et uniques. */
  static cellList(v: unknown): string[] {
    return Array.isArray(v)
      ? Array.from(new Set(v.filter((s: unknown): s is string => typeof s === "string" && /^-?\d+,-?\d+$/.test(s))))
      : [];
  }

  /** Liste de PORTES DE SALLE normalisées (défauts : porte 900×2100 mm, listel 40 mm, charnière gauche, ouvre vers
      l'intérieur, sur le mur haut). L'id est conservé s'il existe, sinon généré. */
  static dcDoors(v: unknown): DcDoor[] {
    if (!Array.isArray(v)) return [];
    return v.filter((d: unknown): d is any => !!d && typeof d === "object").map((d: any) => ({
      id: (typeof d.id === "string" && d.id) ? d.id : Id.uid(),
      wall: (DOOR_WALLS as readonly string[]).includes(d.wall) ? d.wall : "top",
      offset: Math.max(0, Math.round(+d.offset || 0)),
      width_mm: Math.max(100, Math.round(+d.width_mm || DOOR_DEFAULT_WIDTH_MM)),
      height_mm: Math.max(100, Math.round(+d.height_mm || DOOR_DEFAULT_HEIGHT_MM)),
      frame_mm: Math.max(0, Math.round(+d.frame_mm || DOOR_DEFAULT_FRAME_MM)),
      hinge: (d.hinge === "right") ? "right" : "left",
      leaves: (d.leaves === 2 || d.leaves === "2") ? 2 : 1,
      opening: (d.opening === "exterior") ? "exterior" : "interior",
    }));
  }

  /** Porte de rack { enabled, thickness_mm, hinge, hollow, hollow_mm }. */
  static rackDoor(p: any): RackDoor {
    p = p || {};
    return {
      enabled: p.enabled === true,
      thickness_mm: (p.thickness_mm != null && p.thickness_mm !== "") ? Math.max(1, p.thickness_mm | 0) : 40,
      hinge: (p.hinge === "right") ? "right" : "left",
      leaves: (p.leaves === 2 || p.leaves === "2") ? 2 : 1,
      hollow: p.hollow === true,
      hollow_mm: (p.hollow_mm != null && p.hollow_mm !== "") ? Math.max(0, p.hollow_mm | 0) : 0,
    };
  }
}

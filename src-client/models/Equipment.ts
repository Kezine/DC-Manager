import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { EQUIP_DEPTHS } from "../domain/constants";

/** Équipement : matériel répertorié, placé (rack / libre / sol / paroi) et câblé. */
export class Equipment extends Entity {
  /** Nom d'affichage. */
  name: string;
  /** Type d'équipement (switch, router, server, pdu, …) — pilote l'icône/la couleur. */
  type: string;
  /** Marque. */
  brand: string;
  /** Modèle. */
  model: string;
  /** Numéro de série. */
  serial: string;

  /* ---- champs ADMINISTRATIFS (achat / garantie / attribution) ---- */
  /** Date d'achat (YYYY-MM-DD). */
  purchase_date: string;
  /** Référence du bon de commande. */
  po_ref: string;
  /** Date de fin de garantie (YYYY-MM-DD). */
  warranty_end: string;
  /** Date d'attribution (YYYY-MM-DD). */
  assigned_date: string;
  /** Personne à qui l'équipement est attribué. */
  assigned_to: string;
  /** PDU / tableau : capacité max en ampères. null = non renseigné (pertinent si `type === "pdu"`/`"switchboard"`). */
  pdu_max_a: number | null;
  /** CONSOMMATION nominale (W) — un équipement CONSOMMATEUR tire cette puissance en régime normal. Répartie sur
      ses ports power (sink). En WATTS (invariant de la PSU à puissance constante) ; le courant = W / tension du
      circuit se DÉDUIT (cf. Store). null = non renseigné. */
  power_nominal_w: number | null;
  /** CONSOMMATION maximale (W) — pointe. Sert au dimensionnement (rating PSU ≥ max ⇒ redondance réelle). null = idem nominale. */
  power_max_w: number | null;
  /** « Inventaire seul » : répertorié uniquement (ni placé, ni câblé, ni de ports). */
  inventory_only: boolean;
  /** Positionnement VERROUILLÉ : empêche déplacement / rotation / retrait (baie · salle · étagère · étage)
      DEPUIS LES VUES 2D/3D — cf. PlacementLock. Le formulaire reste l'échappatoire (principe n°10). Défaut : libre. */
  locked: boolean;
  /** FK → groups : groupe PRIMAIRE (pilote la couleur héritée). null = aucun. TOUJOURS ∈ `group_ids`. */
  group_id: string | null;
  /** FK[] → groups : TOUS les groupes de l'équipement (primaire + secondaires). Le primaire y est inclus. */
  group_ids: string[];

  /* ---- dimensions (propres à l'équipement) ---- */
  /** Nombre de U. */
  u_height: number;
  /** Largeur RÉELLE du boîtier en mode U (mm) — null = pleine largeur du corps 19″ (comportement historique).
      Si renseignée (petit switch…), TOUJOURS inférieure à la largeur utile 19″ ; les oreilles s'étendent alors
      des rails jusqu'au boîtier (cf. RackGeometry.eqBodyWidth). */
  u_width_mm: number | null;
  /** Alignement du boîtier rétréci dans la baie, VU DE FACE : "left" | "center" | "right". */
  u_align: string;
  /** Profondeur d'occupation LEGACY ("full" | "half" | "quarter") — champ PASSIF : plus jamais écrit par
      l'UI, ne sert qu'au repli de lecture pré-migration (Store._migrateDepths convertit → depth_mm). */
  depth: string;
  /** Profondeur RÉELLE (mm) — la SEULE saisie par l'UI. null = enregistrement legacy pas encore migré. */
  depth_mm: number | null;
  /** Verrouille tout le U / les deux faces. DÉCOUPLÉ de la profondeur : c'est le SEUL pilote d'occupation
      dès que depth_mm existe (forcé vrai uniquement pour un legacy « full » non migré, compat). */
  locks_u: boolean;
  /** DÉBORD de façade (mm, ≥ 0) : le corps dépasse le plan de façade standard AU-DELÀ des oreilles (rare).
      Les oreilles restent au plan standard ; une image « avec oreilles » est alors TRIMMÉE au corps. */
  face_offset_mm: number;

  /* ---- emplacement ---- */
  /** "manual" | "rack" | "side" (marge latérale) | "wall" (paroi) | "floor" (plan d'étage) | "tray" (posé sur une étagère). */
  placement_mode: string;

  /* POSÉ SUR UNE ÉTAGÈRE (rackItem kind "tray" ; dims LIBRES). La baie et la salle se DÉRIVENT de l'étagère. */
  /** FK → rackItems (l'étagère hôte). */
  tray_item_id: string | null;
  /** Position (mm) du bord GAUCHE sur la LARGEUR du plateau. null = centré. */
  tray_x: number | null;
  /** Position (mm) du bord côté FAÇADE, en PROFONDEUR depuis la face de montage. null = centré. */
  tray_y: number | null;

  /* MONTAGE MURAL (paroi latérale d'un rack, dans la marge avant/arrière ; dims LIBRES). */
  /** Paroi gauche/droite : "left" | "right". */
  wall_lr: string;
  /** Marge avant/arrière : "front" | "rear". */
  wall_margin: string;
  /** U de base (bandes de SIDE_U_STEP). */
  wall_u: number;
  /** Colonne le long de la profondeur de marge. */
  wall_col: number;
  /** Face vers le "center" (⊥) ou la "facade" de la marge. */
  wall_orient: string;

  /* SIDE-MOUNT : posé dans la marge latérale du rack `rack_id` (dims LIBRES). */
  /** Face av/ar du montage latéral : "front" | "rear". */
  side_face: string;
  /** Côté gauche/droite : "left" | "right". */
  side_lr: string;
  /** Position verticale en U (snap 4U). */
  side_u: number;
  /** Colonne (0 | 1). */
  side_col: number;
  /** Accroche : "post" (montant) | "wall" (paroi). */
  side_snap: string;

  /* ---- mode d'édition des dimensions ---- */
  /** "u" (U + depth → emplacement rack) | "free" (mm L×l×h → emplacement manuel). */
  dim_mode: string;
  /** Dimensions libres (mm) — longueur (profondeur). null = non renseigné. */
  free_l_mm: number | null;
  /** Dimensions libres (mm) — largeur. */
  free_w_mm: number | null;
  /** Dimensions libres (mm) — hauteur. */
  free_h_mm: number | null;

  /* ---- placement PHYSIQUE dans un datacenter (mode « libre », à plat sur la vue du dessus) ---- */
  /** FK → datacenters. null = non placé. */
  dc_id: string | null;
  /** Centre au sol X (mm). */
  dc_x: number | null;
  /** Centre au sol Y (mm). */
  dc_y: number | null;
  /** Décalage vertical (mm) — NÉGATIF autorisé (sous le faux-plancher). */
  dc_z: number;
  /** Rotation au sol (0/90/180/270). */
  dc_orientation: number;
  /** Position sur le PLAN D'ÉTAGE X (mm). null = non localisé. */
  floor_x: number | null;
  /** Position sur le PLAN D'ÉTAGE Y (mm). */
  floor_y: number | null;

  /* ---- mode MANUEL (lieu libre) ---- */
  /** Lieu / bâtiment (slug ∈ LOCATIONS). */
  location: string;
  /** Étage (∈ FLOORS). */
  floor: string;
  /** Local / salle. */
  room: string;

  /* ---- mode RACK (position asservie au rack) ---- */
  /** FK → racks. */
  rack_id: string | null;
  /** U de bas. null = positionnement libre. */
  rack_u: number | null;
  /** Face (half-depth / dual) : "front" | "rear". */
  rack_side: string;

  /* ---- façade : références vers la bibliothèque d'images ---- */
  /** FK → faceImages (face avant). */
  face_image_id: string | null;
  /** FK → faceImages (face arrière). */
  face_image_rear_id: string | null;
  /** FK → faceImages (dessus) — équipement en dimensionnement libre. */
  face_image_top_id: string | null;
  /** FK → faceImages (dessous). */
  face_image_bottom_id: string | null;
  /** FK → faceImages (gauche). */
  face_image_left_id: string | null;
  /** FK → faceImages (droite). */
  face_image_right_id: string | null;
  /** Legacy inline (avant) — migré vers la bibliothèque au boot, puis null. */
  face_image: string | null;
  /** Legacy inline (arrière) — migré au boot, puis null. */
  face_image_rear: string | null;

  constructor(p: Props = {}) {
    super(p);
    // TRIMÉ à la construction (parité avec la normalisation partagée equipments.name/trim) : le modèle en
    // mémoire porte toujours l'identité propre, avant même la re-sauvegarde qui nettoie le stocké (unicité fiable).
    this.name = (p.name || "").trim();
    this.type = p.type || "switch";
    this.brand = p.brand || "";
    this.model = p.model || "";
    this.serial = p.serial || "";
    this.purchase_date = p.purchase_date || "";
    this.po_ref = p.po_ref || "";
    this.warranty_end = p.warranty_end || "";
    this.assigned_date = p.assigned_date || "";
    this.assigned_to = p.assigned_to || "";
    this.pdu_max_a = (p.pdu_max_a != null && p.pdu_max_a !== "") ? Math.max(0, +p.pdu_max_a || 0) : null;
    this.power_nominal_w = (p.power_nominal_w != null && p.power_nominal_w !== "") ? Math.max(0, +p.power_nominal_w || 0) : null;
    this.power_max_w = (p.power_max_w != null && p.power_max_w !== "") ? Math.max(0, +p.power_max_w || 0) : null;
    this.inventory_only = p.inventory_only === true;
    this.locked = p.locked === true;
    this.group_id = p.group_id || null;
    // group_ids = TOUS les groupes (primaire + secondaires). MIGRATION legacy : un enregistrement d'avant le
    // multi-groupes n'a que `group_id` → group_ids se sème à [group_id]. On garantit aussi que le primaire est
    // TOUJOURS membre (invariant partagé T1d), en tête de liste.
    let gids: string[] = Array.isArray(p.group_ids) ? p.group_ids.filter((x: any) => typeof x === "string" && x) : [];
    if (this.group_id) gids = [this.group_id, ...gids.filter((x) => x !== this.group_id)];   // primaire TOUJOURS en tête
    this.group_ids = [...new Set(gids)];
    this.u_height = (p.u_height != null) ? Math.max(1, p.u_height | 0)
      : (p.rack_u_height != null ? Math.max(1, p.rack_u_height | 0) : 1);
    this.u_width_mm = (p.u_width_mm != null && p.u_width_mm !== "") ? Math.max(1, p.u_width_mm | 0) : null;
    this.u_align = (p.u_align === "left" || p.u_align === "right") ? p.u_align : "center";
    this.depth = EQUIP_DEPTHS.includes(p.depth) ? p.depth
      : (p.rack_depth === "half" ? "half" : "full");
    this.depth_mm = (p.depth_mm != null && p.depth_mm !== "") ? Math.max(1, +p.depth_mm | 0) : null;
    // locks_u forcé UNIQUEMENT pour un legacy « full » non migré (l'enum impliquait les 2 faces) ;
    // dès que depth_mm existe, locks_u est EXPLICITE (le toggle du formulaire fait foi).
    this.locks_u = (this.depth_mm == null && this.depth === "full") ? true : (p.locks_u === true);
    this.face_offset_mm = (p.face_offset_mm != null && p.face_offset_mm !== "") ? Math.max(0, Math.round(+p.face_offset_mm) || 0) : 0;
    this.placement_mode = (p.placement_mode === "rack") ? "rack" : (p.placement_mode === "side") ? "side" : (p.placement_mode === "wall") ? "wall" : (p.placement_mode === "floor") ? "floor" : (p.placement_mode === "tray") ? "tray" : "manual";
    this.tray_item_id = p.tray_item_id || null;
    this.tray_x = (p.tray_x != null && p.tray_x !== "") ? Math.max(0, Math.round(+p.tray_x) || 0) : null;
    this.tray_y = (p.tray_y != null && p.tray_y !== "") ? Math.max(0, Math.round(+p.tray_y) || 0) : null;
    this.wall_lr = (p.wall_lr === "right") ? "right" : "left";
    this.wall_margin = (p.wall_margin === "rear") ? "rear" : "front";
    this.wall_u = (p.wall_u != null) ? Math.max(1, p.wall_u | 0) : 1;
    this.wall_col = (p.wall_col != null) ? Math.max(0, p.wall_col | 0) : 0;
    this.wall_orient = (p.wall_orient === "facade") ? "facade" : "center";
    this.side_face = (p.side_face === "rear") ? "rear" : "front";
    this.side_lr = (p.side_lr === "right") ? "right" : "left";
    this.side_u = (p.side_u != null) ? Math.max(1, p.side_u | 0) : 1;
    this.side_col = (p.side_col === 1 || p.side_col === "1") ? 1 : 0;
    this.side_snap = (p.side_snap === "wall") ? "wall" : "post";
    this.dim_mode = (p.dim_mode === "free" || p.dim_mode === "u") ? p.dim_mode
      : (this.placement_mode === "rack" ? "u" : "free");
    this.free_l_mm = (p.free_l_mm != null) ? Math.max(0, Math.round(+p.free_l_mm) || 0) : null;
    this.free_w_mm = (p.free_w_mm != null) ? Math.max(0, Math.round(+p.free_w_mm) || 0) : null;
    this.free_h_mm = (p.free_h_mm != null) ? Math.max(0, Math.round(+p.free_h_mm) || 0) : null;
    this.dc_id = p.dc_id || null;
    this.dc_x = (p.dc_x != null) ? +p.dc_x : null;
    this.dc_y = (p.dc_y != null) ? +p.dc_y : null;
    this.dc_z = (p.dc_z != null) ? (Math.round(+p.dc_z) || 0) : 0;
    this.dc_orientation = Normalize.rackOrientation(p.dc_orientation);
    this.floor_x = (p.floor_x != null) ? +p.floor_x : null;
    this.floor_y = (p.floor_y != null) ? +p.floor_y : null;
    this.location = p.location || "";
    this.floor = p.floor || "";
    this.room = p.room || "";
    this.rack_id = p.rack_id || null;
    this.rack_u = (p.rack_u != null) ? (p.rack_u | 0) : null;
    this.rack_side = (p.rack_side === "rear") ? "rear" : "front";
    this.face_image_id = p.face_image_id || null;
    this.face_image_rear_id = p.face_image_rear_id || null;
    this.face_image_top_id = p.face_image_top_id || null;
    this.face_image_bottom_id = p.face_image_bottom_id || null;
    this.face_image_left_id = p.face_image_left_id || null;
    this.face_image_right_id = p.face_image_right_id || null;
    this.face_image = p.face_image || null;
    this.face_image_rear = p.face_image_rear || null;
  }
}

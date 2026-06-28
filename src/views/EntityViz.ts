import type { Store } from "../store";
import { Html } from "../core/Html";
import { EquipmentTypes } from "../registries/EquipmentTypes";

/* =============================================================================
   EntityViz — rendu VISUEL riche (HTML) des LIAISONS de ports et des LOCALISATIONS
   d'équipement / baie, partagé par les listings (et réutilisable ailleurs).
     · liaison  : [Équip A] → portA  ⟷  portB ← [Équip B]
     · localisation : Bât. › Étage › Salle › Rack › U   (+ variante abrégée Rack · U)
   Les icônes d'ÉQUIPEMENT proviennent du registre existant (EquipmentTypes) ; les
   icônes de structure (bâtiment, étage, salle, rack, U, lien, flèches, chevron) sont
   définies ici. Couleurs pilotées par le thème (cf. classes .viz-* dans netmap.css).
   ============================================================================= */

/** Icône SVG « trait » (stroke) — bâtiment, étage, etc. (24×24, currentColor). */
const lineIcon = (inner: string): string =>
  `<svg class="viz-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const I = {
  arrowR: lineIcon('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  arrowL: lineIcon('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
  link: lineIcon('<path d="M4 12h16M8 7l-5 5 5 5M16 7l5 5-5 5"/>'),
  building: lineIcon('<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16"/><path d="M14 9h5a1 1 0 0 1 1 1v11"/><line x1="3" y1="21" x2="21" y2="21"/><line x1="8" y1="8" x2="8.01" y2="8"/><line x1="11" y1="8" x2="11.01" y2="8"/><line x1="8" y1="12" x2="8.01" y2="12"/><line x1="11" y1="12" x2="11.01" y2="12"/><line x1="8" y1="16" x2="8.01" y2="16"/><line x1="11" y1="16" x2="11.01" y2="16"/>'),
  stairs: lineIcon('<path d="M4 20h4v-4h4v-4h4v-4h4"/>'),
  door: lineIcon('<path d="M5 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17"/><line x1="3" y1="21" x2="20" y2="21"/><line x1="12.5" y1="12" x2="12.5" y2="12.5"/>'),
  rack: lineIcon('<rect x="5" y="3" width="14" height="18" rx="1"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="16" y2="15"/>'),
  u: lineIcon('<rect x="4" y="4" width="16" height="16" rx="1"/><line x1="4" y1="12" x2="20" y2="12"/>'),
  chevron: lineIcon('<path d="M9 6l6 6-6 6"/>'),
};

interface LocSeg { ic: string; k: string; v: string; mono?: boolean; }

export class EntityViz {
  /* ---- icône d'équipement (registre existant ; conserve ses fill/stroke inline) ---- */
  private static equipIcon(type: string): string { return `<svg class="viz-ic" viewBox="0 0 24 24" aria-hidden="true">${EquipmentTypes.icon(type)}</svg>`; }

  /** Pastille d'équipement (icône de type + nom). `e` peut être nul (port non rattaché). */
  static equipChip(e: any): string {
    if (!e) return `<span class="viz-equip viz-equip-unk">?</span>`;
    return `<span class="viz-equip">${EntityViz.equipIcon(e.type)}<span>${Html.escape(e.name || "(équip.)")}</span></span>`;
  }

  private static portTag(name: string | null | undefined): string { return `<span class="viz-port">${Html.escape(name || "—")}</span>`; }

  /** Liaison d'un câble : Équip A → portA ⟷ portB ← Équip B. Chaque CÔTÉ (équipement + sa flèche + son port) forme
      un bloc INSÉCABLE → l'équipement reste toujours sur la même ligne que son port ; le retour à la ligne éventuel
      se fait au LIEN central (côté B passant alors sous le côté A, comme un câblage à deux lignes). */
  static cableLink(store: Store, c: any): string {
    const pa: any = c.from_port_id && store.get("ports", c.from_port_id);
    const pb: any = c.to_port_id && store.get("ports", c.to_port_id);
    const ea: any = pa && pa.equipment_id && store.get("equipments", pa.equipment_id);
    const eb: any = pb && pb.equipment_id && store.get("equipments", pb.equipment_id);
    const side1 = `<span class="viz-liaison-side">${EntityViz.equipChip(ea)}<span class="viz-own">${I.arrowR}</span>${EntityViz.portTag(pa && pa.name)}</span>`;
    const side2 = `<span class="viz-liaison-side"><span class="viz-link">${I.link}</span>${EntityViz.portTag(pb && pb.name)}<span class="viz-own">${I.arrowL}</span>${EntityViz.equipChip(eb)}</span>`;
    return `<span class="viz-liaison">${side1}${side2}</span>`;
  }

  /* ---- localisation ---- */
  private static segHtml(s: LocSeg): string {
    // densité : icône + valeur seulement (le préfixe « Bât./Étage/… » est gardé en info-bulle `title`).
    return `<span class="viz-loc-seg" title="${Html.escape(s.k)}">${s.ic}<span class="viz-loc-v${s.mono ? " mono" : ""}">${Html.escape(s.v)}</span></span>`;
  }
  private static breadcrumb(segs: LocSeg[]): string {
    if (!segs.length) return `<span class="viz-muted">—</span>`;
    return `<span class="viz-loc">` + segs.map((s, i) => (i > 0 ? `<span class="viz-loc-sep">${I.chevron}</span>` : "") + EntityViz.segHtml(s)).join("") + `</span>`;
  }

  /** Segments Bât. › Étage › Salle issus d'une salle (datacenter). */
  private static dcSegs(store: Store, dc: any): LocSeg[] {
    const segs: LocSeg[] = [];
    if (!dc) return segs;
    const site = store.siteLabel(dc.location || "");
    if (site) segs.push({ ic: I.building, k: "Bât.", v: site });
    if (dc.floor != null && String(dc.floor) !== "") segs.push({ ic: I.stairs, k: "Étage", v: String(dc.floor) });
    const room = dc.room || dc.name;
    if (room) segs.push({ ic: I.door, k: "Salle", v: room });
    return segs;
  }

  /** Plage d'U occupée par un équipement monté en baie (« 24–26 » ou « 8 »), ou null. */
  private static uRange(e: any): string | null {
    if (e.placement_mode !== "rack" || e.rack_u == null) return null;
    const h = Math.max(1, (e.u_height | 0) || 1);
    return h > 1 ? (e.rack_u + "–" + (e.rack_u + h - 1)) : String(e.rack_u);
  }

  /** Localisation COMPLÈTE d'un équipement : Bât. › Étage › Salle › Rack › U (selon le placement). */
  static equipmentLocation(store: Store, e: any): string {
    let dc: any = null, rack: any = null;
    const inRack = e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall";
    if (inRack && e.rack_id) { rack = store.get("racks", e.rack_id); if (rack) dc = rack.datacenter_id && store.get("datacenters", rack.datacenter_id); }
    else if (e.dim_mode === "free" && e.dc_id) { dc = store.get("datacenters", e.dc_id); }
    else if (e.placement_mode === "floor") return `<span class="viz-loc"><span class="viz-loc-seg" title="Étage">${I.stairs}<span class="viz-loc-v">${Html.escape(store.siteLabel(e.location || "") || "—")}${e.floor != null && String(e.floor) !== "" ? " · " + Html.escape(String(e.floor)) : ""}</span></span></span>`;
    const segs = EntityViz.dcSegs(store, dc);
    if (rack) segs.push({ ic: I.rack, k: "Rack", v: rack.name || "(baie)", mono: true });
    const u = EntityViz.uRange(e);
    if (u) segs.push({ ic: I.u, k: "U", v: u, mono: true });
    return EntityViz.breadcrumb(segs);
  }

  /** Variante ABRÉGÉE (badge dense) : Rack · U — repli sur la salle si l'équipement n'est pas en baie. */
  static equipmentLocationShort(store: Store, e: any): string {
    const inRack = e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall";
    if (inRack && e.rack_id) {
      const rack: any = store.get("racks", e.rack_id); if (!rack) return `<span class="viz-muted">—</span>`;
      const u = EntityViz.uRange(e);
      return `<span class="viz-loc-short">${I.rack}<span>${Html.escape(rack.name || "(baie)")}</span>${u ? `<span class="viz-dot">·</span><span>U${Html.escape(u)}</span>` : ""}</span>`;
    }
    if (e.dim_mode === "free" && e.dc_id) { const dc: any = store.get("datacenters", e.dc_id); if (dc) return `<span class="viz-loc-short">${I.door}<span>${Html.escape(dc.room || dc.name || "(salle)")}</span></span>`; }
    return `<span class="viz-muted">—</span>`;
  }

  /** Localisation d'une BAIE : Bât. › Étage › Salle (la baie EST le rack, pas d'U). */
  static rackLocation(store: Store, r: any): string {
    const dc: any = r.datacenter_id && store.get("datacenters", r.datacenter_id);
    if (dc) return EntityViz.breadcrumb(EntityViz.dcSegs(store, dc));
    if (r.room) return `<span class="viz-loc"><span class="viz-loc-seg" title="Salle">${I.door}<span class="viz-loc-v">${Html.escape(r.room)}</span></span></span>`;
    return `<span class="viz-muted">— pool —</span>`;
  }
}

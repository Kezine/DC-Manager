import type { Store } from "../../store";
import { Dom } from "../../ui/Dom";
import { FormControls } from "../../ui/FormControls";
import { MultiSelect } from "../../ui/MultiSelect";
import { Dialog } from "../../ui/Dialog";
import { Notify } from "../../ui/Notify";
import { ContextMenu } from "../../ui/ContextMenu";
import type { CtxSection } from "../../ui/ContextMenu";
import { ImageExport } from "../../ui/ImageExport";
import type { ExportOptions } from "../../ui/ImageExport";
import { Html } from "../../core/Html";
import { Normalize } from "../../core/Normalize";
import { RackGeometry } from "../../geometry/RackGeometry";
import { RackScene } from "../../geometry/RackScene";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { Resolver3D } from "../../geometry/Resolver3D";
import { FloorLayout } from "../../geometry/FloorLayout";
import type { MultiLayout, RoomPlacement } from "../../geometry/FloorLayout";
import { Box } from "../../geometry/Box";
import { Painter } from "../../geometry/Painter";
import { GridGeometry } from "../../geometry/GridGeometry";
import { Depths } from "../../registries/Depths";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { Format } from "../../core/Format";
import { Text } from "../../core/Text";
import { Waypoint } from "../../models/Waypoint";
import { CableStatuses } from "../../domain/CableStatuses";
import { RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, U_MM, SIDE_U_STEP, BRUSH_PADDING_MM } from "../../domain/constants";
import { DC_DOT_PX, WP_HIT_PX, CABLE_PORT_STUB_MM, CABLE_SPLINE_K, CAM_PRESETS, DC_SCOPE_ICONS } from "./shared";
import type { Vec3, Drawable, DatacenterHost } from "./shared";
import { DcViews2D } from "./DcViews2D";

export class DcPanels extends DcViews2D {


  /* ---- toolbar ---- */
  buildToolbar(): void {
    if (!this.toolbarEl) return;
    this.toolbarEl.innerHTML = "";
    // contrôles alignés à DROITE (la sélection de salle se fait au panneau latéral / au clic, pas ici).
    const spacer = document.createElement("div"); spacer.style.flex = "1 1 auto"; this.toolbarEl.appendChild(spacer);

    // ORDRE INVERSÉ : bascules d'édition (déplacement/exclusion, plans 2D) À GAUCHE · modes de vue À DROITE.
    if (this.view === "top" || this.view === "floor") {
      const edits = document.createElement("div"); edits.className = "dc-subviews"; edits.style.cssText = "display:flex;gap:4px";
      const bFree = this.btn("Placement libre", () => { this.freePlace = !this.freePlace; bFree.classList.toggle("active", this.freePlace); }, "Désactive l'aimantation à la grille pendant le glisser (n'affecte pas les éléments déjà placés)");
      bFree.classList.toggle("active", this.freePlace);
      // édition contextuelle : étage courant (plan d'étage) · salle courante (plan de salle)
      const bEdit = (this.view === "floor")
        ? this.btn("Éditer l'étage", () => { const ft = this.floorTargetResolve(); if (ft) this.editFloor(ft.location, ft.floor, false); else this.editFloor("", "", true); }, "Modifier le plan de l'étage courant")
        : this.btn("Éditer la salle", () => { if (this.dcId) this.host.openDatacenterForm?.(this.dcId); }, "Modifier la salle courante");
      const bBlock = this.btn("Cases inaccessibles", () => { this.blockEdit = !this.blockEdit; bBlock.classList.toggle("active", this.blockEdit); this.render(); }, "Glissez une sélection sur la grille pour marquer / démarquer les cases (in)accessibles");
      bBlock.classList.toggle("active", this.blockEdit);
      edits.append(bFree, bEdit, bBlock); this.toolbarEl.appendChild(edits);
      this.toolbarEl.appendChild(this.vsep());   // séparateur : déplacement/exclusion | contrôles de visualisation
    }

    // mode de vue : 3D ⟷ Dessus (2D) ⟷ Étage (plan bâtiment 2D)
    const modes = document.createElement("div"); modes.className = "dc-subviews"; modes.style.cssText = "display:flex;gap:4px";
    ([["3d", "3D"], ["top", "Plan de salle"], ["floor", "Plan d'étage"]] as Array<["3d" | "top" | "floor", string]>).forEach(([m, label]) => {
      const b = this.btn(label, () => { if (this.view === m) return; this.view = m; if (m === "3d") this.blockEdit = false; this.scale = null; this.camTarget = null; this.buildToolbar(); this.render(); });
      b.classList.toggle("active", this.view === m);
      modes.appendChild(b);
    });
    this.toolbarEl.appendChild(modes);
    // NB : les boutons « Mesurer » et « Projection ortho/perspective » sont désormais dans l'overlay de contrôles 3D (cf. buildControls).
    // multi-select des SITES/bâtiments accessibles à l'UI (vide = tous) — filtre la vue Étage / le rail / la portée 3D.
    const sites = this.store.sitesSorted();
    if (sites.length) {
      this.toolbarEl.appendChild(this.vsep());
      const ms = MultiSelect.build("Sites", sites.map((s: any) => ({ id: s.id, label: s.name || s.id })), this.visibleSites, () => { this.buildToolbar(); this.render(); });
      if (sites.length <= 1) {   // un seul site → rien à filtrer : bouton désactivé
        const trig = ms.querySelector(".multi-trigger") as HTMLButtonElement | null;
        if (trig) { trig.disabled = true; trig.title = "Un seul site — rien à filtrer"; }
      }
      this.toolbarEl.appendChild(ms);
    }
    this.updateControls();
  }

  /** N'affiche que la baie `id` (masque les autres salles affichées), la cible et la sélectionne. */
  protected isolateRack(id: string): void {
    const dc = this.current(); if (!dc) return;
    this.hidden3dRacks = new Set(this.displayedDcIds(dc).flatMap((d) => this.store.racksOfDc(d)).map((r: any) => r.id)); this.hidden3dRacks.delete(id);
    const r: any = this.store.get("racks", id);
    if (r) this.camTarget = { x: (r.dc_x != null ? r.dc_x : 0), y: (r.dc_y != null ? r.dc_y : 0), z: RackGeometry.physHeight(r) / 2 };
    this.selRackId = id; this.scale = null; this.render();
  }

  /** Racks du pool (sans salle). */
  protected poolRacks(): any[] { return this.store.all("racks").filter((r: any) => !r.datacenter_id).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")); }

  /** Première maille libre de la salle (placement auto d'une baie/équipement). */
  protected freeCell(dc: any): { x: number; y: number } {
    const cell = dc.cell_mm, placed = this.store.racksOfDc(dc.id);
    const occupied = (x: number, y: number) => placed.some((r: any) => Math.abs((r.dc_x || 0) - x) < cell * 0.5 && Math.abs((r.dc_y || 0) - y) < cell * 0.5);
    for (let y = cell / 2; y <= dc.depth_mm; y += cell) for (let x = cell / 2; x <= dc.width_mm; x += cell) if (!occupied(x, y)) return { x, y };
    return { x: cell / 2, y: cell / 2 };
  }

  /** Câble « inter-DC » : ses deux bouts résolvent dans des salles différentes. */
  protected isInterDc(c: any): boolean { const a = this.store.cableEndDcId(c, "A"), b = this.store.cableEndDcId(c, "B"); return !!(a && b && a !== b); }

  protected cableLabelShort(c: any): string {
    if (c.name) return c.name;
    const pa: any = c.from_port_id ? this.store.get("ports", c.from_port_id) : null, pb: any = c.to_port_id ? this.store.get("ports", c.to_port_id) : null;
    return (pa ? (pa.name || "?") : "?") + " ↔ " + (pb ? (pb.name || "?") : "?");
  }
  /** Câbles candidats de la carte (dessinables dans la vue) : intra-salle des salles affichées
      + inter-DC (mono : sortants ; multi : un bout résolu dans une salle affichée). */

  protected panelCables(dc: any): Array<{ cable: any }> {
    const dcIds = this.displayedDcIds(dc), seen = new Set<string>(), out: Array<{ cable: any }> = [];
    const add = (c: any) => { if (!seen.has(c.id)) { seen.add(c.id); out.push({ cable: c }); } };
    dcIds.forEach((id) => this.resolvedCables(id).forEach((rc) => add(rc.cable)));
    if (dcIds.length === 1) this.outgoingCableStubs(dcIds[0]).forEach((st) => add(st.cable));
    else { const dset = new Set(dcIds); this.store.all("cables").forEach((c: any) => { const da = this.store.cableEndDcId(c, "A"), db = this.store.cableEndDcId(c, "B"); if ((da && dset.has(da)) || (db && dset.has(db))) add(c); }); }
    return out;
  }

  protected eqAllowed(c: any): boolean {
    if (!this._cableEqFilter) return true;
    const pa: any = this.store.get("ports", c.from_port_id), pb: any = this.store.get("ports", c.to_port_id);
    return (pa && pa.equipment_id === this._cableEqFilter) || (pb && pb.equipment_id === this._cableEqFilter);
  }

  protected cableListFiltered(resolved: Array<{ cable: any }>): Array<{ rc: { cable: any }; label: string }> {
    const q = Text.normSearch(this._cableSearch);
    return resolved.map((rc) => ({ rc, label: this.cableLabelShort(rc.cable) }))
      .filter((o) => this.eqAllowed(o.rc.cable) && (!q || Text.normSearch(o.label).includes(q)))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  protected renderCableList(wrap: HTMLElement, resolved: Array<{ cable: any }>): void {
    wrap.innerHTML = "";
    this.cableListFiltered(resolved).slice(0, 200).forEach(({ rc, label }) => {
      const tog = FormControls.toggle(label, this.selCables.has(rc.cable.id), (v) => { if (v) this.selCables.add(rc.cable.id); else this.selCables.delete(rc.cable.id); this.rerenderView(); });
      tog.classList.add("tgl-row"); wrap.appendChild(tog);
    });
  }


  /** Panneau latéral : orchestrateur (cartes selon la vue). */
  renderSide(dc: any): void {
    const side = this.sideEl; if (!side) return;
    side.innerHTML = "";
    if (this.routeBuild) side.appendChild(this.routeCard());   // panneau de routage (toutes vues), en tête
    if (this.measure && this.measure.active) side.appendChild(this.measureCard());   // panneau de mesure (toutes vues), en tête
    if (this.view === "floor") {   // plan d'étage : carte étage + panneau Waypoints (scope étage, toutes les salles)
      side.appendChild(this.collapsible(this.floorCard(), "floor"));
      const ft = this.floorTargetResolve(); const cur = this.current();
      if (ft) {
        const onFloor = (cur && (cur.location || "") === ft.location && String(cur.floor || "") === ft.floor) ? cur : null;
        side.appendChild(this.collapsible(this.floorCablesCard(ft.location, ft.floor), "floorcables"));
        side.appendChild(this.collapsible(this.waypointsCard(onFloor, ft), "waypoints"));
        side.appendChild(this.collapsible(this.view3dOptionsCard(), "view3d"));   // Affichage (waypoints, repères) — view-aware
      }
      return;
    }
    if (!dc) { const h = document.createElement("div"); h.className = "dc-card"; h.innerHTML = '<div class="dc-card-title">Datacenter</div><div class="form-hint">Aucune salle. Créez-en une (onglet Datacenters → Salles) pour la visualiser.</div>'; side.appendChild(h); return; }
    if (this.view === "top") {
      side.appendChild(this.collapsible(this.selectionCard(dc), "sel"));
      side.appendChild(this.collapsible(this.poolRacksCard(dc), "pool"));
      side.appendChild(this.collapsible(this.poolFreeEquipCard(dc), "freepool"));
      side.appendChild(this.collapsible(this.racks3dCard(dc), "rack3d"));   // visibilité des baies — respectée par renderTop
      side.appendChild(this.collapsible(this.waypointsCard(dc), "waypoints"));
      side.appendChild(this.collapsible(this.cableCard(dc), "cables"));
      side.appendChild(this.collapsible(this.view3dOptionsCard(), "view3d"));   // Affichage (waypoints, repères) — view-aware
    } else {
      side.appendChild(this.collapsible(this.dcScopeCard(dc), "dcscope"));   // Datacenters affichés / Vue étage
      side.appendChild(this.collapsible(this.racks3dCard(dc), "rack3d"));
      side.appendChild(this.collapsible(this.cableCard(dc), "cables"));
      side.appendChild(this.collapsible(this.view3dOptionsCard(), "view3d"));
    }
  }


  /* ---- carte SÉLECTION (vue Dessus) : baie / équipement libre / waypoint, ou aide ---- */
  protected selectionCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const wpSel: any = this.selWaypointId ? this.store.get("waypoints", this.selWaypointId) : null;
    const fe: any = this.selEquipId ? this.store.get("equipments", this.selEquipId) : null;
    const r: any = this.selRackId ? this.store.get("racks", this.selRackId) : null;
    const title = (txt: string) => { const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = txt; box.appendChild(t); };
    const acts = () => { const a = document.createElement("div"); a.className = "dc-card-acts"; return a; };
    if (wpSel && wpSel.datacenter_id === dc.id) {
      title(Waypoint.glyph(wpSel) + " " + (wpSel.name || "(waypoint)"));
      const a = acts();
      const bEdit = this.btn("Modifier", () => this.host.openWaypointForm?.(wpSel.id));
      const bDel = this.btn("Supprimer", async () => {
        const ok = await Dialog.confirm({ title: "Supprimer le waypoint", danger: true, message: `Supprimer « ${wpSel.name || "(waypoint)"} » ? Les câbles qui le traversent seront détachés (pas supprimés).` });
        if (!ok) return;
        await this.store.remove("waypoints", wpSel.id); this.selWaypointId = null; this.host.setDirty?.(true); Notify.toast("Waypoint supprimé");
      }); bDel.classList.add("danger");
      a.append(bEdit, bDel); box.appendChild(a);
    } else if (fe && fe.dim_mode === "free" && fe.dc_id === dc.id) {
      title(fe.name || "(équipement)");
      const a = acts();
      const bRot = this.btn("Pivoter 90°", async () => { await this.store.update("equipments", fe.id, { dc_orientation: Normalize.rackOrientation((fe.dc_orientation || 0) + 90) }); this.host.setDirty?.(true); });
      const bEdit = this.btn("Détails", () => this.host.openEquipmentDetail?.(fe.id));
      const bOut = this.btn("Retirer", async () => {
        const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "equipments", id: fe.id, patch: { dc_id: null, dc_x: null, dc_y: null, dc_z: 0 } }];
        if (fe.dc_id) ops.push(...this.store.cableDowngradeOps([fe.id]));
        await this.store.updateBatch(ops);
        this.selEquipId = null; this.host.setDirty?.(true);
        if (ops.length > 1) Notify.toast("Câble(s) repassé(s) en « Planifié » (équipement plus en salle)");
      }); bOut.classList.add("danger");
      a.append(bRot, bEdit, bOut); box.appendChild(a);
    } else if (r && r.datacenter_id === dc.id) {
      title(r.name || "(baie)");
      const info = document.createElement("div"); info.className = "form-hint";
      info.textContent = (r.width_mm || RACK_WIDTH_DEFAULT) + " × " + (r.depth || RACK_DEPTH_DEFAULT) + " mm · " + r.u_count + " U · orientation " + Normalize.rackOrientation(r.orientation) + "°";
      box.appendChild(info);
      const a = acts();
      a.append(
        this.btn("Pivoter 90°", async () => { await this.store.update("racks", r.id, { orientation: Normalize.rackOrientation(r.orientation + 90) }); this.host.setDirty?.(true); }),
        this.btn("Modifier", () => this.host.openRackForm?.(r.id)),
      );
      const bOut = this.btn("Retirer", async () => {
        const eqIds = this.store.equipmentsOfRack(r.id).filter((e: any) => e.placement_mode === "rack" && e.rack_u != null).map((e: any) => e.id);
        const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "racks", id: r.id, patch: { datacenter_id: null, dc_x: null, dc_y: null } }];
        if (r.datacenter_id) ops.push(...this.store.cableDowngradeOps(eqIds));
        await this.store.updateBatch(ops);
        this.selRackId = null; this.host.setDirty?.(true);
        if (ops.length > 1) Notify.toast("Câble(s) repassé(s) en « Planifié » (contenu plus en salle)");
      }); bOut.classList.add("danger"); a.appendChild(bOut);
      box.appendChild(a);
    } else {
      title("Sélection");
      const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Cliquez une baie pour la sélectionner ; glissez-la pour la déplacer (aimantation à la grille).";
      box.appendChild(h);
    }
    return box;
  }


  /* ---- carte RACKS DISPONIBLES (pool) — vue Dessus ---- */
  protected poolRacksCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Racks disponibles (pool)"; box.appendChild(t);
    const pool = this.poolRacks();
    if (!pool.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun rack libre. Créez un rack (onglet Racks) ou retirez-en un d'une salle."; box.appendChild(h); return box; }
    const list = document.createElement("div"); list.className = "dc-pool";
    pool.forEach((rk: any) => {
      const row = document.createElement("div"); row.className = "dc-pool-row";
      const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = (rk.name || "(rack)") + " · " + (rk.width_mm || RACK_WIDTH_DEFAULT) + "×" + (rk.depth || RACK_DEPTH_DEFAULT) + " · " + rk.u_count + "U";
      const b = this.btn("Placer", async () => {
        const why = this.store.rackPlacementBlockedReason(rk.id, dc.id);
        if (why) { Notify.toast("Placement impossible : " + why, "err"); return; }
        const pos = this.freeCell(dc); this.selRackId = rk.id;
        await this.store.update("racks", rk.id, { datacenter_id: dc.id, dc_x: pos.x, dc_y: pos.y }); this.host.setDirty?.(true);
      });
      row.append(lab, b); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }


  /* ---- carte ÉQUIPEMENTS LIBRES (pool) — vue Dessus ---- */
  protected poolFreeEquipCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Équipements libres (pool)"; box.appendChild(t);
    const fpool = this.store.all("equipments").filter((e: any) => e.dim_mode === "free" && !e.dc_id && e.placement_mode !== "floor" && !e.inventory_only).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    if (!fpool.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun équipement « libre » non placé. Créez-en un (onglet Équipements, mode Libre)."; box.appendChild(h); return box; }
    const list = document.createElement("div"); list.className = "dc-pool";
    fpool.forEach((eq: any) => {
      const bx = FreeEquipGeometry.box(eq);
      const row = document.createElement("div"); row.className = "dc-pool-row";
      const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = (eq.name || "(équipement)") + " · " + bx.w + "×" + bx.d + "×" + bx.h + " mm";
      const b = this.btn("Placer", async () => {
        const why = this.store.equipmentPlacementBlockedReason(eq.id, dc.id);
        if (why) { Notify.toast("Placement impossible : " + why, "err"); return; }
        const pos = this.freeCell(dc); this.selRackId = null; this.selEquipId = eq.id;
        await this.store.update("equipments", eq.id, { dc_id: dc.id, dc_x: pos.x, dc_y: pos.y, dc_z: eq.dc_z || 0 }); this.host.setDirty?.(true);
      });
      row.append(lab, b); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }


  /** Ouvre le form d'étage (création `pick` ou édition) avec navigation vers le plan créé. */
  protected editFloor(location: string, floor: string, pick: boolean): void {
    this.host.openFloorForm?.(location, floor, { pick, onPicked: (L: string, F: string) => { this.floorTarget = { location: L, floor: F }; this.view = "floor"; this.scale = null; this.buildToolbar(); this.render(); } });
  }

  /* ---- carte PLAN D'ÉTAGE (vue Étage) : sélecteur bâtiment/étage + salles de l'étage + OOB ---- */
  protected floorCard(): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Plan d'étage"; box.appendChild(t);
    const ft = this.floorTargetResolve();
    if (!ft) {
      const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun étage connu. Créez-en un pour afficher son plan."; box.appendChild(h);
      box.appendChild(this.btn("+ Créer un étage…", () => this.editFloor("", "", true)));
      return box;
    }
    // (Gestion des SITES/bâtiments : onglet « Sites » — plus dans ce panneau. Repère du site courant ci-dessous.)
    const st = document.createElement("div"); st.className = "form-hint"; st.textContent = "Bâtiment : " + this.store.siteLabel(ft.location); box.appendChild(st);
    // salles de cet étage (clic = activer ; bouton = éditer)
    const dcs = this.store.dcsOfFloor(ft.location, ft.floor).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const rt = document.createElement("div"); rt.className = "dc-card-title"; rt.style.marginTop = "8px"; rt.textContent = "Salles (" + dcs.length + ")"; box.appendChild(rt);
    if (!dcs.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucune salle sur cet étage. Posez-en une (onglet Datacenters → Salles · bâtiment/étage)."; box.appendChild(h); }
    else {
      const list = document.createElement("div"); list.className = "dc-layers";
      dcs.forEach((d: any) => {
        const row = document.createElement("div"); row.className = "dc-layer-row";
        const nm = this.btn((d.name || "(salle)") + (d.id === this.dcId ? "  ◀ active" : ""), () => { this.selRoomId = d.id; this.dcId = d.id; this.render(); });
        nm.style.cssText = "flex:1 1 auto;text-align:left;justify-content:flex-start"; nm.classList.toggle("active", this.selRoomId === d.id);
        row.append(nm, this.btn("Modifier", () => this.host.openDatacenterForm?.(d.id)));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    // (OOB : listés dans le panneau « Waypoints » ci-dessous — pas de doublon ici)
    // équipements posés sur cet étage (clic = cibler/sélectionner ; bouton = fiche)
    const feqs = this.store.floorEquipments().filter((e: any) => (e.location || "") === ft.location && String(e.floor || "") === ft.floor).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const et = document.createElement("div"); et.className = "dc-card-title"; et.style.marginTop = "8px"; et.textContent = "Équipements de l'étage (" + feqs.length + ")"; box.appendChild(et);
    if (!feqs.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun équipement posé sur cet étage (mode « Étage » du formulaire d'équipement)."; box.appendChild(h); }
    else {
      const list = document.createElement("div"); list.className = "dc-layers";
      feqs.forEach((eq: any) => {
        const row = document.createElement("div"); row.className = "dc-layer-row";
        const nm = this.btn((eq.name || "(équipement)") + (FloorLayout.floorEquipLocalized(eq) ? "" : " (auto)"), () => { this.selFloorEquip = eq.id; this.render(); });
        nm.style.cssText = "flex:1 1 auto;text-align:left;justify-content:flex-start"; nm.classList.toggle("active", this.selFloorEquip === eq.id);
        row.append(nm, this.btn("ⓘ", () => this.host.openEquipmentDetail?.(eq.id)));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    const acts = document.createElement("div"); acts.className = "dc-card-acts"; acts.style.marginTop = "8px";
    acts.append(
      this.btn("Éditer le plan…", () => this.editFloor(ft.location, ft.floor, false)),
      this.btn("+ Créer un étage…", () => this.editFloor(ft.location, ft.floor, true)),
    );
    box.appendChild(acts);
    const acfg = this.floor.config(ft.location, ft.floor);
    const ah = document.createElement("div"); ah.className = "form-hint"; ah.textContent = "⚓ Ancrage : " + Format.meters(acfg.anchor_x || 0) + " ; " + Format.meters(acfg.anchor_y || 0) + " (affichage : panneau « Affichage »)"; box.appendChild(ah);
    return box;   // recadrage : bouton ⊕ (recentrer) de l'overlay
  }

  /* ---- carte CÂBLES INTER-DC (vue Étage) : affichage des câbles dont les 2 bouts sont sur cet étage ---- */
  protected floorCablesCard(loc: string, fl: string): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Câbles inter-DC"; box.appendChild(t);
    const routes = this.interDcRoutesFloor(loc, fl, this.floor.config(loc, fl));
    if (!routes.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun câble inter-DC sur cet étage (route valide avec exits, les deux bouts dans des salles de l'étage)."; box.appendChild(h); return box; }
    box.appendChild(FormControls.toggle("Tout afficher", this.showAllCables, (v) => { this.showAllCables = v; this.render(); }, { block: true }));
    const list = document.createElement("div"); list.className = "dc-layers";
    routes.slice().sort((a, b) => (a.cable.name || "").localeCompare(b.cable.name || "")).forEach((rc) => {
      const c = rc.cable;
      const row = document.createElement("div"); row.className = "dc-layer-row";
      const tog = FormControls.toggle(c.name || "(câble)", this.showAllCables || this.selCables.has(c.id), (v) => { if (v) this.selCables.add(c.id); else this.selCables.delete(c.id); this.render(); }, { title: "Afficher ce câble inter-DC" });
      tog.style.cssText = "flex:1 1 auto;text-align:left;justify-content:flex-start"; if (this.showAllCables) tog.disabled = true;
      row.append(tog, this.btn("Modifier", () => this.host.openCableForm?.(c.id)));
      list.appendChild(row);
    });
    box.appendChild(list);
    return box;
  }

  /* ---- carte WAYPOINTS (passage de câbles) — GÉNÉRIQUE (plan de salle OU plan d'étage), types séparés en sections.
       `dc` = salle active (création in-situ + scope mono-salle) ; `floor` = scope étage (toutes les salles de l'étage). ---- */

  protected waypointsCard(dc: any, floor?: { location: string; floor: string }): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Waypoints (passage de câbles)"; box.appendChild(t);
    const kindLbl = (k: string) => k === "segment" ? "Chemin" : k === "brush" ? "Brosse" : "Pin";
    // ---- création (pins/chemins/exits dans la salle active si présente ; OOB toujours) ----
    const addActs = document.createElement("div"); addActs.className = "dc-card-acts";
    const mkAdd = (label: string, kind: string, wpType?: string) => this.btn(label, async () => {
      const pos = this.freeCell(dc), cellW = dc.cell_mm || 600;
      const props: any = { name: (wpType === "exit" ? "EXIT-" : "WP-") + (this.store.all("waypoints").length + 1), kind, wp_type: wpType || "datacenter", datacenter_id: dc.id, dc_x: pos.x, dc_y: pos.y };
      if (kind === "segment") { props.dc_x = Math.max(0, pos.x - cellW); props.dc_y = pos.y; props.dc_x2 = Math.min(dc.width_mm, pos.x + cellW); props.dc_y2 = pos.y; }
      const wp = await this.store.create("waypoints", props);
      this.selWaypointId = wp.id; this.setDirty();
      Notify.toast(wpType === "exit" ? "Exit créé — un câble sort par une PAIRE d'exits (salles différentes)" : (kind === "segment" ? "Chemin de câbles créé" : "Pin créé"));
    });
    if (dc) addActs.append(mkAdd("+ Pin", "point"), mkAdd("+ Chemin", "segment"), mkAdd("+ Exit", "point", "exit"));
    addActs.appendChild(this.btn("+ Pin d'étage", async () => {   // ex-OOB : pin hors salle rattaché à un bâtiment/étage
      const loc = floor ? floor.location : (dc ? (dc.location || "") : ""), fl = floor ? floor.floor : (dc ? String(dc.floor || "") : "");
      const wp: any = await this.store.create("waypoints", { name: "PIN-" + (this.store.all("waypoints").length + 1), kind: "point", location: loc, floor: fl });
      this.selWaypointId = wp.id; this.setDirty(); Notify.toast("Pin d'étage créé — glissez-le sur le plan d'étage, éditez sa hauteur");
    }));
    box.appendChild(addActs);
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = dc ? "Astuce : clic droit sur le sol pour créer un waypoint à l'endroit visé. ⏏ exits par paires (salles différentes) · ◎ pin d'étage entre deux exits."
      : "Sélectionnez une salle de l'étage (liste ci-dessus) pour y créer des pins/chemins. ◎ pin d'étage : hors salles, entre deux exits.";
    box.appendChild(hint);
    // ---- scope des waypoints POSÉS : salle active, ou toutes les salles de l'étage ----
    const scopeIds = floor ? this.store.dcsOfFloor(floor.location, floor.floor).map((d: any) => d.id) : (dc ? [dc.id] : []);
    const multiRoom = scopeIds.length > 1;
    const placed = this.store.all("waypoints").filter((w: any) => w.datacenter_id && scopeIds.includes(w.datacenter_id) && this.store.waypointIsPlaced(w) && !Waypoint.isFloorLevel(w));
    // ---- section par TYPE (réplique de la séparation par sections du form équipement) ----
    const section = (title: string, items: any[], action: (wp: any) => HTMLElement) => {
      if (!items.length) return;
      const st = document.createElement("div"); st.className = "dc-card-title"; st.style.marginTop = "8px"; st.textContent = title + " (" + items.length + ")"; box.appendChild(st);
      const list = document.createElement("div"); list.className = "dc-pool";
      items.sort((a, b) => (a.name || "").localeCompare(b.name || "")).forEach((wp) => {
        const row = document.createElement("div"); row.className = "dc-pool-row";
        const n = this.store.cablesOfWaypoint(wp.id).length, room = multiRoom ? " · " + this.store.dcName(wp.datacenter_id) : "";
        const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)") + room + " · " + n + " câble" + (n > 1 ? "s" : "");
        row.append(lab, action(wp)); list.appendChild(row);
      });
      box.appendChild(list);
    };
    const edit = (wp: any) => this.btn("Éditer", () => this.host.openWaypointForm?.(wp.id));
    section("◆ Pins", placed.filter((w: any) => w.kind === "point" && Waypoint.typeOf(w) !== "exit"), edit);
    section("▬ Chemins de câbles", placed.filter((w: any) => w.kind === "segment" && Waypoint.typeOf(w) !== "exit"), edit);
    section("▦ Brosses de brassage", placed.filter((w: any) => w.kind === "brush"), edit);
    section("⏏ Exits (sortie de salle)", placed.filter((w: any) => Waypoint.typeOf(w) === "exit"), edit);
    // ---- pool du bâtiment (à poser dans la salle active) ----
    const wpool = dc ? this.store.waypointsOfDc(null).filter((w: any) => !Waypoint.isFloorLevel(w)) : [];
    section("⏳ Pool du bâtiment (à poser)", wpool, (wp: any) => this.btn("Placer", async () => {
      const pos = this.freeCell(dc), cellW = dc.cell_mm || 600, patch: any = { datacenter_id: dc.id, dc_x: pos.x, dc_y: pos.y };
      if (wp.kind === "segment") { patch.dc_x = Math.max(0, pos.x - cellW); patch.dc_x2 = Math.min(dc.width_mm, pos.x + cellW); patch.dc_y2 = pos.y; }
      this.selWaypointId = wp.id; await this.store.update("waypoints", wp.id, patch); this.setDirty();
    }));
    // ---- Pins d'étage (OOB) du MÊME bâtiment + étage : floor courant si scope étage, sinon ceux de la salle ----
    const oobLoc = floor ? floor.location : (dc ? (dc.location || "") : null);
    const oobFl = floor ? floor.floor : (dc ? String(dc.floor || "") : null);
    const oobs = (oobLoc == null ? [] : this.store.oobWaypoints().filter((w: any) => (w.location || "") === oobLoc && String(w.floor || "") === oobFl))
      .sort((a: any, b: any) => (FloorLayout.floorNum(a.floor) - FloorLayout.floorNum(b.floor)) || (a.name || "").localeCompare(b.name || ""));
    if (oobs.length) {
      const st = document.createElement("div"); st.className = "dc-card-title"; st.style.marginTop = "8px"; st.textContent = "◎ Pins d'étage — hors salles (" + oobs.length + ")"; box.appendChild(st);
      const list = document.createElement("div"); list.className = "dc-pool";
      oobs.forEach((wp: any) => {
        const row = document.createElement("div"); row.className = "dc-pool-row";
        const n = this.store.cablesOfWaypoint(wp.id).length;
        const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)") + " · " + Waypoint.floorLabel(wp) + " · " + n + " câble" + (n > 1 ? "s" : "");
        row.append(lab, edit(wp)); list.appendChild(row);
      });
      box.appendChild(list);
    }
    return box;
  }


  /* ---- carte DATACENTERS (portée d'affichage / Vue étage) — vue 3D ---- */
  protected dcScopeCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Datacenters"; box.appendChild(t);
    const refit = () => { this.camTarget = null; this.scale = null; this.buildToolbar(); this.renderSide(this.current()); this.renderThreeD(this.current()); };
    const all = this.store.all("datacenters");
    const curLoc = dc ? (dc.location || "") : "";
    const bldgIds = (loc: string) => all.filter((d: any) => (d.location || "") === loc).map((d: any) => d.id);
    const selRow = document.createElement("div"); selRow.className = "form-hint"; selRow.style.cssText = "margin-bottom:6px"; selRow.innerHTML = "Salle active : <b>" + Html.escape(dc.name || "(salle)") + "</b>"; box.appendChild(selRow);
    // bascule maître : Vue étage (empilement 3D de plusieurs salles)
    if (all.length) {
      const tog = FormControls.toggle("Multi-DC", this.multiDc, (v) => {
        this.multiDc = v;
        if (v) { if (!this.visibleDcIds.size) { const b = bldgIds(curLoc); this.visibleDcIds = new Set(b.length ? b : all.map((d: any) => d.id)); } }
        refit();
      }, { block: true, title: "Empile plusieurs salles / étages en 3D (bâtiments côte à côte). Désactivé : une seule salle active." });
      if (all.length <= 1) { tog.disabled = true; tog.title = "Une seule salle — rien à empiler"; }   // inutile avec une seule salle
      box.appendChild(tog);
    }
    // préréglages de portée (actifs en Vue étage)
    const displayed = new Set(this.displayedDcIds(dc));
    const sameSet = (arr: string[]) => displayed.size === arr.length && arr.every((id) => displayed.has(id));
    const acts = document.createElement("div"); acts.className = "dc-card-acts";
    const scopeBtn = (icon: string, titleTxt: string, active: boolean, onClick: () => void) => {
      const b = document.createElement("button"); b.type = "button";
      b.className = "btn btn-ghost btn-sm dc-scope-btn" + (active && this.multiDc ? " active" : "");
      b.title = this.multiDc ? titleTxt : (titleTxt + " — disponible en mode Multi-DC"); b.disabled = !this.multiDc;
      b.innerHTML = icon; if (this.multiDc) b.onclick = onClick; return b;
    };
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.self, "Salle active seule", sameSet([dc.id]), () => { this.visibleDcIds = new Set([dc.id]); refit(); }));
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.bldg, "Tout le bâtiment", sameSet(bldgIds(curLoc)), () => { this.visibleDcIds = new Set(bldgIds(curLoc)); refit(); }));
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.all, "Tous les sites", sameSet(all.map((d: any) => d.id)), () => { this.visibleDcIds = new Set(all.map((d: any) => d.id)); refit(); }));
    box.appendChild(acts);
    // liste groupée par bâtiment puis étage (mono = sélection radio ; Vue étage = multi-sélection)
    const locs = Array.from(new Set(all.map((d: any) => d.location || "")))
      .sort((a, b) => (a === curLoc ? -1 : b === curLoc ? 1 : this.store.siteLabel(a).localeCompare(this.store.siteLabel(b))));
    locs.forEach((loc) => {
      const inLoc = all.filter((d: any) => (d.location || "") === loc).sort((a: any, b: any) => FloorLayout.floorNum(a.floor) - FloorLayout.floorNum(b.floor) || (a.name || "").localeCompare(b.name || ""));
      if (!inLoc.length) return;
      const h = document.createElement("div"); h.className = "dc-card-title"; h.style.marginTop = "8px"; h.textContent = this.store.siteLabel(loc) + (loc === curLoc ? " (actif)" : ""); box.appendChild(h);
      const list = document.createElement("div"); list.className = "dc-layers";
      inLoc.forEach((d: any) => {
        const isCur = d.id === dc.id;
        let tog: HTMLElement;
        if (this.multiDc) {
          tog = FormControls.toggle((d.name || "(salle)") + (isCur ? "  ◀ active" : ""), displayed.has(d.id), (v) => { if (v) this.visibleDcIds.add(d.id); else this.visibleDcIds.delete(d.id); refit(); }, { disabled: isCur });
        } else {
          tog = FormControls.toggle((d.name || "(salle)") + (isCur ? "  ◀ active" : ""), isCur, () => { if (isCur) return; this.dcId = d.id; this.selRackId = null; refit(); }, { disabled: isCur });
        }
        tog.classList.add("tgl-row"); list.appendChild(tog);
      });
      box.appendChild(list);
    });
    return box;
  }


  /* ---- carte RACKS (visibilité / estomper / isoler — globale sur les salles affichées) — vue 3D ---- */
  protected racks3dCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Racks"; box.appendChild(t);
    const racks = this.displayedDcIds(dc).flatMap((id) => this.store.racksOfDc(id))
      .sort((a: any, b: any) => (a.datacenter_id !== b.datacenter_id ? this.store.dcName(a.datacenter_id).localeCompare(this.store.dcName(b.datacenter_id)) : 0) || (a.name || "").localeCompare(b.name || ""));
    if (!racks.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun rack dans cette salle."; box.appendChild(h); return box; }
    const quick = document.createElement("div"); quick.className = "dc-card-acts";
    quick.append(
      this.btn("Tout afficher", () => { this.hidden3dRacks.clear(); this.render(); }),
      this.btn("Tout masquer", () => { this.hidden3dRacks = new Set(racks.map((r: any) => r.id)); this.render(); }),
    );
    box.appendChild(quick);
    const list = document.createElement("div"); list.className = "dc-layers";
    racks.forEach((r: any) => {
      const row = document.createElement("div"); row.className = "dc-rack-row";
      const tog = FormControls.toggle(r.name || "(rack)", !this.hidden3dRacks.has(r.id), (v) => { if (v) this.hidden3dRacks.delete(r.id); else this.hidden3dRacks.add(r.id); this.reflow(); });
      tog.classList.add("tgl-row");
      const bIso = this.btn("Isoler", () => this.isolateRack(r.id), "N'afficher que ce rack et le cibler");
      row.append(tog, bIso); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }


  /* ---- carte CÂBLES (sélection par réseau / inter-DC / liste filtrée) — 3D & Dessus ---- */
  protected cableCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const multi = this.displayedDcIds(dc).length > 1;
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Câbles" + (multi ? " (toutes salles affichées)" : ""); box.appendChild(t);
    const resolved = this.panelCables(dc);
    const total = this.store.all("cables").length;
    // créer une route 3D au clic (le prochain clic sur un port libre démarre ; puis waypoints ; puis port terminal)
    const bRoute = this.btn(this.routeBuild ? "✕ Annuler la route" : "🧵 Créer une route", () => { if (this.routeBuild) this.routeCancel(); else this.routeArm(); }, "Tracer un câble en cliquant les ports + waypoints");
    bRoute.style.marginBottom = "6px"; box.appendChild(bRoute);
    box.appendChild(FormControls.toggle("Tout afficher (estompé)", this.showAllCables, (v) => { this.showAllCables = v; this.rerenderView(); }, { block: true }));
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = resolved.length + " câble(s) " + (multi ? "sur les salles affichées" : "raccordable(s) ici") + (total > resolved.length ? " · " + (total - resolved.length) + " hors champ" : "") + ". L'affichage suit la sélection (cases / clic) ; « Tout afficher » montre tout, estompé.";
    box.appendChild(hint);
    if (!resolved.length) return box;
    const addSel = (ids: string[]) => { ids.forEach((id) => this.selCables.add(id)); this.rerenderView(); };
    const delSel = (ids: string[]) => { ids.forEach((id) => this.selCables.delete(id)); this.rerenderView(); };
    const eyePair = (parent: HTMLElement, ids: () => string[], what: string) => {
      parent.append(
        this.btn("◉", () => addSel(ids()), "Sélectionner (afficher) " + what),
        this.btn("◎", () => delSel(ids()), "Désélectionner (masquer) " + what),
      );
    };
    // liens inter-DC
    const interIds = () => resolved.filter((o) => this.isInterDc(o.cable)).map((o) => o.cable.id);
    if (interIds().length) {
      const row = document.createElement("div"); row.className = "dc-layer-row";
      const itx = document.createElement("span"); itx.className = "grow"; itx.textContent = "Liens inter-DC · " + interIds().length;
      row.append(itx); eyePair(row, interIds, "les liens inter-DC"); box.appendChild(row);
    }
    // réseaux
    const netsMap = new Map<string, { label: string; color: string | null; count: number }>();
    resolved.forEach((rc) => { const ids = this.store.cableNetworkIds(rc.cable); (ids.length ? ids : ["__none__"]).forEach((key: string) => { if (!netsMap.has(key)) { const n: any = key !== "__none__" ? this.store.get("networks", key) : null; netsMap.set(key, { label: n ? (n.label || "(réseau)") : "Autre", color: n ? n.color : null, count: 0 }); } netsMap.get(key)!.count++; }); });
    if (netsMap.size) {
      const nt = document.createElement("div"); nt.className = "form-hint"; nt.style.marginTop = "6px"; nt.textContent = "Réseaux (◉ sélectionner · ◎ retirer) :"; box.appendChild(nt);
      const netList = document.createElement("div"); netList.className = "dc-layers";
      [...netsMap.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label)).forEach(([key, info]) => {
        const idsOf = () => resolved.filter((rc) => { const ks = this.store.cableNetworkIds(rc.cable); return (ks.length ? ks : ["__none__"]).includes(key); }).map((rc) => rc.cable.id);
        const row = document.createElement("div"); row.className = "dc-layer-row";
        const sw = document.createElement("span"); sw.className = "dc-net-sw"; sw.style.background = info.color || "var(--fg-dim)";
        const txt = document.createElement("span"); txt.className = "grow"; txt.textContent = info.label + " · " + info.count;
        row.append(sw, txt); eyePair(row, idsOf, "« " + info.label + " »"); netList.appendChild(row);
      });
      box.appendChild(netList);
    }
    // filtres de liste (équipement + texte) — aident à sélectionner, n'affectent pas l'affichage
    const eqIds = new Set<string>();
    resolved.forEach((rc) => { const pa: any = this.store.get("ports", rc.cable.from_port_id), pb: any = this.store.get("ports", rc.cable.to_port_id); if (pa) eqIds.add(pa.equipment_id); if (pb) eqIds.add(pb.equipment_id); });
    const eqOpts = [...eqIds].map((id) => this.store.get("equipments", id)).filter(Boolean).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    if (this._cableEqFilter && !eqIds.has(this._cableEqFilter)) this._cableEqFilter = "";
    const eqSel = FormControls.select([{ value: "", label: "— tous les équipements —" }].concat(eqOpts.map((e: any) => ({ value: e.id, label: (e.name || "(sans nom)") + (multi ? " · " + this.store.dcName(this.store.equipmentDcId(e)) : "") }))), this._cableEqFilter);
    eqSel.style.cssText = "width:100%;margin-top:8px;font-size:11px"; eqSel.onchange = () => { this._cableEqFilter = eqSel.value; this.render(); };
    box.appendChild(eqSel);
    const search = document.createElement("input"); search.type = "text"; search.className = "search-input"; search.placeholder = "Filtrer la liste…"; search.style.cssText = "width:100%;margin:6px 0"; search.value = this._cableSearch;
    search.oninput = () => { this._cableSearch = search.value; this.renderCableList(listWrap, resolved); };
    box.appendChild(search);
    const listActs = document.createElement("div"); listActs.className = "dc-card-acts";
    listActs.append(
      this.btn("Sélectionner la liste", () => addSel(this.cableListFiltered(resolved).map((o) => o.rc.cable.id))),
      this.btn("Retirer la liste", () => delSel(this.cableListFiltered(resolved).map((o) => o.rc.cable.id))),
    );
    box.appendChild(listActs);
    if (this.selCables.size) box.appendChild(this.btn("Effacer la sélection (" + this.selCables.size + ")", () => { this.selCables.clear(); this.rerenderView(); }));
    const listWrap = document.createElement("div"); listWrap.className = "dc-layers"; box.appendChild(listWrap);
    this.renderCableList(listWrap, resolved);
    return box;
  }


  /* ---- carte VUE 3D (options d'affichage) ---- */
  /** Re-render de la SCÈNE de la vue courante (sans reconstruire le panneau) — view-aware : Dessus→renderTop,
      Étage→renderFloor, 3D→renderThreeD (diff WebGL). Pour les toggles d'affichage PARTAGÉS entre vues. */
  protected reflow(): void {
    if (this.view === "floor") { const ft = this.floorTargetResolve(); if (ft) this.renderFloor(ft); return; }
    const d = this.current(); if (!d) return;
    if (this.view === "top") this.renderTop(d); else this.renderThreeD(d);
  }

  /** Carte « Affichage » VIEW-AWARE : chaque toggle déclare les vues où il s'applique (`["3d","top","floor"]`) ;
      seuls les pertinents s'affichent. Affichée en 3D (jeu complet) ET en 2D Dessus/Étage (sous-ensemble : ce que
      le rendu 2D respecte réellement — waypoints, repères d'orientation). Évite que des filtres « 3D » pilotent
      la 2D sans contrôle. Réglages avancés (coloration, sliders, recentrage) : 3D uniquement. */
  protected view3dOptionsCard(): HTMLElement {
    const v = this.view;
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = (v === "3d") ? "Vue 3D" : "Affichage";
    if (v === "3d") {   // icône d'aide (navigation 3D) — uniquement en 3D
      const help = document.createElement("span"); help.className = "settings-help-icon dc-help"; help.textContent = "?";
      help.setAttribute("role", "img"); help.tabIndex = 0; help.setAttribute("aria-label", "Aide : navigation 3D");
      help.title = "Glisser GAUCHE = déplacer le modèle · glisser DROIT (ou Maj+glisser) = orbiter (depuis n'importe où) · molette = zoom (vers la souris).\nSurvolez une baie pour son détail, cliquez-la pour l'éditer.\nEn multi-salles : clic GAUCHE sur le SOL d'une salle = l'activer · clic DROIT = menu.\nPoints de vue : boutons Dessus/Face/Arrière/Côté/3D près du recentrage.";
      t.appendChild(help);
    }
    box.appendChild(t);
    const r3 = () => this.reflow();
    const redraw = () => this.reflow();
    // toggles GROUPÉS par thème. Section LAZY : l'en-tête n'apparaît que si ≥1 toggle s'applique à la vue courante.
    let cur: HTMLElement = box; let pending: string | null = null;
    const section = (label: string) => { pending = label; };
    const I: Record<string, string> = {
      hideFront: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="1"/><rect x="4" y="4" width="16" height="6" fill="currentColor" stroke="none"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5"/></svg>',
      hideRear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="1"/><rect x="4" y="14" width="16" height="6" fill="currentColor" stroke="none"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5"/></svg>',
      names: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M5 12h9M5 18h6"/></svg>',
      ports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/></svg>',
      image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="1.8"/><path d="M21 16l-5-4-8 7"/></svg>',
      sides: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18M19 3v18"/><rect x="9" y="6" width="6" height="12" rx="1"/></svg>',
      door: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17"/><path d="M4 21h16"/><circle cx="13.5" cy="12" r="0.9" fill="currentColor" stroke="none"/></svg>',
      doorSwing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5"/><path d="M5 5a16 16 0 0 1 16 16"/><path d="M5 21h16" stroke-dasharray="2.5 2.5"/></svg>',
      slot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="8" rx="1" stroke-dasharray="3 2.5"/></svg>',
      grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
      marker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l9 9.5-9 9.5-9-9.5z"/></svg>',
      conduit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="8" rx="1"/><path d="M3 12h18" stroke-dasharray="2.5 2.5"/></svg>',
      pivot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>',
      orient: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 5.5l2.4 8.5L12 12l-2.4 2z" fill="currentColor" stroke="none"/></svg>',
      anchor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><line x1="12" y1="7.5" x2="12" y2="21"/><path d="M5 13a7 7 0 0 0 14 0"/><line x1="5" y1="13" x2="8.5" y2="13"/><line x1="15.5" y1="13" x2="19" y2="13"/></svg>',
      perp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v14h14"/><path d="M10.5 18a4.5 4.5 0 0 1 4.5-4.5"/></svg>',
      mouse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l6 15 2.2-6.2L19.5 9.5z"/></svg>',
      onTop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="12" width="14" height="8" rx="1"/><path d="M3 9c3.5 0 4.5-4 9-4s5.5 4 9 4"/></svg>',
    };
    const D3 = ["3d"], ALL = ["3d", "top", "floor"];   // vues d'applicabilité d'un toggle
    const tgi = (views: string[], icon: string, title: string, get: () => boolean, apply: (v: boolean) => void) => {
      if (!views.includes(v)) return;   // toggle non pertinent pour la vue courante → masqué
      if (pending) { const lab = document.createElement("div"); lab.style.cssText = "font-size:10.5px;color:var(--fg-dim);text-transform:uppercase;letter-spacing:.05em;margin:9px 0 3px"; lab.textContent = pending; box.appendChild(lab); cur = document.createElement("div"); cur.className = "dc-3d-toggle-grid"; box.appendChild(cur); pending = null; }
      const b = FormControls.toggle("", get(), (val) => apply(val), { title });
      b.innerHTML = icon; b.title = title; b.setAttribute("aria-label", title); cur.appendChild(b); return b;
    };
    section("Équipements");
    tgi(D3, I.hideFront, "Masquer les équipements montés en façade AVANT", () => this.hideFrontEq, (v) => { this.hideFrontEq = v; r3(); });
    tgi(D3, I.hideRear, "Masquer les équipements montés à l'ARRIÈRE", () => this.hideRearEq, (v) => { this.hideRearEq = v; r3(); });
    tgi(D3, I.ports, "Ports (connecteurs sur les faces)", () => this.showPorts, (v) => { this.showPorts = v; r3(); });
    tgi(D3, I.names, "Noms des équipements", () => this.showEqNames, (v) => { this.showEqNames = v; r3(); });
    tgi(D3, I.image, "Images de façade", () => this.showFaceImages, (v) => { this.showFaceImages = v; r3(); });
    section("Baies");
    tgi(D3, I.sides, "Capots / parois des baies", () => this.showRackSides, (v) => { this.showRackSides = v; r3(); });
    tgi(D3, I.door, "Portes des baies", () => this.showDoors, (v) => { this.showDoors = v; r3(); });
    tgi(["3d", "top"], I.doorSwing, "Débattement des portes : projection du rayon d'ouverture au sol (3D et plan de salle)", () => this.showDoorSwing, (v) => { this.showDoorSwing = v; r3(); });
    tgi(D3, I.slot, "Emplacements libres", () => this.showPlaceholders, (v) => { this.showPlaceholders = v; r3(); });
    section("Câbles");
    tgi(D3, I.onTop, "Câbles toujours au-dessus des équipements / baies (moteur WebGL)", () => this.cablesOnTop, (v) => { this.cablesOnTop = v; if (this.useWebGL && this._three) { this._three.setCablesOnTop(v); this.persistView(); } else r3(); });
    tgi(D3, I.perp, "Sortie ⊥ des ports (20 mm) : les câbles quittent la face perpendiculairement sur 20 mm", () => this.cablePortNormal, (v) => { this.cablePortNormal = v; redraw(); });
    section("Waypoints");
    tgi(ALL, I.marker, "Marqueurs de waypoint (pins, extrémités de chemins/brosses, OOB). N'affecte pas le routage des câbles.", () => this.showWaypoints, (v) => { this.showWaypoints = v; redraw(); });
    tgi(D3, I.conduit, "Brosses et passe-câbles (géométrie des conduits : bacs de chemins de câbles, coques des brosses)", () => this.showConduits, (v) => { this.showConduits = v; r3(); });
    section("Étage & repères");
    tgi(D3, I.grid, "Grilles d'étage", () => this.showFloorGrid, (v) => { this.showFloorGrid = v; r3(); });
    tgi(ALL, I.orient, "Repères d'orientation", () => this.showOrientMarks, (v) => { this.showOrientMarks = v; redraw(); });
    tgi(["floor"], I.anchor, "Point d'ancrage de l'étage", () => this.showFloorAnchor, (v) => { this.showFloorAnchor = v; redraw(); });
    tgi(D3, I.pivot, "Centre de rotation", () => this.showPivot, (v) => { this.showPivot = v; r3(); });
    // Réglages avancés (coloration / sliders / recentrage) — 3D UNIQUEMENT (pas pertinents en 2D).
    if (v === "3d") {
      const colorRow = document.createElement("div"); colorRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px";
      const colTxt = document.createElement("span"); colTxt.className = "grow"; colTxt.textContent = "Coloration";
      const colSel = FormControls.select([{ value: "face", label: "Par face" }, { value: "group", label: "Par groupe" }, { value: "type", label: "Par type" }], this.colorMode);
      colSel.onchange = () => { this.colorMode = colSel.value as any; r3(); };
      colorRow.append(colTxt, colSel); box.appendChild(colorRow);
      // arrondi des câbles (slider) — en WebGL : reconstruction PARTIELLE des seuls câbles (live, coalescée).
      box.appendChild(this.slider("Arrondi des câbles", this.cableSplineK, 0, 0.32, 0.01, (val) => val.toFixed(2), (val) => { this.cableSplineK = val; if (this.useWebGL && this._three) { this._three.setCableSpline(val); this.persistView(); } else redraw(); }));
      // taille des marqueurs de waypoint + connecteurs de port (1 = défaut = milieu du range) — inerte en WebGL (pas de full rebuild).
      box.appendChild(this.slider("Taille marqueurs / ports", this.markerScale, 0.25, 1.75, 0.05, (val) => Math.round(val * 100) + " %", (val) => { this.markerScale = val; if (this.useWebGL && this._three) { this._three.setMarkerScale(val); this.persistView(); } else redraw(); }));
      box.appendChild(this.btn("Recentrer sur la salle", () => { this.camTarget = null; this.hidden3dRacks.clear(); this.scale = null; if (this.useWebGL && this._three) this._three.recenter(); else this.render(); }));
    }
    return box;
  }

}

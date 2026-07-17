import { FormControls } from "../../ui/FormControls";
import { MultiSelect } from "../../ui/MultiSelect";
import { Dialog } from "../../ui/Dialog";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { Normalize } from "../../core/Normalize";
import { RackGeometry } from "../../geometry/RackGeometry";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { FloorLayout } from "../../geometry/FloorLayout";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { Format } from "../../core/Format";
import { Text } from "../../core/Text";
import { Waypoint } from "../../models/Waypoint";
import { PlacementLock } from "../../domain/PlacementLock";
import { RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT } from "../../domain/constants";
import { DC_SCOPE_ICONS } from "./shared";
import { Icons } from "../../ui/Icons";
import { IconButton } from "../../ui/IconButton";
import { I18n } from "../../i18n/I18n";
import { DcViews2D } from "./DcViews2D";

export abstract class DcPanels extends DcViews2D {


  /* ---- toolbar ---- */
  buildToolbar(): void {
    if (!this.toolbarEl) return;
    this.toolbarEl.innerHTML = "";
    // Champ de recherche global (équipement / baie / câble / salle / waypoint) — À GAUCHE, UNIQUEMENT en vue 3D :
    // tout résultat cliqué NAVIGUE vers la 3D (locate → focus3DAt/locateRoom forcent la vue 3D), la recherche n'a
    // donc pas de sens en plan de salle / plan d'étage. Hors 3D on efface aussi le terme, sinon un surlignage « hit »
    // résiduel des câbles subsisterait en plan de salle (cf. cableHit dans DcViews2D) sans bouton ✕ pour l'effacer.
    if (this.view === "3d") this.toolbarEl.appendChild(this.buildSearchBox());
    else this.searchTerm = "";
    // contrôles alignés à DROITE (la sélection de salle se fait au panneau latéral / au clic, pas ici).
    const spacer = document.createElement("div"); spacer.style.flex = "1 1 auto"; this.toolbarEl.appendChild(spacer);

    // ORDRE INVERSÉ : bascules d'édition (déplacement/exclusion, plans 2D) À GAUCHE · modes de vue À DROITE.
    if (this.view === "top" || this.view === "floor") {
      const edits = document.createElement("div"); edits.className = "dc-subviews"; edits.style.cssText = "display:flex;gap:4px";
      const bFree = this.btn(I18n.t("dc.panels.freePlace"), () => { this.freePlace = !this.freePlace; bFree.classList.toggle("active", this.freePlace); }, I18n.t("dc.panels.freePlaceTitle"));
      bFree.classList.toggle("active", this.freePlace);
      // édition contextuelle : étage courant (plan d'étage) · salle courante (plan de salle)
      const bEdit = (this.view === "floor")
        ? this.btn(I18n.t("dc.panels.editFloor"), () => { const ft = this.floorTargetResolve(); if (ft) this.editFloor(ft.location, ft.floor, false); else this.editFloor("", "", true); }, I18n.t("dc.panels.editFloorTitle"))
        : this.btn(I18n.t("dc.panels.editRoom"), () => { const d = this.current(); if (d) this.host.openDatacenterForm?.(d.id); }, I18n.t("dc.panels.editRoomTitle"));   // current() (pas this.dcId, qui peut être null alors qu'une salle par défaut est affichée)
      const bBlock = this.btn(I18n.t("dc.panels.blockedCells"), () => { this.blockEdit = !this.blockEdit; bBlock.classList.toggle("active", this.blockEdit); this.render(); }, I18n.t("dc.panels.blockedCellsTitle"));
      bBlock.classList.toggle("active", this.blockEdit);
      edits.append(bFree, bEdit, bBlock); this.toolbarEl.appendChild(edits);
      this.toolbarEl.appendChild(this.vsep());   // séparateur : déplacement/exclusion | contrôles de visualisation
    }

    // mode de vue : 3D ⟷ Dessus (2D) ⟷ Étage (plan bâtiment 2D) — CHOIX 1 parmi N → contrôle SEGMENTÉ
    // (.rm-toggle : un seul conteneur bordé, segment actif teinté), pas une rangée de boutons d'action.
    const modes = document.createElement("div"); modes.className = "rm-toggle";
    ([["3d", "3D"], ["top", I18n.t("dc.common.roomPlan")], ["floor", I18n.t("dc.common.floorPlan")]] as Array<["3d" | "top" | "floor", string]>).forEach(([m, label]) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label;   // nu : style via .rm-toggle button
      b.classList.toggle("on", this.view === m);
      b.onclick = () => { if (this.view === m) return; this.view = m; if (m === "3d") this.blockEdit = false; this.scale = null; this.camTarget = null; this.buildToolbar(); this.render(); };
      modes.appendChild(b);
    });
    this.toolbarEl.appendChild(modes);
    // NB : les boutons « Mesurer » et « Projection ortho/perspective » sont désormais dans l'overlay de contrôles 3D (cf. buildControls).
    // multi-select des SITES/bâtiments accessibles à l'UI (vide = tous) — filtre la vue Étage / le rail / la portée 3D.
    const sites = this.store.sitesSorted();
    if (sites.length) {
      this.toolbarEl.appendChild(this.vsep());
      const ms = MultiSelect.build(I18n.t("dc.panels.sites"), sites.map((s: any) => ({ id: s.id, label: s.name || s.id })), this.visibleSites, () => { this.buildToolbar(); this.render(); });
      if (sites.length <= 1) {   // un seul site → rien à filtrer : bouton désactivé
        const trig = ms.querySelector(".multi-trigger") as HTMLButtonElement | null;
        if (trig) { trig.disabled = true; trig.title = I18n.t("dc.panels.oneSiteNoFilter"); }
      }
      this.toolbarEl.appendChild(ms);
    }
    this.updateControls();
  }

  /** Champ de recherche global de la toolbar : saisie → résultats (toutes catégories) ; clic → `locate` (mise en
      évidence identique aux boutons « pin ») ; bouton ✕ → `clearHighlight`. Repeuplé depuis `searchTerm` à chaque build. */
  protected buildSearchBox(): HTMLElement {
    const wrap = document.createElement("div"); wrap.style.cssText = "position:relative;display:flex;align-items:center;gap:4px";
    const input = document.createElement("input");
    input.type = "text"; input.className = "search-input"; input.placeholder = I18n.t("dc.panels.searchPlaceholder");
    input.style.cssText = "min-width:220px;max-width:320px;padding:6px 10px;flex:none"; input.value = this.searchTerm;
    const clear = this.btn("", () => this.clearHighlight(), I18n.t("dc.panels.clearHighlight")); clear.innerHTML = Icons.CLOSE;
    const pop = document.createElement("div"); pop.className = "dc-search-pop";
    const hide = () => { pop.classList.remove("open"); pop.innerHTML = ""; };
    const renderPop = () => {
      const res = this.searchResults(input.value); pop.innerHTML = "";
      if (!res.length) { hide(); return; }
      res.forEach((r) => {
        const it = document.createElement("div"); it.className = "dc-search-item";
        const tag = document.createElement("span"); tag.className = "dc-search-tag"; tag.textContent = r.tag;
        const lab = document.createElement("span"); lab.textContent = r.label; lab.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        it.append(tag, lab);
        it.onmousedown = (e) => { e.preventDefault(); hide(); this.locate(r.kind as any, r.id); };   // mousedown : avant le blur
        pop.appendChild(it);
      });
      pop.classList.add("open");
    };
    input.oninput = () => { this.searchTerm = input.value; renderPop(); };
    input.onfocus = () => { if (input.value.trim()) renderPop(); };
    input.onblur = () => { window.setTimeout(hide, 150); };
    input.onkeydown = (e) => {
      if (e.key === "Escape") { hide(); input.blur(); }
      else if (e.key === "Enter") { const res = this.searchResults(input.value); if (res.length) { hide(); this.locate(res[0].kind as any, res[0].id); } }
    };
    wrap.append(input, clear, pop);
    return wrap;
  }

  /** Résultats de recherche, toutes catégories confondues (objets LOCALISABLES uniquement), plafonnés par type. */
  protected searchResults(q: string): Array<{ kind: string; id: string; label: string; tag: string }> {
    const nq = Text.normSearch(q); if (!nq) return [];
    const m = (...vals: any[]) => vals.some((v) => v != null && Text.normSearch(v).includes(nq));
    const out: Array<{ kind: string; id: string; label: string; tag: string }> = [];
    const CAP = 6;
    let n = 0; for (const d of this.store.all("datacenters")) { if (n >= CAP) break; if (m(d.name, d.location)) { out.push({ kind: "room", id: d.id, label: d.name || I18n.t("lists.ph.room"), tag: I18n.t("lists.filter.room") }); n++; } }
    n = 0; for (const r of this.store.all("racks")) { if (n >= CAP) break; if (!r.datacenter_id) continue; if (m(r.name)) { out.push({ kind: "rack", id: r.id, label: r.name || I18n.t("lists.ph.rack"), tag: I18n.t("dc.panels.tagRack") }); n++; } }
    n = 0; for (const e of this.store.all("equipments")) { if (n >= CAP) break; if (!this.store.equipmentDcId(e.id)) continue; if (m(e.name, e.type, e.brand, e.model)) { out.push({ kind: "equipment", id: e.id, label: e.name || I18n.t("lists.ph.equipment"), tag: I18n.t("dc.panels.tagEquip") }); n++; } }
    n = 0; for (const c of this.store.all("cables")) { if (n >= CAP) break; const lab = this.cableLabelShort(c); if (m(c.name, lab) && (this.portDcId(c.from_port_id) || this.portDcId(c.to_port_id))) { out.push({ kind: "cable", id: c.id, label: lab, tag: I18n.t("dc.panels.tagCable") }); n++; } }
    n = 0; for (const w of this.store.all("waypoints")) { if (n >= CAP) break; if (!w.datacenter_id || !this.store.waypointIsPlaced(w)) continue; if (m(w.name)) { out.push({ kind: "waypoint", id: w.id, label: Waypoint.glyph(w) + " " + (w.name || I18n.t("dc.common.waypoint")), tag: I18n.t("dc.panels.tagWaypoint") }); n++; } }
    return out;
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
    if (this.routeTool.active) side.appendChild(this.routeTool.card());   // panneau de routage (toutes vues), en tête
    if (this.measureTool.hasActive()) side.appendChild(this.measureTool.card());   // panneau de mesure (toutes vues), en tête
    if (this.posTool.active) side.appendChild(this.posTool.card());   // panneau d'aide au positionnement (vues 2D)
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
    if (!dc) { const h = document.createElement("div"); h.className = "dc-card"; h.innerHTML = '<div class="dc-card-title">' + I18n.t("dc.panels.dcTitle") + '</div><div class="form-hint">' + I18n.t("dc.panels.noRoomHint") + '</div>'; side.appendChild(h); return; }
    if (this.view === "top") {
      if (this.store.all("datacenters").length > 1) side.appendChild(this.collapsible(this.roomPickerCard(dc), "roompick"));   // changer de salle (sans les contrôles multi-salle de la 3D)
      side.appendChild(this.collapsible(this.selectionCard(dc), "sel"));
      side.appendChild(this.collapsible(this.poolRacksCard(dc), "pool"));
      side.appendChild(this.collapsible(this.poolFreeEquipCard(dc), "freepool"));
      side.appendChild(this.collapsible(this.racks3dCard(dc), "rack3d"));   // visibilité des baies — respectée par renderTop
      side.appendChild(this.collapsible(this.freeEquip3dCard(dc), "freeeq3d"));   // visibilité des équipements libres (par équip. / type / groupe)
      side.appendChild(this.collapsible(this.doorTool.card(dc), "doors"));   // portes de la salle (collées aux murs) — cf. DoorTool
      side.appendChild(this.collapsible(this.waypointsCard(dc), "waypoints"));
      side.appendChild(this.collapsible(this.cableCard(dc), "cables"));
      side.appendChild(this.collapsible(this.view3dOptionsCard(), "view3d"));   // Affichage (waypoints, repères) — view-aware
    } else {
      side.appendChild(this.collapsible(this.dcScopeCard(dc), "dcscope"));   // Datacenters affichés / Vue étage
      side.appendChild(this.collapsible(this.racks3dCard(dc), "rack3d"));
      side.appendChild(this.collapsible(this.freeEquip3dCard(dc), "freeeq3d"));   // visibilité des équipements libres (par équip. / type / groupe)
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
      title(Waypoint.glyph(wpSel) + " " + (wpSel.name || I18n.t("dc.common.waypoint")));
      const a = acts();
      const bEdit = this.btn(I18n.t("lists.chrome.rowEdit"), () => this.host.openWaypointForm?.(wpSel.id));
      const bDel = this.btn(I18n.t("ui.action.delete"), async () => {
        const ok = await Dialog.confirm({ title: I18n.t("dc.common.delWpTitle"), danger: true, message: I18n.t("dc.panels.delWpMsgDetach", { name: wpSel.name || I18n.t("dc.common.waypoint") }) });
        if (!ok) return;
        await this.store.remove("waypoints", wpSel.id); this.selWaypointId = null; this.host.setDirty?.(true); Notify.toast(I18n.t("dc.common.wpDeleted"));
      }); bDel.classList.add("danger");
      a.append(bEdit, bDel); box.appendChild(a);
    } else if (fe && fe.dim_mode === "free" && fe.dc_id === dc.id) {
      title(fe.name || I18n.t("lists.ph.equipment"));
      const a = acts();
      const feLocked = PlacementLock.isLocked(fe);
      const bLock = this.btn(PlacementLock.toggleLabel(feLocked), async () => { await PlacementLock.toggle(this.store, "equipments", fe.id); this.host.setDirty?.(true); this.render(); });
      IconButton.decorate(bLock, feLocked ? Icons.UNLOCK : Icons.LOCK);   // icône = l'ACTION (verrouillé → « déverrouiller » 🔓)
      const bRot = this.btn(I18n.t("dc.common.rotate90"), async () => { await this.store.update("equipments", fe.id, { dc_orientation: Normalize.rackOrientation((fe.dc_orientation || 0) + 90) }); this.host.setDirty?.(true); });
      const bEdit = this.btn(I18n.t("lists.chrome.rowView"), () => this.host.openEquipmentDetail?.(fe.id));
      const bOut = this.btn(I18n.t("dc.common.remove"), async () => {
        const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "equipments", id: fe.id, patch: { dc_id: null, dc_x: null, dc_y: null, dc_z: 0 } }];
        if (fe.dc_id) ops.push(...this.store.cableDowngradeOps([fe.id]));
        await this.store.updateBatch(ops);
        this.selEquipId = null; this.host.setDirty?.(true);
        if (ops.length > 1) Notify.toast(I18n.t("dc.panels.cablesPlannedEquip"));
      }); bOut.classList.add("danger");
      if (feLocked) { [bRot, bOut].forEach((b) => { b.disabled = true; b.title = PlacementLock.BLOCKED_HINT; }); }   // verrouillé : pas de rotation ni de retrait depuis la vue
      a.append(bLock, bRot, bEdit, bOut); box.appendChild(a);
    } else if (r && r.datacenter_id === dc.id) {
      title(r.name || I18n.t("lists.ph.rack"));
      const info = document.createElement("div"); info.className = "form-hint";
      info.textContent = I18n.t("dc.panels.rackInfo", { w: r.width_mm || RACK_WIDTH_DEFAULT, d: r.depth || RACK_DEPTH_DEFAULT, u: r.u_count, deg: Normalize.rackOrientation(r.orientation) });
      box.appendChild(info);
      const a = acts();
      const rLocked = PlacementLock.isLocked(r);
      const bRot = this.btn(I18n.t("dc.common.rotate90"), async () => { await this.store.update("racks", r.id, { orientation: Normalize.rackOrientation(r.orientation + 90) }); this.host.setDirty?.(true); });
      const bContent = this.btn(I18n.t("dc.panels.content"), () => this.host.openRackContentForm?.(r.id)); IconButton.decorate(bContent, Icons.RACK_CONTENT);   // éditeur de montage des U (modale dédiée)
      const bRLock = this.btn(PlacementLock.toggleLabel(rLocked), async () => { await PlacementLock.toggle(this.store, "racks", r.id); this.host.setDirty?.(true); this.render(); }); IconButton.decorate(bRLock, rLocked ? Icons.UNLOCK : Icons.LOCK);
      a.append(
        bContent,
        bRLock,
        bRot,
        this.btn(I18n.t("lists.chrome.rowEdit"), () => this.host.openRackForm?.(r.id)),
      );
      const bOut = this.btn(I18n.t("dc.common.remove"), async () => {
        const eqIds = this.store.equipmentsOfRack(r.id).filter((e: any) => e.placement_mode === "rack" && e.rack_u != null).map((e: any) => e.id);
        const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "racks", id: r.id, patch: { datacenter_id: null, dc_x: null, dc_y: null } }];
        if (r.datacenter_id) ops.push(...this.store.cableDowngradeOps(eqIds));
        await this.store.updateBatch(ops);
        this.selRackId = null; this.host.setDirty?.(true);
        if (ops.length > 1) Notify.toast(I18n.t("dc.panels.cablesPlannedContent"));
      }); bOut.classList.add("danger"); a.appendChild(bOut);
      if (rLocked) { [bRot, bOut].forEach((b) => { b.disabled = true; b.title = PlacementLock.BLOCKED_HINT; }); }   // verrouillé : pas de rotation ni de retrait depuis la vue
      box.appendChild(a);
    } else {
      // Rien de sélectionné → carte de la SALLE courante : édition fiable depuis le panneau (indépendante de la
      // barre d'outils). Conforme au principe « tout éditable hors vue 2D/3D ».
      title(dc.name || I18n.t("lists.ph.room"));
      const info = document.createElement("div"); info.className = "form-hint";
      info.textContent = I18n.t("dc.panels.roomInfo", { w: (dc.width_mm / 1000).toFixed(1), d: (dc.depth_mm / 1000).toFixed(1), cell: dc.cell_mm })
        + (dc.location ? " · " + (this.store.siteLabel(dc.location) || dc.location) : "") + (dc.floor !== "" && dc.floor != null ? I18n.t("dc.panels.floorSuffix", { n: dc.floor }) : "");
      box.appendChild(info);
      const a = acts();
      a.append(
        this.btn(I18n.t("dc.common.editRoomEllipsis"), () => this.host.openDatacenterForm?.(dc.id)),
        this.btn(I18n.t("dc.common.editFloorPlanEllipsis"), () => this.editFloor(dc.location || "", String(dc.floor || ""), false)),
      );
      box.appendChild(a);
      const h = document.createElement("div"); h.className = "form-hint"; h.style.marginTop = "6px";
      h.textContent = I18n.t("dc.panels.selHint");
      box.appendChild(h);
    }
    return box;
  }


  /* ---- carte RACKS DISPONIBLES (pool) — vue Dessus ---- */
  protected poolRacksCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("dc.panels.poolRacksTitle"); box.appendChild(t);
    const pool = this.poolRacks();
    if (!pool.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("dc.panels.poolRacksEmpty"); box.appendChild(h); return box; }
    const list = document.createElement("div"); list.className = "dc-pool";
    pool.forEach((rk: any) => {
      const row = document.createElement("div"); row.className = "dc-pool-row";
      const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = (rk.name || I18n.t("dc.common.rack")) + " · " + (rk.width_mm || RACK_WIDTH_DEFAULT) + "×" + (rk.depth || RACK_DEPTH_DEFAULT) + " · " + rk.u_count + "U";
      const b = this.btn(I18n.t("dc.common.place"), async () => {
        const why = this.store.rackPlacementBlockedReason(rk.id, dc.id);
        if (why) { Notify.toast(I18n.t("dc.panels.placementBlocked", { why }), "err"); return; }
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
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("dc.panels.poolEquipTitle"); box.appendChild(t);
    const fpool = this.store.all("equipments").filter((e: any) => e.dim_mode === "free" && !e.dc_id && e.placement_mode !== "floor" && !e.inventory_only).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    if (!fpool.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("dc.panels.poolEquipEmpty"); box.appendChild(h); return box; }
    const list = document.createElement("div"); list.className = "dc-pool";
    fpool.forEach((eq: any) => {
      const bx = FreeEquipGeometry.box(eq);
      const row = document.createElement("div"); row.className = "dc-pool-row";
      const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = (eq.name || I18n.t("lists.ph.equipment")) + " · " + bx.w + "×" + bx.d + "×" + bx.h + " mm";
      const b = this.btn(I18n.t("dc.common.place"), async () => {
        const why = this.store.equipmentPlacementBlockedReason(eq.id, dc.id);
        if (why) { Notify.toast(I18n.t("dc.panels.placementBlocked", { why }), "err"); return; }
        const pos = this.freeCell(dc); this.selRackId = null; this.selEquipId = eq.id;
        await this.store.update("equipments", eq.id, { dc_id: dc.id, dc_x: pos.x, dc_y: pos.y, dc_z: eq.dc_z || 0 }); this.host.setDirty?.(true);
      });
      row.append(lab, b); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }


  /* ---- carte PORTES (value-objects sur le datacenter) = DoorTool.card (cf. DoorTool.ts) ---- */

  /** Ouvre le form d'étage (création `pick` ou édition) avec navigation vers le plan créé. */
  protected editFloor(location: string, floor: string, pick: boolean): void {
    this.host.openFloorForm?.(location, floor, { pick, onPicked: (L: string, F: string) => { this.floorTarget = { location: L, floor: F }; this.view = "floor"; this.scale = null; this.buildToolbar(); this.render(); } });
  }

  /* ---- carte PLAN D'ÉTAGE (vue Étage) : sélecteur bâtiment/étage + salles de l'étage + OOB ---- */
  protected floorCard(): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("dc.common.floorPlan"); box.appendChild(t);
    const ft = this.floorTargetResolve();
    if (!ft) {
      const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("dc.panels.noFloorKnown"); box.appendChild(h);
      box.appendChild(this.btn(I18n.t("dc.common.createFloor"), () => this.editFloor("", "", true)));
      return box;
    }
    // (Gestion des SITES/bâtiments : onglet « Sites » — plus dans ce panneau. Repère du site courant ci-dessous.)
    const st = document.createElement("div"); st.className = "form-hint"; st.textContent = I18n.t("dc.panels.buildingLabel", { name: this.store.siteLabel(ft.location) }); box.appendChild(st);
    // salles de cet étage (clic = activer ; bouton = éditer)
    const dcs = this.store.dcsOfFloor(ft.location, ft.floor).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const rt = document.createElement("div"); rt.className = "dc-card-title"; rt.style.marginTop = "8px"; rt.textContent = I18n.t("dc.panels.roomsCount", { n: dcs.length }); box.appendChild(rt);
    if (!dcs.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("dc.panels.noRoomOnFloor"); box.appendChild(h); }
    else {
      const list = document.createElement("div"); list.className = "dc-layers";
      dcs.forEach((d: any) => {
        const row = document.createElement("div"); row.className = "dc-layer-row";
        const nm = this.btn((d.name || I18n.t("lists.ph.room")) + (d.id === this.dcId ? I18n.t("dc.common.activeSuffix") : ""), () => { this.selRoomId = d.id; this.dcId = d.id; this.render(); });
        nm.style.cssText = "flex:1 1 auto;text-align:left;justify-content:flex-start"; nm.classList.toggle("active", this.selRoomId === d.id);
        row.append(nm, this.btn(I18n.t("lists.chrome.rowEdit"), () => this.host.openDatacenterForm?.(d.id)));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    // (OOB : listés dans le panneau « Waypoints » ci-dessous — pas de doublon ici)
    // équipements posés sur cet étage (clic = cibler/sélectionner ; bouton = fiche)
    const feqs = this.store.floorEquipments().filter((e: any) => (e.location || "") === ft.location && String(e.floor || "") === ft.floor).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const et = document.createElement("div"); et.className = "dc-card-title"; et.style.marginTop = "8px"; et.textContent = I18n.t("dc.panels.floorEquipCount", { n: feqs.length }); box.appendChild(et);
    if (!feqs.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("dc.panels.noFloorEquip"); box.appendChild(h); }
    else {
      const list = document.createElement("div"); list.className = "dc-layers";
      feqs.forEach((eq: any) => {
        const row = document.createElement("div"); row.className = "dc-layer-row";
        const nm = this.btn((eq.name || I18n.t("lists.ph.equipment")) + (FloorLayout.floorEquipLocalized(eq) ? "" : I18n.t("dc.common.autoSuffix")), () => { this.selFloorEquip = eq.id; this.render(); });
        nm.style.cssText = "flex:1 1 auto;text-align:left;justify-content:flex-start"; nm.classList.toggle("active", this.selFloorEquip === eq.id);
        row.append(nm, this.btn("ⓘ", () => this.host.openEquipmentDetail?.(eq.id)));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    const acts = document.createElement("div"); acts.className = "dc-card-acts"; acts.style.marginTop = "8px";
    acts.append(
      this.btn(I18n.t("dc.panels.editPlanEllipsis"), () => this.editFloor(ft.location, ft.floor, false)),
      this.btn(I18n.t("dc.common.createFloor"), () => this.editFloor(ft.location, ft.floor, true)),
    );
    box.appendChild(acts);
    const acfg = this.floor.config(ft.location, ft.floor);
    const ah = document.createElement("div"); ah.className = "form-hint"; ah.innerHTML = '<span class="gi">' + Icons.ANCHOR + '</span>' + Html.escape(I18n.t("dc.panels.anchorLine", { x: Format.meters(acfg.anchor_x || 0), y: Format.meters(acfg.anchor_y || 0) })); box.appendChild(ah);
    return box;   // recadrage : bouton ⊕ (recentrer) de l'overlay
  }

  /* ---- carte CÂBLES INTER-DC (vue Étage) : affichage des câbles dont les 2 bouts sont sur cet étage ---- */
  protected floorCablesCard(loc: string, fl: string): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("dc.panels.interDcTitle"); box.appendChild(t);
    const routes = this.interDcRoutesFloor(loc, fl, this.floor.config(loc, fl));
    if (!routes.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("dc.panels.noInterDc"); box.appendChild(h); return box; }
    box.appendChild(FormControls.toggle(I18n.t("dc.common.showAll"), this.showAllCables, (v) => { this.showAllCables = v; this.render(); }, { block: true }));
    const list = document.createElement("div"); list.className = "dc-layers";
    routes.slice().sort((a, b) => (a.cable.name || "").localeCompare(b.cable.name || "")).forEach((rc) => {
      const c = rc.cable;
      const row = document.createElement("div"); row.className = "dc-layer-row";
      const tog = FormControls.toggle(c.name || I18n.t("lists.ph.cable"), this.showAllCables || this.selCables.has(c.id), (v) => { if (v) this.selCables.add(c.id); else this.selCables.delete(c.id); this.render(); }, { title: I18n.t("dc.panels.showInterDcCable") });
      tog.style.cssText = "flex:1 1 auto;text-align:left;justify-content:flex-start"; if (this.showAllCables) tog.disabled = true;
      row.append(tog, this.btn(I18n.t("lists.chrome.rowEdit"), () => this.host.openCableForm?.(c.id)));
      list.appendChild(row);
    });
    box.appendChild(list);
    return box;
  }

  /* ---- carte WAYPOINTS (passage de câbles) — GÉNÉRIQUE (plan de salle OU plan d'étage), types séparés en sections.
       `dc` = salle active (création in-situ + scope mono-salle) ; `floor` = scope étage (toutes les salles de l'étage). ---- */

  protected waypointsCard(dc: any, floor?: { location: string; floor: string }): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("dc.panels.waypointsTitle"); box.appendChild(t);
    // ---- création (pins/chemins/exits dans la salle active si présente ; OOB toujours) ----
    const addActs = document.createElement("div"); addActs.className = "dc-card-acts";
    const mkAdd = (label: string, kind: string, wpType?: string) => this.btn(label, async () => {
      const pos = this.freeCell(dc), cellW = dc.cell_mm || 600;
      const props: any = { name: (wpType === "exit" ? "EXIT-" : "WP-") + (this.store.all("waypoints").length + 1), kind, wp_type: wpType || "datacenter", datacenter_id: dc.id, dc_x: pos.x, dc_y: pos.y };
      if (kind === "segment") { props.dc_x = Math.max(0, pos.x - cellW); props.dc_y = pos.y; props.dc_x2 = Math.min(dc.width_mm, pos.x + cellW); props.dc_y2 = pos.y; }
      const wp = await this.store.create("waypoints", props);
      this.selWaypointId = wp.id; this.setDirty();
      Notify.toast(wpType === "exit" ? I18n.t("dc.panels.exitCreated") : (kind === "segment" ? I18n.t("dc.panels.pathCreated") : I18n.t("dc.panels.pinCreated")));
    });
    if (dc) addActs.append(mkAdd(I18n.t("dc.panels.addPin"), "point"), mkAdd(I18n.t("dc.panels.addPath"), "segment"), mkAdd(I18n.t("dc.panels.addExit"), "point", "exit"));
    addActs.appendChild(this.btn(I18n.t("dc.panels.addFloorPin"), async () => {   // ex-OOB : pin hors salle rattaché à un bâtiment/étage
      const loc = floor ? floor.location : (dc ? (dc.location || "") : ""), fl = floor ? floor.floor : (dc ? String(dc.floor || "") : "");
      const wp: any = await this.store.create("waypoints", { name: "PIN-" + (this.store.all("waypoints").length + 1), kind: "point", location: loc, floor: fl });
      this.selWaypointId = wp.id; this.setDirty(); Notify.toast(I18n.t("dc.panels.floorPinCreated"));
    }));
    box.appendChild(addActs);
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = dc ? I18n.t("dc.panels.wpHintRoom") : I18n.t("dc.panels.wpHintFloor");
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
        const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = Waypoint.glyph(wp) + " " + (wp.name || I18n.t("dc.common.waypoint")) + room + " · " + I18n.t("dc.common.cableCount", { count: n });
        row.append(lab, action(wp)); list.appendChild(row);
      });
      box.appendChild(list);
    };
    const edit = (wp: any) => this.btn(I18n.t("dc.common.edit"), () => this.host.openWaypointForm?.(wp.id));
    section(I18n.t("dc.panels.secPins"), placed.filter((w: any) => w.kind === "point" && Waypoint.typeOf(w) !== "exit"), edit);
    section(I18n.t("dc.panels.secPaths"), placed.filter((w: any) => w.kind === "segment" && Waypoint.typeOf(w) !== "exit"), edit);
    section(I18n.t("dc.panels.secBrushes"), placed.filter((w: any) => w.kind === "brush"), edit);
    section(I18n.t("dc.panels.secExits"), placed.filter((w: any) => Waypoint.typeOf(w) === "exit"), edit);
    // ---- pool du bâtiment (à poser dans la salle active) ----
    const wpool = dc ? this.store.waypointsOfDc(null).filter((w: any) => !Waypoint.isFloorLevel(w)) : [];
    section(I18n.t("dc.panels.secPool"), wpool, (wp: any) => this.btn(I18n.t("dc.common.place"), async () => {
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
      const st = document.createElement("div"); st.className = "dc-card-title"; st.style.marginTop = "8px"; st.textContent = I18n.t("dc.panels.secFloorPins", { n: oobs.length }); box.appendChild(st);
      const list = document.createElement("div"); list.className = "dc-pool";
      oobs.forEach((wp: any) => {
        const row = document.createElement("div"); row.className = "dc-pool-row";
        const n = this.store.cablesOfWaypoint(wp.id).length;
        const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = Waypoint.glyph(wp) + " " + (wp.name || I18n.t("dc.common.waypoint")) + " · " + Waypoint.floorLabel(wp) + " · " + I18n.t("dc.common.cableCount", { count: n });
        row.append(lab, edit(wp)); list.appendChild(row);
      });
      box.appendChild(list);
    }
    return box;
  }


  /* ---- carte SALLE (Plan de salle 2D) — change la SALLE ACTIVE, sans les contrôles multi-salle (Multi-DC,
     portée, visibilité) réservés à la 3D. Même liste groupée bâtiment→étage que `dcScopeCard`, en sélection
     radio uniquement. Le handler réplique le corps d'`activateDc` (défini dans DcInteract, plus dérivé donc
     inaccessible ici — comme le fait déjà `dcScopeCard`) avec `render()` view-aware (→ renderTop en 2D). ---- */
  protected roomPickerCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("lists.filter.room"); box.appendChild(t);
    const all = this.store.all("datacenters");
    const curLoc = dc ? (dc.location || "") : "";
    const locs = Array.from(new Set(all.map((d: any) => d.location || "")))
      .sort((a, b) => (a === curLoc ? -1 : b === curLoc ? 1 : this.store.siteLabel(a).localeCompare(this.store.siteLabel(b))));
    locs.forEach((loc) => {
      const inLoc = all.filter((d: any) => (d.location || "") === loc).sort((a: any, b: any) => FloorLayout.floorNum(a.floor) - FloorLayout.floorNum(b.floor) || (a.name || "").localeCompare(b.name || ""));
      if (!inLoc.length) return;
      const h = document.createElement("div"); h.className = "dc-card-title"; h.style.marginTop = "8px"; h.textContent = this.store.siteLabel(loc) + (loc === curLoc ? I18n.t("dc.common.activeParen") : ""); box.appendChild(h);
      const list = document.createElement("div"); list.className = "dc-layers";
      inLoc.forEach((d: any) => {
        const isCur = d.id === dc.id;
        const tog = FormControls.toggle((d.name || I18n.t("lists.ph.room")) + (isCur ? I18n.t("dc.common.activeSuffix") : ""), isCur, () => {
          if (isCur) return;
          this.dcId = d.id; this.selRackId = null; this.camTarget = null; this.scale = null;   // recentre sur la nouvelle salle
          this.buildToolbar(); this.render();
        }, { disabled: isCur });
        tog.classList.add("tgl-row"); list.appendChild(tog);
      });
      box.appendChild(list);
    });
    return box;
  }

  /* ---- carte DATACENTERS (portée d'affichage / Vue étage) — vue 3D ---- */
  protected dcScopeCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("dc.panels.datacentersTitle"); box.appendChild(t);
    const refit = () => { this.camTarget = null; this.scale = null; this.buildToolbar(); this.renderSide(this.current()); this.renderThreeD(this.current()); };
    const all = this.store.all("datacenters");
    const curLoc = dc ? (dc.location || "") : "";
    const bldgIds = (loc: string) => all.filter((d: any) => (d.location || "") === loc).map((d: any) => d.id);
    const selRow = document.createElement("div"); selRow.className = "form-hint"; selRow.style.cssText = "margin-bottom:6px"; selRow.innerHTML = I18n.t("dc.panels.activeRoom") + "<b>" + Html.escape(dc.name || I18n.t("lists.ph.room")) + "</b>"; box.appendChild(selRow);
    // bascule maître : Vue étage (empilement 3D de plusieurs salles)
    if (all.length) {
      const tog = FormControls.toggle(I18n.t("dc.panels.multiDc"), this.multiDc, (v) => {
        this.multiDc = v;
        if (v) { if (!this.visibleDcIds.size) { const b = bldgIds(curLoc); this.visibleDcIds = new Set(b.length ? b : all.map((d: any) => d.id)); } }
        refit();
      }, { block: true, title: I18n.t("dc.panels.multiDcTitle") });
      if (all.length <= 1) { tog.disabled = true; tog.title = I18n.t("dc.panels.oneRoomNoStack"); }   // inutile avec une seule salle
      box.appendChild(tog);
    }
    // préréglages de portée (actifs en Vue étage)
    const displayed = new Set(this.displayedDcIds(dc));
    const sameSet = (arr: string[]) => displayed.size === arr.length && arr.every((id) => displayed.has(id));
    // presets de portée = CHOIX 1 parmi N (aucun actif possible si ensemble custom) → contrôle SEGMENTÉ d'icônes.
    const acts = document.createElement("div"); acts.className = "rm-toggle dc-scope-seg";
    const scopeBtn = (icon: string, titleTxt: string, active: boolean, onClick: () => void) => {
      const b = document.createElement("button"); b.type = "button";   // nu : style via .rm-toggle button (+ svg)
      b.classList.toggle("on", active && this.multiDc);
      b.title = this.multiDc ? titleTxt : (titleTxt + I18n.t("dc.panels.scopeMultiSuffix")); b.disabled = !this.multiDc;
      b.innerHTML = icon; if (this.multiDc) b.onclick = onClick; return b;
    };
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.self, I18n.t("dc.panels.scopeSelf"), sameSet([dc.id]), () => { this.visibleDcIds = new Set([dc.id]); refit(); }));
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.bldg, I18n.t("dc.panels.scopeBldg"), sameSet(bldgIds(curLoc)), () => { this.visibleDcIds = new Set(bldgIds(curLoc)); refit(); }));
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.all, I18n.t("dc.panels.scopeAll"), sameSet(all.map((d: any) => d.id)), () => { this.visibleDcIds = new Set(all.map((d: any) => d.id)); refit(); }));
    box.appendChild(acts);
    // liste groupée par bâtiment puis étage (mono = sélection radio ; Vue étage = multi-sélection)
    const locs = Array.from(new Set(all.map((d: any) => d.location || "")))
      .sort((a, b) => (a === curLoc ? -1 : b === curLoc ? 1 : this.store.siteLabel(a).localeCompare(this.store.siteLabel(b))));
    locs.forEach((loc) => {
      const inLoc = all.filter((d: any) => (d.location || "") === loc).sort((a: any, b: any) => FloorLayout.floorNum(a.floor) - FloorLayout.floorNum(b.floor) || (a.name || "").localeCompare(b.name || ""));
      if (!inLoc.length) return;
      const h = document.createElement("div"); h.className = "dc-card-title"; h.style.marginTop = "8px"; h.textContent = this.store.siteLabel(loc) + (loc === curLoc ? I18n.t("dc.common.activeParen") : ""); box.appendChild(h);
      const list = document.createElement("div"); list.className = "dc-layers";
      inLoc.forEach((d: any) => {
        const isCur = d.id === dc.id;
        let tog: HTMLElement;
        if (this.multiDc) {
          tog = FormControls.toggle((d.name || I18n.t("lists.ph.room")) + (isCur ? I18n.t("dc.common.activeSuffix") : ""), displayed.has(d.id), (v) => { if (v) this.visibleDcIds.add(d.id); else this.visibleDcIds.delete(d.id); refit(); }, { disabled: isCur });
        } else {
          tog = FormControls.toggle((d.name || I18n.t("lists.ph.room")) + (isCur ? I18n.t("dc.common.activeSuffix") : ""), isCur, () => { if (isCur) return; this.dcId = d.id; this.selRackId = null; refit(); }, { disabled: isCur });
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
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("dc.panels.racksTitle"); box.appendChild(t);
    const racks = this.displayedDcIds(dc).flatMap((id) => this.store.racksOfDc(id))
      .sort((a: any, b: any) => (a.datacenter_id !== b.datacenter_id ? this.store.dcName(a.datacenter_id).localeCompare(this.store.dcName(b.datacenter_id)) : 0) || (a.name || "").localeCompare(b.name || ""));
    if (!racks.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("dc.panels.noRackInRoom"); box.appendChild(h); return box; }
    const quick = document.createElement("div"); quick.className = "dc-card-acts";
    quick.append(
      this.btn(I18n.t("dc.common.showAll"), () => { this.hidden3dRacks.clear(); this.render(); }),
      this.btn(I18n.t("dc.common.hideAll"), () => { this.hidden3dRacks = new Set(racks.map((r: any) => r.id)); this.render(); }),
    );
    box.appendChild(quick);
    const list = document.createElement("div"); list.className = "dc-layers";
    racks.forEach((r: any) => {
      const row = document.createElement("div"); row.className = "dc-rack-row";
      const tog = FormControls.toggle(r.name || I18n.t("dc.common.rack"), !this.hidden3dRacks.has(r.id), (v) => { if (v) this.hidden3dRacks.delete(r.id); else this.hidden3dRacks.add(r.id); this.reflow(); });
      tog.classList.add("tgl-row");
      const bIso = this.btn(I18n.t("dc.panels.isolate"), () => this.isolateRack(r.id), I18n.t("dc.panels.isolateTitle"));
      row.append(tog, bIso); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }

  /* ---- carte ÉQUIPEMENTS LIBRES (visibilité par équipement / type / groupe) — vues 3D + Dessus ---- */
  protected freeEquip3dCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("dc.panels.freeEquipTitle"); box.appendChild(t);
    const equips = this.displayedDcIds(dc).flatMap((id) => this.store.freeEquipsOfDc(id))
      .filter((e: any) => e.dc_x != null && e.dc_y != null)
      .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    if (!equips.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("dc.panels.noFreeEquip"); box.appendChild(h); return box; }
    const apply = () => { this.reflow(); this.renderSide(this.current()); };   // rebuild du groupe libre + rafraîchit les états du panneau
    const quick = document.createElement("div"); quick.className = "dc-card-acts";
    quick.append(
      this.btn(I18n.t("dc.common.showAll"), () => { equips.forEach((e: any) => this.hidden3dEquips.delete(e.id)); apply(); }),
      this.btn(I18n.t("dc.common.hideAll"), () => { equips.forEach((e: any) => this.hidden3dEquips.add(e.id)); apply(); }),
    );
    box.appendChild(quick);
    // Masquage GROUPÉ (par type / par groupe) : un bouton par catégorie ; masque/affiche TOUS ses équipements.
    const bulkRow = (label: string, entries: Array<{ label: string; list: any[] }>) => {
      if (entries.length < 2) return;   // 0/1 catégorie → rien à filtrer
      const wrap = document.createElement("div"); wrap.style.cssText = "margin:6px 0";
      const lab = document.createElement("div"); lab.className = "form-hint"; lab.style.cssText = "margin:0 0 3px"; lab.textContent = label; wrap.appendChild(lab);
      const chips = document.createElement("div"); chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";
      entries.forEach((en) => {
        const shown = en.list.some((e: any) => !this.hidden3dEquips.has(e.id));
        const b = this.btn(en.label + " (" + en.list.length + ")", () => {
          const hide = en.list.some((e: any) => !this.hidden3dEquips.has(e.id));   // au moins un visible → on masque tout ; sinon on affiche tout
          en.list.forEach((e: any) => { if (hide) this.hidden3dEquips.add(e.id); else this.hidden3dEquips.delete(e.id); });
          apply();
        }, I18n.t("dc.panels.bulkCategoryTitle"));
        if (shown) b.classList.add("active");
        chips.appendChild(b);
      });
      wrap.appendChild(chips); box.appendChild(wrap);
    };
    const byType = new Map<string, any[]>(); equips.forEach((e: any) => { const k = e.type || "?"; (byType.get(k) || byType.set(k, []).get(k))!.push(e); });
    bulkRow(I18n.t("dc.panels.byType"), [...byType.entries()].map(([k, list]) => ({ label: EquipmentTypes.label(k), list })));
    // Par groupe : appartenance MULTIPLE (primaire + secondaires) — un équipement apparaît dans chaque bucket dont il est membre.
    const byGroup = new Map<string, any[]>(); equips.forEach((e: any) => { this.store.equipmentGroupIds(e).forEach((k: string) => { if (!k) return; (byGroup.get(k) || byGroup.set(k, []).get(k))!.push(e); }); });
    bulkRow(I18n.t("dc.panels.byGroup"), [...byGroup.entries()].map(([k, list]) => ({ label: (this.store.get("groups", k) as any)?.label || I18n.t("lists.ph.group"), list })));
    // liste par équipement (comme le panneau des baies)
    const list = document.createElement("div"); list.className = "dc-layers";
    equips.forEach((e: any) => {
      const row = document.createElement("div"); row.className = "dc-rack-row";
      const tog = FormControls.toggle(e.name || I18n.t("lists.ph.equipment"), !this.hidden3dEquips.has(e.id), (v: boolean) => { if (v) this.hidden3dEquips.delete(e.id); else this.hidden3dEquips.add(e.id); this.reflow(); });
      tog.classList.add("tgl-row"); row.append(tog); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }


  /* ---- carte CÂBLES (sélection par réseau / inter-DC / liste filtrée) — 3D & Dessus ---- */
  protected cableCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const multi = this.displayedDcIds(dc).length > 1;
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = I18n.t("lists.col.cables") + (multi ? I18n.t("dc.panels.cablesAllRooms") : ""); box.appendChild(t);
    const resolved = this.panelCables(dc);
    const total = this.store.all("cables").length;
    // créer une route 3D au clic (le prochain clic sur un port libre démarre ; puis waypoints ; puis port terminal)
    const bRoute = this.btn(this.routeTool.active ? I18n.t("dc.panels.cancelRoute") : I18n.t("dc.panels.createRoute"), () => { if (this.routeTool.active) this.routeTool.cancel(); else this.routeTool.arm(); }, I18n.t("dc.panels.createRouteTitle"));
    IconButton.decorate(bRoute, this.routeTool.active ? Icons.CLOSE : Icons.ROUTE);
    bRoute.style.marginBottom = "6px"; box.appendChild(bRoute);
    box.appendChild(FormControls.toggle(I18n.t("dc.panels.showAllDimmed"), this.showAllCables, (v) => { this.showAllCables = v; this.rerenderView(); }, { block: true }));
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = I18n.t("dc.panels.cableHintMain", { n: resolved.length, scope: multi ? I18n.t("dc.panels.cableScopeMulti") : I18n.t("dc.panels.cableScopeHere"), off: (total > resolved.length ? I18n.t("dc.panels.cableOff", { n: total - resolved.length }) : "") });
    box.appendChild(hint);
    const addSel = (ids: string[]) => { ids.forEach((id) => this.selCables.add(id)); this.rerenderView(); };
    const delSel = (ids: string[]) => { ids.forEach((id) => this.selCables.delete(id)); this.rerenderView(); };
    const eyePair = (parent: HTMLElement, ids: () => string[], what: string) => {
      parent.append(
        this.btn("◉", () => addSel(ids()), I18n.t("dc.panels.eyeShowTitle", { what })),
        this.btn("◎", () => delSel(ids()), I18n.t("dc.panels.eyeHideTitle", { what })),
      );
    };
    // FAISCEAUX (trunks) dont une extrémité (patch) touche les salles affichées — mêmes ◉/◎ que les réseaux
    // (la sélection partage `selCables` : ids uniques toutes collections). Avant le retour anticipé : une salle
    // peut n'avoir AUCUN câble raccordable mais des trunks à piloter.
    const shownDcIds = new Set(this.displayedDcIds(dc));
    const trunkIds = () => this.store.all("cableBundles").filter((b: any) => {
      const da = b.endpoint_a_equipment_id ? this.store.equipmentDcId(b.endpoint_a_equipment_id) : null;
      const db = b.endpoint_b_equipment_id ? this.store.equipmentDcId(b.endpoint_b_equipment_id) : null;
      return (da != null && shownDcIds.has(da)) || (db != null && shownDcIds.has(db));
    }).map((b: any) => b.id);
    if (trunkIds().length) {
      const row = document.createElement("div"); row.className = "dc-layer-row";
      const ttx = document.createElement("span"); ttx.className = "grow"; ttx.textContent = I18n.t("dc.panels.trunksLabel", { n: trunkIds().length });
      row.append(ttx); eyePair(row, trunkIds, I18n.t("dc.panels.whatTrunks")); box.appendChild(row);
    }
    if (!resolved.length) return box;
    // liens inter-DC
    const interIds = () => resolved.filter((o) => this.isInterDc(o.cable)).map((o) => o.cable.id);
    if (interIds().length) {
      const row = document.createElement("div"); row.className = "dc-layer-row";
      const itx = document.createElement("span"); itx.className = "grow"; itx.textContent = I18n.t("dc.panels.interLinksLabel", { n: interIds().length });
      row.append(itx); eyePair(row, interIds, I18n.t("dc.panels.whatInterLinks")); box.appendChild(row);
    }
    // réseaux
    const netsMap = new Map<string, { label: string; color: string | null; count: number }>();
    resolved.forEach((rc) => { const ids = this.store.cableNetworkIds(rc.cable); (ids.length ? ids : ["__none__"]).forEach((key: string) => { if (!netsMap.has(key)) { const n: any = key !== "__none__" ? this.store.get("networks", key) : null; netsMap.set(key, { label: n ? (n.label || I18n.t("lists.ph.network")) : I18n.t("lists.opt.faceOther"), color: n ? n.color : null, count: 0 }); } netsMap.get(key)!.count++; }); });
    if (netsMap.size) {
      const nt = document.createElement("div"); nt.className = "form-hint"; nt.style.marginTop = "6px"; nt.textContent = I18n.t("dc.panels.networksLabel"); box.appendChild(nt);
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
    const eqSel = FormControls.select([{ value: "", label: I18n.t("dc.panels.allEquipments") }].concat(eqOpts.map((e: any) => ({ value: e.id, label: (e.name || I18n.t("lists.ph.noName")) + (multi ? " · " + this.store.dcName(this.store.equipmentDcId(e)) : "") }))), this._cableEqFilter);
    eqSel.style.cssText = "width:100%;margin-top:8px;font-size:11px"; eqSel.onchange = () => { this._cableEqFilter = eqSel.value; this.render(); };
    box.appendChild(eqSel);
    const search = document.createElement("input"); search.type = "text"; search.className = "search-input"; search.placeholder = I18n.t("dc.panels.filterList"); search.style.cssText = "width:100%;margin:6px 0"; search.value = this._cableSearch;
    search.oninput = () => { this._cableSearch = search.value; this.renderCableList(listWrap, resolved); };
    box.appendChild(search);
    const listActs = document.createElement("div"); listActs.className = "dc-card-acts";
    listActs.append(
      this.btn(I18n.t("dc.panels.selectList"), () => addSel(this.cableListFiltered(resolved).map((o) => o.rc.cable.id))),
      this.btn(I18n.t("dc.panels.removeList"), () => delSel(this.cableListFiltered(resolved).map((o) => o.rc.cable.id))),
    );
    box.appendChild(listActs);
    if (this.selCables.size) box.appendChild(this.btn(I18n.t("dc.panels.clearSelection", { n: this.selCables.size }), () => { this.selCables.clear(); this.rerenderView(); }));
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
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = (v === "3d") ? I18n.t("dc.panels.view3dTitle") : I18n.t("dc.panels.displayTitle");
    if (v === "3d") {   // icône d'aide (navigation 3D) — uniquement en 3D
      const help = document.createElement("span"); help.className = "settings-help-icon dc-help"; help.textContent = "?";
      help.setAttribute("role", "img"); help.tabIndex = 0; help.setAttribute("aria-label", I18n.t("dc.panels.helpNav3d"));
      help.title = I18n.t("dc.panels.nav3dHelp");
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
      realSize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l9 9.5-9 9.5-9-9.5z"/><text x="12" y="14.6" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" stroke="none">1:1</text></svg>',
      conduit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="8" rx="1"/><path d="M3 12h18" stroke-dasharray="2.5 2.5"/></svg>',
      pivot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>',
      orient: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 5.5l2.4 8.5L12 12l-2.4 2z" fill="currentColor" stroke="none"/></svg>',
      anchor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><line x1="12" y1="7.5" x2="12" y2="21"/><path d="M5 13a7 7 0 0 0 14 0"/><line x1="5" y1="13" x2="8.5" y2="13"/><line x1="15.5" y1="13" x2="19" y2="13"/></svg>',
      perp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v14h14"/><path d="M10.5 18a4.5 4.5 0 0 1 4.5-4.5"/></svg>',
      mouse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l6 15 2.2-6.2L19.5 9.5z"/></svg>',
      onTop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="12" width="14" height="8" rx="1"/><path d="M3 9c3.5 0 4.5-4 9-4s5.5 4 9 4"/></svg>',
      person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6" r="3"/><path d="M6 21v-1.5a6 6 0 0 1 12 0V21"/></svg>',
    };
    const D3 = ["3d"], ALL = ["3d", "top", "floor"];   // vues d'applicabilité d'un toggle
    const tgi = (views: string[], icon: string, title: string, get: () => boolean, apply: (v: boolean) => void) => {
      if (!views.includes(v)) return;   // toggle non pertinent pour la vue courante → masqué
      if (pending) { const lab = document.createElement("div"); lab.style.cssText = "font-size:10.5px;color:var(--fg-dim);text-transform:uppercase;letter-spacing:.05em;margin:9px 0 3px"; lab.textContent = pending; box.appendChild(lab); cur = document.createElement("div"); cur.className = "dc-3d-toggle-grid"; box.appendChild(cur); pending = null; }
      const b = FormControls.toggle("", get(), (val) => apply(val), { title });
      b.innerHTML = icon; b.title = title; b.setAttribute("aria-label", title); cur.appendChild(b); return b;
    };
    section(I18n.t("lists.col.equipments"));
    tgi(D3, I.hideFront, I18n.t("dc.panels.tHideFront"), () => this.hideFrontEq, (v) => { this.hideFrontEq = v; r3(); });
    tgi(D3, I.hideRear, I18n.t("dc.panels.tHideRear"), () => this.hideRearEq, (v) => { this.hideRearEq = v; r3(); });
    tgi(D3, I.ports, I18n.t("dc.panels.tPorts"), () => this.showPorts, (v) => { this.showPorts = v; r3(); });
    tgi(D3, I.names, I18n.t("dc.panels.tNames"), () => this.showEqNames, (v) => { this.showEqNames = v; r3(); });
    tgi(D3, I.image, I18n.t("dc.panels.tImages"), () => this.showFaceImages, (v) => { this.showFaceImages = v; r3(); });
    section(I18n.t("lists.col.racks"));
    tgi(D3, I.sides, I18n.t("dc.panels.tSides"), () => this.showRackSides, (v) => { this.showRackSides = v; r3(); });
    tgi(D3, I.door, I18n.t("dc.panels.tDoors"), () => this.showDoors, (v) => { this.showDoors = v; r3(); });
    tgi(["3d", "top"], I.doorSwing, I18n.t("dc.panels.tDoorSwing"), () => this.showDoorSwing, (v) => { this.showDoorSwing = v; r3(); });
    tgi(D3, I.slot, I18n.t("dc.panels.tSlots"), () => this.showPlaceholders, (v) => { this.showPlaceholders = v; r3(); });
    section(I18n.t("lists.col.cables"));
    tgi(D3, I.onTop, I18n.t("dc.panels.tOnTop"), () => this.cablesOnTop, (v) => { this.cablesOnTop = v; if (this.useWebGL && this._three) { this._three.setCablesOnTop(v); this.persistView(); } else r3(); });
    tgi(ALL, I.perp, I18n.t("dc.panels.tPerp"), () => this.cablePortNormal, (v) => { this.cablePortNormal = v; redraw(); });
    section(I18n.t("dc.panels.secWaypoints"));
    tgi(ALL, I.marker, I18n.t("dc.panels.tMarkers"), () => this.showWaypoints, (v) => { this.showWaypoints = v; redraw(); });
    tgi(D3, I.conduit, I18n.t("dc.panels.tConduits"), () => this.showConduits, (v) => { this.showConduits = v; r3(); });
    // taille RÉELLE ⟷ STATIQUE : bascule en place au moteur (rescale des sprites, aucun rebuild) — comme le slider.
    tgi(D3, I.realSize, I18n.t("dc.panels.tRealSize"), () => this.markerRealSize, (v) => { this.markerRealSize = v; if (this.useWebGL && this._three) { this._three.setMarkerRealSize(v); this.persistView(); } else redraw(); });
    section(I18n.t("dc.panels.secFloorMarkers"));
    tgi(D3, I.grid, I18n.t("dc.panels.tFloorGrid"), () => this.showFloorGrid, (v) => { this.showFloorGrid = v; r3(); });
    tgi(ALL, I.orient, I18n.t("dc.panels.tOrient"), () => this.showOrientMarks, (v) => { this.showOrientMarks = v; redraw(); });
    tgi(["floor"], I.anchor, I18n.t("dc.panels.tAnchor"), () => this.showFloorAnchor, (v) => { this.showFloorAnchor = v; redraw(); });
    tgi(ALL, I.person, I18n.t("dc.panels.tFigure"), () => this.showFigure, (v) => { this.showFigure = v; if (v) this.figureEnsure(this.current()); this.persistView(); redraw(); });
    tgi(D3, I.pivot, I18n.t("dc.panels.tPivot"), () => this.showPivot, (v) => { this.showPivot = v; r3(); });
    // Sliders AFFECTANT AUSSI le rendu 2D (arrondi des câbles, taille des marqueurs/pastilles de ports) →
    // exposés dans TOUTES les vues. En WebGL : mise à jour en direct (setCableSpline/setMarkerScale) ; sinon
    // `redraw()` re-dessine le SVG 2D avec la nouvelle valeur.
    box.appendChild(this.slider(I18n.t("dc.panels.sCableSpline"), this.cableSplineK, 0, 0.32, 0.01, (val) => val.toFixed(2), (val) => { this.cableSplineK = val; if (this.useWebGL && this._three) { this._three.setCableSpline(val); this.persistView(); } else redraw(); }));
    box.appendChild(this.slider(I18n.t("dc.panels.sMarkerSize"), this.markerScale, 0.25, 1.75, 0.05, (val) => Math.round(val * 100) + " %", (val) => { this.markerScale = val; if (this.useWebGL && this._three) { this._three.setMarkerScale(val); this.persistView(); } else redraw(); }));
    // Réglages PROPRES à la 3D (coloration du volume, recentrage caméra) — sans objet en 2D.
    if (v === "3d") {
      const colorRow = document.createElement("div"); colorRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px";
      const colTxt = document.createElement("span"); colTxt.className = "grow"; colTxt.textContent = I18n.t("dc.panels.coloration");
      const colSel = FormControls.select([{ value: "face", label: I18n.t("dc.panels.byFace") }, { value: "group", label: I18n.t("dc.panels.byGroup") }, { value: "type", label: I18n.t("dc.panels.byType") }], this.colorMode);
      colSel.onchange = () => { this.colorMode = colSel.value as any; r3(); };
      colorRow.append(colTxt, colSel); box.appendChild(colorRow);
      box.appendChild(this.btn(I18n.t("dc.panels.recenterRoom"), () => { this.camTarget = null; this.hidden3dRacks.clear(); this.scale = null; if (this.useWebGL && this._three) this._three.recenter(); else this.render(); }));
    }
    return box;
  }

}

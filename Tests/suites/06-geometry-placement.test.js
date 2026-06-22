/* Géométrie de placement : helpers purs (marge/colonnes/extents), familles SIDE & WALL
   (cibles d'une éventuelle fusion → on verrouille leur comportement), et resolvePort3D
   (point monde d'un port — rack / side / wall / libre). Sanity + invariants clés, pas de
   coordonnées exactes fragiles. Les fonctions dépendant du `store` global → makeStore(). */
module.exports = {
  name: "Géométrie de placement — side/wall + resolvePort3D",
  run: async (NM, ck) => {
    const U = NM.U_MM, MW = NM.RACK_MOUNT_WIDTH;

    // ---- helpers PURS (objets simples ; valeurs exactes) ----
    ck.eq(NM.rackSideMarginMm({ width_mm: 800 }), (800 - MW) / 2, "rackSideMarginMm(800)");
    ck.eq(NM.rackSideColumns({ width_mm: 800 }), 2, "rackSideColumns(800) = 2 (marge > 2U)");
    ck.eq(NM.rackSideColumns({ width_mm: 600 }), 1, "rackSideColumns(600) = 1");
    ck(NM.rackSideEnabled({ width_mm: 800, allow_side_front: true }, "front") === true, "rackSideEnabled front (marge≥1U + flag)");
    ck(NM.rackSideEnabled({ width_mm: 800, allow_side_front: true }, "rear") === false, "rackSideEnabled rear faux sans flag");
    ck(NM.rackSideEnabled({ width_mm: 500, allow_side_front: true }, "front") === false, "rackSideEnabled faux si marge < 1U");
    const r0 = NM.rackHalfExtents({ width_mm: 600, depth: 1000, orientation: 0 });
    const r90 = NM.rackHalfExtents({ width_mm: 600, depth: 1000, orientation: 90 });
    ck(r0.hx === 300 && r0.hy === 500, "rackHalfExtents 0° = {300,500}");
    ck(r90.hx === 500 && r90.hy === 300, "rackHalfExtents 90° permute hx/hy");

    // ---- SIDE-MOUNT ----
    {
      const s = await NM.makeStore();
      const dc = await s.create("datacenters", { name: "DC" });
      const rack = await s.create("racks", { name: "R", width_mm: 800, depth: 1000, u_count: 42, allow_side_front: true, datacenter_id: dc.id, dc_x: 1000, dc_y: 1000 });
      const eq = await s.create("equipments", { name: "PDU", placement_mode: "side", dim_mode: "free", rack_id: rack.id, side_face: "front", side_lr: "left", side_col: 0, side_u: 5, free_w_mm: 60, free_h_mm: 150, free_l_mm: 300 });
      ck.eq(NM.rackSideOccupants(rack.id, "front", "left").length, 1, "rackSideOccupants(front,left) trouve le PDU");
      ck.eq(NM.rackSideOccupants(rack.id, "rear", null).length, 0, "rackSideOccupants(rear) vide");
      const box = NM.sideEquipBoxLocal(rack, eq), h = box.heightU;
      ck(NM.sideSlotFree(rack.id, "front", "left", 0, 5, h, null) === false, "sideSlotFree : bande occupée = false");
      ck(NM.sideSlotFree(rack.id, "front", "left", 0, 35, 2, null) === true, "sideSlotFree : bande libre = true");
      ck(NM.sideSlotFree(rack.id, "front", "left", 0, 5, h, eq.id) === true, "sideSlotFree : exceptId ignore l'occupant");
      const free = NM.sideFreeSlots(rack);
      ck(free.length > 0 && free.every(sl => !(sl.face === "front" && sl.lr === "left" && sl.col === 0 && sl.uTop === 5)), "sideFreeSlots exclut la bande occupée");
      ck(box.x0 < 0 && box.x1 <= 0, "sideEquipBoxLocal : côté GAUCHE → x ≤ 0");
      ck(box.front === true && box.z1 > box.z0, "sideEquipBoxLocal : front + hauteur cohérente");
      const slotBox = NM.sideSlotBoxLocal(rack, "front", "left", 0, 5, 2);
      ck(slotBox.x0 < 0 && slotBox.front === true, "sideSlotBoxLocal : gauche/front cohérent");
      const p = await s.create("ports", { equipment_id: eq.id, name: "p", face_x: 0.5, face_y: 0.5 });
      const r3 = NM.resolvePort3D(p.id, dc.id);
      ck(r3 && isFinite(r3.x) && isFinite(r3.y) && isFinite(r3.z), "resolvePort3D(side) → point fini");
      ck(r3 && r3.n && (Math.abs(r3.n.x) + Math.abs(r3.n.y)) > 0, "resolvePort3D(side) → normale non nulle");
    }

    // ---- WALL-MOUNT ----
    {
      const s = await NM.makeStore();
      const dc = await s.create("datacenters", { name: "DC" });
      const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1200, u_count: 42, front_margin_mm: 200, cage_depth_mm: 700, datacenter_id: dc.id, dc_x: 2000, dc_y: 2000 });
      ck(NM.rackWallEnabled(rack, "front") === true, "rackWallEnabled(rack, front) avec marge avant ≥ 1U");
      const eq = await s.create("equipments", { name: "WALL", placement_mode: "wall", dim_mode: "free", rack_id: rack.id, wall_lr: "left", wall_margin: "front", wall_col: 0, wall_u: 5, wall_orient: "center", free_w_mm: 80, free_h_mm: 150, free_l_mm: 100 });
      ck.eq(NM.rackWallOccupants(rack.id, "front", "left").length, 1, "rackWallOccupants(front,left) trouve l'équipement");
      ck(NM.wallSlotFree(rack.id, "left", "front", 0, 5, 2, null) === false, "wallSlotFree : bande occupée = false");
      ck(NM.wallSlotFree(rack.id, "left", "front", 0, 35, 2, null) === true, "wallSlotFree : bande libre = true");
      ck(NM.wallFreeSlots(rack).length > 0, "wallFreeSlots non vide");
      const wbox = NM.wallEquipBoxLocal(rack, eq);
      ck(wbox.n && (wbox.n.x !== 0 || wbox.n.y !== 0), "wallEquipBoxLocal : normale définie");
      ck(wbox.z1 > wbox.z0, "wallEquipBoxLocal : hauteur cohérente");
      const p = await s.create("ports", { equipment_id: eq.id, name: "p", face_x: 0.5, face_y: 0.5 });
      const r3 = NM.resolvePort3D(p.id, dc.id);
      ck(r3 && isFinite(r3.x) && isFinite(r3.z), "resolvePort3D(wall) → point fini");
    }

    // ---- resolvePort3D : racké + libre + garde dc ----
    {
      const s = await NM.makeStore();
      const dc = await s.create("datacenters", { name: "DC" });
      const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
      const eq = await s.create("equipments", { name: "SW", placement_mode: "rack", rack_id: rack.id, rack_u: 10 });
      const p = await s.create("ports", { equipment_id: eq.id, name: "p", face_x: 0.3, face_y: 0.4, face_side: "front" });
      const r3 = NM.resolvePort3D(p.id, dc.id);
      ck(r3 && isFinite(r3.x) && isFinite(r3.y) && isFinite(r3.z), "resolvePort3D(rack) → point fini");
      ck(NM.resolvePort3D(p.id, "autre-dc") === null, "resolvePort3D : dc ≠ rack.datacenter_id → null");
      const fe = await s.create("equipments", { name: "free", dim_mode: "free", dc_id: dc.id, dc_x: 800, dc_y: 800, free_w_mm: 200, free_h_mm: 100, free_l_mm: 200 });
      const fp = await s.create("ports", { equipment_id: fe.id, name: "fp", face_x: 0.5, face_y: 0.5 });
      const fr = NM.resolvePort3D(fp.id, dc.id);
      ck(fr && isFinite(fr.x) && isFinite(fr.z), "resolvePort3D(libre) → point fini");
    }
  }
};

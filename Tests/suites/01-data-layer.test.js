/* Couche de données : Store (CRUD), FieldIndex (helpers FK), cascade de suppression,
   transactions undo/redo, clone. Teste l'INSTANCE Store (méthodes), donc indépendant
   du `store` global. CARACTÉRISE le comportement courant. */
module.exports = {
  name: "Couche de données — Store · FieldIndex · cascade · undo/redo",
  run: async (NM, ck) => {
    if (!NM.Store || !NM.BrowserStorageAdapter) { ck(false, "Store / BrowserStorageAdapter exposés"); return; }
    const store = await NM.makeStore();

    // --- document neuf ---
    ck(Array.isArray(store.all("equipments")) && store.all("equipments").length === 0, "document neuf : 0 équipement");
    ck(store.all("portTypes").length > 0, "newDocument sème le catalogue de types de port (liste fermée)");
    ck(store.all("cableTypes").length > 0, "newDocument sème le catalogue de types de câble");

    // --- create / get / horodatage ---
    const eq = await store.create("equipments", { name: "SW1", type: "switch" });
    ck(!!eq && !!eq.id, "create equipment → id attribué");
    ck(store.get("equipments", eq.id) && store.get("equipments", eq.id).name === "SW1", "get(equipments, id) après create");
    ck(!!eq.created_date && !!eq.updated_date, "create pose created_date + updated_date");

    // --- FieldIndex : portsOf (FK equipment_id) ---
    const p1 = await store.create("ports", { equipment_id: eq.id, name: "p1" });
    await store.create("ports", { equipment_id: eq.id, name: "p2" });
    ck.eq(store.portsOf(eq.id).length, 2, "portsOf(eq) = 2 via index FK");

    // --- FieldIndex : equipmentsOfRack ---
    const rack = await store.create("racks", { name: "R1" });
    const e2 = await store.create("equipments", { name: "SW2", rack_id: rack.id });
    ck.eq(store.equipmentsOfRack(rack.id).length, 1, "equipmentsOfRack(rack) = 1");

    // --- cable : cablesOfPort (union from/to) ---
    const net = await store.create("networks", { name: "N1" });
    const eqB = await store.create("equipments", { name: "SRV" });
    const pb = await store.create("ports", { equipment_id: eqB.id, name: "pb" });
    const cable = await store.create("cables", { from_port_id: p1.id, to_port_id: pb.id, network_ids: [net.id] });
    ck.eq(store.cablesOfPort(p1.id).length, 1, "cablesOfPort(p1) = 1");
    ck.eq(store.cablesOfPort(pb.id).length, 1, "cablesOfPort(pb) = 1 (union from/to)");

    // --- cascade : supprimer l'équipement retire ses ports (1 transaction) ---
    await store.remove("equipments", eq.id);
    ck(!store.get("equipments", eq.id), "remove equipment → get null");
    ck.eq(store.portsOf(eq.id).length, 0, "remove equipment → cascade supprime ses ports");
    const c = store.get("cables", cable.id);
    ck(!c || c.from_port_id !== p1.id, "cascade : câble du port supprimé retiré/détaché (pas de FK fantôme)");

    // --- undo / redo : la cascade se défait/refait en UN geste ---
    if (store.canUndo()) {
      await store.undo();
      ck(!!store.get("equipments", eq.id), "undo → l'équipement revient");
      ck.eq(store.portsOf(eq.id).length, 2, "undo → ses ports reviennent (cascade = 1 undo)");
      await store.redo();
      ck(!store.get("equipments", eq.id), "redo → ré-supprimé");
    } else { ck(false, "canUndo() vrai après un remove"); }

    // --- update ---
    await store.update("equipments", e2.id, { name: "SW2-bis" });
    ck.eq(store.get("equipments", e2.id).name, "SW2-bis", "update applique le patch");

    // --- cloneEquipment : placement réinitialisé (clone non placé) ---
    const clone = await store.cloneEquipment(e2.id);
    ck(!!clone && clone.id !== e2.id, "cloneEquipment → nouvel id distinct");
    ck(clone.rack_id == null, "clone : rack_id réinitialisé → non placé");
  }
};

/* Store — helpers d'index FK (*Of) + updateBatch.
   Couvre les fonctions qui seront consolidées en v160 (table CASCADE-like + _applyPatch),
   pour garantir un refactor sans changement de comportement. */
module.exports = {
  name: "Store — helpers d'index (*Of) & updateBatch",
  run: async (NM, ck) => {
    const s = await NM.makeStore();

    // --- updateBatch : plusieurs patchs en UN geste ---
    const a = await s.create("equipments", { name: "A" });
    const b = await s.create("equipments", { name: "B" });
    const n = await s.updateBatch([
      { collection: "equipments", id: a.id, patch: { name: "A2" } },
      { collection: "equipments", id: b.id, patch: { name: "B2" } }
    ]);
    ck.eq(n, 2, "updateBatch retourne le nombre d'updates");
    ck.eq(s.get("equipments", a.id).name, "A2", "updateBatch applique le patch A");
    ck.eq(s.get("equipments", b.id).name, "B2", "updateBatch applique le patch B");
    const cd = s.get("equipments", a.id).created_date;
    await s.updateBatch([{ collection: "equipments", id: a.id, patch: { id: "HACK", created_date: "1999", name: "A3" } }]);
    ck.eq(s.get("equipments", a.id).id, a.id, "updateBatch n'écrase pas id");
    ck.eq(s.get("equipments", a.id).created_date, cd, "updateBatch n'écrase pas created_date");

    // --- helpers *Of simples (un par famille) ---
    const eq = await s.create("equipments", { name: "EQ" });
    const ag = await s.create("aggregates", { equipment_id: eq.id });
    const p = await s.create("ports", { equipment_id: eq.id, aggregate_id: ag.id });
    ck.eq(s.portsOf(eq.id).length, 1, "portsOf");
    ck.eq(s.aggregatesOf(eq.id).length, 1, "aggregatesOf");
    ck.eq(s.portsOfAggregate(ag.id).length, 1, "portsOfAggregate");

    const pt = await s.create("portTypes", { name: "PT", family: "X" });
    await s.update("ports", p.id, { port_type_id: pt.id });
    ck.eq(s.portsOfType(pt.id).length, 1, "portsOfType");

    const ct = await s.create("cableTypes", { name: "CT", family: "X" });
    await s.create("cables", { cable_type_id: ct.id });
    ck.eq(s.cablesOfType(ct.id).length, 1, "cablesOfType");

    const g = await s.create("groups", { name: "G" });
    await s.update("equipments", eq.id, { group_id: g.id });
    ck.eq(s.equipmentsOfGroup(g.id).length, 1, "equipmentsOfGroup");

    const rack = await s.create("racks", { name: "R" });
    const eqR = await s.create("equipments", { name: "ER", rack_id: rack.id });
    await s.create("rackItems", { rack_id: rack.id, kind: "blank" });
    ck.eq(s.equipmentsOfRack(rack.id).length, 1, "equipmentsOfRack");
    ck.eq(s.rackItemsOf(rack.id).length, 1, "rackItemsOf");

    const ipn = await s.create("ipNetworks", { name: "IPN", cidr: "10.0.0.0/24" });
    await s.create("ipAddresses", { network_id: ipn.id, equipment_id: eq.id, address: "10.0.0.5" });
    await s.create("dhcpRanges", { network_id: ipn.id, server_id: eq.id, start_ip: "10.0.0.10", end_ip: "10.0.0.20" });
    await s.create("networks", { name: "N", ip_network_id: ipn.id });
    ck.eq(s.ipAddressesOfNetwork(ipn.id).length, 1, "ipAddressesOfNetwork");
    ck.eq(s.ipAddressesOfEquipment(eq.id).length, 1, "ipAddressesOfEquipment");
    ck.eq(s.dhcpRangesOfNetwork(ipn.id).length, 1, "dhcpRangesOfNetwork");
    ck.eq(s.dhcpRangesOfServer(eq.id).length, 1, "dhcpRangesOfServer");
    ck.eq(s.networksOfIpNetwork(ipn.id).length, 1, "networksOfIpNetwork");

    const wp = await s.create("waypoints", { name: "wp", kind: "point", wp_type: "datacenter" });
    await s.create("cables", { waypoint_ids: [wp.id] });
    ck.eq(s.cablesOfWaypoint(wp.id).length, 1, "cablesOfWaypoint");

    // --- helpers avec fallback ||null ---
    const dc = await s.create("datacenters", { name: "DC" });
    await s.create("racks", { name: "Rdc", datacenter_id: dc.id });
    await s.create("waypoints", { name: "wpdc", kind: "point", wp_type: "datacenter", datacenter_id: dc.id });
    ck.eq(s.racksOfDc(dc.id).length, 1, "racksOfDc(dc)");
    ck(s.racksOfDc(null).some(r => r.id === rack.id), "racksOfDc(null) → racks non placés (fallback ||null)");
    ck.eq(s.waypointsOfDc(dc.id).length, 1, "waypointsOfDc(dc)");
    const fl = await s.create("floors", { location: "BatA", floor: 1 });
    ck(s.floorsOf("BatA").some(f => f.id === fl.id), "floorsOf(location)");

    // --- freeEquipsOfDc : filtre dim_mode=free ---
    const freeEq = await s.create("equipments", { name: "free", dim_mode: "free", dc_id: dc.id });
    await s.create("equipments", { name: "notfree", dim_mode: "u", dc_id: dc.id });
    const free = s.freeEquipsOfDc(dc.id);
    ck(free.some(e => e.id === freeEq.id) && free.every(e => e.dim_mode === "free"), "freeEquipsOfDc filtre dim_mode=free");
  }
};

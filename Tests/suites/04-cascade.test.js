/* Cascade de suppression — CARACTÉRISATION exhaustive (12 collections).
   Verrouille le comportement de `_cascadePlan` AVANT son refactor déclaratif (v159).
   Chaque bloc part d'un store neuf (isolation). */
module.exports = {
  name: "Cascade de suppression — intégrité référentielle (12 collections)",
  run: async (NM, ck) => {
    const fresh = () => NM.makeStore();
    const has = (s, c, id) => !!s.get(c, id);

    // 1) equipments → supprime ports + agrégats + câbles de ses ports ; détache IP/DHCP
    {
      const s = await fresh();
      const eq = await s.create("equipments", { name: "EQ" });
      const p1 = await s.create("ports", { equipment_id: eq.id, name: "p1" });
      const ag = await s.create("aggregates", { equipment_id: eq.id, name: "ag" });
      const eqB = await s.create("equipments", { name: "B" });
      const pb = await s.create("ports", { equipment_id: eqB.id, name: "pb" });
      const cab = await s.create("cables", { from_port_id: p1.id, to_port_id: pb.id });
      const ip = await s.create("ipAddresses", { equipment_id: eq.id, address: "10.0.0.1" });
      const dh = await s.create("dhcpRanges", { server_id: eq.id, start_ip: "10.0.0.2", end_ip: "10.0.0.9" });
      await s.remove("equipments", eq.id);
      ck(!has(s, "ports", p1.id), "equipments→ delete port");
      ck(!has(s, "aggregates", ag.id), "equipments→ delete agrégat");
      ck(!has(s, "cables", cab.id), "equipments→ delete câble de son port");
      ck(has(s, "ipAddresses", ip.id) && s.get("ipAddresses", ip.id).equipment_id == null, "equipments→ détache ipAddress.equipment_id");
      ck(has(s, "dhcpRanges", dh.id) && s.get("dhcpRanges", dh.id).server_id == null, "equipments→ détache dhcpRange.server_id");
    }

    // 2) ports → câbles du port + lanes de breakout (+ leurs câbles)
    {
      const s = await fresh();
      const eq = await s.create("equipments", { name: "EQ" });
      const trunk = await s.create("ports", { equipment_id: eq.id, name: "trunk" });
      const lane = await s.create("ports", { equipment_id: eq.id, name: "lane", parent_port_id: trunk.id });
      const eqB = await s.create("equipments", { name: "B" });
      const pb = await s.create("ports", { equipment_id: eqB.id, name: "pb" });
      const cab = await s.create("cables", { from_port_id: lane.id, to_port_id: pb.id });
      await s.remove("ports", trunk.id);
      ck(!has(s, "ports", lane.id), "ports→ delete lane de breakout");
      ck(!has(s, "cables", cab.id), "ports→ delete câble de la lane");
    }

    // 3) aggregates → détache ports.aggregate_id (le port survit)
    {
      const s = await fresh();
      const eq = await s.create("equipments", { name: "EQ" });
      const ag = await s.create("aggregates", { equipment_id: eq.id, name: "ag" });
      const p = await s.create("ports", { equipment_id: eq.id, name: "p", aggregate_id: ag.id });
      await s.remove("aggregates", ag.id);
      ck(has(s, "ports", p.id), "aggregates→ le port survit");
      ck(s.get("ports", p.id).aggregate_id == null, "aggregates→ détache port.aggregate_id");
    }

    // 4) networks (multi) → retire l'id de network_ids + repointe le principal
    {
      const s = await fresh();
      const n1 = await s.create("networks", { name: "N1" });
      const n2 = await s.create("networks", { name: "N2" });
      const c = await s.create("cables", { network_ids: [n1.id, n2.id], network_id: n1.id });
      await s.remove("networks", n1.id);
      const c1 = s.get("cables", c.id);
      ck(c1.network_ids.length === 1 && c1.network_ids[0] === n2.id, "networks→ retire l'id de network_ids");
      ck(c1.network_id === n2.id, "networks→ repointe le réseau principal sur le restant");
      await s.remove("networks", n2.id);
      const c2 = s.get("cables", c.id);
      ck(c2.network_ids.length === 0 && c2.network_id == null, "networks→ dernier réseau retiré → principal null");
    }

    // 5) groups → détache equipments.group_id
    {
      const s = await fresh();
      const g = await s.create("groups", { name: "G" });
      const eq = await s.create("equipments", { name: "EQ", group_id: g.id });
      await s.remove("groups", g.id);
      ck(has(s, "equipments", eq.id) && s.get("equipments", eq.id).group_id == null, "groups→ détache equipment.group_id");
    }

    // 6) racks → delete rackItems ; détache equipments (rack_id null + placement_mode manual)
    {
      const s = await fresh();
      const r = await s.create("racks", { name: "R" });
      const it = await s.create("rackItems", { rack_id: r.id, kind: "blank" });
      const eq = await s.create("equipments", { name: "EQ", rack_id: r.id, placement_mode: "rack" });
      await s.remove("racks", r.id);
      ck(!has(s, "rackItems", it.id), "racks→ delete rackItem");
      const e = s.get("equipments", eq.id);
      ck(e && e.rack_id == null, "racks→ détache equipment.rack_id");
      ck(e && e.placement_mode === "manual", "racks→ equipment.placement_mode → manual");
    }

    // 7) portTypes → détache ports.port_type_id
    {
      const s = await fresh();
      const pt = await s.create("portTypes", { name: "PT", family: "X" });
      const eq = await s.create("equipments", { name: "EQ" });
      const p = await s.create("ports", { equipment_id: eq.id, name: "p", port_type_id: pt.id });
      await s.remove("portTypes", pt.id);
      ck(has(s, "ports", p.id) && s.get("ports", p.id).port_type_id == null, "portTypes→ détache port.port_type_id");
    }

    // 8) cableTypes → détache cables.cable_type_id + cableBundles.cable_type_id
    {
      const s = await fresh();
      const ct = await s.create("cableTypes", { name: "CT", family: "X" });
      const c = await s.create("cables", { cable_type_id: ct.id });
      const b = await s.create("cableBundles", { cable_type_id: ct.id, name: "B" });
      await s.remove("cableTypes", ct.id);
      ck(has(s, "cables", c.id) && s.get("cables", c.id).cable_type_id == null, "cableTypes→ détache cable.cable_type_id");
      ck(has(s, "cableBundles", b.id) && s.get("cableBundles", b.id).cable_type_id == null, "cableTypes→ détache bundle.cable_type_id");
    }

    // 9) cableBundles → détache cables.bundle_id + strand_no (les brins redeviennent autonomes)
    {
      const s = await fresh();
      const b = await s.create("cableBundles", { name: "B" });
      const c = await s.create("cables", { bundle_id: b.id, strand_no: 3 });
      await s.remove("cableBundles", b.id);
      const cc = s.get("cables", c.id);
      ck(cc && cc.bundle_id == null, "cableBundles→ détache cable.bundle_id");
      ck(cc && cc.strand_no == null, "cableBundles→ détache cable.strand_no");
    }

    // 10) datacenters → détache racks / équipements libres / waypoints
    {
      const s = await fresh();
      const dc = await s.create("datacenters", { name: "DC", width_mm: 6000, depth_mm: 6000 });
      const r = await s.create("racks", { name: "R", datacenter_id: dc.id, dc_x: 100, dc_y: 200 });
      const eq = await s.create("equipments", { name: "EQ", dim_mode: "free", dc_id: dc.id, dc_x: 1, dc_y: 2, dc_z: 300 });
      const wp = await s.create("waypoints", { name: "wp", kind: "point", wp_type: "datacenter", datacenter_id: dc.id, dc_x: 5, dc_y: 6 });
      await s.remove("datacenters", dc.id);
      const rr = s.get("racks", r.id);
      ck(rr && rr.datacenter_id == null && rr.dc_x == null && rr.dc_y == null, "datacenters→ détache rack (datacenter_id/dc_x/dc_y)");
      const ee = s.get("equipments", eq.id);
      ck(ee && ee.dc_id == null && ee.dc_z === 0, "datacenters→ détache équipement libre (dc_id null, dc_z 0)");
      const ww = s.get("waypoints", wp.id);
      ck(ww && ww.datacenter_id == null && ww.dc_x == null, "datacenters→ renvoie waypoint au pool");
    }

    // 11) ipNetworks → delete ipAddresses + dhcpRanges ; détache networks.ip_network_id
    {
      const s = await fresh();
      const ipn = await s.create("ipNetworks", { name: "IPN", cidr: "10.0.0.0/24" });
      const ip = await s.create("ipAddresses", { network_id: ipn.id, address: "10.0.0.5" });
      const dh = await s.create("dhcpRanges", { network_id: ipn.id, start_ip: "10.0.0.10", end_ip: "10.0.0.20" });
      const n = await s.create("networks", { name: "N", ip_network_id: ipn.id });
      await s.remove("ipNetworks", ipn.id);
      ck(!has(s, "ipAddresses", ip.id), "ipNetworks→ delete ipAddress");
      ck(!has(s, "dhcpRanges", dh.id), "ipNetworks→ delete dhcpRange");
      ck(has(s, "networks", n.id) && s.get("networks", n.id).ip_network_id == null, "ipNetworks→ détache network.ip_network_id");
    }

    // 12) waypoints → retire l'id des waypoint_ids (cables + bundles)
    {
      const s = await fresh();
      const wp = await s.create("waypoints", { name: "wp", kind: "point", wp_type: "oob" });
      const c = await s.create("cables", { waypoint_ids: [wp.id] });
      const b = await s.create("cableBundles", { name: "B", waypoint_ids: [wp.id] });
      await s.remove("waypoints", wp.id);
      const cc = s.get("cables", c.id), bb = s.get("cableBundles", b.id);
      ck(cc && Array.isArray(cc.waypoint_ids) && !cc.waypoint_ids.includes(wp.id), "waypoints→ retire l'id de cable.waypoint_ids");
      ck(bb && Array.isArray(bb.waypoint_ids) && !bb.waypoint_ids.includes(wp.id), "waypoints→ retire l'id de bundle.waypoint_ids");
    }
  }
};

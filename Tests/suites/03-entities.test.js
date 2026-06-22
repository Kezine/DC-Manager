/* Entités : normalisation au constructeur, rétro-compat, invariants documentés. */
module.exports = {
  name: "Entités — normalisation & rétro-compat",
  run: (NM, ck) => {
    // Entity de base : id (uid) + dates auto
    if (NM.Equipment) {
      const e = new NM.Equipment({ name: "X" });
      ck(!!e.id, "Equipment : id auto (uid)");
      ck(!!e.created_date && !!e.updated_date, "Equipment : created_date/updated_date auto");
      if (typeof e.clone === "function") {
        const e2 = e.clone();
        ck(e2.id !== e.id, "Entity.clone() : nouvel id");
        ck.eq(e2.name, e.name, "Entity.clone() : champs métier copiés");
      }
    } else { ck(false, "Equipment exposé"); }

    // Câble : rétro-compat network_id (seul) → network_ids normalisé [v36]
    if (NM.Cable) {
      const c = new NM.Cable({ network_id: "net-1", from_port_id: "a", to_port_id: "b" });
      ck(Array.isArray(c.network_ids), "Cable : network_ids est un tableau");
      ck(c.network_ids.includes("net-1"), "Cable : network_id seul → network_ids = [network_id]");
    }

    // Waypoint OOB : jamais POSÉ dans une salle (datacenter_id null) — normalisé au constructeur [v66].
    // dc_z = HAUTEUR de l'OOB : un positif est conservé, un négatif est re-clampé à 0 [v68/v122].
    if (NM.Waypoint) {
      const w = new NM.Waypoint({ wp_type: "oob", datacenter_id: "dc-1", dc_x: 5, dc_z: 3000 });
      ck(w.datacenter_id == null, "Waypoint OOB : datacenter_id forcé null (jamais posé en salle)");
      ck.eq(w.dc_z, 3000, "Waypoint OOB : dc_z (hauteur) positif conservé");
      const wNeg = new NM.Waypoint({ wp_type: "oob", dc_z: -500 });
      ck.eq(wNeg.dc_z, 0, "Waypoint OOB : dc_z négatif re-clampé à 0 [v122]");
    }

    // Aggregate / Rack présents (sanity de la liste d'entités)
    ck(typeof NM.Rack === "function" && typeof NM.Network === "function", "classes d'entités exposées (Rack, Network)");
  }
};

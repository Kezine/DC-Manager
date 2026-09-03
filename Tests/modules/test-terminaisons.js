/* Tests modules — TERMINAISONS (docs/terminaisons.md, retour terrain T5 : « une jarretière FO-SM ne rejoint jamais un
   port SFP28 »). Ici : la JONCTION du Store (`terminationOf` / `effectivePortType` / `portFamily` — héritage lane ← trunk,
   priorité de la lane, garde anti-cycle, `portConnectorSize` INCHANGÉ), le cas T5 MOT POUR MOT sur `cableIsComplete`, la
   validation PARTAGÉE (T-TERM1 kind data, appartenance de la cage, transceiver seul, dépendance inverse), la CASCADE
   (port supprimé ⇒ pièce détachée, équipement conservé ; type supprimé ⇒ média détaché), la source de candidats du
   dialogue (`core/TerminationSpareSource` — spares lazy, tête « générique », pièce d'une autre cage grisée), et — par
   lecture des SOURCES, patron T2-B1 — les deux surfaces T3 qui lisent le type EFFECTIF, l'absence de `all("spares")`
   synchrone, et le fait que le menu ⋮ et le hint passent bien par le dialogue. Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, Cascade, Validation, PortCompatibility, makeStore } = require("./harness.js");

module.exports = async () => {
  const fs = require("fs");
  const src = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", "src-client", ...p), "utf8");
  const { TerminationSpareSource } = D("core/TerminationSpareSource.js");
  const { PORT_CONNECTOR_MM, CABLE_STATUS_DRAFT } = D("domain/constants.js");
  const { INDEX_SPEC } = SHARED("src-shared/RelationalSchema.js");
  const DV = Validation.DataValidator;
  const FO_SM = "pt-fo-sm-lc", SFP28 = "pt-sfp28-25g", QSFP = "pt-qsfpp-40g", SFPP = "pt-sfpp-10g", CT_FO_SM = "ct-fo-sm";

  /** Le montage T5 : un tiroir optique (port FO-SM) face à un switch (cage SFP28), catalogue semé par le Store. */
  const rig = async () => {
    const s = await makeStore();
    ck(!!s.get("portTypes", FO_SM) && !!s.get("portTypes", SFP28) && !!s.get("cableTypes", CT_FO_SM), "sanité : le catalogue livré est semé (Fibre SM (LC), 25G SFP28, Jarretière fibre SM)");
    const tray = await s.create("equipments", { name: "TIROIR-FO" });
    const sw = await s.create("equipments", { name: "SW-CORE" });
    const trayPort = await s.create("ports", { equipment_id: tray.id, name: "LC-1", port_type_id: FO_SM, role: "data" });
    const swPort = await s.create("ports", { equipment_id: sw.id, name: "Eth1/49", port_type_id: SFP28, role: "data" });
    return { s, tray, sw, trayPort, swPort };
  };

  await section("Terminaisons : la JONCTION du Store — terminationOf / effectivePortType / portFamily", async () => {
    const { s, sw, swPort } = await rig();
    ck.eq(s.terminationOf(swPort), null, "sans terminaison : terminationOf → null");
    ck.eq(s.effectivePortType(swPort).id, SFP28, "sans terminaison : le type effectif est le type PROPRE (la cage)");
    ck.eq(s.portFamily(swPort), "SFP28", "sans terminaison : famille = celle de la cage — comportement d'avant, au bit près");
    ck.eq(s.terminationOf(null), null, "port absent → null (jamais un throw dans un chemin chaud)");
    ck.eq(s.effectivePortType(null), null, "…idem pour le type effectif");
    ck.eq(s.portFamily({ port_type_id: null }), null, "port sans type ni terminaison → famille null (inchangé)");

    const posed = await s.update("ports", swPort.id, { termination_port_type_id: FO_SM, termination_label: "SFP-10G-LR" });
    ck(!!posed, "poser une terminaison (média FO-SM) sur la cage SFP28 est accepté par la validation");
    const t = s.terminationOf(posed);
    ck.eq(t && t.typeId, FO_SM, "terminationOf : le média présenté");
    ck.eq(t && t.label, "SFP-10G-LR", "…et le libellé du module");
    ck.eq(t && t.ownerPortId, swPort.id, "…posée sur CE port");
    ck.eq(t && t.inherited, false, "…donc pas héritée");
    ck.eq(s.effectivePortType(posed).id, FO_SM, "🎯 type EFFECTIF = le média présenté, plus la cage");
    ck.eq(s.portFamily(posed), "FO-SM", "🎯 portFamily SUIT : la famille effective est celle du média");
    // La CAGE se dessine, pas le média : `portConnectorSize` lit toujours le type PROPRE (Q5.5).
    ck.eq(JSON.stringify(s.portConnectorSize(posed)), JSON.stringify(PORT_CONNECTOR_MM.SFP28), "🚨 portConnectorSize INCHANGÉ : la cage SFP28 (14×9), pas le LC (12×6)");
    // Média dont le type a DISPARU : repli sur la cage, jamais sur « inconnu » (objet brut : V2 refuserait de l'écrire).
    ck.eq(s.effectivePortType({ id: "x", port_type_id: SFP28, termination_port_type_id: "pt-fantome" }).id, SFP28, "média au type disparu → repli sur la cage");
    ck.eq(s.portFamily({ id: "y", port_type_id: null, termination_port_type_id: FO_SM }), "FO-SM", "port sans type propre mais avec média → la famille du média");

    // Retirer : les deux champs vidés → tout redevient comme avant.
    const cleared = await s.update("ports", swPort.id, { termination_port_type_id: null, termination_label: "" });
    ck.eq(s.terminationOf(cleared), null, "terminaison retirée → null");
    ck.eq(s.portFamily(cleared), "SFP28", "…et la famille redevient celle de la cage");
    ck.eq(s.portsOf(sw.id).length, 1, "sanité : un seul port sur le switch");
  });

  await section("Terminaisons : HÉRITAGE lane ← trunk (montage fan-out), priorité de la lane, garde anti-cycle", async () => {
    const { s, sw } = await rig();
    const trunk = await s.create("ports", { equipment_id: sw.id, name: "QSFP1", port_type_id: QSFP, role: "data" });
    const lanes = [];
    for (let i = 1; i <= 4; i++) lanes.push(await s.create("ports", { equipment_id: sw.id, name: "QSFP1/" + i, port_type_id: SFPP, role: "data", parent_port_id: trunk.id, lane: i }));
    ck.eq(s.terminationOf(lanes[0]), null, "trunk sans terminaison → la lane n'en hérite aucune");
    ck.eq(s.portFamily(lanes[0]), "SFP+", "…sa famille est celle de son PROPRE type (clause C2)");

    await s.update("ports", trunk.id, { termination_port_type_id: "pt-fo-mm-lc", termination_label: "QSFP-40G-SR4" });
    const lane1 = s.get("ports", lanes[0].id);
    const inherited = s.terminationOf(lane1);
    ck.eq(inherited && inherited.inherited, true, "🎯 terminaison posée sur le TRUNK → la lane l'HÉRITE");
    ck.eq(inherited && inherited.ownerPortId, trunk.id, "…et sait qu'elle vient du trunk");
    ck.eq(inherited && inherited.label, "QSFP-40G-SR4", "…avec son libellé");
    ck.eq(s.portFamily(lane1), "FO-MM", "🎯 famille effective de la lane = le média du trunk (fan-out MPO → 4× LC multimode)");
    ck.eq(s.portFamily(s.get("ports", trunk.id)), "FO-MM", "le trunk lui-même présente ce média");
    ck.eq(JSON.stringify(s.portConnectorSize(lane1)), JSON.stringify(PORT_CONNECTOR_MM["QSFP+"]), "portConnectorSize : la lane émerge toujours du connecteur QSFP+ du trunk (inchangé)");

    // Une lane qui porte SA terminaison prime sur celle du trunk.
    await s.update("ports", lanes[1].id, { termination_port_type_id: FO_SM, termination_label: "propre" });
    const lane2 = s.get("ports", lanes[1].id);
    ck.eq(s.terminationOf(lane2).inherited, false, "🎯 lane avec terminaison PROPRE → la sienne prime (pas héritée)");
    ck.eq(s.portFamily(lane2), "FO-SM", "…et sa famille est celle de SON média");
    ck.eq(s.portFamily(s.get("ports", lanes[2].id)), "FO-MM", "…les autres lanes héritent toujours du trunk");

    // Garde ANTI-CYCLE : deux ports parents l'un de l'autre (état atteignable par API) — la montée TERMINE, sur null.
    const a = await s.create("ports", { equipment_id: sw.id, name: "A", port_type_id: SFPP, role: "data" });
    const b = await s.create("ports", { equipment_id: sw.id, name: "B", port_type_id: SFPP, role: "data", parent_port_id: a.id });
    const cyc = await s.update("ports", a.id, { parent_port_id: b.id });
    ck(!!cyc, "sanité : le cycle A ⇄ B est écrit (rien ne l'interdit à l'écriture — c'est la cascade et la montée qui le gèrent)");
    ck.eq(s.terminationOf(s.get("ports", a.id)), null, "🚨 cycle de parents sans terminaison → null, sans boucler");
    ck.eq(s.portFamily(s.get("ports", b.id)), "SFP+", "…et la famille reste celle du type propre");
    // Auto-parent (le cas dégénéré du même cycle).
    ck.eq(s.terminationOf({ id: "self", port_type_id: SFPP, parent_port_id: "self" }), null, "auto-parent → null, sans boucler");
  });

  await section("🎯 Le cas T5 MOT POUR MOT : jarretière FO-SM entre un port FO-SM et un SFP28 — avec terminaison ⇒ complet, sans ⇒ brouillon", async () => {
    const { s, trayPort, swPort } = await rig();
    const cable = await s.create("cables", { name: "J-1", from_port_id: trayPort.id, to_port_id: swPort.id, cable_type_id: CT_FO_SM });
    ck(!!cable, "sanité : le câble est créé (il est simplement bloqué en brouillon)");
    ck.eq(s.cableIsComplete(cable), false, "🚨 SANS terminaison : FO-SM ⇄ SFP28 → le câble n'est PAS complet (bloqué en brouillon, comme avant)");
    ck.eq(s.cableMaxStatus(cable), CABLE_STATUS_DRAFT, "…statut maximal = brouillon");
    ck.eq(PortCompatibility.compare(s.effectivePortType(trayPort), s.effectivePortType(swPort)).verdict, "impossible", "…et les deux surfaces T3 diraient « impossible » (LC vs SFP28)");

    await s.update("ports", swPort.id, { termination_port_type_id: FO_SM, termination_label: "" });
    const after = s.get("cables", cable.id);
    ck.eq(s.cableIsComplete(after), true, "🎯 AVEC terminaison FO-SM sur la cage SFP28 : le câble est COMPLET");
    ck(s.cableMaxStatus(after) !== CABLE_STATUS_DRAFT, "…il sort du brouillon");
    ck.eq(s.cableCompatible(CT_FO_SM, trayPort.id, swPort.id).ok, true, "…cableCompatible dit oui");
    ck.eq(PortCompatibility.compare(s.effectivePortType(s.get("ports", trayPort.id)), s.effectivePortType(s.get("ports", swPort.id))).verdict, "ok", "…et les surfaces T3 disent « ok » — le montage est DÉCRIT, plus aberrant");
    // Le libellé vide = transceiver GÉNÉRIQUE : aucune pièce, aucune ligne dans spares — et ça suffit.
    ck.eq(s.all("spares").length, 0, "🎯 DUMMY : poser une terminaison ne crée AUCUNE pièce (aucune ligne dans spares)");

    // Candidats au clic : un brouillon FO-SM à un seul bout (sur un SECOND port du tiroir — un port ne porte qu'un
    // câble, et LC-1 porte déjà J-1) devient candidat pour la cage terminée.
    const trayPort2 = await s.create("ports", { equipment_id: trayPort.equipment_id, name: "LC-2", port_type_id: FO_SM, role: "data" });
    const draft = await s.create("cables", { name: "J-2", to_port_id: trayPort2.id, cable_type_id: CT_FO_SM, status: CABLE_STATUS_DRAFT });
    ck(!!draft, "sanité : brouillon à un bout créé");
    const sw2 = await s.create("ports", { equipment_id: swPort.equipment_id, name: "Eth1/50", port_type_id: SFP28, role: "data" });
    ck.eq(s.cableDraftCandidatesForPort(sw2.id).some((c) => c.id === draft.id), false, "cage SFP28 nue : le brouillon FO-SM n'est pas candidat");
    await s.update("ports", sw2.id, { termination_port_type_id: FO_SM });
    ck.eq(s.cableDraftCandidatesForPort(sw2.id).some((c) => c.id === draft.id), true, "🎯 cage terminée en FO-SM : le brouillon FO-SM devient candidat (portFamily suit partout)");

    await s.update("ports", swPort.id, { termination_port_type_id: null });
    ck.eq(s.cableIsComplete(s.get("cables", cable.id)), false, "terminaison retirée → le câble retombe en brouillon");
  });

  await section("Terminaisons : validation PARTAGÉE — T-TERM1 kind data · appartenance de la cage · transceiver seul · dépendance inverse", async () => {
    // Normalisation : défauts des champs neufs (parité constructeurs Port.ts / Spare.ts).
    const port = DV.normalizeRecord("ports", { name: "p" });
    ck.eq(port.termination_port_type_id, null, "ports.termination_port_type_id absent → null");
    ck.eq(port.termination_label, "", "ports.termination_label absent → \"\"");
    ck.eq(DV.normalizeRecord("spares", {}).assigned_port_id, null, "spares.assigned_port_id absent → null");
    ck(INDEX_SPEC.spares.includes("assigned_port_id"), "INDEX_SPEC : spares.assigned_port_id indexé (cascade + dépendance inverse)");

    // T-TERM1 : le média présenté est un type de DONNÉES.
    const typeFetch = (c, i) => (c === "portTypes" && i === "PT-POWER") ? { id: "PT-POWER", kind: "power" } : (c === "portTypes" && i === "PT-DATA") ? { id: "PT-DATA", kind: "data" } : null;
    ck.eq(DV.validateRecord("ports", { termination_port_type_id: "PT-POWER" }, typeFetch).some((x) => x.code === "cross_entity" && x.path === "termination_port_type_id"), true, "T-TERM1 : média d'ÉNERGIE → cross_entity");
    ck.eq(DV.validateRecord("ports", { termination_port_type_id: "PT-DATA" }, typeFetch).some((x) => x.code === "cross_entity"), false, "T-TERM1 : média de données → OK");
    ck.eq(DV.validateRecord("ports", { termination_port_type_id: null }, typeFetch).length, 0, "sans terminaison → rien à juger");

    // Seul un TRANSCEIVER occupe une cage (invariant).
    ck.eq(DV.validateRecord("spares", { type: "hdd", status: "assigned", assigned_port_id: "P1", assigned_equipment_id: "E1" }).some((x) => x.code === "invariant" && x.path === "assigned_port_id"), true, "invariant : un disque dans une cage → refus");
    // La cage appartient à l'ÉQUIPEMENT D'AFFECTATION. Le `fetch` sert AUSSI à l'intégrité référentielle (V2 :
    // « existe ? » = fetch ≠ null) : il doit connaître les équipements, sinon `assigned_equipment_id` serait
    // `ref_missing` et le cas « OK » ne rendrait jamais 0 erreur.
    const portFetch = (c, i) => (c === "ports" && i === "P1") ? { id: "P1", equipment_id: "E1" } : (c === "equipments" && (i === "E1" || i === "E2")) ? { id: i } : null;
    const tx = { type: "transceiver", status: "assigned", assigned_port_id: "P1" };
    ck.eq(DV.validateRecord("spares", { ...tx, assigned_equipment_id: "E1" }, portFetch).length, 0, "cage P1 (E1) + affecté à E1 → OK");
    ck.eq(DV.validateRecord("spares", { ...tx, assigned_equipment_id: "E2" }, portFetch).some((x) => x.code === "cross_entity" && x.path === "assigned_port_id"), true, "cage P1 (E1) + affecté à E2 → cross_entity");
    ck.eq(DV.validateRecord("spares", { ...tx, status: "available", assigned_equipment_id: null }, portFetch).some((x) => x.code === "cross_entity" && x.path === "assigned_port_id"), true, "🚨 cage occupée SANS équipement d'affectation → refus (une pièce « disponible » n'occupe pas de cage)");
    ck.eq(DV.validateRecord("spares", { ...tx, assigned_equipment_id: "E2" }, () => null).some((x) => x.code === "cross_entity"), false, "port introuvable → la règle s'abstient (l'existence est l'affaire de V2)");
    ck(Validation.COLLECTION_SPECS.ports.dependents.some((d) => d.collection === "spares" && d.fkField === "assigned_port_id"), "dépendance inverse déclarée : ports → spares.assigned_port_id");

    // …et rejouée par le Store : déplacer le port vers un autre équipement est REFUSÉ tant qu'une pièce y est logée.
    const { s, sw, tray, swPort } = await rig();
    const spare = await s.create("spares", { name: "TX-1", type: "transceiver", status: "assigned", assigned_equipment_id: sw.id, assigned_port_id: swPort.id });
    ck(!!spare, "sanité : transceiver logé dans la cage du switch");
    let refused = null;
    s.onInvalid = (errors) => { refused = errors; };
    const moved = await s.update("ports", swPort.id, { equipment_id: tray.id });
    ck.eq(moved, null, "🎯 V5b : déplacer la cage vers un autre équipement est REFUSÉ (la pièce logée y contredirait son affectation)");
    ck(!!refused && refused.some((e) => e.collection === "spares" && e.path === "assigned_port_id"), "…l'erreur désigne la pièce et sa cage");
    s.onInvalid = null;
    const power = await s.create("ports", { equipment_id: sw.id, name: "PSU1", port_type_id: "pt-iec-c14", role: "power" });
    ck(!!power, "sanité : port d'énergie créé");
    ck.eq(await s.update("ports", power.id, { termination_port_type_id: "pt-iec-c13" }), null, "T-TERM1 au Store : présenter un type d'ÉNERGIE est refusé");
  });

  await section("Terminaisons : CASCADE — port supprimé ⇒ pièce DÉTACHÉE (équipement conservé) ; type supprimé ⇒ média détaché", async () => {
    // Plan PUR (find/fetch injectés — patron de test-shared-validation.js).
    const db = {
      equipments: [{ id: "E1", name: "sw" }],
      ports: [{ id: "P1", equipment_id: "E1", port_type_id: "PT-CAGE", termination_port_type_id: "PT-MEDIA" }, { id: "P2", equipment_id: "E1", port_type_id: "PT-MEDIA" }],
      spares: [{ id: "S1", type: "transceiver", status: "assigned", assigned_equipment_id: "E1", assigned_port_id: "P1" }, { id: "S2", type: "transceiver", status: "assigned", assigned_equipment_id: "E1", assigned_port_id: null }],
      portTypes: [{ id: "PT-CAGE" }, { id: "PT-MEDIA" }],
    };
    const find = (coll, field, value) => (db[coll] || []).filter((o) => { const v = o[field]; return Array.isArray(v) ? v.includes(value) : v === value; });
    const fetch = (coll, id) => (db[coll] || []).find((o) => o.id === id) || null;
    const portPlan = Cascade.plan("ports", "P1", find, fetch);
    ck.eq(portPlan.detaches.some((d) => d.c === "spares" && d.id === "S1" && d.key === "assigned_port_id" && d.value === null), true, "🎯 port supprimé : la pièce logée est DÉTACHÉE de la cage");
    ck.eq(portPlan.detaches.some((d) => d.c === "spares" && d.key === "assigned_equipment_id"), false, "…mais reste affectée à l'équipement (aucun détachement de assigned_equipment_id)");
    ck.eq(portPlan.deletes.some((d) => d.c === "spares"), false, "…et n'est JAMAIS supprimée");
    ck.eq(portPlan.detaches.some((d) => d.c === "spares" && d.id === "S2"), false, "une pièce affectée sans cage n'est pas touchée");
    const typePlan = Cascade.plan("portTypes", "PT-MEDIA", find, fetch);
    ck.eq(typePlan.detaches.some((d) => d.c === "ports" && d.id === "P1" && d.key === "termination_port_type_id" && d.value === null), true, "🎯 type supprimé : le MÉDIA présenté qui le référence est détaché");
    ck.eq(typePlan.detaches.some((d) => d.c === "ports" && d.id === "P2" && d.key === "port_type_id" && d.value === null), true, "…et la CAGE qui le référence aussi (règle historique intacte)");
    const eqPlan = Cascade.plan("equipments", "E1", find, fetch);
    ck.eq(eqPlan.detaches.some((d) => d.c === "spares" && d.id === "S1" && d.key === "assigned_port_id" && d.value === null), true, "équipement supprimé : par RÉCURSION (ses ports), la pièce est détachée de sa cage…");
    ck.eq(eqPlan.detaches.some((d) => d.c === "spares" && d.id === "S1" && d.key === "assigned_equipment_id" && d.value === null), true, "…et de l'équipement (règle historique) — les deux dans le MÊME plan");

    // Exécution par le Store (mode fichier : tout hydraté).
    const { s, sw, swPort } = await rig();
    const spare = await s.create("spares", { name: "TX-1", type: "transceiver", status: "assigned", assigned_equipment_id: sw.id, assigned_port_id: swPort.id, assigned_date: "2026-09-03" });
    await s.remove("ports", swPort.id);
    const after = s.get("spares", spare.id);
    ck.eq(after.assigned_port_id, null, "Store : port supprimé → assigned_port_id détaché");
    ck.eq(after.assigned_equipment_id, sw.id, "Store : …assigned_equipment_id CONSERVÉ");
    ck.eq(after.status, "assigned", "Store : …statut « attribué » conservé");
    ck.eq(after.assigned_date, "2026-09-03", "Store : …date d'attribution conservée");
  });

  await section("TerminationSpareSource : transceivers seuls, dédoublonnés, triés ; tête « générique » ; pièce d'une autre cage GRISÉE et nommée", async () => {
    const rows = [
      { id: "txB", type: "transceiver", name: "Bravo", status: "assigned", assigned_equipment_id: "E1", assigned_port_id: "P9" },   // dans une AUTRE cage
      { id: "hdd", type: "hdd", name: "Alpha disque", status: "available" },                                                     // pas un transceiver
      { id: "txA", type: "transceiver", name: "alpha", status: "assigned", assigned_equipment_id: "E1", assigned_port_id: null },
      { id: "txA", type: "transceiver", name: "alpha", status: "assigned", assigned_equipment_id: "E1", assigned_port_id: null },  // doublon (deux lectures)
      { id: "txD", type: "transceiver", name: "Delta", status: "available" },
      { id: "txC", type: "transceiver", name: "Charlie", status: "assigned", assigned_equipment_id: "E1", assigned_port_id: "P1" },   // DANS la cage du dialogue
    ];
    let candidateCalls = 0;
    const reader = {
      candidates: async () => { candidateCalls++; return rows; },
      get: (id) => (id === "txZ" ? { id: "txZ", type: "transceiver", name: "Zulu (cache)" } : null),
      fetchOne: async (id) => (id === "txY" ? { id: "txY", type: "transceiver", name: "Yankee (serveur)" } : null),
      portName: (portId) => (portId === "P9" ? "Eth9" : null),
    };
    const labels = { generic: "Transceiver générique (non inventorié)", spare: (r) => r.name, otherCage: (spare, port) => spare + " — déjà dans la cage " + port };
    const source = new TerminationSpareSource(reader, "P1", labels);
    ck.eq(source.debounceMs, 0, "source LOCALE : aucun anti-rebond (les candidats sont déjà chargés)");

    const all = await source.fetch("");
    ck.eq(all.options[0].value, "", "🎯 parcours : la TÊTE est le transceiver GÉNÉRIQUE, valeur vide (= aucune pièce)");
    ck.eq(all.options[0].label, labels.generic, "…avec son libellé");
    ck.eq(all.options.slice(1).map((o) => o.value).join(","), "txA,txB,txC,txD", "🎯 transceivers SEULS (le disque est écarté), DÉDOUBLONNÉS, triés par libellé normalisé (« alpha » avant « Bravo »)");
    const bravo = all.options.find((o) => o.value === "txB");
    ck.eq(bravo.disabled, true, "🎯 une pièce logée dans une AUTRE cage est GRISÉE…");
    ck(/Eth9/.test(bravo.label), "…et la cage est NOMMÉE (« déjà dans la cage Eth9 »)");
    ck.eq(!!all.options.find((o) => o.value === "txC").disabled, false, "la pièce qui occupe CETTE cage n'est pas grisée (c'est la valeur courante)");
    ck.eq(all.hidden, 0, "aucun surplus");
    ck.eq(await source.currentSpareId(), "txC", "🎯 currentSpareId : la pièce dont assigned_port_id = la cage du dialogue");
    await source.fetch("");
    ck.eq(candidateCalls, 1, "les candidats sont chargés UNE fois (promesse mémoïsée)");

    const filtered = await source.fetch("delt");
    ck.eq(filtered.options.map((o) => o.value).join(","), "txD", "recherche : filtre sur le libellé normalisé, SANS la tête (on cherche une vraie pièce)");
    ck.eq((await source.fetch("génér")).options[0].value, "", "…sauf si la saisie NOMME le générique (accents/casse repliés)");
    ck.eq((await source.fetch("zzz")).options.length, 0, "rien ne correspond → liste vide");
    const capped = new TerminationSpareSource(reader, "P1", labels, 2);
    const small = await capped.fetch("");
    ck.eq(small.options.length, 3, "plafond 2 : la tête + 2 pièces…");
    ck.eq(small.hidden, 2, "…et le surplus est ANNONCÉ (2 masquées), jamais tu");

    ck.eq(source.labelOf("txA"), "alpha", "labelOf : une pièce chargée → son libellé (synchrone)");
    ck.eq(source.labelOf("txZ"), "Zulu (cache)", "labelOf : une pièce au CACHE du Store → son libellé");
    ck.eq(source.labelOf("inconnu"), null, "labelOf : inconnue → null (le contrôle passera par resolveLabel)");
    ck.eq(await source.resolveLabel("txY"), "Yankee (serveur)", "resolveLabel : lecture unitaire async");
    ck.eq(await source.resolveLabel("inconnu"), null, "resolveLabel : introuvable → null (repli du contrôle)");
    ck.eq(source.record("txC").assigned_port_id, "P1", "record : la pièce chargée, pour l'avertissement pièce ⇄ cage/média");
  });

  /* ============================================================================================
     🚨 VERROU sur les SOURCES (patron T2-B1) : la jonction ne sert à rien si les deux surfaces T3
     comparent encore les CAGES, et la garde G7 ne vaut que si personne ne lit `all("spares")`.
     ⚠ `\r?\n` dans les motifs multi-lignes : le dépôt est en LF, la copie Windows en CRLF.
     ============================================================================================ */
  await section("🚨 VERROU sources : les surfaces T3 lisent le type EFFECTIF, aucun all(\"spares\") synchrone, menu ⋮ et hint passent par le dialogue", async () => {
    const routeTool = src("views", "dc", "RouteTool.ts");
    const warn = /protected warnIfIncompatible\(([\s\S]*?)\r?\n  \}\r?\n/.exec(routeTool);
    ck(!!warn, "RouteTool.warnIfIncompatible est bien lu");
    ck(/this\.store\.effectivePortType\(p\)/.test(warn[1]), "🎯 RouteTool : le toast T3 compare les types EFFECTIFS");
    ck(!/get\("portTypes", p\.port_type_id\)/.test(warn[1]), "…et plus la cage en direct");

    const cableForms = src("views", "forms", "CableForms.ts");
    ck(/PortCompatibility\.compare\(store\.effectivePortType\(store\.get\("ports", a\)\), store\.effectivePortType\(store\.get\("ports", b\)\)\)/.test(cableForms), "🎯 CableForms : le hint T3 compare les types EFFECTIFS");
    ck(!/store\.get\("portTypes", \(store\.get\("ports", a\) \|\| \{\}\)\.port_type_id\)/.test(cableForms), "…et plus la cage en direct");
    ck(/const offerTermination = \(portId: string, otherPortId: string\)/.test(cableForms), "CableForms : le hint PROPOSE la terminaison (offerTermination)");
    ck(/offerTermination\(a, b\), offerTermination\(b, a\)/.test(cableForms), "…un bouton par bout, A et B");
    ck(/suggestedTypeId: otherType \? otherType\.id : null/.test(cableForms), "🎯 …le média est PRÉ-REMPLI depuis le type effectif de l'AUTRE bout (« prend automatiquement les bonnes specs »)");
    ck(/await FormSave\.batch\(store, ops\)/.test(cableForms), "🎯 …écriture IMMÉDIATE en UN lot (port + pièce liée/détachée), via la garde « jamais annoncer un succès refusé »");
    ck(/store\.portKind\(port\) !== "data"\) return null/.test(cableForms), "…réservé aux bouts de DONNÉES");

    const forms = src("views", "forms", "EquipmentForms.ts");
    ck(/const terminationMenuItems = \(p: PortDraft\): RowMenuItem\[\]/.test(forms), "EquipmentForms : items de terminaison du menu ⋮");
    ck(/\[splitMenuItem\(p\), \.\.\.terminationMenuItems\(p\)\]/.test(forms), "🎯 …au SECOND emplacement du menu d'un port ordinaire (clause C3), après « éclater »");
    ck(/\[\.\.\.terminationMenuItems\(trunk\), \.\.\.trunkMenuItems\(trunk, lanes\)\]/.test(forms), "…sur le TRUNK aussi (un fan-out se pose sur le trunk)");
    ck(/RowMenu\.open\(e\.currentTarget as HTMLElement, terminationMenuItems\(lane\)\)/.test(forms), "…et sur chaque LANE (terminaison propre)");
    ck(/this\.configureTermination\(store, \{ port: \{ id: p\.id/.test(forms), "…le geste passe par le dialogue partagé FormBase.configureTermination");
    ck(/const pendingSpareLinks = new Map<string, \{ spareId: string \| null \}>\(\)/.test(forms), "🎯 la PIÈCE choisie est un lien EN ATTENTE (pas un brouillon : spares lazy)");
    ck(/await store\.sparesOfEquipmentAsync\(existingId\)/.test(forms), "🎯 …appliqué AU SAVE : la vérité « qui occupe la cage » est relue en ASYNC (G7)");
    ck(/termination_port_type_id: terminationTypeId, termination_label: terminationLabel/.test(forms), "…les deux champs partent dans le patch du port, avec les autres");
    ck(/store\.terminationOf\(p\)/.test(forms), "la FICHE lit la terminaison effective du Store (pastille sous le nom)");
    ck(/assigned_port_id: \(status === "assigned" && eqId && sp && sp\.assigned_port_id && eqId === sp\.assigned_equipment_id\)/.test(forms), "le formulaire de spare NEUTRALISE la cage quand la pièce change d'équipement (sinon la règle d'appartenance refuserait)");

    const formBase = src("views", "forms", "FormBase.ts");
    const dialog = /protected static configureTermination\(([\s\S]*?)\r?\n  \}\r?\n/.exec(formBase);
    ck(!!dialog, "FormBase.configureTermination est bien lu");
    ck(/FormControls\.entityPicker\(typeOpts/.test(dialog[1]), "🎯 le MÉDIA se choisit dans un sélecteur À RECHERCHE sur les types de port (principe n°14)");
    ck(/FormControls\.entityPickerAsync\(source/.test(dialog[1]), "🎯 la PIÈCE se choisit dans un sélecteur ASYNC (spares lazy — G7)");
    ck(/new TerminationSpareSource\(/.test(dialog[1]), "…alimenté par la source dédiée");
    ck(/store\.sparesOfEquipmentAsync\(port\.equipmentId\)/.test(dialog[1]) && /store\.sparesAvailableAsync\(\)/.test(dialog[1]), "…qui lit les jumeaux ASYNC du Store (affectés à l'équipement + disponibles)");
    ck(/forms\.termination\.genericSpare/.test(dialog[1]), "…avec le transceiver GÉNÉRIQUE comme état par défaut");
    ck(/warnMismatch/.test(dialog[1]) && !/errSpare/.test(dialog[1]), "…et un AVERTISSEMENT pièce ⇄ cage/média, jamais un refus");
    ck(/t\.kind !== "power"/.test(formBase), "…les types proposés sont ceux de DONNÉES");

    // G7 : aucune lecture synchrone de `spares` dans les fichiers touchés. Ces fichiers DOCUMENTENT l'interdit en
    // commentaire (« jamais `all("spares")` ») : on contrôle le CODE seul — le parseur TypeScript retire les
    // commentaires (même recette que `TsImports` du harnais : jamais une regex sur de la prose).
    const ts = require("typescript");
    const codeOnly = (text) => ts.transpileModule(text, { compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2020 } }).outputText;
    for (const [file, text] of [["FormBase.ts", formBase], ["EquipmentForms.ts", forms], ["CableForms.ts", cableForms], ["TerminationSpareSource.ts", src("core", "TerminationSpareSource.ts")], ["DcInteract.ts", src("views", "dc", "DcInteract.ts")]]) {
      ck(!/all\("spares"\)/.test(codeOnly(text)), "🚨 G7 : aucun `all(\"spares\")` synchrone dans " + file);
    }
    ck(/all\("spares"\)/.test(codeOnly('const x = store.all("spares"); // rien')) && !/all\("spares"\)/.test(codeOnly('// store.all("spares")')), "…contrôle de discrimination : le détecteur voit un appel et ignore un commentaire");

    const store = src("store", "Store.ts");
    const family = /  portFamily\(port: any\): string \| null \{([\s\S]*?)\r?\n  \}/.exec(store);
    ck(!!family && /this\.effectivePortType\(port\)/.test(family[1]), "🎯 Store.portFamily est écrit sur effectivePortType (SEUL point de lecture de la famille — clause C1)");
    const size = /  portConnectorSize\(port: any\)[\s\S]*?\r?\n  \}/.exec(store);
    ck(!!size && /port\.port_type_id/.test(size[0]) && !/effectivePortType|terminationOf/.test(size[0]), "🚨 Store.portConnectorSize lit toujours le type PROPRE (la cage se dessine) — INCHANGÉ");
    ck(/sparesAvailableAsync\(\): Promise<any\[\]> \{ return this\._sectionRows\("spares", "status", "available"\); \}/.test(store), "Store.sparesAvailableAsync : même corps `_sectionRows` que les autres jumeaux");

    const dcInteract = src("views", "dc", "DcInteract.ts");
    const tip = /protected portTipHtml\(port: any, cab: any\): string \{([\s\S]*?)\r?\n  \}/.exec(dcInteract);
    ck(!!tip && /this\.store\.terminationOf\(port\)/.test(tip[1]), "3D : la bulle de port mentionne la terminaison (logique — aucun mesh)");
    ck(/dc\.interact\.terminationInherited/.test(tip[1]), "…et dit si elle est héritée du trunk");

    const picker = src("ui", "EntityPicker.ts");
    ck(/id: option\.value, label: option\.label, disabled: option\.disabled, data: option,/.test(picker), "EntityPicker.buildAsync relaie `disabled` (une pièce d'une autre cage est visible et non sélectionnable)");

    const css = fs.readFileSync(path.join(__dirname, "..", "..", "src-client", "styles", "dc-manager.css"), "utf8");
    const block = /\.pill\.p-term \{[\s\S]*?\.form-hint \.hint-actions[^\n]*\n/.exec(css);
    ck(!!block, "la CSS porte le bloc terminaison (pastille du formulaire/fiche + boutons du hint)");
    ck(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/.test(block[0]), "🚨 aucune couleur en dur dans le bloc : tokens seulement");
    ck(/\.pill\.p-term\.inherited/.test(block[0]), "…la pastille HÉRITÉE a son style atténué");
  });
};

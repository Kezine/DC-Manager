/* Tests modules — vues & outils pilotés par hôte injecté (Graph/Datacenter, outils 2D/3D, images).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, RichTooltip, FormSave, Store, BrowserStorageAdapter, PlacementContainers, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, FilterChips, Ip, Prefs, DatacenterView, FloorLayout, Positioning, CameraFraming, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, SceneLayoutSignature, FaceImagePolicy, PivotBounds, PivotMarker, FocusArrowMarker, ImageStore, FaceImage, SaveState, ShellNav, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("FormSave : un formulaire n'annonce JAMAIS un succès que le Store a REFUSÉ", async () => {
  {
    /* DÉFAUT FERMÉ : onze formulaires écrivaient `await store.update(...)` puis annonçaient le succès
       SANS regarder le retour. Or `create`/`update` rendent `null` quand la validation refuse — sans
       lever d'exception. La modale se fermait donc sur « … mis à jour » pendant que le Store affichait
       un toast ROUGE, et la saisie était perdue. */
    const s = await makeStore();

    // ---- CRÉATION acceptée : l'enregistrement est rendu (l'appelant a besoin de l'id tout juste créé)
    const cree = await FormSave.record(s, "sites", null, { name: "Site A" });
    ck(!!cree && !!cree.id, "création acceptée → l'enregistrement est rendu, avec son id");
    ck.eq(s.all("sites").length, 1, "…et il est bien dans le document");

    // ---- MISE À JOUR acceptée : c'est bien l'existant qui est patché, pas un doublon qui est créé
    const maj = await FormSave.record(s, "sites", cree.id, { name: "Site B" });
    ck(!!maj, "mise à jour acceptée → enregistrement rendu");
    ck.eq(s.all("sites").length, 1, "mise à jour : AUCUN doublon créé (l'id fourni discrimine create/update)");
    ck.eq(s.get("sites", cree.id).name, "Site B", "mise à jour : la valeur est bien écrite");

    // ---- REFUS : `name` est requis → le Store rend null, et RIEN n'est écrit.
    let signale = 0;
    s.onInvalid = () => { signale++; };
    const refuse = await FormSave.record(s, "sites", null, { name: "" });
    ck.eq(refuse, null, "création REFUSÉE (nom requis) → null, et non une exception : c'est tout le piège");
    ck.eq(s.all("sites").length, 1, "refus : rien n'est ajouté au document");
    ck(signale > 0, "refus : le Store NOTIFIE la raison (`onInvalid`) — d'où l'inutilité d'un second message générique");

    const refuseMaj = await FormSave.record(s, "sites", cree.id, { name: "" });
    ck.eq(refuseMaj, null, "mise à jour REFUSÉE → null");
    ck.eq(s.get("sites", cree.id).name, "Site B", "refus de mise à jour : la valeur PRÉCÉDENTE est intacte");

    // ---- id absent/vide ⇒ CRÉATION (le ternaire que les onze formulaires réécrivaient)
    const vide = await FormSave.record(s, "sites", "", { name: "Site C" });
    ck(!!vide && vide.id !== cree.id, "id vide → CRÉATION (et non une mise à jour de l'existant)");
    ck.eq(s.all("sites").length, 2, "…deux sites au total");
  }
  });

  await section("VERROU : aucun formulaire ne réintroduit l'écriture directe suivie d'un toast de succès", async () => {
  {
    /* Le module ne sert à rien si un formulaire suivant repart de l'écriture directe. Ce verrou relit les
       SOURCES de `views/forms/` et refuse le motif exact qui portait le défaut : un `await store.create(`
       ou `store.update(` dont le résultat est JETÉ, immédiatement suivi d'un `Notify.toast` qui n'est pas
       une erreur. Il ne juge pas les écritures dont le retour est CAPTURÉ (`const x = await …`) : celles-là
       peuvent être contrôlées, et plusieurs le sont déjà. */
    const fs = require("fs"), dir = path.join(__dirname, "..", "..", "src-client", "views", "forms");
    // `updateBatch` est du même défaut : il rend le NOMBRE d'écritures, donc 0 en cas de refus.
    const ECRITURE_JETEE = /(^|[^=]\s|\{\s*)await\s+(this\.)?store\.(create|update|updateBatch)\s*\(/;
    const SUCCES = /Notify\.toast\(/;
    /* ⚠ NEUTRALISER LES COMMENTAIRES avant de juger — sinon le verrou mord sur la PROSE. Il l'a fait :
       l'en-tête de `FormSave.ts` CITE le motif fautif pour l'expliquer, et se faisait accuser de le
       commettre. Même piège qu'au verrou d'isolement de `src-shared/` (§6.19), résolu là-bas par le
       parseur TS. Ici les blocs sont remplacés par des espaces (les NUMÉROS DE LIGNE sont préservés,
       sans quoi les messages désigneraient la mauvaise ligne). */
    const sansCommentaires = (t) => t
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*/g, (m, p) => p);

    const fautesDe = (texteBrut, nom) => {
      const texte = sansCommentaires(texteBrut);
      const lignes = texte.split(/\r?\n/), fautes = [];
      for (let i = 0; i < lignes.length; i++) {
        if (!ECRITURE_JETEE.test(lignes[i]) || /=\s*await/.test(lignes[i])) continue;
        // la ligne SUIVANTE annonce-t-elle un succès ? (un toast d'ERREUR est légitime, lui)
        const suivante = lignes[i + 1] || "";
        if (SUCCES.test(suivante) && !/"err"|'err'/.test(suivante)) {
          fautes.push(nom + ":" + (i + 1) + " → écriture au résultat JETÉ, puis annonce de succès");
        }
      }
      return fautes;
    };

    const fichiers = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    ck(fichiers.length > 10, "le verrou lit bien le dossier des formulaires (" + fichiers.length + " fichiers) — anti-vacuité");
    const fautes = [];
    fichiers.forEach((f) => fautes.push(...fautesDe(fs.readFileSync(path.join(dir, f), "utf8"), f)));
    ck.eq(fautes.join("  |  "), "", "aucun formulaire n'annonce un succès sans regarder le retour du Store");

    // -- preuve que le verrou MORD : sondes SYNTHÉTIQUES, aucune source réelle n'est modifiée --
    const sondeFautive = '        if (x) await store.update("sites", x.id, p); else await store.create("sites", p);\n        Notify.toast(I18n.t("rack.site.updated")); return true;';
    ck.eq(fautesDe(sondeFautive, "sonde.ts").length, 1, "VERROU : le motif d'origine EXACT est refusé (sinon le verrou ne prouverait rien)");
    const sondeCorrigee = '        if (!await FormSave.record(store, "sites", x && x.id, p)) return false;\n        Notify.toast(I18n.t("rack.site.updated")); return true;';
    ck.eq(fautesDe(sondeCorrigee, "sonde.ts").length, 0, "VERROU : la forme CORRIGÉE passe (ce n'est pas un refus aveugle du mot `Notify.toast`)");
    const sondeCapturee = '        const ok = await store.update("sites", x.id, p);\n        Notify.toast(I18n.t("rack.site.updated")); return true;';
    ck.eq(fautesDe(sondeCapturee, "sonde.ts").length, 0, "VERROU : un retour CAPTURÉ n'est pas jugé ici (le contrôle lui appartient)");
    const sondeErreur = '        if (x) await store.update("sites", x.id, p); else await store.create("sites", p);\n        Notify.toast(I18n.t("x.failed"), "err"); return false;';
    ck.eq(fautesDe(sondeErreur, "sonde.ts").length, 0, "VERROU : un toast d'ERREUR après écriture n'est pas une annonce de succès");
    const sondeLot = '        await store.updateBatch(ops);\n        Notify.toast(I18n.t("face.saved"));';
    ck.eq(fautesDe(sondeLot, "sonde.ts").length, 1, "VERROU : `updateBatch` est couvert (il rend 0 au refus, donc le même piège)");
    // -- le décommentage ne doit NI aveugler le verrou, NI le laisser mordre sur de la prose --
    const sondeProse = '/* Exemple à NE PAS suivre :\n       await store.update("sites", x.id, p);\n       Notify.toast("Site mis à jour");\n    */';
    ck.eq(fautesDe(sondeProse, "sonde.ts").length, 0, "VERROU : le motif CITÉ dans un commentaire n'est pas une faute (c'est le cas de l'en-tête de FormSave)");
    const sondeProseLigne = '        // await store.update("sites", x.id, p);\n        // Notify.toast("Site mis à jour");';
    ck.eq(fautesDe(sondeProseLigne, "sonde.ts").length, 0, "VERROU : … y compris en commentaire de LIGNE");
    const sondeApresProse = '/* du blabla\n   sur deux lignes */\n        if (x) await store.update("sites", x.id, p); else await store.create("sites", p);\n        Notify.toast("ok");';
    ck.eq(fautesDe(sondeApresProse, "sonde.ts").length, 1, "VERROU : le décommentage ne l'AVEUGLE pas — une vraie faute qui suit un commentaire est toujours vue");
    ck(fautesDe(sondeApresProse, "sonde.ts")[0].indexOf(":3") > 0, "VERROU : le décommentage PRÉSERVE les numéros de ligne (faute annoncée en ligne 3)");
  }
  });

  await section("FilterChips : modèle pur des filtres actifs (barre de contrôles unifiée, lot C)", async () => {
    const dims = [
      { key: "type", label: "Type", options: [{ id: "switch", label: "Switch" }, { id: "server", label: "Serveur" }] },
      { key: "status", label: "Statut", options: [{ id: "ok", label: "OK" }, { id: "ko", label: "KO" }] },
    ];
    const sel = (m) => (k) => m[k];   // accès à l'état : dimKey → Set (ou undefined)

    // état vide → aucun chip
    ck.eq(FilterChips.build(dims, sel({})).length, 0, "aucun filtre → 0 chip");
    ck.eq(FilterChips.count(dims, sel({})), 0, "count = 0 sans filtre");
    ck.eq(FilterChips.build(dims, sel({ type: new Set() })).length, 0, "Set vide → 0 chip");

    // une valeur → un chip entièrement renseigné
    const one = FilterChips.build(dims, sel({ type: new Set(["switch"]) }));
    ck.eq(one.length, 1, "1 valeur → 1 chip");
    ck.eq(one[0].dimKey, "type", "chip.dimKey");
    ck.eq(one[0].dimLabel, "Type", "chip.dimLabel");
    ck.eq(one[0].valueId, "switch", "chip.valueId");
    ck.eq(one[0].valueLabel, "Switch", "chip.valueLabel");
    ck.eq(one[0].key, FilterChips.keyOf("type", "switch"), "chip.key = keyOf(dim, val)");

    // ordre DÉTERMINISTE = dimensions puis OPTIONS (pas l'ordre d'insertion du Set)
    const state = { type: new Set(["server", "switch"]), status: new Set(["ko"]) };
    const many = FilterChips.build(dims, sel(state));
    ck.eq(many.map((c) => c.valueId).join(","), "switch,server,ko", "ordre = dimensions puis options (déterministe)");
    ck.eq(FilterChips.count(dims, sel(state)), 3, "count = 3");

    // valeur cochée absente des options (option disparue) → ignorée (aucun chip fantôme)
    const orphan = FilterChips.build(dims, sel({ type: new Set(["switch", "ghost"]) }));
    ck.eq(orphan.length, 1, "valeur orpheline ignorée");
    ck.eq(orphan[0].valueId, "switch", "seule la valeur valide subsiste");

    // clés uniques par (dimension, valeur)
    ck(FilterChips.keyOf("type", "x") !== FilterChips.keyOf("status", "x"), "keyOf : clés distinctes selon la dimension");
    ck(FilterChips.keyOf("d", "a") !== FilterChips.keyOf("d", "b"), "keyOf : clés distinctes selon la valeur");
  });

  await section("GraphView (pilote) : build + layout (sans DOM)", async () => {
  {
    const s = await makeStore();
    const sw = await s.create("equipments", { name: "sw", type: "switch" });
    const srv = await s.create("equipments", { name: "srv", type: "server" });
    await s.create("equipments", { name: "stock", type: "other", inventory_only: true });
    const noPorts = await s.create("equipments", { name: "bandeau", type: "other" });   // SANS port → jamais au graphe
    const p1 = await s.create("ports", { equipment_id: sw.id, name: "a" });
    const p2 = await s.create("ports", { equipment_id: srv.id, name: "b" });
    await s.create("cables", { name: "lnk", from_port_id: p1.id, to_port_id: p2.id });
    const fakeStage = { clientWidth: 900, clientHeight: 560 };
    const gv = new GraphView(s, fakeStage, {});
    gv.computeVisible();
    ck.eq(gv.nodes.length, 2, "computeVisible : 2 nœuds (inventory_only ET sans-port exclus)");
    // même sélectionné EXPLICITEMENT par le filtre, un équipement sans port reste hors du graphe
    gv.filters.equip.add(noPorts.id); gv.filters.equip.add(sw.id);
    gv.computeVisible();
    ck(gv.nodes.every((n) => n.id !== noPorts.id), "filtre explicite : équipement sans port toujours exclu");
    gv.filters.equip.clear();
    gv.computeVisible();
    ck.eq(gv.edges.length, 1, "computeVisible : 1 arête");
    ck(gv.edges[0].a === sw.id && gv.edges[0].b === srv.id, "arête relie sw↔srv");
    gv.layout();
    ck(gv.nodes.every((n) => isFinite(n.x) && isFinite(n.y)), "layout : positions finies");
    ck(gv.nodes[0].x !== gv.nodes[1].x || gv.nodes[0].y !== gv.nodes[1].y, "layout : nœuds séparés");
    gv.selectAll();
    ck.eq(gv.selection.size, 2, "selectAll : 2 nœuds sélectionnés");
  }

  // ---- overlay « VMs » (opt-in) : nœuds vm:/net: matérialisés via le mapping bridge/tag → réseau ----
  {
    const s = await makeStore();
    const eq = await s.create("equipments", { name: "hyperviseur", type: "server" });
    const p1 = await s.create("ports", { equipment_id: eq.id, name: "eth0" });
    const eq2 = await s.create("equipments", { name: "sw2", type: "switch" });
    const p2 = await s.create("ports", { equipment_id: eq2.id, name: "g1" });
    await s.create("cables", { name: "c", from_port_id: p1.id, to_port_id: p2.id });
    const netA = await s.create("networks", { label: "Prod" });
    const netB = await s.create("networks", { label: "DMZ" });   // mappé mais AUCUNE vNIC ne le référence
    // mapping : (vmbr0, tag 10) → netA ; (vmbr9, tag 99) → netB (jamais utilisé par une vNIC affichée)
    s.meta.vmNetMappings = [
      { bridge: "vmbr0", vlan_tag: 10, network_id: netA.id },
      { bridge: "vmbr9", vlan_tag: 99, network_id: netB.id },
    ];
    const vm1 = await s.create("vms", { name: "web01", nics: [{ name: "net0", bridge: "vmbr0", vlan_tag: 10 }] });
    const vm2 = await s.create("vms", { name: "iso", nics: [{ name: "net0", bridge: "vmbrX", vlan_tag: null }] });   // vNIC non mappée → VM isolée
    const gv = new GraphView(s, { clientWidth: 900, clientHeight: 560 }, {});

    // toggle OFF (défaut) : graphe STRICTEMENT équipement (non-régression)
    gv.computeVisible();
    ck(gv.nodes.every((n) => n.kind === "equip"), "VMs OFF : aucun nœud vm/net (graphe inchangé)");
    ck.eq(gv.nodes.length, 2, "VMs OFF : seuls les 2 équipements à port");

    // toggle ON : un nœud vm: par VM, un nœud net: pour le réseau RÉFÉRENCÉ par une vNIC (netA), pas netB
    gv.showVms = true;
    gv.computeVisible();
    ck(gv.nodes.some((n) => n.id === "vm:" + vm1.id && n.kind === "vm"), "VMs ON : nœud vm: préfixé pour vm1");
    ck(gv.nodes.some((n) => n.id === "vm:" + vm2.id), "VMs ON : VM isolée (vNIC non mappée) présente aussi");
    ck(gv.nodes.some((n) => n.id === "net:" + netA.id && n.kind === "net"), "VMs ON : nœud net: pour le réseau mappé référencé (netA)");
    ck(!gv.nodes.some((n) => n.id === "net:" + netB.id), "VMs ON : réseau NON référencé par une vNIC absent (netB)");
    ck(gv.edges.some((e) => e.a === "vm:" + vm1.id && e.b === "net:" + netA.id && e.network_id === netA.id), "VMs ON : arête VM→réseau via le mapping");
    ck(!gv.edges.some((e) => e.a === "vm:" + vm2.id), "VMs ON : vNIC non mappée → VM sans arête (isolée)");
    // pas de collision d'id : les nœuds équipement gardent leur id NU, jamais préfixé
    ck(gv.nodes.some((n) => n.id === eq.id && n.kind === "equip") && !gv.nodes.some((n) => n.id === "vm:" + eq.id), "VMs ON : ids équipement NON préfixés (aucune collision)");
    gv.layout();
    ck(gv.nodes.every((n) => isFinite(n.x) && isFinite(n.y)), "VMs ON : layout fini avec nœuds vm:/net:");

    // filtre « Réseaux » : exclure netA (mode A = filtrage) retire le nœud net: et l'arête ; la VM reste
    gv.filters.net.add(netB.id);   // netB seul autorisé → netA exclu
    gv.computeVisible();
    ck(!gv.nodes.some((n) => n.id === "net:" + netA.id), "filtre Réseaux : nœud net: du réseau exclu retiré");
    ck(!gv.edges.some((e) => e.b === "net:" + netA.id), "filtre Réseaux : arête VM→réseau exclu retirée");
    ck(gv.nodes.some((n) => n.id === "vm:" + vm1.id), "filtre Réseaux : la VM reste (indépendante du filtre)");
    gv.filters.net.clear();
    window.localStorage.clear();
  }

  // ---- GraphGeometry.nodeSize : dimension selon le kind (sous-ligne) ----
  {
    const equip = GraphGeometry.nodeSize({ name: "x", type: "switch", kind: "equip" });
    ck(equip.h === 40 && equip.w >= 120, "nodeSize équip : hauteur 40, largeur ≥ 120");
    ck(GraphGeometry.nodeSize({ name: "x", kind: "vm", orphan: true }).w > GraphGeometry.nodeSize({ name: "x", kind: "vm" }).w, "nodeSize VM : sous-ligne « orpheline » élargit la boîte");
    const net = GraphGeometry.nodeSize({ name: "un-reseau-au-nom-long", kind: "net" });
    ck(net.h === 40 && net.w > 120, "nodeSize réseau : boîte dimensionnée sur le nom");
    ck.eq(GraphGeometry.nodeSize({ name: "x", type: "switch" }).w, equip.w, "nodeSize : kind absent → voie équipement (compat des appels existants)");
  }
  });

  await section("DatacenterView : persistance de l'état de vue (par fichier)", async () => {
  {
    const s = await makeStore();
    s.meta.fileId = "F1";
    const dv = new DatacenterView(s, {}, {});   // garde headless
    window.localStorage.setItem("dcmanager.view3d.F1", JSON.stringify({ az: 1.23, el: 0.5, scale: 2, tx: 10, ty: 20, camTarget: { x: 1, y: 2, z: 3 }, showAllCables: false, showPorts: false, hideFrontEq: true, dcId: "ghost", hidden3dRacks: ["ghost"] }));
    dv.restoreView();
    ck(Math.abs(dv.az - 1.23) < 1e-9 && dv.scale === 2 && dv.tx === 10, "restore : caméra (az/scale/tx)");
    ck(dv.showAllCables === false && dv.showPorts === false && dv.hideFrontEq === true, "restore : toggles d'affichage");
    ck.eq(dv.hidden3dRacks.size, 0, "restore : baie inexistante ignorée (failsafe)");
    window.localStorage.removeItem("dcmanager.view3d.F1");
    dv.restoreView();
    ck(Math.abs(dv.az - (-0.62)) < 1e-9 && dv.scale === null && dv.showAllCables === true && dv.hideFrontEq === false, "restore : défauts quand état absent");
    window.localStorage.clear();
  }
  });

  await section("DatacenterView : presets caméra + résolution de câbles (helpers partagés avec la 2D)", async () => {
  {
    // NB : le moteur 3D SVG legacy (projection orbitale, builders) a été retiré — la 3D passe par le moteur WebGL.
    // Ne subsistent côté vue que les helpers de câbles partagés avec les vues 2D (resolvedCables / outgoingCableStubs).
    const s = await makeStore();
    const dv = new DatacenterView(s, {}, {});   // garde headless (pas de document) → méthodes pures testables
    dv.setCamPreset("top"); ck(Math.abs(dv.el - Math.PI / 2) < 1e-9, "preset « Dessus » → élévation π/2");
    dv.setCamPreset("front"); ck(dv.az === 0 && dv.el === 0, "preset « Face » → az=0, el=0");

    // résolution des câbles INTRA-salle : 2 équipements rackés reliés → 1 câble résolu (2 points).
    const dc = await s.create("datacenters", { name: "DC" });
    const rk = await s.create("racks", { name: "R", u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const mkEqPort = async (u) => { const e = await s.create("equipments", { name: "e" + u, placement_mode: "rack", rack_id: rk.id, rack_u: u }); return (await s.create("ports", { equipment_id: e.id, name: "p", face_x: 0.5, face_y: 0.5 })).id; };
    const pa = await mkEqPort(1), pb = await mkEqPort(2);
    await s.create("cables", { name: "patch", from_port_id: pa, to_port_id: pb });
    const rcs = dv.resolvedCables(dc.id);
    ck.eq(rcs.length, 1, "resolvedCables : 1 câble intra-salle");
    ck(rcs[0].pts.length === 2 && rcs[0].pts.every((p) => isFinite(p.x) && isFinite(p.z)), "resolvedCables : 2 points finis (sans waypoint)");
    // câbles SORTANTS : port local → exit de la salle (un seul bout résolu ici)
    const dc2 = await s.create("datacenters", { name: "DC2" });
    const rk2 = await s.create("racks", { name: "R2", u_count: 42, datacenter_id: dc2.id, dc_x: 500, dc_y: 500 });
    const e2 = await s.create("equipments", { name: "eDC2", placement_mode: "rack", rack_id: rk2.id, rack_u: 1 });   // nom UNIQUE par document (V6g) : « e2 » déjà pris par mkEqPort(2)
    const pc = (await s.create("ports", { equipment_id: e2.id, name: "p", face_x: 0.5, face_y: 0.5 })).id;
    const exit1 = await s.create("waypoints", { wp_type: "exit", datacenter_id: dc.id, dc_x: 0, dc_y: 0 });
    const exit2 = await s.create("waypoints", { wp_type: "exit", datacenter_id: dc2.id, dc_x: 0, dc_y: 0 });
    const paOut = await mkEqPort(3);   // pa porte déjà « patch » (1 câble/port) → port distinct pour le câble inter
    const outCable = await s.create("cables", { name: "inter", from_port_id: paOut, to_port_id: pc, waypoint_ids: [exit1.id, exit2.id] });
    ck(s.cableRoute(outCable).valid && s.cableRoute(outCable).hasExits, "câble inter-salles : route valide avec exits");
    const stubs = dv.outgoingCableStubs(dc.id);
    ck.eq(stubs.length, 1, "outgoingCableStubs : 1 câble sortant de la salle");
    ck(stubs[0].cable.id === outCable.id && stubs[0].pts.length >= 2 && stubs[0].pts.every((p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z)), "outgoingCableStubs : port → exit, points finis");
    ck.eq(dv.outgoingCableStubs(dc.id).length + dv.outgoingCableStubs(dc2.id).length, 2, "outgoingCableStubs : tracé dans CHAQUE salle traversée");
    // routes INTER-DC (multi-salles) : déléguées au service de routage `CableRouting` (réutilisé par le moteur WebGL).
    const mInter = new FloorLayout(s).multiLayout(dc, { visibleDcIds: new Set([dc.id, dc2.id]) });
    const inter = dv.routing.interDcRoutes(mInter, false);
    ck.eq(inter.length, 1, "routing.interDcRoutes : 1 route inter-salles");
    ck(inter[0].cable.id === outCable.id && inter[0].pts.length >= 2 && inter[0].pts.every((p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z)), "routing.interDcRoutes : port A → port B, points monde finis");
    // FAISCEAUX (trunks) : tracé uplink↔uplink dès la POSE des 2 patchs d'extrémité — parité complète câbles
    // (intra-salle · stub sortant · inter-DC monde · inter-DC plan d'étage), service TrunkRouting injecté.
    const patchA = await s.create("equipments", { name: "PA", type: "patch_panel", placement_mode: "rack", rack_id: rk.id, rack_u: 10 });
    const patchB = await s.create("equipments", { name: "PB", type: "patch_panel", placement_mode: "rack", rack_id: rk.id, rack_u: 12 });
    const patchC = await s.create("equipments", { name: "PC", type: "patch_panel", placement_mode: "rack", rack_id: rk2.id, rack_u: 10 });
    const patchPool = await s.create("equipments", { name: "PP", type: "patch_panel" });   // non placé
    const tIntra = await s.create("cableBundles", { name: "T-intra", endpoint_a_equipment_id: patchA.id, endpoint_b_equipment_id: patchB.id });
    const rts = dv.resolvedTrunks(dc.id);
    ck.eq(rts.length, 1, "resolvedTrunks : 1 trunk intra-salle (aucun brin pioché nécessaire)");
    ck(rts[0].bundle.id === tIntra.id && rts[0].pts.length === 2 && rts[0].pts.every((p) => isFinite(p.x) && isFinite(p.z)), "resolvedTrunks : uplink → uplink, points finis");
    await s.create("cableBundles", { name: "T-pool", endpoint_a_equipment_id: patchA.id, endpoint_b_equipment_id: patchPool.id });
    ck.eq(dv.resolvedTrunks(dc.id).length, 1, "extrémité NON posée → pas de tracé intra");
    ck.eq(dv.outgoingTrunkStubs(dc.id).length, 0, "extrémité non posée + pas de route → pas de stub");
    const tInter = await s.create("cableBundles", { name: "T-inter", endpoint_a_equipment_id: patchA.id, endpoint_b_equipment_id: patchC.id, waypoint_ids: [exit1.id, exit2.id] });
    const tStubs = dv.outgoingTrunkStubs(dc.id);
    ck.eq(tStubs.length, 1, "outgoingTrunkStubs : 1 trunk sortant → exit de la salle");
    ck(tStubs[0].bundle.id === tInter.id && tStubs[0].endpointRackId === rk.id && tStubs[0].pts.every((p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z)), "outgoingTrunkStubs : baie de l'uplink exposée + points finis");
    ck.eq(dv.outgoingTrunkStubs(dc2.id).length, 1, "outgoingTrunkStubs : tracé dans CHAQUE salle traversée");
    const interT = dv.trunks.interDcTrunks(mInter, false);
    ck.eq(interT.length, 1, "trunks.interDcTrunks : 1 faisceau inter-salles (monde)");
    ck(interT[0].bundle.id === tInter.id && interT[0].pts.length >= 2 && interT[0].pts.every((p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z)), "trunks.interDcTrunks : uplink A → uplink B, points monde finis");
    // route saisie « à l'envers » (extrémité A dans la salle d'ARRIVÉE de la route) → bouts inversés, tracé quand même
    await s.create("cableBundles", { name: "T-swap", endpoint_a_equipment_id: patchC.id, endpoint_b_equipment_id: patchB.id, waypoint_ids: [exit1.id, exit2.id] });
    ck.eq(dv.trunks.interDcTrunks(mInter, false).length, 2, "trunks.interDcTrunks : extrémités inversées vs sens de route → tolérées");
    /* ROUTE INCOHÉRENTE avec les extrémités (le cas de l'INCIDENT) : extrémités posées en DC et DC2, route
       qui SORT d'une TROISIÈME salle → plus AUCUN tracé, STUB COMPRIS. Avant, le verdict vivait dans le
       rendu : `interDcTrunks` ne traçait rien (déjà), mais `outgoingTrunkStubs` dessinait un demi-tracé
       dans la salle de l'extrémité qui matchait l'ARRIVÉE de la route — silencieusement. `bundleRoute`
       (source unique) invalide désormais la route entière ; le formulaire faisceau porte le message. */
    const dc3 = await s.create("datacenters", { name: "DC3" });
    const exit3 = await s.create("waypoints", { wp_type: "exit", datacenter_id: dc3.id, dc_x: 0, dc_y: 0 });
    const tBad = await s.create("cableBundles", { name: "T-incident", endpoint_a_equipment_id: patchA.id, endpoint_b_equipment_id: patchC.id, waypoint_ids: [exit3.id, exit2.id] });
    ck.eq(s.bundleRoute(tBad).sens, null, "bundleRoute : route DC3 → DC2 vs extrémités DC/DC2 → sens null (endpoint_route_mismatch)");
    ck.eq(dv.trunks.interDcTrunks(mInter, false).filter((t) => t.bundle.id === tBad.id).length, 0, "interDcTrunks : faisceau incohérent NON tracé");
    ck.eq(dv.outgoingTrunkStubs(dc2.id).filter((t) => t.bundle.id === tBad.id).length, 0, "outgoingTrunkStubs : plus de demi-tracé dans la salle de l'extrémité qui matchait l'arrivée");
    // plan d'ÉTAGE : mêmes faisceaux inter-DC en coordonnées plan (projection injectée par la vue)
    {
      const flLayout = new FloorLayout(s);
      const cfg = flLayout.config("", "");
      const onFloor = new Map(); s.dcsOfFloor("", "").forEach((d) => onFloor.set(d.id, d));
      const planOf = (d, p) => FloorLayout.roomLocalToPlan(d, flLayout.roomPos(d, cfg), p);
      // L'étage DESSINÉ est passé en conteneur : c'est la portée des extrémités posées à même l'étage (D3).
      const flT = dv.trunks.interDcTrunksFloor(onFloor, cfg, PlacementContainers.floorOf("", ""), planOf);
      ck.eq(flT.length, 2, "trunks.interDcTrunksFloor : faisceaux inter-DC de l'étage (coords plan)");
      ck(flT.every((rt) => rt.pts.length >= 2 && rt.pts.every((p) => isFinite(p.x) && isFinite(p.y))), "trunks.interDcTrunksFloor : points plan finis");
      /* PLAN D'ÉTAGE 2D : un câble baie → POSÉ D'ÉTAGE y est tracé lui aussi (doctrine §6.31, D3). La vue
         DESSINE déjà les posés d'étage (`floorEquipNode2D`) ; il eût été incohérent d'y montrer l'objet
         sans son câble. Le bout d'étage est résolu en coordonnées PLAN — la transformée étage → monde
         n'étant qu'une translation, c'est le MÊME résolveur qui sert, avec une autre origine. */
      const feq = await s.create("equipments", { name: "posé-étage", placement_mode: "floor", location: "", floor: "", floor_x: 1500, floor_y: 1500, width_mm: 400, height_mm: 300, depth_mm: 200 });
      const pfeq = (await s.create("ports", { equipment_id: feq.id, name: "pfe", face_x: 0.5, face_y: 0.5, face_side: "front" })).id;
      const pinEtage = await s.create("waypoints", { name: "gaine-plan", wp_type: "oob", location: "", floor: "", floor_x: 1200, floor_y: 1200 });
      const paFloor = await mkEqPort(5);   // U (et donc NOM) libre : « e4 » sert plus bas au brouillon de câble
      await s.create("cables", { name: "vers-posé", from_port_id: paFloor, to_port_id: pfeq, waypoint_ids: [exit1.id, pinEtage.id] });
      const flCables = dv.interDcRoutesFloor("", "", cfg);
      ck(flCables.some((rc) => rc.cable.name === "vers-posé"), "interDcRoutesFloor : le câble baie → posé d'étage est tracé sur le PLAN D'ÉTAGE");
      const rcPose = flCables.find((rc) => rc.cable.name === "vers-posé");
      ck(rcPose.pts.length >= 3 && rcPose.pts.every((p) => isFinite(p.x) && isFinite(p.y)), "…port → exit → pin d'étage → posé, points plan finis");
      // ÉQUIVALENCE : le dernier point vaut le port résolu depuis la position PLAN du posé (deux mesures).
      const posPlan = FloorLayout.floorEquipPos(s.get("equipments", feq.id), cfg);
      const attenduPlan = dv.resolver.resolvePortWorld3D(pfeq, posPlan.x, posPlan.y, 0);
      const finPlan = rcPose.pts[rcPose.pts.length - 1];
      ck(finPlan.x === attenduPlan.x && finPlan.y === attenduPlan.y, "…et il finit EXACTEMENT sur le port du posé, en coordonnées plan");
    }
    // visibilité : MÊME modèle que les câbles (« Tout afficher » + sélection partagée selCables)
    dv.showAllCables = false;
    ck.eq(dv.resolvedTrunks(dc.id).filter((rt) => dv.trunkShown(rt)).length, 0, "trunkShown : tout masqué quand showAllCables=false et sélection vide");
    dv.selCables.add(tIntra.id);
    ck.eq(dv.resolvedTrunks(dc.id).filter((rt) => dv.trunkShown(rt)).length, 1, "trunkShown : trunk sélectionné visible (Afficher/Isoler)");
    dv.showAllCables = true; dv.selCables.clear();

    // route builder : départ port A → waypoint → port B → ouvre le form câble prérempli. Machine d'état = RouteTool
    // (on pose l'état directement : arm/start émettent un toast → besoin du DOM, absent ici). L'état vit DANS l'outil.
    let routed = null;
    const dvr = new DatacenterView(s, {}, { openCableForm: (id, opts) => { routed = { id, opts }; } });
    dvr.routeTool.state = { fromPortId: pa, wpIds: [] };
    dvr.routeTool.addWp(exit1.id); ck.eq(JSON.stringify(dvr.routeTool.state.wpIds), JSON.stringify([exit1.id]), "RouteTool.addWp : waypoint ajouté");
    dvr.routeTool.finish(pc);
    ck(routed && routed.id === null && routed.opts.fromPortId === pa && routed.opts.toPortId === pc && JSON.stringify(routed.opts.waypointIds) === JSON.stringify([exit1.id]), "RouteTool.finish → openCableForm prérempli (from/to/waypoints)");
    ck.eq(dvr.routeTool.state, null, "RouteTool.finish : session terminée");
    // brouillons-candidats : un câble draft à un seul bout est proposé pour un port compatible
    const pDraft = await mkEqPort(4);   // port libre distinct pour le brouillon (pa porte déjà « patch »)
    const draft = await s.create("cables", { name: "brouillon", from_port_id: pDraft, to_port_id: null, status: "brouillon" });
    const cands = s.cableDraftCandidatesForPort(pb);
    ck(cands.some((c) => c.id === draft.id), "cableDraftCandidatesForPort : draft à un bout proposé");
    ck(!s.cableDraftCandidatesForPort(pDraft).some((c) => c.id === draft.id), "cableDraftCandidatesForPort : pas le port déjà branché");
    // vue Dessus : aimantation au centre de maille + demi-emprise selon l'orientation
    ck.eq(dv.snap(610, 600), 900, "snap → centre de maille (610 → 900)");
    ck.eq(dv.snap(290, 600), 300, "snap → centre de maille (290 → 300)");
    // vue Étage : aimantation au BORD de maille (coin de salle) + résolution de l'étage cible
    ck.eq(dv.snapEdge(610, 600), 600, "snapEdge → bord de maille (610 → 600)");
    ck.eq(dv.snapEdge(910, 600), 1200, "snapEdge → bord de maille (910 → 1200)");
    const dcLoc = await s.create("datacenters", { name: "L1", location: "liege", floor: "2" });
    dv.dcId = dcLoc.id; dv.floorTarget = null;
    ck.eq(JSON.stringify(dv.floorTargetResolve()), JSON.stringify({ location: "liege", floor: "2" }), "floorTargetResolve → étage de la salle active");
    dv.floorTarget = { location: "herstal", floor: "0" };
    ck.eq(dv.floorTargetResolve().location, "herstal", "floorTargetResolve → cible explicite prioritaire");
    dv.floorTarget = null; dv.dcId = dc.id;
    // brosse de brassage : waypoint kind "brush" ancré à la baie → occupe ses U (bloque les emplacements libres)
    await s.create("waypoints", { wp_type: "datacenter", kind: "brush", datacenter_id: dc.id, rack_id: rk.id, rack_u: 20, u_height: 2 });
    const scn = new RackScene(s); const occB = scn.occupants(rk.id);
    ck(occB.has("20:front") && occB.has("21:front"), "brosse : occupe ses U (20–21 front)");
    ck.eq(scn.occupants(rk.id, { exceptBrushId: s.all("waypoints").find((w) => w.kind === "brush").id }).has("20:front"), false, "brosse : exclue via exceptBrushId");
    // baie DOUBLE : la brosse est ancrée au plan de montage AVANT et n'occupe QUE cette face — l'assertion
    // sur `rk` (simple face) ne prouverait rien, l'arrière y est libre par construction.
    const rkDual = await s.create("racks", { name: "R-dual", u_count: 42, sides: "dual", datacenter_id: dc.id });
    await s.create("waypoints", { wp_type: "datacenter", kind: "brush", datacenter_id: dc.id, rack_id: rkDual.id, rack_u: 20, u_height: 2 });
    const occD = scn.occupants(rkDual.id);
    ck(occD.has("20:front") && occD.has("21:front"), "brosse (baie double) : occupe ses U côté AVANT");
    ck.eq(occD.has("20:rear"), false, "brosse : la face ARRIÈRE reste libre — profondeur gérée par V6d");
    ck.eq(occD.get("20:front").depth_mm, 100, "brosse : depth_mm exposé à la grille U (« 100 mm », plus « Full-depth »)");
    ck.eq(JSON.stringify(dv.rackHalfExtents({ width_mm: 600, depth: 1000, orientation: 0 })), JSON.stringify({ hx: 300, hy: 500 }), "rackHalfExtents 0° → (w/2, d/2)");
    ck.eq(JSON.stringify(dv.rackHalfExtents({ width_mm: 600, depth: 1000, orientation: 90 })), JSON.stringify({ hx: 500, hy: 300 }), "rackHalfExtents 90° → (d/2, w/2)");
    // visibilité câble (panneaux de contrôle). NB : `matchSearch`/`searchTerm` ont été RETIRÉS avec le
    // champ de recherche de la toolbar (2026-08-13) — la localisation passe par la recherche GLOBALE Ctrl+K.
    dv.showAllCables = true; ck(dv.cableShown({ cable: { id: "x" } }) === true, "cableShown : tout affiché → vrai");
    dv.showAllCables = false; ck(dv.cableShown({ cable: { id: "x" } }) === false, "cableShown : non sélectionné → faux");
    dv.selCables = new Set(["x"]); ck(dv.cableShown({ cable: { id: "x" } }) === true, "cableShown : sélectionné → vrai");
    // NB : coloration d'équipement (eqFill), largeur de vue (camViewWidthM) et éclairs power (cableIsPower) étaient
    // des helpers du moteur 3D SVG retiré — ils vivent désormais dans le moteur WebGL (occColor / updateScreenScales).
  }
  });

  await section("MeasureTool : machine d'état de la mesure (via hôte injecté — testable en isolation)", async () => {
  {
    const host = {
      render: () => {}, buildToolbar: () => {}, showCote: () => {}, hideCote: () => {},
      viewKind: () => "top", isMultiDc: () => false, currentDc: () => ({ id: "DC1" }),
      floorTargetResolve: () => null, scaleOrNull: () => 1, hasSvg: () => true,
      clientToWorld: (x, y) => ({ x, y }), overlayRoot: () => null, dotScale: () => 1,
      isFloorTransformed: () => false, applyUprightText: () => {}, three: () => null,
      btn: () => ({}), disarmPositioning: () => {}, clearRoute: () => {}, refreshSide: () => {},
    };
    const tool = new MeasureTool(host);
    ck.eq(tool.hasActive(), false, "MeasureTool : inactif au départ");
    ck.eq(tool.ctxKey(), "room:DC1", "ctxKey : salle courante (top mono)");
    // on arme l'ÉTAT à la main (arm() passe par Notify.toast → DOM, hors périmètre de ce test unitaire)
    tool.state = { active: true, ctx: tool.ctxKey(), pts: [], cursor: null, done: [] };
    ck.eq(tool.hasActive() && tool.activeHere(), true, "état actif dans le contexte courant");
    ck.eq(tool.state.ctx, "room:DC1", "contexte capturé");
    tool.placeAt(100, 200); tool.placeAt(400, 600);
    ck.eq(tool.state.pts.length, 2, "placeAt : 2 points posés (2D, sol z=0)");
    ck.eq(tool.state.pts[0].z, 0, "placeAt : point au niveau du sol (z=0)");
    tool.commit();
    ck.eq(tool.state.done.length === 1 && tool.state.pts.length === 0, true, "commit : mesure archivée, points en cours vidés");
    tool.placeAt(10, 10); tool.placeAt(20, 20); tool.undo();
    ck.eq(tool.state.pts.length, 1, "undo : retire le dernier point");
    tool.clearAll();
    ck.eq(tool.state.pts.length === 0 && tool.state.done.length === 0, true, "clearAll : tout effacé");
    host.currentDc = () => ({ id: "DC2" });   // le contexte de vue change → la mesure (figée sur DC1) n'est plus « ici »
    ck.eq(tool.activeHere(), false, "activeHere : false si le contexte a changé");
    tool.cancel();
    ck.eq(tool.hasActive(), false, "cancel : outil désarmé");
  }
  });

  await section("RouteTool : machine d'état du routage (back/cancel, via hôte injecté)", async () => {
  {
    const host = { render: () => {}, svgEl: () => null, currentDc: () => null, openCableForm: () => {}, disarmPositioning: () => {}, three: () => null, btn: () => ({}), portShort: () => "" };
    const tool = new RouteTool(host, {}, {});   // store/resolver non sollicités par back/cancel
    ck.eq(tool.active, false, "RouteTool : inactif au départ");
    tool.state = { fromPortId: "P1", wpIds: ["w1", "w2"] };   // départ + 2 waypoints (pont d'accès de la vue)
    ck.eq(tool.active && tool.started, true, "démarré (port + waypoints)");
    tool.back(); ck.eq(JSON.stringify(tool.state.wpIds), JSON.stringify(["w1"]), "back : retire le dernier waypoint");
    tool.back(); ck.eq(tool.state.wpIds.length, 0, "back : retire le 2e waypoint");
    tool.back(); ck.eq(tool.state.fromPortId, null, "back : plus de waypoint → efface le port de départ (retour armement)");
    ck.eq(tool.started, false, "après back complet : plus démarré (encore armé)");
    tool.cancel(); ck.eq(tool.active, false, "cancel : outil désarmé");
  }
  });

  await section("Doors : domaine des portes de salle (valeurs canoniques, libellés, défauts, règles pures)", async () => {
  {
    ck.eq(Doors.wallLabel("top"), "avant", "wallLabel(top) = avant");
    ck.eq(Doors.wallLabel("bottom"), "arrière", "wallLabel(bottom) = arrière");
    ck.eq(Doors.wallLabel("inconnu"), "inconnu", "wallLabel : mur inconnu → renvoyé tel quel");
    ck.eq(Doors.isVerticalWall("left"), true, "isVerticalWall(left) = true");
    ck.eq(Doors.isVerticalWall("top"), false, "isVerticalWall(top) = false");
    ck.eq(Doors.freeWidth({ width_mm: 900, frame_mm: 40 }), 820, "freeWidth = width − 2·frame");
    ck.eq(Doors.freeWidth({ width_mm: 60, frame_mm: 40 }), 0, "freeWidth borné à 0 (listel > demi-largeur)");
    ck.eq(Doors.toggleHinge("left"), "right", "toggleHinge(left) = right");
    ck.eq(Doors.toggleOpening("interior"), "exterior", "toggleOpening(interior) = exterior");
    // defaults : porte centrée le long du mur, dimensions par défaut, SANS id
    const def = Doors.defaults("top", 6000);
    ck.eq(def.offset, 3000, "defaults : offset centré (wallLen/2)");
    ck.eq(def.width_mm, DOOR_DEFAULT_WIDTH_MM, "defaults : largeur par défaut");
    ck.eq(def.hinge, "left", "defaults : charnière gauche");
    ck.eq("id" in def, false, "defaults : SANS id (ajouté par l'appelant)");
    ck.eq(DOOR_WALLS.length, 4, "DOOR_WALLS : 4 murs");
  }
  });

  await section("DoorTool : contrôleur des portes (CRUD + menu, via hôte injecté — testable en isolation)", async () => {
  {
    let saved = null;
    const host = { persistDoors: async (dcId, doors) => { saved = { dcId, doors }; }, openDoorForm: () => {}, toggleRoomDoors: () => {} };
    const tool = new DoorTool(host);
    // add : porte par défaut centrée, persistée sur la salle
    const dc = { id: "DC1", width_mm: 6000, depth_mm: 4000, doors: [] };
    const id = await tool.add(dc, "top");
    ck(saved && saved.dcId === "DC1" && saved.doors.length === 1, "DoorTool.add : porte persistée sur la salle");
    ck.eq(saved.doors[0].offset, 3000, "DoorTool.add : offset centré (width/2)");
    ck.eq(saved.doors[0].wall, "top", "DoorTool.add : mur demandé");
    ck(typeof id === "string" && !!id, "DoorTool.add : renvoie l'id de la porte");
    // mur vertical → centré sur la profondeur
    await tool.add({ id: "DC1", width_mm: 6000, depth_mm: 4000, doors: [] }, "left");
    ck.eq(saved.doors[0].offset, 2000, "DoorTool.add : mur vertical → offset = depth/2");
    // update : patch partiel sur la BONNE porte, les autres inchangées
    const dc2 = { id: "DC1", doors: [{ id: "d1", wall: "top", hinge: "left" }, { id: "d2", wall: "left", hinge: "left" }] };
    await tool.update(dc2, "d1", { hinge: "right" });
    ck.eq(saved.doors.find((d) => d.id === "d1").hinge, "right", "DoorTool.update : patch sur la bonne porte");
    ck.eq(saved.doors.find((d) => d.id === "d2").hinge, "left", "DoorTool.update : autres portes inchangées");
    // remove
    await tool.remove(dc2, "d1");
    ck(saved.doors.length === 1 && saved.doors[0].id === "d2", "DoorTool.remove : porte retirée");
    // ctx : menu (passage libre dans l'en-tête + 6 actions en simple, 5 en double — charnière masquée)
    // 6 = modifier / vantaux / charnière / ouverture / masquer portes de salle / supprimer.
    const sections = tool.ctx(dc2, { id: "d2", width_mm: 900, frame_mm: 40, hinge: "left", opening: "interior" });
    ck(sections[0].head.indexOf("820") >= 0, "DoorTool.ctx : en-tête montre le passage libre (820 mm)");
    ck.eq(sections[0].items.length, 6, "DoorTool.ctx : 6 actions (modifier/vantaux/charnière/ouverture/masquer/supprimer)");
    ck(sections[0].items.some((it) => it.label.indexOf("Masquer les portes de salle") >= 0), "DoorTool.ctx : item « Masquer les portes de salle »");
    const sectionsDbl = tool.ctx(dc2, { id: "d2", width_mm: 900, frame_mm: 40, hinge: "left", leaves: 2, opening: "interior" });
    ck.eq(sectionsDbl[0].items.length, 5, "DoorTool.ctx double battant : charnière masquée (5 actions)");
    ck(sectionsDbl[0].head.indexOf("double battant") >= 0, "DoorTool.ctx double battant : signalé dans l'en-tête");
    ck(sectionsDbl[0].items.some((it) => it.label.indexOf("simple") >= 0), "DoorTool.ctx double : bascule → simple proposée");
    // posEntries : entités déplaçables contraintes à leur mur (emprise le long = w/2, ⟂ fine ; commit = offset seul)
    const dc3 = { id: "DC1", width_mm: 6000, depth_mm: 4000, doors: [
      { id: "dt", wall: "top", offset: 2000, width_mm: 900, frame_mm: 40 },
      { id: "dl", wall: "left", offset: 1000, width_mm: 800, frame_mm: 40 },
    ] };
    const entries = tool.posEntries(dc3);
    ck.eq(entries.length, 2, "posEntries : une entrée par porte");
    const et = entries.find((e) => e.id === "dt");
    ck(et.rect.cy === 0 && Math.abs(et.rect.cx - 2000) < 1, "posEntries : mur haut → cy=0, cx=offset");
    ck(et.rect.hx === 450 && et.rect.hy === 30, "posEntries : mur haut → emprise le long = w/2, ⟂ fine (30)");
    const el = entries.find((e) => e.id === "dl");
    ck(el.rect.cx === 0 && Math.abs(el.rect.cy - 1000) < 1, "posEntries : mur gauche → cx=0, cy=offset");
    ck(el.rect.hx === 30 && el.rect.hy === 400, "posEntries : mur gauche → emprise le long = w/2 en y");
    await et.commit(2500, 999);   // mur horizontal → n'écrit que l'offset = nx (coord ⟂ ignorée), borné
    ck.eq(saved.doors.find((d) => d.id === "dt").offset, 2500, "posEntries.commit : mur haut → offset = nx (⟂ ignorée)");
  }
  });

  await section("ImageStore : helpers purs (dataUrl ↔ Blob · bundle .nmfb)", async () => {
  {
    const blob = ImageStore.dataUrlToBlob("data:text/plain;base64," + Buffer.from("hi").toString("base64"));
    ck(blob && blob.size === 2 && blob.type === "text/plain", "dataUrlToBlob → Blob (2 octets, type)");
    ck.eq(ImageStore.dataUrlToBlob("pas-une-data-url"), null, "dataUrlToBlob(invalide) → null");
    // round-trip bundle .nmfb (manifeste + blobs concaténés)
    const recs = [{ id: "a", name: "img", u_height: 2, face: "rear", description: "d", type: "image/png", blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) }];
    const buf = await ImageStore.buildBundle(recs, "K1").arrayBuffer();
    const parsed = ImageStore.parseBundle(buf);
    ck(parsed.key === "K1" && parsed.recs.length === 1 && parsed.recs[0].id === "a" && parsed.recs[0].u_height === 2 && parsed.recs[0].face === "rear", "parseBundle → manifeste restauré");
    const pb = new Uint8Array(await parsed.recs[0].blob.arrayBuffer());
    ck(pb.length === 3 && pb[0] === 1 && pb[2] === 3, "parseBundle → blob d'image restauré (3 octets)");
    let threw = false; try { ImageStore.parseBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer); } catch (_) { threw = true; }
    ck(threw, "parseBundle : signature NMFB invalide → exception");
  }
  });

  await section("ImageStore : import/export EXPLICITE de la bibliothèque (.nmfb)", async () => {
  {
    // Stubs navigateur manquants pour exercer les méthodes d'INSTANCE (miroir → objectURL) hors navigateur.
    global.URL = global.URL || {};
    global.URL.createObjectURL = () => "blob:stub"; global.URL.revokeObjectURL = () => {};
    // Backend mémoire (remplace IndexedDB/REST) : Map id → ImageRec (blob conservé).
    const mkMemBackend = () => { const m = new Map(); return {
      put: async (rec) => { m.set(rec.id, rec); },
      del: async (id) => { m.delete(id); },
      getRaw: async (id) => m.get(id) || null,
      getAll: async () => Array.from(m.values()),
      clear: async () => { m.clear(); },
      _map: m,
    }; };
    const backend = mkMemBackend();
    const store = new ImageStore({ backend });
    // état de départ : une image "old" en bibliothèque
    await store.add({ id: "old", name: "ancienne", u_height: 1, face: "front", blob: new Blob([new Uint8Array([9])], { type: "image/png" }) });
    ck(store.has("old") && store.count() === 1, "pré-import : bibliothèque contient « old »");

    // bundle importé : 2 images aux ids "x"/"y" (issu d'un AUTRE document)
    const bundleRecs = [
      { id: "x", name: "x", u_height: 2, face: "rear", description: "", type: "image/png", blob: new Blob([new Uint8Array([1, 2])], { type: "image/png" }) },
      { id: "y", name: "y", u_height: 1, face: "front", description: "", type: "image/jpeg", blob: new Blob([new Uint8Array([7, 7, 7])], { type: "image/jpeg" }) },
    ];
    const bundle = ImageStore.buildBundle(bundleRecs, "OTHER");
    const n = await store.importBundle(bundle);
    ck.eq(n, 2, "importBundle → nombre d'images importées");
    ck(!store.has("old"), "import ÉCRASE : « old » a disparu (références orphelines → ré-assignation)");
    ck(store.has("x") && store.has("y"), "import : ids CONSERVÉS (x, y présents)");
    ck.eq(store.get("x").u_height, 2, "import : métadonnées conservées (u_height de x)");
    ck.eq(backend._map.size, 2, "import : backend remplacé (2 enregistrements)");
    ck(store.lastLoadedKey == null, "importBundle NE touche PAS la clé d'appariement du compagnon");

    // round-trip : ré-export → reparse rend les mêmes ids/blobs (blobs déjà présents → pas de fetch)
    const out = await store.serializeBundle("RT");
    const reparsed = ImageStore.parseBundle(await out.arrayBuffer());
    const ids = reparsed.recs.map((r) => r.id).sort();
    ck(reparsed.key === "RT" && ids.join(",") === "x,y", "serializeBundle → round-trip (clé + ids)");
    const yblob = new Uint8Array(await reparsed.recs.find((r) => r.id === "y").blob.arrayBuffer());
    ck(yblob.length === 3 && yblob[0] === 7, "serializeBundle → blobs hydratés dans le bundle");
  }
  });

  await section("Images de façade : oreilles (with_ears) + règle « autre »", async () => {
  {
    // ---- modèle FaceImage ----
    ck(new FaceImage({ face: "front" }).with_ears === true, "FaceImage : défaut = avec oreilles (front)");
    ck(new FaceImage({ face: "rear" }).with_ears === false, "FaceImage : défaut = SANS oreilles (rear)");
    ck(new FaceImage({ face: "rear", with_ears: true }).with_ears === false, "FaceImage : arrière TOUJOURS sans oreilles (même si with_ears=true)");
    ck(new FaceImage({ face: "front", with_ears: false }).with_ears === false, "FaceImage : with_ears=false respecté (front)");
    const autre = new FaceImage({ face: "autre", u_height: 5, with_ears: true });
    ck(autre.u_height === 1 && autre.with_ears === false, "FaceImage : « autre » → pas de U (1) ni d'oreilles");

    // ---- bundle .nmfb : with_ears round-trip + normalisation « autre » au parse ----
    const recs = [
      { id: "a", name: "a", u_height: 2, face: "front", with_ears: false, type: "image/png", blob: new Blob([new Uint8Array([1])], { type: "image/png" }) },
      { id: "b", name: "b", u_height: 7, face: "autre", with_ears: true, type: "image/png", blob: new Blob([new Uint8Array([2])], { type: "image/png" }) },
    ];
    const parsed = ImageStore.parseBundle(await ImageStore.buildBundle(recs, null).arrayBuffer());
    const a = parsed.recs.find((r) => r.id === "a"), b = parsed.recs.find((r) => r.id === "b");
    ck(a.with_ears === false, "bundle : with_ears=false conservé (front)");
    ck(b.with_ears === false && b.u_height === 1, "bundle : « autre » normalisé (pas d'oreilles, U=1)");

    // ---- normaliseur d'INSTANCE (ImageStore.norm via add/update) ----
    global.URL = global.URL || {}; global.URL.createObjectURL = () => "blob:stub"; global.URL.revokeObjectURL = () => {};
    const m = new Map();
    const store = new ImageStore({ backend: {
      put: async (r) => { m.set(r.id, r); }, del: async (id) => { m.delete(id); },
      getRaw: async (id) => m.get(id) || null, getAll: async () => Array.from(m.values()), clear: async () => { m.clear(); },
    } });
    const f1 = await store.add({ id: "f1", name: "f", face: "front", u_height: 3, blob: new Blob([new Uint8Array([9])], { type: "image/png" }) });
    ck(f1.with_ears === true && f1.u_height === 3, "ImageStore.add : front → avec oreilles, U conservé");
    const f3 = await store.add({ id: "f3", name: "r", face: "rear", u_height: 2, with_ears: true, blob: new Blob([new Uint8Array([5])], { type: "image/png" }) });
    ck(f3.with_ears === false, "ImageStore.add : arrière → oreilles forcées à false (même si with_ears=true)");
    const f2 = await store.add({ id: "f2", name: "g", face: "autre", u_height: 4, with_ears: true, blob: new Blob([new Uint8Array([8])], { type: "image/png" }) });
    ck(f2.with_ears === false && f2.u_height === 1, "ImageStore.add : « autre » → pas d'oreilles, U=1");
    const f1b = await store.update("f1", { with_ears: false });
    ck(f1b.with_ears === false, "ImageStore.update : with_ears modifiable");
  }
  });

  await section("UndoTimeline : timeline d'undo unifiée (piles simulées)", async () => {
  {
    // Logique extraite de main.ts/boot (où elle était intestable) : deux piles, jetons chronologiques, plafond.
    const { UndoTimeline } = D("app/UndoTimeline.js");
    const mkStack = () => { const s = { u: 0, r: 0, canUndo: () => s.u > 0, canRedo: () => s.r > 0, undo: () => { s.u--; s.r++; }, redo: () => { s.r--; s.u++; } }; return s; };
    const model = mkStack(), image = mkStack();
    const t = new UndoTimeline();
    t.register("model", model); t.register("image", image);
    let changes = 0; t.onChange = () => { changes++; };
    model.u++; t.note("model"); image.u++; t.note("image"); model.u++; t.note("model");   // chronologie : M, I, M
    ck.eq(changes, 3, "onChange notifié à chaque note()");
    await t.undo(); ck.eq(model.u, 1, "undo 1 → dernière action (modèle) défaite");
    await t.undo(); ck.eq(image.u, 0, "undo 2 → image défaite (ordre chronologique inverse)");
    ck.eq(t.redoDepth, 2, "redoDepth suit les undos");
    await t.redo(); ck.eq(image.u, 1, "redo → image rétablie");
    model.u++; t.note("model");
    ck.eq(t.redoDepth, 0, "toute NOUVELLE action vide le redo unifié");
    // jeton dont la pile est épuisée (plafond côté pile) → sauté sans casser la timeline
    const t2 = new UndoTimeline(), m2 = mkStack(), i2 = mkStack();
    t2.register("model", m2); t2.register("image", i2);
    t2.note("model");   // jeton SANS undo réel (pile déjà épuisée)
    i2.u++; t2.note("image");
    ck.eq(await t2.undo(), true, "pile réelle défaite malgré le jeton fantôme en dessous");
    ck.eq(i2.u, 0, "…et c'est bien l'image qui a été défaite");
    ck.eq(await t2.undo(), false, "jeton épuisé sauté, plus rien à défaire → false");
    // filet de sécurité : timeline désynchronisée (vide) mais une pile encore dépilable
    const t3 = new UndoTimeline(), m3 = mkStack(); m3.u = 1;
    t3.register("model", m3);
    ck.eq(await t3.undo(), true, "filet : timeline vide mais pile dépilable → undo quand même");
    ck.eq(m3.u, 0, "…le filet a bien dépilé le modèle");
  }
  });

  await section("ShellNav : rattachement historique et résolution de hash (menu à deux niveaux)", async () => {
  {
    /* Ce qui reste de `ShellNav` après le re-design du menu (2026-08-20, cf. docs/navigation.md) : la
       STRUCTURE du menu est passée à `app/NavModel` (domaines ▸ vues, testée par test-nav-model.js), et
       avec elle ont disparu `ancestorGroup` et `responsiveMenu` — le mécanisme de GROUPE déroulant et le
       menu responsive APLATI n'existent plus (le tiroir à accordéons les remplace). Subsistent ici les
       trois helpers que le Shell appelle encore.

       Carte représentative : un ancien primaire + sa sous-vue, et un DOMAINE (« parametres ») avec une
       vue qui lui est rattachée par `NAV_DOMAINS` — donc SANS `parent` (le groupe n'existe plus, un
       `parent` pointant vers lui serait une référence pendante ; cf. la déclaration de `contacts`). */
    const lookup = {
      equipements: { kind: "primary" },
      groupes: { parent: "equipements", kind: "secondary" },
      parametres: { kind: "domain" },
      contacts: { kind: "secondary" },
    };

    // ---- activeTab : rattachement HISTORIQUE (repli du Shell quand une vue n'a pas de domaine visible) ----
    ck.eq(ShellNav.activeTab({ name: "equipements" }), "equipements", "activeTab : vue sans parent → elle-même");
    ck.eq(ShellNav.activeTab({ name: "groupes", parent: "equipements" }), "equipements", "activeTab : sous-vue → sa vue parente");
    ck.eq(ShellNav.activeTab({ name: "contacts" }), "contacts", "activeTab : vue rattachée par NAV_DOMAINS (aucun parent) → elle-même");

    // ---- navigabilité / résolution de hash (piège ① : domaine sans hash · piège ⑤ : sous-vue bookmarkable) ----
    ck.eq(ShellNav.isNavigable("contacts", lookup), true, "isNavigable : sous-vue → oui");
    ck.eq(ShellNav.isNavigable("parametres", lookup), false, "isNavigable : DOMAINE → non (il ne navigue jamais — piège ①)");
    ck.eq(ShellNav.isNavigable("inconnu", lookup), false, "isNavigable : nom inconnu → non");
    ck.eq(ShellNav.resolveHash("#contacts", lookup), "contacts", "resolveHash : #contacts → sous-page (bookmarkable — piège ⑤)");
    ck.eq(ShellNav.resolveHash("#parametres", lookup), null, "🚨 resolveHash : #<domaine> → null (un domaine n'a PAS de hash — piège ①)");
    ck.eq(ShellNav.resolveHash("#groupes", lookup), "groupes", "resolveHash : une sous-vue garde son deep-link INCHANGÉ (contrainte dure du re-design)");
    ck.eq(ShellNav.resolveHash("contacts", lookup), "contacts", "resolveHash : tolère l'absence de # de tête");
    ck.eq(ShellNav.resolveHash("", lookup), null, "resolveHash : hash vide → null");

    // ---- les helpers du mécanisme de GROUPE ont bien DISPARU (pas seulement cessé d'être appelés) ----
    ck.eq(typeof ShellNav.ancestorGroup, "undefined", "ancestorGroup RETIRÉ avec le mécanisme de groupe déroulant");
    ck.eq(typeof ShellNav.responsiveMenu, "undefined", "responsiveMenu RETIRÉ avec le menu responsive aplati (→ tiroir à accordéons)");
  }
  });

  await section("AutoSave : mécanique d'auto-save (hôte simulé, battement testé directement)", async () => {
  {
    const { AutoSave } = D("app/AutoSave.js");
    const mkHost = (over = {}) => {
      const h = {
        writes: 0, notices: [], states: [],
        fsApi: true, file: true, isDirty: true, perm: true,
        hasFsApi() { return h.fsApi; }, hasFile() { return h.file; }, dirty() { return h.isDirty; },
        ensureWritePermission: async () => h.perm,
        write: async () => { h.writes++; },
        pickFile: async () => {}, confirmEnable: async () => true,
        onStateChange: (on, i, s) => { h.states.push([on, i, s]); },
        notify: (m, k) => { h.notices.push([m, k]); },
      };
      return Object.assign(h, over);
    };
    // battement nominal : modifié + fichier lié → écrit
    const h1 = mkHost(); const a1 = new AutoSave({ autosave: true, autosaveInterval: 60 }, h1);
    await a1.tick(); ck.eq(h1.writes, 1, "tick : modifié + fichier → écrit");
    h1.isDirty = false; await a1.tick(); ck.eq(h1.writes, 1, "tick : propre → n'écrit PAS");
    // permission révoquée : désactive + notifie, n'écrit pas
    const p2 = { autosave: true, autosaveInterval: 60 };
    const h2 = mkHost({ perm: false }); const a2 = new AutoSave(p2, h2);
    await a2.tick();
    ck(h2.writes === 0 && p2.autosave === false, "tick : permission révoquée → désactivé, rien d'écrit");
    ck(h2.notices.some((n) => /permission/.test(n[0])), "tick : permission révoquée → notifié");
    a2.dispose();
    // activation sans FS API → refus notifié, préférence inchangée
    const p3 = { autosave: false, autosaveInterval: 30 };
    const h3 = mkHost({ fsApi: false }); const a3 = new AutoSave(p3, h3);
    await a3.setEnabled(true);
    ck(p3.autosave === false && h3.notices.some((n) => n[1] === "err"), "setEnabled(on) sans FS API → refusé + notifié");
    // activation sans fichier : dialogue accepté mais « Enregistrer sous » annulé → refus silencieux
    const p4 = { autosave: false, autosaveInterval: 30 };
    const h4 = mkHost({ file: false }); const a4 = new AutoSave(p4, h4);
    await a4.setEnabled(true);
    ck(p4.autosave === false && h4.states.length > 0 && h4.states[h4.states.length - 1][0] === false, "setEnabled(on) : « Enregistrer sous » annulé → chrome repassé à off");
    // désactivation
    const p5 = { autosave: true, autosaveInterval: 30 };
    const a5 = new AutoSave(p5, mkHost()); await a5.setEnabled(false); a5.dispose();
    ck.eq(p5.autosave, false, "setEnabled(off) → préférence coupée");
    // statut lisible
    ck(/File System Access/.test(new AutoSave(p5, mkHost({ fsApi: false })).statusHtml()), "statusHtml : navigateur sans FS API");
    ck(/off/.test(new AutoSave({ autosave: false, autosaveInterval: 30 }, mkHost()).statusHtml()), "statusHtml : off");
    ck(/actif/.test(new AutoSave({ autosave: true, autosaveInterval: 30 }, mkHost()).statusHtml()), "statusHtml : actif + intervalle");
  }
  });

  await section("CableRouteAnalyzer : grammaire de route EN ISOLATION (hôte RouteStoreView simulé)", async () => {
  {
    // L'automate est déjà couvert de bout en bout via le Store (qui délègue) ; ici on prouve la TESTABILITÉ
    // EN ISOLATION apportée par l'extraction : un hôte minimal simulé suffit, sans Store ni adapter.
    const { CableRouteAnalyzer } = D("store/CableRouteAnalyzer.js");
    const data = {
      waypoints: {
        w1: { id: "w1", name: "WP1", kind: "point", wp_type: "datacenter", datacenter_id: "dc1", dc_x: 1, dc_y: 1 },
        x1: { id: "x1", name: "X1", kind: "point", wp_type: "exit", datacenter_id: "dc1", dc_x: 2, dc_y: 2 },
        x2: { id: "x2", name: "X2", kind: "point", wp_type: "exit", datacenter_id: "dc2", dc_x: 3, dc_y: 3 },
      },
      datacenters: { dc1: { id: "dc1", name: "Salle A" }, dc2: { id: "dc2", name: "Salle B" } },
    };
    const view = {
      get: (c, id) => (data[c] && data[c][id]) || null,
      waypointIsPlaced: (wp) => wp.dc_x != null,
      // L'hôte rend désormais des CONTENEURS (doctrine §6.31) : aucun équipement ici, donc aucun conteneur.
      equipmentNamedContainer: () => null,
      containerLabel: (c) => (c && c.kind === "room" ? ((data.datacenters[c.id] || {}).name || "(salle)") : null),
      effectiveWaypointIds: (cable) => cable.waypoint_ids || [],
      portsOf: () => [], cableOnPort: () => null, cablesOfEquipment: () => [], equipmentsOfRack: () => [],
      cableIsComplete: () => false,
    };
    const ra = new CableRouteAnalyzer(view);
    const ok = ra.cableRoute({ waypoint_ids: ["w1", "x1", "x2"] });
    ck(ok.valid && ok.hasExits && ok.startContainer.id === "dc1" && ok.endContainer.id === "dc2", "salle A → exit A → exit B : valide, bouts déduits");
    ck(ra.cableRoute({ waypoint_ids: ["x1"] }).errors.some((e) => e.code === "exit_unpaired"), "exit seul → exit_unpaired");
    ck(ra.cableRoute({ waypoint_ids: ["x1", "w1"] }).errors.some((e) => e.code === "room_wp_outside"), "waypoint de salle dans le tronçon hors salle → room_wp_outside");
    ck.eq(ra.routeHasRoomBreak({ waypoint_ids: ["x1", "w1"] }), true, "routeHasRoomBreak (codes stables) via l'hôte simulé");
    ck.eq(ra.dcName("dc2"), "Salle B", "dcName lu via l'hôte injecté");
    ck.eq(ra.cableRouteSummary(ok), "◆ Salle A → ⏏ Salle A → ⏏ Salle B", "résumé lisible de la route");
  }

  /* ================= SERVEUR : règles pures de la couche HTTP ================= */
  });

  await section("StaleGate : garde de fraîcheur des réponses asynchrones concurrentes (primitive UI pure)", async () => {
  {
    // Helper PUR extrait de SearchPop (recherche « au vol ») : seule la réponse de la DERNIÈRE saisie
    // doit s'appliquer. Un compteur de génération tranche à la résolution — testable sans DOM.
    const { StaleGate } = D("ui/StaleGate.js");
    const g = new StaleGate();

    const t1 = g.begin();
    ck.eq(g.isCurrent(t1), true, "begin : le jeton fraîchement ouvert est courant");
    const t2 = g.begin();
    ck.eq(g.isCurrent(t2), true, "begin : nouveau jeton → courant");
    ck.eq(g.isCurrent(t1), false, "un jeton devancé par un plus récent est PÉRIMÉ (réponse ignorée)");
    ck(t2 !== t1, "chaque begin renvoie un jeton distinct (génération croissante)");

    // bump : périme tout jeton en vol SANS en ouvrir de nouveau (fermeture du popover / champ vidé).
    const t3 = g.begin();
    g.bump();
    ck.eq(g.isCurrent(t3), false, "bump : le jeton en vol devient périmé (aucune réponse ne s'applique)");
    const t4 = g.begin();
    ck.eq(g.isCurrent(t4), true, "après bump, un nouveau begin redevient courant");
  }
  });

  await section("RichTooltip.place : placement PUR (sous l'ancre, flip, clamp)", async () => {
  {
    /* Depuis le cadrage C §2.2, la géométrie vit dans `core/FloatPlacement.tooltip` (testée dans
       test-float-placement.js) et `place` DÉLÈGUE. Ces cas historiques restent joués sur la façade
       publique : ils verrouillent la NON-RÉGRESSION de la délégation (signature et pixels). */
    const VP = { width: 1000, height: 800 };
    const TIP = { width: 200, height: 100 };
    const rect = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

    // Cas nominal : sous l'ancre, centré horizontalement dessus.
    const p = RichTooltip.place(rect(400, 300, 40, 30), TIP, VP, 8);
    ck.eq(p.y, 338, "sous l'ancre : bottom (330) + gap (8)");
    ck.eq(p.x, 320, "centré sur l'ancre : 400 + 40/2 - 200/2");

    // FLIP : déborde en bas ET place au-dessus → passe au-dessus.
    const flip = RichTooltip.place(rect(400, 700, 40, 30), TIP, VP, 8);
    ck.eq(flip.y, 592, "flip au-dessus : top (700) - gap (8) - hauteur (100)");

    // Déborde en bas MAIS pas de place au-dessus (ancre collée en haut) → pas de flip, clamp bas.
    const noRoom = RichTooltip.place(rect(400, 20, 40, 770), TIP, VP, 8);
    ck.eq(noRoom.y, 700, "sans place au-dessus : pas de flip, clamp à vp.height - tip.height");

    // CLAMP horizontal : ancre collée à gauche → jamais de x négatif.
    ck.eq(RichTooltip.place(rect(0, 300, 20, 20), TIP, VP, 8).x, 0, "clamp gauche : x ne passe jamais sous 0");
    // Ancre collée à droite → le tooltip reste dans le viewport.
    ck.eq(RichTooltip.place(rect(980, 300, 20, 20), TIP, VP, 8).x, 800, "clamp droite : x = vp.width - tip.width");

    // Tooltip PLUS GRAND que le viewport → on colle au bord 0 plutôt que de partir hors-champ.
    const huge = RichTooltip.place(rect(10, 10, 20, 20), { width: 1200, height: 900 }, VP, 8);
    ck.eq(huge.x, 0, "tooltip plus large que le viewport : x = 0 (pas de valeur négative)");
    ck.eq(huge.y, 0, "tooltip plus haut que le viewport : y = 0");
  }
  });

  await section("RichTooltip : contenus par CLÉ (register/get)", async () => {
  {
    RichTooltip.register("t.demo", { title: "Démo", sub: "s", sections: [{ head: "H", body: "B" }] });
    ck.eq(RichTooltip.get("t.demo").title, "Démo", "register/get : contenu retrouvé par sa clé");
    ck.eq(RichTooltip.get("t.inconnue"), null, "clé inconnue → null (aucun tooltip, le title natif reste)");
    RichTooltip.registerAll({ "t.a": { title: "A" }, "t.b": { title: "B" } });
    ck.eq(RichTooltip.get("t.b").title, "B", "registerAll : lot enregistré");
  }
  });

  await section("UI a11y : ScrollLock (compteur) + OverlayA11y.nextId (ids stables) — socle des overlays", async () => {
  {
    const { ScrollLock } = D("ui/ScrollLock.js");
    const { OverlayA11y } = D("ui/OverlayA11y.js");

    // ---- ScrollLock : le verrou ne se pose qu'à la 1re prise, ne se retire qu'à la dernière libération ----
    ScrollLock.reset();
    ck.eq(ScrollLock.depth, 0, "verrou : profondeur initiale 0");
    ck.eq(ScrollLock.acquire(), true, "1re prise (0→1) → APPLIQUER le verrou");
    ck.eq(ScrollLock.acquire(), false, "prise imbriquée (1→2, dialogue sur modale) → déjà verrouillé, ne rien faire");
    ck.eq(ScrollLock.depth, 2, "profondeur = 2 après deux prises");
    ck.eq(ScrollLock.release(), false, "libération imbriquée (2→1) → une modale reste ouverte, garder le verrou");
    ck.eq(ScrollLock.release(), true, "dernière libération (1→0) → RÉTABLIR le défilement");
    ck.eq(ScrollLock.depth, 0, "profondeur revenue à 0");
    ck.eq(ScrollLock.release(), true, "libération en trop → borné à 0 (jamais négatif)");
    ck.eq(ScrollLock.depth, 0, "profondeur reste 0 après libération excédentaire");
    ScrollLock.reset();

    // ---- OverlayA11y.nextId : identifiants uniques et préfixés (aria-labelledby / aria-describedby) ----
    const a = OverlayA11y.nextId("dcm-modal-title");
    const b = OverlayA11y.nextId("dcm-modal-title");
    ck.eq(a === b, false, "nextId : deux appels ne collisionnent jamais");
    ck.eq(a.startsWith("dcm-modal-title-"), true, "nextId : préfixe conservé");
    ck.eq(OverlayA11y.nextId("x").startsWith("x-"), true, "nextId : préfixe arbitraire respecté");
  }
  });

  await section("CountdownButton : temporisation d'un bouton (timers injectés, bouton STUB)", async () => {
    const { CountdownButton } = D("ui/CountdownButton.js");
    // Horloge SIMULÉE : capture la fonction de tick + l'état d'activité du timer (calque des timers injectés de
    // PkiSession). Aucun setInterval réel — les défauts natifs ne sont jamais atteints (schedule/cancel fournis).
    const makeClock = () => {
      const st = { fn: null, active: false, cancels: 0 };
      return {
        schedule: (fn) => { st.fn = fn; st.active = true; return 1; },
        cancel: () => { st.active = false; st.cancels++; },
        tick: () => { if (st.fn) st.fn(); },
        st,
      };
    };

    // ---- décompte seconde par seconde, libellé « base (n) », restauration en fin ----
    {
      const clk = makeClock();
      const btn = { textContent: "Initialiser", disabled: false };
      const h = CountdownButton.start(btn, 3, { schedule: clk.schedule, cancel: clk.cancel });
      ck.eq(btn.disabled, true, "START : bouton DÉSACTIVÉ");
      ck.eq(btn.textContent, "Initialiser (3)", "START : libellé « base (3) »");
      ck.eq(h.running, true, "START : décompte en cours");
      clk.tick();
      ck.eq(btn.textContent, "Initialiser (2)", "tick 1 → « base (2) »");
      ck.eq(btn.disabled, true, "toujours désactivé à (2)");
      clk.tick();
      ck.eq(btn.textContent, "Initialiser (1)", "tick 2 → « base (1) »");
      clk.tick();   // remaining → 0 : fin naturelle
      ck.eq(btn.textContent, "Initialiser", "fin : libellé RESTAURÉ (base)");
      ck.eq(btn.disabled, false, "fin : bouton RÉACTIVÉ");
      ck.eq(h.running, false, "fin : décompte terminé");
      ck.eq(clk.st.active, false, "fin : timer stoppé (aucune fuite)");
    }

    // ---- onTick (état initial + chaque affichage) et onDone (fin naturelle seulement) ----
    {
      const clk = makeClock();
      const btn = { textContent: "X", disabled: false };
      let done = 0; const ticks = [];
      CountdownButton.start(btn, 2, { schedule: clk.schedule, cancel: clk.cancel, onTick: (r) => ticks.push(r), onDone: () => done++ });
      ck.eq(ticks.join(","), "2", "onTick : appelé à l'état initial (2)");
      clk.tick();
      ck.eq(ticks.join(","), "2,1", "onTick : appelé à chaque affichage");
      ck.eq(done, 0, "onDone : pas encore appelé (décompte en cours)");
      clk.tick();   // → 0
      ck.eq(done, 1, "onDone : appelé à la fin NATURELLE");
    }

    // ---- cancel() : restaure + stoppe, sans onDone ; double cancel = no-op ----
    {
      const clk = makeClock();
      const btn = { textContent: "Valider", disabled: false };
      let done = 0;
      const h = CountdownButton.start(btn, 5, { schedule: clk.schedule, cancel: clk.cancel, onDone: () => done++ });
      ck.eq(btn.disabled, true, "cancel : désactivé avant annulation");
      h.cancel();
      ck.eq(btn.disabled, false, "cancel : bouton RÉACTIVÉ");
      ck.eq(btn.textContent, "Valider", "cancel : libellé RESTAURÉ");
      ck.eq(h.running, false, "cancel : décompte stoppé");
      ck.eq(clk.st.active, false, "cancel : timer annulé (pas de fuite)");
      ck.eq(done, 0, "cancel : onDone JAMAIS appelé");
      const before = clk.st.cancels;
      h.cancel();   // idempotent
      ck.eq(clk.st.cancels, before, "double cancel : no-op (aucun nouvel appel timer)");
      ck.eq(h.running, false, "double cancel : toujours terminé");
    }

    // ---- option `label` (base explicite) + `format` personnalisé ----
    {
      const clk = makeClock();
      const btn = { textContent: "libellé courant", disabled: false };
      CountdownButton.start(btn, 2, { label: "Base", format: (b, r) => b + "=" + r, schedule: clk.schedule, cancel: clk.cancel });
      ck.eq(btn.textContent, "Base=2", "label/format : libellé initial « Base=2 »");
      clk.tick();
      ck.eq(btn.textContent, "Base=1", "format personnalisé à chaque tick");
      clk.tick();   // fin → restaure la BASE fournie, pas le libellé d'origine
      ck.eq(btn.textContent, "Base", "fin : restaure la base FOURNIE (option label)");
      ck.eq(btn.disabled, false, "fin : réactivé");
    }

    // ---- durée nulle/négative : no-op (bouton laissé tel quel, aucun timer) ----
    {
      const clk = makeClock();
      const btn = { textContent: "Y", disabled: false };
      const h = CountdownButton.start(btn, 0, { schedule: clk.schedule, cancel: clk.cancel });
      ck.eq(btn.disabled, false, "seconds=0 : bouton inchangé (actif)");
      ck.eq(btn.textContent, "Y", "seconds=0 : libellé inchangé");
      ck.eq(h.running, false, "seconds=0 : pas de décompte");
      ck.eq(clk.st.active, false, "seconds=0 : aucun timer planifié");
      h.cancel();
      ck.eq(h.running, false, "seconds=0 : cancel sans effet");
    }
  });

  /* ==========================================================================
     SIGNATURE DE DISPOSITION 3D — la seule logique du moteur WebGL couvrable
     sans contexte graphique. Le rendu 3D n'a AUCUN test automatique : c'est
     précisément pourquoi la décision « reconstruire ou non » a été extraite
     dans un module PUR (`SceneLayoutSignature`), appelé par
     `DcThreeScene.applyOptionsDiff` — lui, non chargeable en Node (THREE).
     Deux exigences OPPOSÉES sont vérifiées ici :
     - ne pas SOUS-invalider (le bug : réglages sans effet jusqu'au F5) ;
     - ne pas SUR-invalider (le risque : reconstruire à chaque rendu).
     ========================================================================== */
  await section("SceneLayoutSignature : signature de disposition 3D (attentes en dur)", async () => {
    const ROOM = { dcId: "dc-a", ox: 100, oy: 200, oz: 0, o: 0, w: 4000, d: 3000 };
    const DECOR = {
      planes: [{ loc: "s1", floor: "0", W: 20000, D: 10000, cell: 600, ox: 0, oy: 0, z: 0, blocked: ["1,1"] }],
      oobs: [{ id: "wp1", x: 10, y: 20, z: 30, baseZ: 0 }],
      equips: [{ id: "eq1", x: 40, y: 50, baseZ: 0 }],
      floorLabels: [{ label: "Étage 0", x: -1, y: 0, z: 0 }],
      buildings: [{ label: "Siège", x: 5, y: 6, z: 7 }],
      // BORNES MONDE (lot 20) : elles ne DESSINENT rien, elles bornent le PIVOT D'ORBITE — et c'est
      // précisément pourquoi elles doivent être signées. `recomputePivotAabb` n'est rejoué qu'à la
      // (re)construction de la scène : une enveloppe de bâtiment qui changerait sans changer la
      // signature laisserait le pivot borné à l'ANCIEN monde jusqu'au rechargement (lot 8, déplacé
      // du dessin vers la caméra). Cf. la section « bornes monde » plus bas pour le cas RÉEL où
      // rien d'autre que ce champ ne bouge.
      world: { minX: 0, maxX: 62000, minY: 0, maxY: 16500, minZ: 0, maxZ: 16000 },
    };

    // ---- forme EXACTE de la signature (verrou : toute évolution du format se voit ici) ----
    ck.eq(SceneLayoutSignature.of([ROOM], null), '[[["dc-a",100,200,0,0,4000,3000,null]],null]', "signature : une salle sans décor");
    ck.eq(SceneLayoutSignature.of([], null), "[[],null]", "signature : disposition vide");
    ck.eq(SceneLayoutSignature.none(), "[[],null]", "none() = signature de la disposition vide");
    ck.eq(SceneLayoutSignature.of([{ ...ROOM, underfloorMm: 450 }], null), '[[["dc-a",100,200,0,0,4000,3000,450]],null]', "signature : vide technique porté (dalle dessinée)");
    ck.eq(
      SceneLayoutSignature.of([ROOM], DECOR),
      '[[["dc-a",100,200,0,0,4000,3000,null]],[[["s1","0",20000,10000,600,0,0,0,["1,1"]]],[["wp1",10,20,30,0]],[["eq1",40,50,0]],[["Étage 0",-1,0,0]],[["Siège",5,6,7]],[0,62000,0,16500,0,16000]]]',
      "signature : salle + décor d'étage complet (bornes monde comprises)",
    );

    // ---- STABILITÉ : deux calculs de la MÊME disposition (objets distincts) rendent la MÊME chaîne.
    //      C'est l'invariant qui empêche de reconstruire la scène à chaque rendu.
    const clone = (o) => JSON.parse(JSON.stringify(o));
    ck.eq(SceneLayoutSignature.of([clone(ROOM)], clone(DECOR)), SceneLayoutSignature.of([ROOM], DECOR), "stabilité : objets recalculés → signature identique");
    ck.eq(SceneLayoutSignature.of([ROOM], DECOR), SceneLayoutSignature.of([ROOM], DECOR), "stabilité : deux appels consécutifs → signature identique");
    // `undefined` explicite et champ ABSENT décrivent la même absence → même signature (pas de faux positif).
    ck.eq(SceneLayoutSignature.of([{ ...ROOM, underfloorMm: undefined }], null), SceneLayoutSignature.of([ROOM], null), "stabilité : underfloorMm absent ≡ undefined");

    // ---- SENSIBILITÉ : chaque champ qui DESSINE doit faire bouger la signature ----
    const base = SceneLayoutSignature.of([ROOM], DECOR);
    const roomDiff = (patch, label) => ck(SceneLayoutSignature.of([{ ...ROOM, ...patch }], DECOR) !== base, "détecte " + label);
    roomDiff({ dcId: "dc-b" }, "un changement de salle (identité)");
    roomDiff({ ox: 101 }, "un déplacement en X (échelle inter-sites, repère bâtiment)");
    roomDiff({ oy: 201 }, "un déplacement en Y");
    roomDiff({ oz: 3500 }, "un changement de NIVEAU (empilement des étages)");
    roomDiff({ o: Math.PI / 2 }, "une rotation de salle sur son plan");
    roomDiff({ w: 4001 }, "un changement de largeur (sol + grille)");
    roomDiff({ d: 3001 }, "un changement de profondeur");
    roomDiff({ underfloorMm: 450 }, "l'apparition d'un plancher technique");
    ck(SceneLayoutSignature.of([ROOM, { ...ROOM, dcId: "dc-b" }], DECOR) !== base, "détecte une salle AJOUTÉE");
    ck(SceneLayoutSignature.of([{ ...ROOM, dcId: "dc-b" }, ROOM], DECOR) !== SceneLayoutSignature.of([ROOM, { ...ROOM, dcId: "dc-b" }], DECOR), "détecte un changement d'ORDRE des salles");

    const decorDiff = (patch, label) => ck(SceneLayoutSignature.of([ROOM], { ...DECOR, ...patch }) !== base, "détecte " + label);
    ck(SceneLayoutSignature.of([ROOM], null) !== base, "détecte l'apparition/disparition du décor d'étage (bascule « Vue étage »)");
    decorDiff({ planes: [{ ...DECOR.planes[0], ox: 3000 }] }, "un ancrage de plan d'étage déplacé");
    decorDiff({ planes: [{ ...DECOR.planes[0], W: 21000 }] }, "un plan d'étage redimensionné");
    decorDiff({ planes: [{ ...DECOR.planes[0], blocked: ["1,1", "2,2"] }] }, "une cellule d'étage rendue inaccessible");
    decorDiff({ planes: [] }, "un plan d'étage retiré de la portée");
    decorDiff({ oobs: [{ ...DECOR.oobs[0], x: 11 }] }, "un OOB déplacé");
    decorDiff({ equips: [{ ...DECOR.equips[0], baseZ: 3500 }] }, "un équipement d'étage changeant de niveau");
    // ÉTIQUETTES D'ÉTAGE (une par plan dessiné depuis le lot 9) : leur position suit l'ancrage de LEUR
    // plan, donc l'échelle inter-sites et le repère du bâtiment — elles doivent peser dans la signature,
    // sinon déplacer un site laisserait ses étiquettes en place jusqu'au rechargement.
    decorDiff({ floorLabels: [{ ...DECOR.floorLabels[0], z: 3500 }] }, "une étiquette d'étage changeant de niveau");
    decorDiff({ floorLabels: [{ ...DECOR.floorLabels[0], x: 48800 }] }, "une étiquette d'étage déplacée en X (échelle inter-sites)");
    decorDiff({ floorLabels: [{ ...DECOR.floorLabels[0], y: 1500 }] }, "une étiquette d'étage déplacée en Y (ancrage du plan)");
    decorDiff({ floorLabels: [{ ...DECOR.floorLabels[0], label: "Étage 1" }] }, "une étiquette d'étage renumérotée");
    decorDiff({ floorLabels: [...DECOR.floorLabels, { label: "Étage 0", x: 48800, y: 0, z: 0 }] }, "l'étiquette d'étage RÉPÉTÉE sur un second site");
    decorDiff({ floorLabels: [] }, "une étiquette d'étage retirée de la portée");
    decorDiff({ buildings: [{ ...DECOR.buildings[0], label: "Secours" }] }, "un bâtiment renommé");
    decorDiff({ buildings: [{ ...DECOR.buildings[0], z: 8000 }] }, "une étiquette de bâtiment remontée (hauteur totale du monde)");
    // BORNES MONDE : chacune des six cotes borne le pivot d'orbite → chacune doit peser dans la signature.
    decorDiff({ world: null }, "la disparition des bornes monde (retour au bornage à la salle)");
    decorDiff({ world: { ...DECOR.world, minX: -1000 } }, "une enveloppe de bâtiment étendue vers l'ouest");
    decorDiff({ world: { ...DECOR.world, maxX: 63000 } }, "une enveloppe de bâtiment élargie (taille de site déclarée)");
    decorDiff({ world: { ...DECOR.world, minY: -1 } }, "une enveloppe de bâtiment étendue vers le nord");
    decorDiff({ world: { ...DECOR.world, maxY: 25000 } }, "une enveloppe de bâtiment APPROFONDIE — le cas où RIEN d'autre ne bouge");
    decorDiff({ world: { ...DECOR.world, minZ: -500 } }, "un plancher de monde abaissé");
    decorDiff({ world: { ...DECOR.world, maxZ: 20000 } }, "un étage ajouté au-dessus (plafond du monde)");
    // STABILITÉ des bornes : champ ABSENT ≡ null, et bornes en Z absentes ≡ null (l'absence a un sens
    // documenté — parois infinies — mais elle ne doit pas produire DEUX signatures pour un même monde).
    ck.eq(SceneLayoutSignature.of([ROOM], { ...DECOR, world: undefined }), SceneLayoutSignature.of([ROOM], { ...DECOR, world: null }), "stabilité : bornes monde absentes ≡ null");
    ck.eq(SceneLayoutSignature.of([ROOM], { ...DECOR, world: { minX: 0, maxX: 1, minY: 0, maxY: 1 } }),
          SceneLayoutSignature.of([ROOM], { ...DECOR, world: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: undefined, maxZ: undefined } }),
          "stabilité : bornes en Z absentes ≡ undefined explicite");
    // Un libellé contenant le séparateur ne doit pas pouvoir imiter une AUTRE disposition (JSON échappe).
    ck(SceneLayoutSignature.of([ROOM], { ...DECOR, buildings: [{ label: '","x', x: 5, y: 6, z: 7 }] })
       !== SceneLayoutSignature.of([ROOM], { ...DECOR, buildings: [{ label: '\\","x', x: 5, y: 6, z: 7 }] }), "aucune collision par libellé contenant des séparateurs");

    // ---- DÉCISION d'invalidation : table de vérité complète ----
    const A = { ids: "M:a", layout: "L1" }, B = { ids: "M:a,b", layout: "L2" }, A2 = { ids: "M:a", layout: "L2" };
    ck.eq(SceneLayoutSignature.action(A, B, { hasContent: false, deltaEligible: true }), "rebuild", "action : aucune scène construite → rebuild");
    ck.eq(SceneLayoutSignature.action(A, B, { hasContent: true, deltaEligible: true }), "roomDelta", "action : ensemble de salles changé + delta applicable → roomDelta");
    ck.eq(SceneLayoutSignature.action(A, B, { hasContent: true, deltaEligible: false }), "rebuild", "action : ensemble de salles changé, delta NON applicable → rebuild");
    ck.eq(SceneLayoutSignature.action(A, A2, { hasContent: true, deltaEligible: true }), "rebuild", "action : MÊMES salles, disposition différente → rebuild (le bug corrigé)");
    ck.eq(SceneLayoutSignature.action(A, { ...A }, { hasContent: true, deltaEligible: true }), "keep", "action : rien n'a changé → keep (aucune reconstruction)");
    ck.eq(SceneLayoutSignature.action(A, { ...A }, { hasContent: true, deltaEligible: false }), "keep", "action : rien n'a changé, delta inapplicable → keep");
  });

  /* ==========================================================================
     BASCULE « IMAGES DE FAÇADE » sur les BOÎTES 6 FACES (FaceImagePolicy).
     Elle n'agissait QUE sur les montés en U (images = PLANS masquables) ; sur
     les cinq modes servis par `buildEquipBox` (libre salle, étage, étagère,
     marge, paroi) l'image est un MATÉRIAU — rien à masquer, bascule sans effet
     (dette consignée à docs/placement.md §6.24). Le correctif ÉCHANGE le jeu de
     matériaux (avec/sans) au lieu de masquer. Le moteur WebGL n'étant pas
     chargeable en Node (THREE), la DÉCISION est extraite dans un module PUR —
     même démarche que SceneLayoutSignature ci-dessus — et c'est ELLE qu'on
     verrouille : `buildEquipBox` la consulte au build, `applyLayerVisibility`
     à chaque bascule, `layerVisible` pour le repère d'orientation. Le swap
     effectif des meshes, lui, reste à valider À L'ŒIL.
     ========================================================================== */
  await section("FaceImagePolicy : la bascule « Images de façade » gouverne AUSSI les boîtes 6 faces", async () => {
    // Jeux OPAQUES : le module ne les ouvre jamais (aucun THREE) — n'importe quelle valeur fait foi.
    const avec = ["jeu texturé"], sans = ["jeu uni"];
    const swap = { avec, sans };

    // ---- choix du jeu ACTIF : au BUILD (état courant de l'option) comme à la BASCULE (même source)
    ck.eq(FaceImagePolicy.materials(swap, true), avec, "bascule ON → jeu AVEC images (matériaux texturés)");
    ck.eq(FaceImagePolicy.materials(swap, false), sans, "bascule OFF → jeu SANS images : une scène CONSTRUITE bascule éteinte sort UNIE");
    // le swap ne fabrique RIEN : mêmes INSTANCES à chaque lecture — les textures chargées (async) dans le
    // jeu débranché réapparaissent telles quelles quand on rebascule, sans rechargement ni double instance.
    ck.eq(FaceImagePolicy.materials(swap, true), FaceImagePolicy.materials(swap, true), "OFF→ON : l'instance d'ORIGINE revient (échange, pas reconstruction)");

    // ---- repère d'orientation (4 arêtes accent de la face avant) : matrice COMPLÈTE
    //      orient × image avant × bascule. Règle : visible si « repères » actifs ET que l'image d'avant
    //      ne fait pas déjà le travail (absente, OU masquée par la bascule). Les arêtes étant désormais
    //      TOUJOURS construites, cette décision est la SEULE chose qui les affiche ou non.
    const matrice = [
      // [showOrientMarks, frontImageAsMarker, showFaceImages, attendu, libellé]
      [true, false, false, true, "repères ON · pas d'image avant · images OFF → arêtes VISIBLES"],
      [true, false, true, true, "repères ON · pas d'image avant · images ON → arêtes VISIBLES (rien ne les remplace)"],
      [true, true, false, true, "repères ON · image avant MASQUÉE par la bascule → arêtes VISIBLES (sinon plus AUCUN repère : le piège du lot)"],
      [true, true, true, false, "repères ON · image avant AFFICHÉE → arêtes MASQUÉES (l'image indique déjà l'avant)"],
      [false, false, false, false, "repères OFF → jamais d'arêtes (pas d'image, images OFF)"],
      [false, false, true, false, "repères OFF → jamais d'arêtes (pas d'image, images ON)"],
      [false, true, false, false, "repères OFF → jamais d'arêtes, même image masquée"],
      [false, true, true, false, "repères OFF → jamais d'arêtes, même image affichée"],
    ];
    matrice.forEach(([orient, marqueur, images, attendu, libelle]) => ck.eq(FaceImagePolicy.orientEdgesVisible(orient, marqueur, images), attendu, libelle));
  });

  await section("DatacenterView : les réglages de vue qui DÉPLACENT la géométrie invalident la scène 3D", async () => {
    // Régression du bug « réglages 3D sans effet avant F5 » (bascule « Vue étage », curseur d'échelle
    // inter-sites, mode linéaire/logarithmique). On rejoue le CONTEXTE réellement poussé au moteur
    // (`webglCtx`) et on applique la MÊME décision que `DcThreeScene.applyOptionsDiff` — seule cette
    // dernière, qui importe THREE, reste hors de portée du harnais Node.
    const s = await makeStore();
    const siteA = await s.create("sites", { name: "Alpha" });
    const siteB = await s.create("sites", { name: "Beta" });   // sans GPS → posé au repli (5 km à l'est) : l'échelle mord
    await s.create("floors", { location: siteA.id, floor: "0", width_mm: 20000, depth_mm: 15000, cell_mm: 600 });
    const dcA = await s.create("datacenters", { name: "Salle A", location: siteA.id, floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcB = await s.create("datacenters", { name: "Salle B", location: siteB.id, floor: "0", width_mm: 5000, depth_mm: 4000, floor_x: 500, floor_y: 500 });
    const dv = new DatacenterView(s, {}, {});   // garde headless
    dv.view = "3d"; dv.useWebGL = true; dv.dcId = dcA.id;

    // Réplique EXACTE des deux entrées comparées par applyOptionsDiff (options d'affichage inchangées).
    const snapshot = () => {
      const ctx = dv.webglCtx(), multi = ctx.multi, hasRooms = !!(multi && multi.rooms.length);
      return {
        ids: hasRooms ? "M:" + multi.rooms.map((r) => r.dcId).join(",") : (dv.dcId || "∅"),
        layout: hasRooms ? SceneLayoutSignature.of(multi.rooms, ctx.floorDecor) : SceneLayoutSignature.none(),
        hasRooms,
      };
    };
    const decide = (prev, next) => SceneLayoutSignature.action(prev, next, { hasContent: true, deltaEligible: next.hasRooms });

    // ---- bascule « Vue étage » à portée INCHANGÉE : le cas où l'ancienne clé (ensemble des salles)
    //      était rigoureusement identique — donc où RIEN ne se reconstruisait jusqu'au rechargement.
    dv.multiDc = false; dv.visibleDcIds = new Set();
    const mono = snapshot();
    dv.multiDc = true; dv.visibleDcIds = new Set([dcA.id]);
    const etage = snapshot();
    ck.eq(etage.ids, mono.ids, "« Vue étage » à portée inchangée : l'ensemble des salles ne bouge PAS (l'ancienne clé était aveugle)");
    ck(etage.layout !== mono.layout, "« Vue étage » : la DISPOSITION change (repère bâtiment + décor d'étage)");
    ck.eq(decide(mono, etage), "rebuild", "« Vue étage » OFF → ON : reconstruction");
    ck.eq(decide(etage, mono), "rebuild", "« Vue étage » ON → OFF : reconstruction");

    // ---- portée élargie : l'ensemble des salles change → le chemin INCRÉMENTAL reste emprunté
    //      (le correctif ne doit pas transformer un delta de salles en reconstruction complète).
    dv.visibleDcIds = new Set([dcA.id, dcB.id]);
    const deux = snapshot();
    ck(deux.ids !== etage.ids, "portée élargie : l'ensemble des salles change");
    ck.eq(decide(etage, deux), "roomDelta", "portée élargie → chemin incrémental (applyRoomDelta) conservé");

    // ---- curseur d'ÉCHELLE inter-sites + bascule LOGARITHMIQUE : mêmes salles, monde déplacé ----
    dv.siteScaleKm = 10; dv.siteScaleLog = false;
    const ech10 = snapshot();
    dv.siteScaleKm = 200;
    const ech200 = snapshot();
    ck.eq(ech200.ids, ech10.ids, "échelle inter-sites : l'ensemble des salles ne bouge pas");
    ck(ech200.layout !== ech10.layout, "échelle inter-sites : les origines de bâtiment bougent");
    ck.eq(decide(ech10, ech200), "rebuild", "curseur d'échelle relâché → reconstruction");
    ck.eq(decide(ech200, ech10), "rebuild", "retour à l'échelle précédente → reconstruction");
    dv.siteScaleKm = 10; dv.siteScaleLog = true;
    const log = snapshot();
    ck.eq(log.ids, ech10.ids, "mode logarithmique : l'ensemble des salles ne bouge pas");
    ck.eq(decide(ech10, log), "rebuild", "linéaire → logarithmique : reconstruction");
    ck.eq(decide(log, ech10), "rebuild", "logarithmique → linéaire : reconstruction");

    // ---- NON-RÉGRESSION MAJEURE : un rendu SANS aucun changement ne doit RIEN reconstruire.
    //      Chaque appel recalcule tout le contexte (objets neufs) — seule la STABILITÉ des valeurs
    //      empêche une reconstruction par rendu, qui figerait l'application.
    const r1 = snapshot(), r2 = snapshot(), r3 = snapshot();
    ck.eq(r2.layout, r1.layout, "aucun changement : signature stable d'un rendu à l'autre");
    ck.eq(decide(r1, r2), "keep", "aucun changement → aucune reconstruction (1)");
    ck.eq(decide(r2, r3), "keep", "aucun changement → aucune reconstruction (2)");
    dv.multiDc = false;
    const m1 = snapshot(), m2 = snapshot();
    ck.eq(decide(m1, m2), "keep", "salle unique, aucun changement → aucune reconstruction");
  });

  /* ==========================================================================
     DÉCOR D'ÉTAGE 3D — étiquettes posées À CÔTÉ de chaque étage, RÉPÉTÉES par
     site, et plan séparateur SUPPRIMÉ (lot 9, demande utilisateur).
     Le rendu 3D n'a aucune couverture automatique, mais le DESCRIPTEUR qu'on
     lui pousse, lui, se calcule en Node : `DatacenterView` s'instancie en
     headless, donc `webglCtx().floorDecor` est observable — c'est la seule
     façon de verrouiller des coordonnées de décor sans contexte graphique.
     ========================================================================== */
  await section("DcBase.webglFloorDecor : étiquettes d'étage par plan dessiné (attentes en dur)", async () => {
    // Deux sites SANS GPS : le second est posé au repli (5 km à l'est), soit 50 000 mm à l'échelle par
    // défaut (1 km = 10 m). Hauteur d'étage FORCÉE à 4 000 mm (`height_mm`) pour que les Z de niveaux
    // soient des valeurs rondes : 4 000 + 2 000 d'écart inter-niveaux = un pas de 6 000 mm.
    const s = await makeStore();
    const siteA = await s.create("sites", { name: "Alpha" });
    const siteB = await s.create("sites", { name: "Beta" });
    await s.create("floors", { location: siteA.id, floor: "-1", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000 });
    await s.create("floors", { location: siteA.id, floor: "0", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000 });
    // ANCRÉ (3 000 ; 1 500) : prouve que l'étiquette suit l'ancrage de SON plan, pas l'origine du bâtiment.
    await s.create("floors", { location: siteA.id, floor: "1", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000, anchor_x: 3000, anchor_y: 1500 });
    await s.create("floors", { location: siteB.id, floor: "0", width_mm: 12000, depth_mm: 9000, cell_mm: 600, height_mm: 4000 });
    const dcAm = await s.create("datacenters", { name: "Salle A-1", location: siteA.id, floor: "-1", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcA0 = await s.create("datacenters", { name: "Salle A0", location: siteA.id, floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcA1 = await s.create("datacenters", { name: "Salle A1", location: siteA.id, floor: "1", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcB0 = await s.create("datacenters", { name: "Salle B0", location: siteB.id, floor: "0", width_mm: 5000, depth_mm: 4000, floor_x: 500, floor_y: 500 });
    const dv = new DatacenterView(s, {}, {});   // garde headless
    dv.view = "3d"; dv.useWebGL = true; dv.dcId = dcA0.id; dv.multiDc = true;
    const decor = () => dv.webglCtx().floorDecor;
    const lab = (l) => [l.label, l.x, l.y, l.z].join("|");

    dv.visibleDcIds = new Set([dcAm.id, dcA0.id, dcA1.id, dcB0.id]);
    const fd = decor();

    // ---- FORME du descripteur : plus AUCUN vestige du séparateur ni des bornes du monde ----
    // ⚠ `world` s'est AJOUTÉ au lot 20 : ce sont les BORNES MONDE du bornage du pivot d'orbite (cf. section
    // dédiée plus bas). Ce n'est PAS le retour de `maxD`/`topZ` — ceux-là DESSINAIENT le plan séparateur,
    // supprimé depuis ; les deux assertions qui suivent vérifient qu'ils n'ont pas reparu au passage.
    ck.eq(Object.keys(fd).sort().join(","), "buildings,equips,floorLabels,oobs,planes,world", "décor : champs exacts (bornes monde comprises)");
    ck.eq("maxD" in fd, false, "décor : toujours pas de maxD (le séparateur était son seul consommateur)");
    ck.eq("topZ" in fd, false, "décor : toujours pas de topZ épars — la hauteur du monde vit dans `world.maxZ`");
    ck.eq(fd.buildings.filter((b) => "sepX" in b).length, 0, "aucune étiquette de bâtiment ne porte de sepX");
    ck.eq(fd.floorLabels.filter((l) => "sepX" in l).length, 0, "aucune étiquette d'étage ne porte de sepX");

    // ---- UNE étiquette PAR PLAN DESSINÉ (donc répétée sur chaque site) ----
    ck.eq(fd.planes.length, 4, "4 plans d'étage dessinés (3 à Alpha, 1 à Beta)");
    ck.eq(fd.floorLabels.length, 4, "une étiquette d'étage PAR PLAN dessiné (et non un jeu global de niveaux)");
    ck.eq(fd.floorLabels.map(lab).join(" ; "),
      "Étage -1|-1200|0|0 ; Étage 0|-1200|0|6000 ; Étage 1|1800|1500|12000 ; Étage 0|48800|0|6000",
      "étiquettes d'étage : libellé + position, plan par plan");
    // Répétition PAR SITE : les deux étages « 0 » portent le même libellé à ~50 m d'écart en X.
    const zero = fd.floorLabels.filter((l) => l.label === "Étage 0");
    ck.eq(zero.length, 2, "l'étage « 0 » est étiqueté DEUX fois : une par site (répétition demandée)");
    ck.eq(zero[1].x - zero[0].x, 50000, "les deux étiquettes « Étage 0 » sont séparées par la distance inter-sites (50 m)");
    // Piège du dépôt : `String(x || "")` écraserait l'étage « 0 » en chaîne vide → libellé « Étage  ».
    ck.eq(zero[0].label, "Étage 0", "l'étage « 0 » produit bien un libellé (pas de chaîne vide)");

    // ---- POSITION : celle de SON plan, décalée de -gap*0.6 en X (gap = 2 000 → 1 200 mm) ----
    fd.floorLabels.forEach((l, i) => {
      ck.eq(l.x, fd.planes[i].ox - 1200, "étiquette " + i + " : x = ancrage du plan − gap*0,6");
      ck.eq(l.y, fd.planes[i].oy, "étiquette " + i + " : y = ancrage du plan");
      ck.eq(l.z, fd.planes[i].z, "étiquette " + i + " : z = niveau du plan");
    });
    // AUCUNE étiquette n'est restée plantée à l'origine du monde (l'ancien jeu unique y vivait, en y = 0/z = niveau).
    ck.eq(fd.floorLabels.filter((l) => l.x === -1200 && l.y === 0).length, 2, "seules les étiquettes du site posé à l'origine sont près de l'origine");
    ck(fd.floorLabels.some((l) => l.x > 40000), "le second site a bien SES propres étiquettes, loin de l'origine");

    // ---- PORTÉE : un étage NON dessiné n'a pas d'étiquette (le repère, lui, ne bouge pas) ----
    dv.visibleDcIds = new Set([dcA0.id]);
    const restreint = decor();
    ck.eq(restreint.planes.length, 3, "portée réduite au bâtiment Alpha : 3 plans dessinés");
    ck.eq(restreint.floorLabels.length, 3, "portée réduite : une étiquette par plan, ni plus ni moins");
    ck.eq(restreint.floorLabels.filter((l) => l.x > 40000).length, 0, "portée réduite : plus aucune étiquette du site Beta");
    ck.eq(restreint.floorLabels.map(lab).join(" ; "),
      "Étage -1|-1200|0|0 ; Étage 0|-1200|0|6000 ; Étage 1|1800|1500|12000",
      "portée réduite : les étiquettes restantes n'ont PAS bougé (repère ⊥ portée)");

    // ---- INVALIDATION : l'échelle inter-sites DÉPLACE les étiquettes → signature différente → rebuild.
    //      (Non-régression du lot 8 : un réglage qui déplace la géométrie doit reconstruire la scène.)
    dv.visibleDcIds = new Set([dcAm.id, dcA0.id, dcA1.id, dcB0.id]);
    const ech10 = decor();
    dv.siteScaleKm = 200;
    const ech200 = decor();
    ck.eq(ech200.floorLabels[3].x, 998800, "échelle × 20 : l'étiquette du site Beta suit son plan (5 km × 200 − 1 200)");
    ck.eq(ech200.floorLabels[0].x, ech10.floorLabels[0].x, "échelle : le site d'origine, lui, ne bouge pas");
    const sig10 = SceneLayoutSignature.of([], ech10), sig200 = SceneLayoutSignature.of([], ech200);
    ck(sig10 !== sig200, "échelle inter-sites : le décor change de signature (les étiquettes ont bougé)");
    ck.eq(SceneLayoutSignature.action({ ids: "M:x", layout: sig10 }, { ids: "M:x", layout: sig200 }, { hasContent: true, deltaEligible: true }), "rebuild", "échelle inter-sites → reconstruction de la scène");
    ck.eq(SceneLayoutSignature.of([], decor()), sig200, "décor recalculé à l'identique → MÊME signature (aucune reconstruction parasite)");
  });

  /* ==========================================================================
     BORNES MONDE DU DÉCOR D'ÉTAGE (lot 20) — ce qui BORNE le pivot d'orbite.
     Cf. docs/placement.md §6.21.

     Le pivot d'orbite était borné à l'union des SALLES affichées : en Vue étage,
     tourner autour d'un point hors salle ramenait le pivot dans l'emprise de la
     salle active alors que le monde regardé est le BÂTIMENT. La boîte devient
     l'union des BANDES DE BÂTIMENT DESSINÉES, et gagne une hauteur.

     ⚠ Toutes les cotes ci-dessous sont dérivées À LA MAIN du modèle :
       - Alpha (sans GPS) est à l'origine, Beta au repli de 5 km = 50 000 mm ;
       - bande Alpha : ses plans font 20 000 × 15 000, mais le 1er étage est ancré
         en (3 000 ; 1 500) → emprise 23 000 × 16 500 ;
       - bande Beta : 12 000 × 9 000 depuis 50 000 → 50 000…62 000 ;
       - hauteur : 3 niveaux de 4 000 mm espacés de 2 000 → socles 0 / 6 000 /
         12 000, sommet du monde = 12 000 + 4 000 = 16 000.
     ========================================================================== */
  await section("DcBase.webglFloorDecor : BORNES MONDE = enveloppes de BÂTIMENT × hauteur (attentes en dur)", async () => {
    const s = await makeStore();
    const siteA = await s.create("sites", { name: "Alpha" });
    const siteB = await s.create("sites", { name: "Beta" });
    await s.create("floors", { location: siteA.id, floor: "-1", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000 });
    await s.create("floors", { location: siteA.id, floor: "0", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000 });
    await s.create("floors", { location: siteA.id, floor: "1", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000, anchor_x: 3000, anchor_y: 1500 });
    await s.create("floors", { location: siteB.id, floor: "0", width_mm: 12000, depth_mm: 9000, cell_mm: 600, height_mm: 4000 });
    const dcAm = await s.create("datacenters", { name: "Salle A-1", location: siteA.id, floor: "-1", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcA0 = await s.create("datacenters", { name: "Salle A0", location: siteA.id, floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcA1 = await s.create("datacenters", { name: "Salle A1", location: siteA.id, floor: "1", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcB0 = await s.create("datacenters", { name: "Salle B0", location: siteB.id, floor: "0", width_mm: 5000, depth_mm: 4000, floor_x: 500, floor_y: 500 });
    const dv = new DatacenterView(s, {}, {});   // garde headless
    dv.view = "3d"; dv.useWebGL = true; dv.dcId = dcA0.id; dv.multiDc = true;
    const j = (o) => JSON.stringify(o);
    // Gardes de LISIBILITÉ (même motif que `sansNull` plus bas) : sans elles, une régression qui fait rendre
    // `floorDecor` ou `world` à null CRASHE la section et masque toutes les assertions suivantes — on ne
    // verrait plus QUE le crash, alors que c'est justement la répartition des FAIL qui informe.
    const DECOR_VIDE = { planes: [], oobs: [], equips: [], floorLabels: [], buildings: [], world: null };
    const BORNES_VIDES = { minX: null, maxX: null, minY: null, maxY: null, minZ: null, maxZ: null };
    const decorOf = (ctx) => ctx.floorDecor || DECOR_VIDE;
    const bornes = (ctx) => decorOf(ctx).world || BORNES_VIDES;

    // ---- PORTÉE COMPLÈTE : la boîte englobe les DEUX bâtiments, et le monde a un plafond ----
    dv.visibleDcIds = new Set([dcAm.id, dcA0.id, dcA1.id, dcB0.id]);
    const ctxPlein = dv.webglCtx();
    ck.eq(j(bornes(ctxPlein)), j({ minX: 0, maxX: 62000, minY: 0, maxY: 16500, minZ: 0, maxZ: 16000 }), "bornes monde : union des deux bandes de bâtiment + hauteur du monde");

    // ---- CONTRASTE avec l'ancienne boîte (union des SALLES), calculée par le MÊME module que le moteur ----
    const sallesBox = PivotBounds.unionAabb(ctxPlein.multi.rooms.map((r) => PivotBounds.rectCorners(r.ox, r.oy, r.o, r.w, r.d)));
    ck.eq(j(sallesBox), j({ minX: 1000, maxX: 55500, minY: 500, maxY: 6500 }), "l'ANCIENNE boîte (union des salles) — dérivée à la main : 4 salles de 6×4 m posées sur leurs plans");
    ck(sallesBox.maxY < bornes(ctxPlein).maxY, "la boîte des salles est bien PLUS ÉTROITE que le bâtiment en Y (16 500 contre 6 500)");
    ck.eq("minZ" in sallesBox, false, "la boîte des salles n'a AUCUNE borne en Z (parois infinies) — c'est le repère salle, conservé");

    // ---- PORTÉE RÉDUITE À UNE SEULE SALLE : le repère reste le BÂTIMENT (ce n'est PAS un comptage) ----
    // Doctrine §3 règle 2 : conditionner un comportement de REPÈRE au NOMBRE d'éléments est un bug par
    // construction. Une salle unique affichée en Vue étage doit donc voir l'enveloppe de SON bâtiment,
    // pas son propre pourtour (5 000 × 4 000 mm posés en 500/500).
    dv.dcId = dcB0.id; dv.visibleDcIds = new Set([dcB0.id]);
    const ctxSeul = dv.webglCtx();
    ck.eq(ctxSeul.multi.rooms.length, 1, "portée réduite : UNE seule salle affichée");
    ck.eq(j(bornes(ctxSeul)), j({ minX: 50000, maxX: 62000, minY: 0, maxY: 9000, minZ: 0, maxZ: 16000 }), "une salle unique en Vue étage : la boîte reste celle de SON bâtiment");
    // Repère ⊥ portée : la bande de Beta n'a pas BOUGÉ, seul le bâtiment non dessiné est sorti de l'union.
    ck.eq(bornes(ctxSeul).maxX, bornes(ctxPlein).maxX, "portée réduite : la bande de Beta ne bouge pas (repère ⊥ portée)");
    ck.eq(bornes(ctxSeul).minX, 50000, "portée réduite : le bâtiment NON DESSINÉ (Alpha) sort de l'union — on n'orbite pas autour de 5 km de vide");
    // ⚠ ASYMÉTRIE ASSUMÉE : la hauteur reste celle du MODÈLE (les 3 niveaux d'Alpha), non celle des seuls
    // niveaux dessinés — écart borné par la hauteur du monde, là où l'écart en XY serait kilométrique.
    ck.eq(bornes(ctxSeul).maxZ, 16000, "portée réduite : la hauteur reste celle du MODÈLE (asymétrie documentée)");

    // ---- SALLE UNIQUE (hors Vue étage) : aucun décor, donc aucune borne monde → bornage à la salle ----
    dv.multiDc = false;
    ck.eq(dv.webglCtx().floorDecor, null, "hors Vue étage : aucun décor d'étage → aucune borne monde (le moteur retombe sur l'union des salles)");
    dv.multiDc = true; dv.dcId = dcA0.id; dv.visibleDcIds = new Set([dcAm.id, dcA0.id, dcA1.id, dcB0.id]);

    // ---- INVALIDATION : le cas où SEULES les bornes monde changent ----
    // Taille DÉCLARÉE d'Alpha : largeur 23 000 (exactement l'emprise déduite) et profondeur 25 000. Choix
    // délibéré — l'étiquette de bâtiment est posée en x = (x0+x1)/2 et en y = y0 − gap/2, donc elle ne bouge
    // NI par la largeur inchangée NI par la profondeur. Les plans, les OOB, les équipements et les étiquettes
    // d'étage ne dépendent pas non plus de l'emprise. Résultat : `world.maxY` est le SEUL champ du décor à
    // changer — sans lui dans la signature, le pivot resterait borné à l'ancienne enveloppe jusqu'au F5.
    const sansWorld = (fd) => j([fd.planes, fd.oobs, fd.equips, fd.floorLabels, fd.buildings]);
    const avant = decorOf(dv.webglCtx());
    const avantSig = SceneLayoutSignature.of([], avant), avantReste = sansWorld(avant);
    await s.update("sites", siteA.id, { width_mm: 23000, depth_mm: 25000 });
    const apres = decorOf(dv.webglCtx());
    ck.eq(sansWorld(apres), avantReste, "taille de bâtiment déclarée : TOUT le reste du décor est inchangé, à l'octet");
    ck.eq(j(apres.world || BORNES_VIDES), j({ minX: 0, maxX: 62000, minY: 0, maxY: 25000, minZ: 0, maxZ: 16000 }), "taille déclarée : l'enveloppe suit la profondeur DÉCLARÉE (25 000), plus grande que les plans (16 500)");
    ck(SceneLayoutSignature.of([], apres) !== avantSig, "…et la signature de disposition CHANGE (sinon le pivot resterait borné à l'ancien monde)");
    ck.eq(SceneLayoutSignature.action({ ids: "M:x", layout: avantSig }, { ids: "M:x", layout: SceneLayoutSignature.of([], apres) }, { hasContent: true, deltaEligible: true }), "rebuild", "bornes monde modifiées → reconstruction de la scène");
    ck.eq(SceneLayoutSignature.of([], decorOf(dv.webglCtx())), SceneLayoutSignature.of([], apres), "bornes recalculées à l'identique → MÊME signature (aucune reconstruction parasite)");
  });

  /* ============================================================================================
     MARQUEUR DU PIVOT D'ORBITE — style, thème et CLÉ DE CACHE (`PivotMarker`).

     Bug utilisateur : « le marqueur de pivot n'est vraiment pas visible en version light ». Deux
     causes cumulées, retrouvées dans le code : une couleur EN DUR (`#c8d2e0`, le `--fg` du thème
     SOMBRE) et une opacité de 0,55 qui écrasait le contraste.

     ⚠ CE QUI NE SE TESTE PAS : la RASTÉRISATION et le contraste perçu. Un canvas n'existe pas en
     Node, et « est-ce lisible ? » est un jugement d'œil. Ce qui SE teste — et qui est testé ici —
     c'est tout ce dont dépend la lisibilité : que les encres suivent le thème, que la CLÉ DE CACHE
     le suive aussi (le piège du lot : les clés « ##… » ne sont jamais évincées, une clé fixe
     resservirait éternellement la texture du premier thème rencontré), et que le tracé pose bien
     le halo SOUS le trait, strictement plus épais. Le contexte 2D est ENREGISTRÉ par un stub —
     l'interface `PivotMarkerCanvas` est étroite exprès pour ça.
     ============================================================================================ */
  await section("PivotMarker : le marqueur de pivot suit le THÈME, halo compris (clé de cache incluse)", async () => {
    const NOIR = 0x0e1116, BLANC = 0xffffff;   // fonds réels : --bg du thème sombre / du thème clair

    // ---- bascule clair/sombre : seuil EXACT (moyenne non pondérée > 128), partagé avec readTheme ----
    ck.eq(PivotMarker.isLight(NOIR), false, "fond sombre (#0e1116) → thème sombre");
    ck.eq(PivotMarker.isLight(BLANC), true, "fond blanc → thème clair");
    ck.eq(PivotMarker.isLight(0x808080), false, "gris 128 : la borne est STRICTE (> 128), donc sombre");
    ck.eq(PivotMarker.isLight(0x818181), true, "gris 129 → clair");
    ck.eq(Color.isLightHex(0x818181), true, "…et c'est bien la règle PARTAGÉE Color.isLightHex (aucune 2ᵉ règle)");

    // ---- ENCRES : le trait prend la teinte OPPOSÉE au fond, le halo celle du fond ----
    const surSombre = PivotMarker.ink(NOIR), surClair = PivotMarker.ink(BLANC);
    ck.eq(surSombre.core, "#f2f6fc", "fond sombre → trait quasi BLANC");
    ck.eq(surSombre.halo, "rgba(6,9,13,0.9)", "fond sombre → halo quasi NOIR");
    ck.eq(surClair.core, "#0f141b", "fond clair → trait quasi NOIR (c'était le bug : il restait clair)");
    ck.eq(surClair.halo, "rgba(255,255,255,0.92)", "fond clair → halo BLANC");
    ck(surClair.core !== surSombre.core, "les deux thèmes ne partagent PAS la même encre de trait");
    ck(surClair.halo !== surSombre.halo, "…ni le même halo");

    // ---- CLÉ DE CACHE : LE piège du lot. Deux variantes, jamais une seule. ----
    ck.eq(PivotMarker.cacheKey(NOIR), "##pivot|dark", "clé de cache : variante SOMBRE nommée");
    ck.eq(PivotMarker.cacheKey(BLANC), "##pivot|light", "clé de cache : variante CLAIRE nommée");
    ck(PivotMarker.cacheKey(NOIR) !== PivotMarker.cacheKey(BLANC), "clé de cache DIFFÉRENTE par thème (sinon l'ancienne texture serait resservie à vie)");
    ck.eq(PivotMarker.cacheKey(0x1b2230), PivotMarker.cacheKey(NOIR), "deux fonds sombres distincts → MÊME clé (2 entrées permanentes au maximum)");
    ck.eq(PivotMarker.cacheKey(BLANC).slice(0, 2), "##", "clé « ## » : texture MUTUALISÉE, exemptée de l'éviction LRU des étiquettes");

    // ---- TRACÉ : contexte 2D ENREGISTREUR (aucun canvas, aucun DOM) ----
    const recorder = () => {
      const ops = [];
      const g = {
        strokeStyle: "", lineWidth: 0, lineCap: "",
        setLineDash: (d) => ops.push({ op: "dash", d: d.slice() }),
        beginPath: () => ops.push({ op: "begin" }),
        arc: (x, y, r) => ops.push({ op: "arc", x, y, r, color: g.strokeStyle, width: g.lineWidth }),
        moveTo: (x, y) => ops.push({ op: "move", x, y }),
        lineTo: (x, y) => ops.push({ op: "line", x, y, color: g.strokeStyle, width: g.lineWidth }),
        stroke: () => ops.push({ op: "stroke", color: g.strokeStyle, width: g.lineWidth }),
      };
      return { g, ops };
    };
    const S = 128;
    const { g, ops } = recorder();
    PivotMarker.draw(g, S, PivotMarker.ink(BLANC));
    const strokes = ops.filter((o) => o.op === "stroke");
    ck.eq(strokes.length, 4, "tracé : 4 stroke() = (anneau + croix) × 2 PASSES");
    // ORDRE : halo D'ABORD, trait ENSUITE — inversé, le halo effacerait le trait.
    ck.eq(strokes[0].color, "rgba(255,255,255,0.92)", "passe 1 = HALO (fond clair)");
    ck.eq(strokes[1].color, "rgba(255,255,255,0.92)", "passe 1 : la croix aussi est halotée");
    ck.eq(strokes[2].color, "#0f141b", "passe 2 = TRAIT, posé PAR-DESSUS le halo");
    ck.eq(strokes[3].color, "#0f141b", "passe 2 : croix");
    // ÉPAISSEURS : le halo doit strictement DÉBORDER, sinon il ne produit aucun liseré.
    ck.eq(strokes[2].width, 5, "trait : (2,5/64) × 128 = 5 px canvas (≈ 1,8 px écran — épaisseur historique)");
    ck.eq(strokes[0].width, 11, "halo : 5 + 2 × 3 (liseré de ~1,1 px écran de CHAQUE côté)");
    ck(strokes[0].width > strokes[2].width, "le halo est STRICTEMENT plus épais que le trait (sans quoi : aucun liseré)");
    // POINTILLÉS : posés UNE fois, donc les deux passes tombent sur les MÊMES segments.
    const dashes = ops.filter((o) => o.op === "dash");
    ck.eq(dashes.length, 1, "pointillés posés UNE seule fois (les deux passes partagent la découpe)");
    ck.eq(JSON.stringify(dashes[0].d), JSON.stringify([8, 6]), "pointillés : [8, 6] px canvas = [4, 3] de l'ancienne texture 64 px (longueurs apparentes inchangées)");
    ck.eq(g.lineCap, "round", "extrémités arrondies (le halo enveloppe aussi les bouts de pointillé)");
    // GÉOMÉTRIE : silhouette INCHANGÉE (anneau centré + croix), le marqueur n'a pas grossi.
    const arcs = ops.filter((o) => o.op === "arc");
    ck.eq(arcs.length, 2, "un anneau par passe");
    ck.eq(arcs[0].x, 64, "anneau centré en x");
    ck.eq(arcs[0].y, 64, "anneau centré en y");
    ck.eq(arcs[0].r, 34.56, "rayon d'anneau : 0,27 × 128 (= 0,27 × 64 de l'ancienne texture, à l'échelle)");
    const lines = ops.filter((o) => o.op === "line");
    ck.eq(lines.length, 4, "deux bras par passe (horizontal + vertical)");
    ck.eq(lines[0].x, 64 + 57.6, "bras horizontal : demi-longueur 0,45 × 128");
    ck.eq(lines[1].y, 64 + 57.6, "bras vertical : même demi-longueur");

    // ---- DISCRIMINATION : le tracé prend bien SES encres du paramètre (une fonction qui les
    //      ignorerait passerait au vert sur le seul test ci-dessus). ----
    const { g: g2, ops: ops2 } = recorder();
    PivotMarker.draw(g2, S, PivotMarker.ink(NOIR));
    const strokes2 = ops2.filter((o) => o.op === "stroke");
    ck.eq(strokes2[0].color, "rgba(6,9,13,0.9)", "discrimination : fond SOMBRE → halo noir");
    ck.eq(strokes2[2].color, "#f2f6fc", "discrimination : fond SOMBRE → trait blanc");
    // …et la TAILLE est bien un PARAMÈTRE (tout est exprimé en ratios du côté) : redessiné sur la
    // texture 64 px d'origine, le tracé retombe EXACTEMENT sur les cotes historiques. C'est ce qui
    // prouve que la silhouette n'a pas bougé — seul le contraste a changé.
    const petit = recorder();
    PivotMarker.draw(petit.g, 64, PivotMarker.ink(NOIR));
    ck.eq(petit.ops.filter((o) => o.op === "arc")[0].r, 17.28, "côté 64 → rayon 17,28 (= 0,27 × 64, l'ancien rayon)");
    ck.eq(JSON.stringify(petit.ops.filter((o) => o.op === "dash")[0].d), JSON.stringify([4, 3]), "côté 64 → pointillés [4, 3] (exactement l'ancien tracé)");
    ck.eq(petit.ops.filter((o) => o.op === "stroke")[2].width, 2.5, "côté 64 → trait 2,5 px (exactement l'ancienne épaisseur)");

    // ---- RÉGLAGES : valeurs EN DUR, pour que toute retouche à l'œil se voie ici ----
    ck.eq(PivotMarker.SCREEN_SIZE_PX, 46, "taille écran conservée (~46 px, quel que soit le zoom)");
    ck.eq(PivotMarker.OPACITY, 0.85, "opacité relevée de 0,55 à 0,85 (0,55 dissolvait le trait sur fond clair)");
    ck.eq(PivotMarker.TEXTURE_SIZE_PX, 128, "texture 128 px : le liseré est un détail FIN, 64 px les confondait");
  });

  /* ============================================================================================
     ORIGINE D'UNE BAIE SANS POSITION — les DERNIERS replis sur 0 (cadrage caméra, outil de
     positionnement, placement automatique). Cf. docs/placement.md §6.12/§6.13.

     ⚠ CORRECTIONS, pas des paritéss : ces valeurs CHANGENT volontairement. Le lot précédent avait
     tranché que l'origine d'un contenu sans `dc_x`/`dc_y` est sa DEMI-EMPREINTE (là où les deux vues
     le DESSINENT), et aligné la résolution des ports ; le cadrage caméra, lui, repliait encore sur 0
     — « Localiser » visait donc le coin de la salle et non la baie. Le placement automatique traitait
     de même une baie non positionnée comme étant en (0, 0), et pouvait empiler la nouvelle dessus.
     Les valeurs ci-dessous sont dérivées À LA MAIN du modèle, jamais de la sortie d'une implémentation.
     ============================================================================================ */
  await section("Origine d'une baie SANS position : cadrage caméra, positionnement, placement auto (CORRECTIONS)", async () => {
  {
    const s = await makeStore();
    const dc = await s.create("datacenters", { name: "Salle O", width_mm: 6000, depth_mm: 4000, cell_mm: 600 });
    // marges verticales à 0 + hauteur ronde ⇒ toutes les cotes Z ci-dessous sont exactes à la main.
    const commun = { u_count: 42, datacenter_id: dc.id, vmargin_mm: 0, vmargin_bottom_mm: 0, height_mm: 2000, width_mm: 600, depth: 1000 };
    const rkPos = await s.create("racks", Object.assign({ name: "R-posée", dc_x: 1500, dc_y: 2500 }, commun));
    const rkNu = await s.create("racks", Object.assign({ name: "R-nue" }, commun));                       // SANS dc_x/dc_y
    const rkNu90 = await s.create("racks", Object.assign({ name: "R-nue90", orientation: 90 }, commun, { width_mm: 800, depth: 1200 }));
    const dv = new DatacenterView(s, {}, {});   // garde headless
    dv.dcId = dc.id;

    // ---- « Localiser » un équipement RACKÉ : la caméra vise la baie, pas le coin de la salle ----
    const eqNu = await s.create("equipments", { name: "eq-nue", placement_mode: "rack", rack_id: rkNu.id, rack_u: 1, u_height: 1 });
    const cNu = dv.equipCenter(eqNu, dc.id);
    ck.eq(cNu.x, 300, "equipCenter(baie NUE, mode rack) : x = demi-LARGEUR (600/2), plus 0");
    ck.eq(cNu.y, 500, "equipCenter(baie NUE, mode rack) : y = demi-PROFONDEUR (1000/2), plus 0");
    ck.eq(cNu.z, 22.225, "equipCenter : z inchangé = milieu du 1er U (0,5 × 44,45)");
    const eqPos = await s.create("equipments", { name: "eq-posée", placement_mode: "rack", rack_id: rkPos.id, rack_u: 1, u_height: 1 });
    const cPos = dv.equipCenter(eqPos, dc.id);
    ck(cPos.x === 1500 && cPos.y === 2500, "equipCenter(baie POSÉE) : inchangé — la correction ne touche QUE l'absence de position");

    // ---- modes `side` / `wall` : même repli, même correction (z = milieu de la baie) ----
    // ⚠ 3ᵉ CORRECTION, trouvée par le balayage : cette branche était INATTEIGNABLE. `dim_mode` vaut
    // « free » pour tout placement autre que « rack » (le formulaire de baie l'écrit en dur pour
    // side/wall), et la branche « libre » — qui la précédait — rendait `null` faute de `dc_id`.
    // « Localiser » un équipement monté en marge ou en paroi visait donc (0, 0, 0), même sur une baie
    // PARFAITEMENT positionnée. D'où les deux assertions sur `rkPos` : elles ne portent pas sur le repli.
    // `sansNull` : garde de LISIBILITÉ — sans elle, une régression qui refait rendre `null` CRASHE la
    // section et masque toutes les assertions suivantes (on ne verrait plus QUE le crash).
    const sansNull = (v) => v || { x: null, y: null, z: null };
    const eqSide = await s.create("equipments", { name: "eq-side", placement_mode: "side", rack_id: rkNu.id, side_u: 1, free_w_mm: 40, free_h_mm: 40, free_l_mm: 100 });
    const cSide = sansNull(dv.equipCenter(eqSide, dc.id));
    ck(cSide.x !== null, "equipCenter(mode side) : la branche side/wall est ATTEIGNABLE (elle rendait `null`)");
    ck(cSide.x === 300 && cSide.y === 500, "equipCenter(baie NUE, mode side) : centre de la baie DESSINÉE");
    ck.eq(cSide.z, 1000, "equipCenter(mode side) : z = mi-hauteur (2000/2)");
    const eqWall = await s.create("equipments", { name: "eq-wall", placement_mode: "wall", rack_id: rkNu.id, wall_u: 1, free_w_mm: 40, free_h_mm: 40, free_l_mm: 100 });
    const cWall = sansNull(dv.equipCenter(eqWall, dc.id));
    ck(cWall.x === 300 && cWall.y === 500, "equipCenter(baie NUE, mode wall) : centre de la baie DESSINÉE");
    const eqSideP = await s.create("equipments", { name: "eq-side-P", placement_mode: "side", rack_id: rkPos.id, side_u: 1, free_w_mm: 40, free_h_mm: 40, free_l_mm: 100 });
    const cSideP = sansNull(dv.equipCenter(eqSideP, dc.id));
    ck(cSideP.x === 1500 && cSideP.y === 2500, "equipCenter(mode side, baie POSÉE) : la caméra vise la baie, plus l'origine de la salle");
    // le mode LIBRE, lui, reste intercepté par sa propre branche (rien ne l'a court-circuité).
    const eqLibre = await s.create("equipments", { name: "eq-libre", placement_mode: "manual", dim_mode: "free", dc_id: dc.id, dc_x: 2000, dc_y: 1000, dc_z: 0, free_w_mm: 400, free_l_mm: 400, free_h_mm: 200 });
    const cLibre = dv.equipCenter(eqLibre, dc.id);
    ck(cLibre.x === 2000 && cLibre.y === 1000 && cLibre.z === 100, "equipCenter(mode LIBRE) : inchangé (position + mi-hauteur de la boîte)");

    // ---- mode `tray` (posé sur une étagère) : la 3ᵉ ligne qui repliait sur 0 ----
    const tray = await s.create("rackItems", { kind: "tray", rack_id: rkNu.id, u: 5, u_height: 2, tray_u: 1, side: "front" });
    const eqTray = await s.create("equipments", { name: "eq-tray", placement_mode: "tray", dim_mode: "free", tray_item_id: tray.id, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 });
    const cTray = dv.equipCenter(eqTray, dc.id);
    ck(cTray.x === 300 && cTray.y === 500, "equipCenter(baie NUE, mode tray) : centre de la baie DESSINÉE");
    ck(cTray.z > 0 && isFinite(cTray.z), "equipCenter(mode tray) : z reste la mi-hauteur de l'espace utile du plateau");

    // ---- « Localiser » une BAIE : même cible ----
    dv.locateRack(rkNu.id);
    ck(dv._focusTarget.p.x === 300 && dv._focusTarget.p.y === 500, "locateRack(baie NUE) : la caméra vise la baie (demi-empreinte)");
    ck.eq(dv._focusTarget.p.z, 1000, "locateRack : z = mi-hauteur de la baie (inchangé)");
    dv.locateRack(rkPos.id);
    ck(dv._focusTarget.p.x === 1500 && dv._focusTarget.p.y === 2500, "locateRack(baie POSÉE) : inchangé");

    // ---- isolement d'une baie (cible d'orbite) : même règle ----
    dv.isolateRack(rkNu.id);
    ck(dv.camTarget.x === 300 && dv.camTarget.y === 500, "isolateRack(baie NUE) : pivot d'orbite SUR la baie");
    ck.eq(dv.camTarget.z, 1000, "isolateRack : z = mi-hauteur (inchangé)");
    dv.hidden3dRacks = new Set();

    // ---- outil de POSITIONNEMENT : le repli n'est pas la demi-empreinte ORIENTÉE ----
    // ⚠ 2ᵉ correction : `rackHalfExtents` PERMUTE largeur/profondeur à 90/270 ; le dessin, lui, pose
    // toujours la baie à (width/2, depth/2). L'ancien repli plaçait donc le rectangle de l'outil en
    // (600, 400) pour une baie 800 × 1200 tournée à 90° — 200 mm à côté de la baie affichée.
    dv.view = "top";
    const sc = dv.posScene();
    const e90 = sc.rects.find((r) => r.id === rkNu90.id);
    ck.eq(e90.rect.cx, 400, "posScene(baie NUE à 90°) : cx = demi-LARGEUR 800/2 (et non la demi-profondeur 600)");
    ck.eq(e90.rect.cy, 600, "posScene(baie NUE à 90°) : cy = demi-PROFONDEUR 1200/2 (et non la demi-largeur 400)");
    ck(e90.rect.hx === 600 && e90.rect.hy === 400, "posScene : l'EMPRISE, elle, reste orientée (permutée à 90°) — seul le repli change");
    const ePos = sc.rects.find((r) => r.id === rkPos.id);
    ck(ePos.rect.cx === 1500 && ePos.rect.cy === 2500, "posScene(baie POSÉE) : inchangé");

    // ---- placement AUTOMATIQUE : une baie non positionnée occupe la maille où elle est DESSINÉE ----
    const dc2 = await s.create("datacenters", { name: "Salle P", width_mm: 6000, depth_mm: 4000, cell_mm: 600 });
    await s.create("racks", { name: "R-nue-P", u_count: 42, datacenter_id: dc2.id, width_mm: 600, depth: 1000 });   // centre DESSINÉ = (300, 500)
    const libre = dv.freeCell(dc2);
    ck(libre.x === 900 && libre.y === 300, "freeCell : la 1re maille (300, 300) est OCCUPÉE par la baie nue dessinée en (300, 500) → (900, 300)");
    const dc3 = await s.create("datacenters", { name: "Salle Q", width_mm: 6000, depth_mm: 4000, cell_mm: 600 });
    const libreVide = dv.freeCell(dc3);
    ck(libreVide.x === 300 && libreVide.y === 300, "freeCell : salle vide → 1re maille, comportement inchangé");
  }
  });

  /* ============================================================================================
     « LOCALISER » : CE QUI EST CADRÉ, ET À QUELLE TAILLE — attentes EN DUR (comportement CHANGÉ).
     Le cadrage ne dépendait d'aucune règle nommée : l'étendue poussée au moteur valait la seule
     HAUTEUR de la baie (une baie murale plus large que haute était donc cadrée trop serré), et une
     CONSTANTE de 1 600 mm pour tout équipement libre, quelle que soit sa taille réelle — d'où un
     gros coffret qui débordait de la vue et un petit boîtier qui s'y perdait. Les valeurs ci-dessous
     sont dérivées à la main du modèle et de `CameraFraming`, jamais de la sortie d'une implémentation.
     ============================================================================================ */
  await section("« Localiser » : on cadre LA BAIE (équipement monté) ou L'OBJET (libre), à sa taille RÉELLE", async () => {
  {
    const s = await makeStore();
    const dc = await s.create("datacenters", { name: "Salle L", width_mm: 8000, depth_mm: 6000, cell_mm: 600 });
    const commun = { u_count: 42, datacenter_id: dc.id, vmargin_mm: 0, vmargin_bottom_mm: 0, height_mm: 2000, width_mm: 600, depth: 1000, dc_x: 2000, dc_y: 3000 };
    const rk = await s.create("racks", Object.assign({ name: "R-42U" }, commun));
    const dv = new DatacenterView(s, {}, {});   // garde headless
    dv.dcId = dc.id;

    // ---- équipement MONTÉ EN BAIE : la cible est la BAIE, centrée (et non l'équipement) ----
    const eq1u = await s.create("equipments", { name: "sw-1U", placement_mode: "rack", rack_id: rk.id, rack_u: 1, u_height: 1 });
    dv.locateEquipment(eq1u.id);
    ck(dv._focusTarget.p.x === 2000 && dv._focusTarget.p.y === 3000, "équipement en baie : la caméra vise la baie en X/Y");
    ck.eq(dv._focusTarget.p.z, 1000, "équipement en baie : z = MI-HAUTEUR DE LA BAIE (2000/2) — la baie est CENTRÉE, l'équipement se repère à sa surbrillance");
    ck.eq(dv._focusTarget.extent, 2000, "équipement en baie : étendue cadrée = plus grande cote de la BAIE (2 000 mm)");
    ck.eq(CameraFraming.halfExtentFor(dv._focusTarget.extent), 1111.111111111111, "…soit 2 222 mm de monde cadré : la baie occupe 90 % de la vue (contre 62,5 % avant)");
    // l'équipement lui-même reste résolu par `equipCenter` (son U), qui n'est PAS ce qu'on cadre.
    ck.eq(dv.equipCenter(eq1u, dc.id).z, 22.225, "equipCenter : rend toujours le centre de l'ÉQUIPEMENT (milieu du 1er U) — le cadrage, lui, vise la baie");
    // même règle pour un monté en marge (side) et un posé sur étagère (tray) : c'est la baie qu'on cadre.
    const eqSide = await s.create("equipments", { name: "eq-side", placement_mode: "side", rack_id: rk.id, side_u: 1, free_w_mm: 40, free_h_mm: 40, free_l_mm: 100 });
    dv.locateEquipment(eqSide.id);
    ck(dv._focusTarget.p.z === 1000 && dv._focusTarget.extent === 2000, "équipement en MARGE : même cadrage — la baie entière");
    const tray = await s.create("rackItems", { kind: "tray", rack_id: rk.id, u: 5, u_height: 2, tray_u: 1, side: "front" });
    const eqTray = await s.create("equipments", { name: "eq-tray", placement_mode: "tray", dim_mode: "free", tray_item_id: tray.id, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 });
    dv.locateEquipment(eqTray.id);
    ck(dv._focusTarget.p.z === 1000 && dv._focusTarget.extent === 2000, "équipement sur ÉTAGÈRE : même cadrage — la baie entière");

    // ---- baie visée DIRECTEMENT : l'étendue n'est plus la seule hauteur ----
    dv.locateRack(rk.id);
    ck.eq(dv._focusTarget.extent, 2000, "locateRack(42U) : étendue = 2 000 mm (la hauteur domine ici)");
    const rkMural = await s.create("racks", { name: "R-mural", u_count: 6, datacenter_id: dc.id, vmargin_mm: 0, vmargin_bottom_mm: 0, height_mm: 400, width_mm: 600, depth: 600, dc_x: 5000, dc_y: 1000 });
    dv.locateRack(rkMural.id);
    ck.eq(dv._focusTarget.extent, 600, "locateRack(baie MURALE 600 × 600 × 400) : étendue = sa LARGEUR — cadrer sa seule hauteur (400) l'aurait tronquée");
    ck.eq(dv._focusTarget.p.z, 200, "locateRack(murale) : z = mi-hauteur (400/2)");
    ck.eq(CameraFraming.halfExtentFor(600), 333.3333333333333, "…666 mm de monde cadré : 90 % de la vue, au-dessus de la limite de zoom");

    // ---- une baie MASQUÉE ne peut pas être localisée : « Localiser » la démasque ----
    dv.hidden3dRacks = new Set([rk.id, rkMural.id]);
    dv.locateRack(rk.id);
    ck(!dv.hidden3dRacks.has(rk.id), "locateRack : la baie visée est DÉMASQUÉE (un isolement laissé par un focus précédent la rendait invisible)");
    ck(dv.hidden3dRacks.has(rkMural.id), "locateRack : les AUTRES masquages sont respectés (on ne réinitialise pas un choix de l'utilisateur)");
    dv.hidden3dRacks = new Set();

    // ---- équipement LIBRE : l'étendue suit la taille RÉELLE de l'objet, plus une constante ----
    const gros = await s.create("equipments", { name: "armoire", placement_mode: "manual", dim_mode: "free", dc_id: dc.id, dc_x: 1000, dc_y: 1000, dc_z: 0, free_w_mm: 2000, free_l_mm: 1000, free_h_mm: 3000 });
    dv.locateEquipment(gros.id);
    ck.eq(dv._focusTarget.extent, 3000, "équipement LIBRE (2000 × 1000 × 3000) : étendue = sa plus grande cote — l'ancienne valait 1 600 mm et l'objet DÉBORDAIT de la vue");
    ck(dv._focusTarget.p.x === 1000 && dv._focusTarget.p.y === 1000, "équipement LIBRE : la caméra vise l'objet");
    ck.eq(dv._focusTarget.p.z, 1500, "équipement LIBRE : z = mi-hauteur de sa boîte");
    const petit = await s.create("equipments", { name: "boitier", placement_mode: "manual", dim_mode: "free", dc_id: dc.id, dc_x: 4000, dc_y: 2000, dc_z: 0, free_w_mm: 100, free_l_mm: 100, free_h_mm: 100 });
    dv.locateEquipment(petit.id);
    ck.eq(dv._focusTarget.extent, 100, "petit boîtier LIBRE : étendue = 100 mm…");
    ck.eq(CameraFraming.halfExtentFor(dv._focusTarget.extent), 300, "…mais la LIMITE DE ZOOM cadre quand même 600 mm de monde (sinon 111 mm : plus aucun contexte)");

    // ---- équipement LIBRE SANS position : viser l'objet là où il est DESSINÉ (13e site du balayage §6.13) ----
    const nu = await s.create("equipments", { name: "libre-nu", placement_mode: "manual", dim_mode: "free", dc_id: dc.id, free_w_mm: 800, free_l_mm: 600, free_h_mm: 400 });
    const cNu = dv.equipCenter(nu, dc.id) || { x: null, y: null, z: null };
    ck(cNu.x !== null, "equipCenter(libre SANS position) : ne rend plus `null` (« Localiser » repliait sur le coin de la salle)");
    ck(cNu.x === 400 && cNu.y === 300, "equipCenter(libre SANS position) : demi-empreinte (800/2, 600/2) — là où l'objet est DESSINÉ");
    ck.eq(cNu.z, 200, "equipCenter(libre SANS position) : z = mi-hauteur de la boîte");
    const ailleurs = await s.create("datacenters", { name: "Salle M", width_mm: 3000, depth_mm: 3000, cell_mm: 600 });
    ck.eq(dv.equipCenter(nu, ailleurs.id), null, "equipCenter : un équipement d'UNE AUTRE salle reste `null` (la garde de salle est conservée)");

    // ---- cibles PONCTUELLES : cadrage volontairement PRÉSERVÉ (constantes recalibrées) ----
    const wp = await s.create("waypoints", { kind: "brush", wp_type: "datacenter", name: "brosse", datacenter_id: dc.id, rack_id: rk.id, rack_u: 10, u_height: 2, depth_mm: 100 });
    dv.locateWaypoint(wp.id);
    ck.eq(dv._focusTarget.extent, 1900, "waypoint : étendue de CONTEXTE recalibrée (1 900 mm)…");
    const mondeWp = 2 * CameraFraming.halfExtentFor(dv._focusTarget.extent);
    ck(Math.abs(mondeWp - 2080) / 2080 < 0.02, "…pour que le monde cadré reste celui d'avant (2 080 mm) à 2 % près — ce lot ne retouche pas ces trois cibles");
  }
  });

  /* ============================================================================================
     « LOCALISER » UN CONTENU D'ÉTAGE — cadrage en MONDE, Vue étage, et PORTÉE amenée à la cible.
     Cf. docs/placement.md §6.27 (et §6.4 : l'étage est un CONTENEUR, pas une salle virtuelle).

     Il n'y a AUCUNE parité à prouver ici : le chemin n'existait pas. La clé « salle » historique
     (`Store.equipmentDcId`, retirée depuis — §6.33) rendait `null` pour un posé d'étage PAR
     CONCEPTION, donc « Localiser » s'arrêtait sur le toast « non placé dans une salle ». Toutes les
     valeurs ci-dessous sont dérivées À LA MAIN du modèle.

     Repères du décor, identiques à ceux des sections « décor d'étage » plus haut : deux sites SANS
     GPS → Alpha à l'origine, Beta au repli de 5 km (50 000 mm à l'échelle par défaut) ; hauteur
     d'étage forcée à 4 000 mm + 2 000 mm d'écart inter-niveaux → socles 0 et 6 000.
     ============================================================================================ */
  await section("« Localiser » un posé d'ÉTAGE : Vue étage, cible en MONDE, portée amenée au bâtiment", async () => {
  {
    const s = await makeStore();
    const siteA = await s.create("sites", { name: "Alpha" });
    const siteB = await s.create("sites", { name: "Beta" });
    const siteC = await s.create("sites", { name: "Gamma" });
    await s.create("floors", { location: siteA.id, floor: "0", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000 });
    await s.create("floors", { location: siteA.id, floor: "1", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000 });
    await s.create("floors", { location: siteB.id, floor: "0", width_mm: 12000, depth_mm: 9000, cell_mm: 600, height_mm: 4000 });
    const dcA0 = await s.create("datacenters", { name: "Salle A0", location: siteA.id, floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcB0 = await s.create("datacenters", { name: "Salle B0", location: siteB.id, floor: "0", width_mm: 5000, depth_mm: 4000, floor_x: 500, floor_y: 500 });
    // ONDULEUR posé sur le plan de Beta / étage 0, dans un AUTRE bâtiment que la salle active : c'est le
    // cas qui met la PORTÉE en défaut (le plan de Beta n'est pas émis tant qu'aucune de ses salles ne l'est).
    const eqF = await s.create("equipments", {
      name: "ONDULEUR", placement_mode: "floor", dim_mode: "free",
      location: siteB.id, floor: "0", floor_x: 4000, floor_y: 2000,
      dc_z: 250, dc_orientation: 90, free_w_mm: 200, free_l_mm: 400, free_h_mm: 300,
    });
    const pF = await s.create("ports", { equipment_id: eqF.id, name: "in", face_x: 0.25, face_y: 0.5, face_side: "front" });
    const dv = new DatacenterView(s, {}, {});   // garde headless
    dv.view = "3d"; dv.useWebGL = true; dv.dcId = dcA0.id; dv.multiDc = true; dv.visibleDcIds = new Set([dcA0.id]);

    // ---- LE PIÈGE, d'abord CONSTATÉ : hors portée, l'objet n'est pas dans la scène ----
    const equipsDessines = () => (dv.webglCtx().floorDecor || { equips: [] }).equips;
    ck.eq(equipsDessines().length, 0, "portée limitée à Alpha : le posé de Beta n'est PAS dessiné (son plan d'étage n'est pas émis)");
    // …et pourtant le REPÈRE, lui, est déjà complet : la cible ne dépend pas de ce qu'on affiche (§6.8).
    const oHorsPortee = dv.floor.equipFloorOrigin(dv.currentMultiLayout(), eqF);

    // ---- « LOCALISER » : bascule en Vue étage + cadrage MONDE ----
    dv.multiDc = false; dv.view = "top";   // état de départ quelconque : la localisation doit le corriger
    dv.locateEquipment(eqF.id);
    ck.eq(dv.view, "3d", "posé d'étage : « Localiser » bascule en 3D");
    ck.eq(dv.multiDc, true, "posé d'étage : … en VUE ÉTAGE (repère bâtiment) — le repère salle ne peut pas l'exprimer");
    ck.eq(dv.dcId, dcA0.id, "posé d'étage : la salle ACTIVE n'est pas déplacée (la Vue étage montre un bâtiment)");
    // Cible : origine du bâtiment Beta (50 000) + floor_x 4 000 ; y = 0 + floor_y 2 000 ; z = socle 0 + dc_z 250 + demi-hauteur 150.
    ck.eq(dv._focusTarget.p.x, 54000, "cible x = origine du bâtiment Beta (50 000) + floor_x (4 000)");
    ck.eq(dv._focusTarget.p.y, 2000, "cible y = origine du bâtiment Beta (0) + floor_y (2 000)");
    ck.eq(dv._focusTarget.p.z, 400, "cible z = socle du niveau (0) + dc_z (250) + demi-hauteur (150) — 650 signalerait un dc_z compté DEUX fois");
    ck.eq(dv._focusTarget.extent, 400, "étendue cadrée = plus grande cote de l'objet (200 × 400 × 300), comme un libre de salle");
    ck.eq(CameraFraming.halfExtentFor(dv._focusTarget.extent), 300, "…et la LIMITE DE ZOOM cadre 600 mm de monde (l'objet est plus petit qu'une baie)");
    ck(Math.abs(dv._focusTarget.face.az) < 1e-9, "azimut « en face » : lacet 90° → façade vers l'EST → caméra sur +X (az = 0)");
    ck.eq(dv._focusTarget.face.el, CameraFraming.FOCUS_ELEVATION_RAD, "élévation = la plongée par défaut (source unique CameraFraming)");
    ck.eq(dv.focusEqId, eqF.id, "l'équipement est mis en SURBRILLANCE (le moteur l'allume désormais aussi dans le décor d'étage)");
    ck.eq(dv.selRackId, null, "aucune baie hôte : rien à isoler");
    ck.eq(dv.focusPortId, null, "localiser l'ÉQUIPEMENT ne met aucun port en évidence");

    // ---- PORTÉE : le bâtiment de la cible est entré dans la scène, donc l'objet est DESSINÉ ----
    ck(dv.visibleDcIds.has(dcB0.id), "portée : la salle du bâtiment visé est ajoutée (sinon la caméra cadrerait un point VIDE)");
    ck(dv.visibleDcIds.has(dcA0.id), "portée : les salles déjà affichées sont CONSERVÉES (on ajoute, on ne remplace pas)");
    const dessines = equipsDessines();
    ck.eq(dessines.length, 1, "portée élargie : le posé d'étage est maintenant DESSINÉ");
    // Garde de LISIBILITÉ (même motif que `sansNull` plus haut) : si la portée cessait d'être élargie, un
    // accès direct à `dessines[0]` CRASHERAIT la section et masquerait la répartition des échecs — or c'est
    // elle qui informe. Sonde mesurée des DEUX côtés : 2 FAIL + 1 crash sans cette garde, 4 FAIL lisibles avec.
    const premier = dessines[0] || { id: null, x: null, y: null, baseZ: null };
    ck.eq(premier.id, eqF.id, "…et c'est bien celui qu'on localise");
    ck(premier.x === dv._focusTarget.p.x && premier.y === dv._focusTarget.p.y,
      "la caméra vise EXACTEMENT là où la scène dessine l'objet (même source : FloorLayout.equipFloorOrigin)");
    ck.eq(premier.baseZ + 250 + 150, dv._focusTarget.p.z, "…et le z de la cible se recompose depuis le socle poussé au moteur");
    // REPÈRE ⊥ PORTÉE : élargir la portée n'a RIEN déplacé — la cible était déjà calculable avant.
    const oDansPortee = dv.floor.equipFloorOrigin(dv.currentMultiLayout(), eqF);
    ck.eq(JSON.stringify(oDansPortee), JSON.stringify(oHorsPortee), "l'origine du posé est la MÊME hors portée et dans la portée (repère ⊥ portée)");

    // ---- « LOCALISER » UN PORT du posé : même chemin, cadrage serré sur le connecteur ----
    dv.locatePort(pF.id);
    ck.eq(dv.multiDc, true, "port d'un posé d'étage : Vue étage également");
    ck.eq(dv.focusPortId, pF.id, "port : le connecteur lui-même est mis en évidence");
    ck.eq(dv.focusEqId, eqF.id, "port : son équipement porteur aussi");
    ck.eq(dv._focusTarget.extent, 1250, "port : étendue de CONTEXTE (cible PONCTUELLE), inchangée par rapport aux ports de salle");
    // local (−50 ; −200 ; 400) tourné de 90° → (+200 ; −50) ; z = 250 + 150 (face_y 0,5 → mi-hauteur).
    ck(Math.abs(dv._focusTarget.p.x - 54200) < 1e-9, "port : x = 54 000 + 200 (local tourné de 90°)");
    ck(Math.abs(dv._focusTarget.p.y - 1950) < 1e-9, "port : y = 2 000 − 50");
    ck(Math.abs(dv._focusTarget.p.z - 400) < 1e-9, "port : z = socle 0 + dc_z 250 + mi-hauteur 150 — le port tombe DANS la boîte dessinée");
    // Le résolveur consulté est bien le pendant SANS SALLE : `resolvePort3D` (scopé par salle) ne sait pas.
    const r3 = new Resolver3D(s);
    ck.eq(r3.resolvePort3D(pF.id, dcB0.id), null, "contrôle de discrimination : `resolvePort3D` (scopé par SALLE) ne résout PAS ce port — c'est bien l'autre chemin qui travaille");

    // ---- NON-RÉGRESSION : un équipement de SALLE reste sur le chemin salle (repère salle, mono-DC) ----
    const eqSalle = await s.create("equipments", { name: "coffret", placement_mode: "manual", dim_mode: "free", dc_id: dcB0.id, dc_x: 1000, dc_y: 800, dc_z: 0, free_w_mm: 400, free_l_mm: 400, free_h_mm: 200 });
    dv.locateEquipment(eqSalle.id);
    ck.eq(dv.multiDc, false, "équipement de SALLE : chemin inchangé — repère salle, Vue étage désactivée");
    ck.eq(dv.dcId, dcB0.id, "équipement de SALLE : la salle active devient la sienne (comportement historique)");
    ck(dv._focusTarget.p.x === 1000 && dv._focusTarget.p.y === 800, "équipement de SALLE : cible en LOCAL SALLE, inchangée");
    ck.eq(dv.locateFloorEquip(eqSalle), false, "le chemin d'étage se DÉSISTE pour un contenu de salle (l'appelant poursuit)");

    // ---- BÂTIMENT SANS AUCUNE SALLE : refus explicite, jamais un cadrage sur le vide ----
    // La portée d'affichage s'exprime en SALLES : un bâtiment qui n'en a aucune ne peut pas y entrer.
    const eqG = await s.create("equipments", {
      name: "GROUPE", placement_mode: "floor", dim_mode: "free",
      location: siteC.id, floor: "0", floor_x: 1000, floor_y: 1000, free_w_mm: 500, free_l_mm: 500, free_h_mm: 500,
    });
    const porteeAvant = [...dv.visibleDcIds].sort().join(",");
    ck.eq(dv.scopeFloorBuilding(siteC.id), false, "bâtiment SANS salle : impossible de l'amener dans la portée");
    ck.eq([...dv.visibleDcIds].sort().join(","), porteeAvant, "…et l'échec ne touche à RIEN (portée inchangée)");
    ck.eq(dv.scopeFloorBuilding(siteB.id), true, "bâtiment AVEC salle : la portée peut l'accueillir");
    dv.multiDc = false; dv.view = "top"; dv._focusTarget = null;
    // `Notify.toast` exige un DOM, absent du harnais : l'exception LEVÉE est donc la PREUVE que le chemin
    // de refus est emprunté. Si la garde disparaissait, `focusWorld3DAt` (headless-safe) programmerait une
    // cible sans lever quoi que ce soit — les deux assertions basculeraient ensemble.
    let refus = null;
    try { dv.locateEquipment(eqG.id); } catch (err) { refus = err; }
    ck(refus !== null, "bâtiment sans salle : le chemin de REFUS est bien emprunté (le toast réclame un DOM)");
    ck.eq(dv._focusTarget, null, "…et AUCUNE cible caméra n'est programmée : on refuse au lieu de viser le vide");
    ck.eq(dv.view, "top", "…la vue courante n'est pas non plus basculée pour rien");
  }
  });

  /* ============================================================================================
     ÉQUIVALENCE prédicat ⟺ action — le verrou qui rend un BOUTON MORT structurellement impossible.
     Cf. docs/placement.md §6.28, et la décision D6 du chantier « câblage des équipements d'étage ».

     POURQUOI CE TEST EXISTE. `core/Locatable` se dit « MIROIR des refus de DcInteract.locateEquipment /
     locatePort ». Un miroir n'est pas une intention : c'est une propriété, et elle se VÉRIFIE. Les tests
     de `Locatable` (test-core-store.js) éprouvent la RÈGLE ; ceux-ci éprouvent qu'elle correspond, mode
     de placement par mode de placement, à ce que l'action fait RÉELLEMENT. Sans cette section, les deux
     côtés peuvent dériver sans qu'aucun test ne rougisse — exactement la panne que le lot corrige (le
     prédicat historique `!!equipmentDcId`, retiré depuis, cachait le bouton d'un posé d'étage que
     l'action sait viser).

     CONVENTION DE MESURE : « l'action aboutit » = elle programme une cible caméra (`_focusTarget`). Un
     refus passe par `Notify.toast`, qui exige un DOM absent du harnais et LÈVE donc — l'exception est
     rattrapée et vaut refus. Les deux signaux (cible posée / exception) sont redondants par construction
     et sont vérifiés ENSEMBLE plus bas, si bien qu'une divergence entre eux ferait rougir aussi.
     ============================================================================================ */
  await section("« Localiser » : le PRÉDICAT des boutons est le miroir EXACT de l'action (anti-bouton mort)", async () => {
  {
    const s = await makeStore();
    // Bâtiment « liege » : une salle → sa Vue étage est atteignable. Bâtiment « namur » : AUCUNE salle.
    const dc = await s.create("datacenters", { name: "Salle A", location: "liege", floor: "0", width_mm: 8000, depth_mm: 6000, floor_x: 1000, floor_y: 1000 });
    await s.create("floors", { location: "liege", floor: "1", width_mm: 20000, depth_mm: 15000, cell_mm: 600 });
    await s.create("floors", { location: "namur", floor: "0", width_mm: 12000, depth_mm: 9000, cell_mm: 600 });
    const rack = await s.create("racks", { name: "R1", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 1000, dc_y: 1000 });
    const rackNu = await s.create("racks", { name: "R-hors-salle", width_mm: 600, depth: 1000, u_count: 42, location: "liege" });
    const tray = await s.create("rackItems", { rack_id: rack.id, kind: "tray", tray_type: "cantilever", u: 10, u_height: 3, tray_u: 1, depth_mm: 400 });
    const libre = { dim_mode: "free", free_w_mm: 200, free_l_mm: 300, free_h_mm: 150 };
    // ⚠ Cotes RÉDUITES pour les posés sur ÉTAGÈRE : la validation BORNE un posé au volume utile au-dessus
    // du plateau (`tray_u: 1` sur une étagère de 3 U ⇒ ~2 U de garde), et un boîtier de 150 mm y est REFUSÉ.
    // `create` rend alors `null` SANS lever — d'où aussi la garde `ck(eq, …)` de la boucle : sans elle, une
    // fixture refusée se présente comme un défaut de logique (`Cannot read properties of null`).
    const libreEtagere = { dim_mode: "free", free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 };

    // Un cas par MODE DE PLACEMENT, plus les trois « presque placés » qui piègent (pool, baie hors salle,
    // inventaire pur) et les DEUX faces de la branche étage. L'attente écrite ici est celle du PRÉDICAT ;
    // l'équivalence avec l'action est mesurée ensuite, elle n'est pas supposée.
    const cas = [
      ["monté en baie posée en salle", { placement_mode: "rack", rack_id: rack.id, rack_u: 5, u_height: 1 }, true],
      ["libre POSITIONNÉ en salle", { placement_mode: "manual", ...libre, dc_id: dc.id, dc_x: 2000, dc_y: 1500 }, true],
      ["libre en salle SANS position (repli demi-empreinte, §6.13)", { placement_mode: "manual", ...libre, dc_id: dc.id }, true],
      ["monté en MARGE d'une baie en salle", { placement_mode: "side", ...libre, rack_id: rack.id, rack_side_pos: "left" }, true],
      ["monté en PAROI d'une baie en salle", { placement_mode: "wall", ...libre, rack_id: rack.id }, true],
      ["posé sur une ÉTAGÈRE d'une baie en salle", { placement_mode: "tray", ...libreEtagere, tray_item_id: tray.id, tray_x: 10, tray_y: 10 }, true],
      ["posé sur un ÉTAGE d'un bâtiment AYANT une salle", { placement_mode: "floor", ...libre, location: "liege", floor: "1", floor_x: 3000, floor_y: 2000 }, true],
      ["posé sur un ÉTAGE d'un bâtiment SANS salle", { placement_mode: "floor", ...libre, location: "namur", floor: "0", floor_x: 3000, floor_y: 2000 }, false],
      ["libre SANS dc_id (inventaire pur)", { placement_mode: "manual", ...libre }, false],
      ["en POOL d'une baie (rack_id SANS rack_u)", { placement_mode: "rack", rack_id: rack.id }, false],
      ["monté dans une baie HORS salle", { placement_mode: "rack", rack_id: rackNu.id, rack_u: 3 }, false],
      ["posé sur une étagère d'une baie HORS salle", { placement_mode: "tray", ...libreEtagere, tray_item_id: (await s.create("rackItems", { rack_id: rackNu.id, kind: "tray", tray_type: "cantilever", u: 10, u_height: 3, tray_u: 1, depth_mm: 400 })).id, tray_x: 10, tray_y: 10 }, false],
    ];

    let vus = 0;
    for (const [nom, props, attendu] of cas) {
      const eq = await s.create("equipments", { name: "eq-" + (++vus), ...props });
      // La validation peut REFUSER une fixture et rendre `null` sans lever : on le dit ICI, sinon l'échec
      // se présente plus bas comme un défaut du prédicat (piège rencontré en écrivant cette section).
      ck(eq, `fixture créée — ${nom} (un null ici = enregistrement REFUSÉ par la validation, pas un défaut du prédicat)`);
      if (!eq) continue;
      const port = await s.create("ports", { equipment_id: eq.id, name: "p", face_x: 0.5, face_y: 0.5, face_side: "front" });
      const dv = new DatacenterView(s, {}, {});   // vue NEUVE par cas : ni portée ni isolement hérités du cas précédent
      dv.dcId = dc.id;

      // 1. le prédicat dit ce qu'on attend de lui
      const propose = s.equipmentLocatable(eq.id);
      ck.eq(propose, attendu, `prédicat — ${nom}`);
      ck.eq(s.portLocatable(port.id), attendu, `prédicat (port) — ${nom} : un port suit son équipement porteur`);

      // 2. …et l'ACTION fait exactement cela.
      dv._focusTarget = null;
      let leve = false;
      try { dv.locateEquipment(eq.id); } catch (_) { leve = true; }
      const aAbouti = dv._focusTarget !== null;
      ck.eq(aAbouti, attendu, `action — ${nom} : « Localiser » programme une cible caméra`);
      // 3. L'ÉQUIVALENCE elle-même, énoncée entre les DEUX MESURES et non contre la constante ci-dessus.
      //    ⚠ La distinction n'est pas cosmétique : épinglés chacun à `attendu`, les deux côtés se
      //    surveillent déjà — mais une dérive SIMULTANÉE (quelqu'un « corrige » l'attente en même temps
      //    que le code) passerait au vert. Comparer les deux mesures entre elles ferme ce trou, et c'est
      //    la propriété que `core/Locatable` REVENDIQUE dans son en-tête (« miroir des refus »).
      ck.eq(aAbouti, propose, `ÉQUIVALENCE — ${nom} : bouton proposé ⟺ « Localiser » aboutit`);
      ck.eq(leve, !attendu, `…et le refus passe bien par le toast (signal redondant, il ne doit pas diverger de la cible)`);
    }
    ck.eq(vus, 12, "les douze cas ont bien été joués (garde anti-boucle vide : une liste tronquée passerait sinon au vert)");

    /* ⚠ ÉCART CONNU, NOMMÉ ET VERROUILLÉ ICI — il n'est PAS une exception à l'équivalence ci-dessus, qui
       porte sur `locateEquipment`. Pour les PORTS, un libre rattaché à une salle mais SANS `dc_x`/`dc_y`
       est jugé localisable (son équipement l'est) alors que `Resolver3D` refuse de résoudre ses ports
       (garde `dc_x == null`) et que la scène ne le dessine pas. Le bouton « Localiser » d'un tel port
       n'ouvre donc qu'un toast. C'est ANTÉRIEUR au lot (l'ancien `portDcId` se comportait à l'identique)
       et 0 occurrence dans les deux corpus ; on le VERROUILLE pour qu'il soit constaté et non redécouvert. */
    const sansPos = await s.create("equipments", { name: "libre-sans-position", placement_mode: "manual", ...libre, dc_id: dc.id });
    const portSansPos = await s.create("ports", { equipment_id: sansPos.id, name: "p", face_x: 0.5, face_y: 0.5, face_side: "front" });
    ck.eq(s.portLocatable(portSansPos.id), true, "écart connu : le port d'un libre NON positionné est jugé localisable…");
    const dv2 = new DatacenterView(s, {}, {}); dv2.dcId = dc.id; dv2._focusTarget = null;
    let leve2 = false;
    try { dv2.locatePort(portSansPos.id); } catch (_) { leve2 = true; }
    ck(leve2 && dv2._focusTarget === null, "…alors que `locatePort` REFUSE (port non résolu en 3D) — écart PRÉ-EXISTANT, hors périmètre du lot");
  }
  });

  /* ============================================================================================
     LE CHEMIN SALLE DE « LOCALISER » NOMME SA SALLE LUI-MÊME — retrait du trio `*DcId`.
     Cf. docs/placement.md §6.33, décision D5 du chantier « câblage des équipements d'étage » (lot 7).

     `Store.equipmentDcId`/`portDcId`/`cableDcId` sont SUPPRIMÉS. Les trois chemins salle de
     « Localiser » lisent désormais le conteneur de CHAÎNE (`Store.equipmentNamedContainer`) et le
     RESTREIGNENT sur place à `kind === "room"` : l'hypothèse « ici c'est une salle » cesse d'être
     enfouie dans une primitive du store pour devenir une affirmation locale, que `tsc` vérifie
     (l'union `PlacementContainer` est discriminée).

     ⚠ CE QUE CETTE SECTION MESURE, ET QUE L'ÉQUIVALENCE CI-DESSUS NE VOIT PAS. Celle-ci demande
     « l'action aboutit-elle ? » ; celle-là demande « QUELLE salle a-t-elle cadrée ? ». La distinction
     porte tout le risque du lot : la restriction s'applique au conteneur de CHAÎNE, jamais au conteneur
     IMMÉDIAT — celui d'un serveur monté est sa BAIE, celui d'un boîtier posé son ÉTAGÈRE. C'est le
     piège symétrique de §6.29 (nommer la baie au lieu de la salle), et il se mesure ici sur la salle
     RÉELLEMENT visée. D'où DEUX salles dans le décor : la vue démarre sur A et doit basculer sur B — à
     une seule salle, garder la salle ambiante donnerait exactement le même verdict que la lire.
     ============================================================================================ */
  await section("« Localiser » (chemin SALLE) : la salle visée est celle de la CHAÎNE, pas le conteneur immédiat", async () => {
  {
    const s = await makeStore();
    const site = await s.create("sites", { name: "Liege" });
    await s.create("floors", { location: site.id, floor: "0", width_mm: 30000, depth_mm: 20000, cell_mm: 600, height_mm: 4000 });
    const dcA = await s.create("datacenters", { name: "Salle A", location: site.id, floor: "0", width_mm: 8000, depth_mm: 6000, floor_x: 1000, floor_y: 1000 });
    const dcB = await s.create("datacenters", { name: "Salle B", location: site.id, floor: "0", width_mm: 8000, depth_mm: 6000, floor_x: 12000, floor_y: 1000 });
    const rackB = await s.create("racks", { name: "R-B", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dcB.id, dc_x: 1000, dc_y: 1000 });
    const rackNu = await s.create("racks", { name: "R-hors-salle", width_mm: 600, depth: 1000, u_count: 42, location: site.id });
    const trayB = await s.create("rackItems", { rack_id: rackB.id, kind: "tray", tray_type: "cantilever", u: 10, u_height: 3, tray_u: 1, depth_mm: 400 });
    const libre = { dim_mode: "free", free_w_mm: 200, free_l_mm: 300, free_h_mm: 150 };
    // ⚠ Cotes RÉDUITES sur l'étagère : la validation BORNE un posé au volume utile au-dessus du plateau
    // (même piège que la section d'équivalence ci-dessus — un boîtier de 150 mm y serait REFUSÉ).
    const petit = { dim_mode: "free", free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 };

    /* Un cas par nature de CONTENEUR IMMÉDIAT — c'est la variable qui décide, pas le mode de placement.
       Colonne 3 = le `kind` immédiat ATTENDU (écrit à la main), colonne 4 = la SALLE que le chemin doit
       viser (idem). Les deux derniers cas n'ont aucune salle dans leur chaîne : ils doivent REFUSER. */
    const cas = [
      ["monté en baie — conteneur immédiat = BAIE", { placement_mode: "rack", rack_id: rackB.id, rack_u: 5, u_height: 1 }, "rack", dcB.id],
      ["en MARGE d'une baie — conteneur immédiat = BAIE", { placement_mode: "side", ...libre, rack_id: rackB.id, rack_side_pos: "left" }, "rack", dcB.id],
      ["en PAROI d'une baie — conteneur immédiat = BAIE", { placement_mode: "wall", ...libre, rack_id: rackB.id }, "rack", dcB.id],
      ["posé sur une ÉTAGÈRE — conteneur immédiat = ÉTAGÈRE", { placement_mode: "tray", ...petit, tray_item_id: trayB.id, tray_x: 10, tray_y: 10 }, "tray", dcB.id],
      ["libre POSITIONNÉ en salle — conteneur immédiat = SALLE", { placement_mode: "manual", ...libre, dc_id: dcB.id, dc_x: 2000, dc_y: 1500 }, "room", dcB.id],
      ["monté dans une baie HORS salle — conteneur VALIDE, aucune salle dans la chaîne", { placement_mode: "rack", rack_id: rackNu.id, rack_u: 3 }, "rack", null],
      ["libre SANS salle (inventaire pur) — aucun conteneur", { placement_mode: "manual", ...libre }, null, null],
    ];

    /* Une vue NEUVE par mesure, toujours posée sur la salle A : ni portée ni salle active héritées du
       cas précédent. Un refus passe par `Notify.toast`, qui LÈVE faute de DOM — on le rattrape, la
       mesure étant `_focusTarget`. */
    const joue = (fn) => {
      const dv = new DatacenterView(s, {}, {});
      dv.view = "3d"; dv.multiDc = false; dv.dcId = dcA.id; dv.visibleDcIds = new Set([dcA.id, dcB.id]); dv._focusTarget = null;
      try { fn(dv); } catch (_) { /* refus : toast sans DOM */ }
      return dv;
    };

    let vus = 0;
    for (const [label, props, kindImmediat, salle] of cas) {
      const eq = await s.create("equipments", { name: "eq-" + (++vus), ...props });
      ck(eq, `fixture créée — ${label} (un null ici = enregistrement REFUSÉ par la validation, pas un défaut du chemin)`);
      if (!eq) continue;
      const port = await s.create("ports", { equipment_id: eq.id, name: "p" + vus, face_x: 0.5, face_y: 0.5, face_side: "front" });
      const cab = await s.create("cables", { name: "c" + vus, from_port_id: port.id, to_port_id: null });

      // 1. LE CONTRASTE, mesuré et non supposé : quatre placements sur cinq ont un conteneur immédiat
      //    qui N'EST PAS une salle. C'est ce qui rend `equipmentContainer` inutilisable ici.
      const immediat = s.equipmentContainer(eq.id);
      ck.eq(immediat ? immediat.kind : null, kindImmediat, `conteneur IMMÉDIAT — ${label}`);

      // 2. …et les TROIS chemins salle visent pourtant la salle de la CHAÎNE, écrite à la main.
      const dvE = joue((dv) => dv.locateEquipment(eq.id));
      ck.eq(dvE._focusTarget ? dvE.dcId : null, salle, `locateEquipment vise la salle de la CHAÎNE — ${label}`);
      const dvP = joue((dv) => dv.locatePort(port.id));
      ck.eq(dvP._focusTarget ? dvP.dcId : null, salle, `locatePort vise la même salle — ${label}`);
      const dvC = joue((dv) => dv.locateCable(cab.id));
      ck.eq(dvC._focusTarget ? dvC.dcId : null, salle, `locateCable (bout unique) vise la même salle — ${label}`);

      // 3. Un REFUS ne déplace pas la salle active : le chemin salle sort AVANT toute écriture d'état.
      if (salle === null) ck.eq(dvE.dcId, dcA.id, `refus — ${label} : la salle active n'a pas bougé`);
    }
    ck.eq(vus, 7, "les sept placements ont bien été joués (garde anti-boucle vide : une liste tronquée passerait sinon au vert)");

    /* PARITÉ avec la règle HISTORIQUE, transcrite ici puisque le dépôt ne la porte plus : la chaîne
       PROJETÉE sur son maillon « salle », c'est-à-dire l'ancien `Store.equipmentDcId` mot pour mot. */
    const salleHistorique = (eqId) => { const r = PlacementContainers.chain(s.get("equipments", eqId), (coll, id) => s.get(coll, id)).find((c) => c.kind === "room"); return r ? r.id : null; };
    let compares = 0;
    for (let i = 1; i <= vus; i++) {
      const eq = s.all("equipments").find((e) => e.name === "eq-" + i);
      const k = s.equipmentNamedContainer(eq.id);
      ck.eq(k && k.kind === "room" ? k.id : null, salleHistorique(eq.id), `PARITÉ avec la clé « salle » historique — eq-${i}`);
      compares++;
    }
    ck.eq(compares, 7, "…sur les sept placements (et non sur un sous-ensemble muet)");
  }
  });

  /* ============================================================================================
     « LOCALISER » UNE LIAISON dont une extrémité est posée sur un ÉTAGE + ÉQUIVALENCE prédicat ⟺ action.
     Cf. docs/placement.md §6.32, et la décision D6 du chantier « câblage des équipements d'étage ».

     §6.28 avait laissé les trois gardes de CÂBLE sur la clé « salle », DÉLIBÉRÉMENT : `locateCable` n'avait
     aucune branche pour un conteneur d'étage, et migrer ces gardes aurait ouvert le bouton d'un câble dont
     le clic ne rendait qu'un toast. Ce lot livre l'ACTION puis ses gardes — dans cet ordre.

     ⚠ LE MIROIR N'EST PLUS SEULEMENT VÉRIFIÉ, IL EST STRUCTUREL : `locateCable` consomme la MÊME méthode
     que le prédicat (`Locatable.cableEnd` via `Store.cableLocatableEnd`). L'équivalence mesurée plus bas
     n'en devient pas superflue — elle couvre ce que la règle ne décide pas : la RÉSOLUTION 3D du bout
     retenu, et la portée d'affichage.

     REPÈRES DU DÉCOR (dérivés à la main du modèle, comme la section §6.27 plus haut) : un seul site
     `liege` → origine du bâtiment à (0 ; 0) ; hauteur d'étage 4 000 mm + 2 000 mm d'écart inter-niveaux →
     socle du niveau 1 à 6 000 mm.
     ============================================================================================ */
  await section("« Localiser » une LIAISON : bout d'ÉTAGE atteint, et le bouton est le MIROIR de l'action", async () => {
  {
    const { Notify } = D("ui/Notify.js");
    const { I18n } = D("i18n/I18n.js");   // catalogues déjà initialisés par le harnais (locale « fr »)
    const toastOrigine = Notify.toast;
    let dernierToast = null;
    // On INTERCEPTE le toast au lieu de compter sur l'exception qu'il lève faute de DOM : le lot fait
    // BASCULER des messages selon le conteneur (décision D4), et une exception ne dit pas LEQUEL.
    Notify.toast = (msg) => { dernierToast = msg; };
    try {
      const s = await makeStore();
      const liege = await s.create("sites", { name: "Liege" });
      const namur = await s.create("sites", { name: "Namur" });
      await s.create("floors", { location: liege.id, floor: "0", width_mm: 30000, depth_mm: 20000, cell_mm: 600, height_mm: 4000 });
      await s.create("floors", { location: liege.id, floor: "1", width_mm: 30000, depth_mm: 20000, cell_mm: 600, height_mm: 4000 });
      await s.create("floors", { location: namur.id, floor: "0", width_mm: 12000, depth_mm: 9000, cell_mm: 600, height_mm: 4000 });
      const dcA = await s.create("datacenters", { name: "Salle A", location: liege.id, floor: "0", width_mm: 8000, depth_mm: 6000, floor_x: 1000, floor_y: 1000 });
      const libre = { dim_mode: "free", free_w_mm: 200, free_l_mm: 300, free_h_mm: 150 };
      const boite = { dim_mode: "free", free_w_mm: 200, free_l_mm: 400, free_h_mm: 300 };
      // LIBRE POSITIONNÉ en salle : cible entièrement dérivable à la main (le chemin SALLE, inchangé).
      const eqLibre = await s.create("equipments", { name: "coffret", placement_mode: "manual", ...libre, dc_id: dcA.id, dc_x: 2000, dc_y: 1500, dc_z: 0 });
      // POSÉS D'ÉTAGE : `eqF` porte une hauteur propre (dc_z) pour que le double comptage se voie.
      const eqF = await s.create("equipments", { name: "ONDULEUR", placement_mode: "floor", ...boite, location: liege.id, floor: "1", floor_x: 4000, floor_y: 2000, dc_z: 250 });
      const eqF2 = await s.create("equipments", { name: "GROUPE", placement_mode: "floor", ...boite, location: liege.id, floor: "1", floor_x: 9000, floor_y: 5000 });
      const eqNamur = await s.create("equipments", { name: "hors-portée", placement_mode: "floor", ...boite, location: namur.id, floor: "0", floor_x: 3000, floor_y: 2000 });
      const eqRien = await s.create("equipments", { name: "inventaire", placement_mode: "manual", ...libre });
      const eqSansPos = await s.create("equipments", { name: "libre-sans-position", placement_mode: "manual", ...libre, dc_id: dcA.id });
      // ⚠ UN PORT NE PORTE QU'UN CÂBLE : chaque liaison du banc reçoit ses PROPRES ports.
      let np = 0;
      const mkPort = async (eq) => (await s.create("ports", { equipment_id: eq.id, name: "p" + (++np), face_x: 0.5, face_y: 0.5, face_side: "front" })).id;
      const mkCable = async (nom, a, b) => s.create("cables", { name: nom, from_port_id: a ? await mkPort(a) : null, to_port_id: b ? await mkPort(b) : null });
      const vueNeuve = () => { const dv = new DatacenterView(s, {}, {}); dv.view = "3d"; dv.multiDc = false; dv.dcId = dcA.id; dv.visibleDcIds = new Set([dcA.id]); dv._focusTarget = null; return dv; };
      /* Garde de LISIBILITÉ (même motif que `premier` dans la section §6.27) : si la localisation cessait
         d'aboutir, un accès direct à `_focusTarget.p` CRASHERAIT la section et masquerait la répartition
         des échecs — or c'est elle qui informe. Sonde mesurée des DEUX côtés : 1 FAIL + 1 crash sans cette
         garde (86 assertions perdues), 16 FAIL lisibles avec. */
      const cible = (dv) => dv._focusTarget || { p: { x: null, y: null, z: null }, extent: null, face: undefined };

      /* ---- 1. LE CHEMIN NOUVEAU : un bout d'ÉTAGE, cadré en MONDE ----
         Cible attendue, DÉRIVÉE À LA MAIN : origine du posé (4 000 ; 2 000 ; socle 6 000) + port au centre
         de la FACE AVANT d'une boîte 200 × 400 × 300 posée à dc_z = 250 → local (0 ; −200 ; 250 + 150). */
      const cEtage = await mkCable("étage → non branché", eqF, null);
      const dv = vueNeuve();
      dv.locateCable(cEtage.id);
      ck.eq(dv.view, "3d", "liaison à bout d'étage : « Localiser » bascule en 3D");
      ck.eq(dv.multiDc, true, "…en VUE ÉTAGE (repère bâtiment) — un posé d'étage n'a pas de repère salle");
      ck.eq(dv.dcId, dcA.id, "…et la salle ACTIVE n'est pas déplacée (comme pour un posé d'étage, §6.27)");
      ck.eq(cible(dv).p.x, 4000, "cible x = origine du bâtiment (0) + floor_x (4 000)");
      ck.eq(cible(dv).p.y, 1800, "cible y = floor_y (2 000) − demi-profondeur (200) : le port est sur la FACE AVANT");
      ck.eq(cible(dv).p.z, 6400, "cible z = socle du niveau 1 (6 000) + dc_z (250) + mi-hauteur (150) — 6 650 signalerait un dc_z compté DEUX fois");
      ck.eq(cible(dv).extent, 3500, "étendue = celle d'une extrémité de câble (cible PONCTUELLE), la MÊME qu'en salle");
      ck.eq(cible(dv).face, null, "aucune face visée : localiser un CÂBLE ne tourne pas la caméra (comportement historique)");
      ck(dv.selCables.has(cEtage.id) && dv.showAllCables === true, "…le câble est SÉLECTIONNÉ et l'affichage « tous les câbles » forcé, comme sur le chemin salle");
      ck.eq(dv.focusEqId, null, "…et aucune surbrillance d'équipement (idem chemin salle)");
      ck(dv.visibleDcIds.has(dcA.id), "portée : le bâtiment visé est amené dans la scène (sinon la caméra cadrerait un point que rien ne dessine)");
      // ÉQUIVALENCE DE SOURCE : la caméra vise le point d'où le TRACÉ fait partir le câble, pas un recalcul.
      const ptTrace = dv.routing.portOnFloorWorld(dv.currentMultiLayout(), s.cableLocatableEnd(cEtage));
      ck(ptTrace && ptTrace.x === cible(dv).p.x && ptTrace.y === cible(dv).p.y && ptTrace.z === cible(dv).p.z,
        "la cible caméra est EXACTEMENT le bout que le traceur porte au monde (même source : CableRouting.portOnFloorWorld)");

      /* ---- 2. LE CHEMIN SALLE, INCHANGÉ (non-régression) — cible dérivée à la main ---- */
      const cSalle = await mkCable("salle → non branché", eqLibre, null);
      const dv2 = vueNeuve();
      dv2.locateCable(cSalle.id);
      ck.eq(dv2.multiDc, false, "liaison de SALLE : chemin inchangé — repère salle, Vue étage désactivée");
      ck.eq(dv2.dcId, dcA.id, "…et la salle active devient la sienne (comportement historique)");
      ck.eq(cible(dv2).p.x, 2000, "cible x = dc_x du libre (2 000)");
      ck.eq(cible(dv2).p.y, 1350, "cible y = dc_y (1 500) − demi-profondeur (150)");
      ck.eq(cible(dv2).p.z, 75, "cible z = dc_z (0) + mi-hauteur (75)");
      ck.eq(cible(dv2).extent, 3500, "étendue inchangée");

      /* ---- 3. LA PRIORITÉ A PUIS B EST PRÉSERVÉE — c'est la parité à ne pas casser ---- */
      const cSalleEtage = await mkCable("salle → étage", eqLibre, eqF);
      const dv3 = vueNeuve(); dv3.locateCable(cSalleEtage.id);
      ck.eq(dv3.multiDc, false, "salle en A, étage en B : c'est A qui cadre — la généralisation ne DÉPLACE aucun cadrage existant");
      ck(cible(dv3).p.x === 2000 && cible(dv3).p.y === 1350, "…et c'est bien le bout de salle qui est visé");
      const cEtageSalle = await mkCable("étage → salle", eqF, eqLibre);
      const dv4 = vueNeuve(); dv4.locateCable(cEtageSalle.id);
      ck.eq(dv4.multiDc, true, "étage en A, salle en B : c'est A qui cadre (même priorité, autre nature de conteneur)");
      ck.eq(cible(dv4).p.z, 6400, "…et la cible est bien celle du posé d'étage");
      // Bout A NON localisable : on le SAUTE, on ne s'arrête pas dessus (parité avec l'expression
      // historique `portDcId(A) || portDcId(B)`, retirée au lot 7).
      const cRienSalle = await mkCable("non placé → salle", eqRien, eqLibre);
      const dv5 = vueNeuve(); dv5.locateCable(cRienSalle.id);
      ck(cible(dv5).p.x === 2000, "bout A non placé : l'extrémité B est retenue (le chemin historique faisait déjà cela)");
      // Bout A sur un étage HORS PORTÉE : non localisable, donc sauté lui aussi — le câble reste atteignable par B.
      const cNamurSalle = await mkCable("étage sans salle → salle", eqNamur, eqLibre);
      const dv6 = vueNeuve(); dv6.locateCable(cNamurSalle.id);
      ck.eq(dv6.multiDc, false, "bout A sur un étage INATTEIGNABLE : sauté, et B (salle) cadre — le câble n'est pas perdu pour autant");

      /* ---- 4. LES REFUS, ET LE MOT JUSTE (décision D4) ---- */
      const cRien = await mkCable("non placé → rien", eqRien, null);
      const dv7 = vueNeuve(); dernierToast = null; dv7.locateCable(cRien.id);
      ck.eq(dv7._focusTarget, null, "aucune extrémité atteignable → AUCUNE cible caméra");
      ck.eq(dernierToast, I18n.t("dc.interact.cableNotInRoom"), "…et le message HISTORIQUE, au caractère près (rien d'un étage n'est en jeu)");
      ck.eq(dv7.selCables.size, 0, "…et un refus ne SÉLECTIONNE rien (comportement historique)");
      const cNamur = await mkCable("étage sans salle → rien", eqNamur, null);
      const dv8 = vueNeuve(); dernierToast = null; dv8.locateCable(cNamur.id);
      ck.eq(dv8._focusTarget, null, "bout posé sur un étage d'un bâtiment SANS salle → refus (la portée s'exprime en salles, §6.27)");
      ck.eq(dernierToast, I18n.t("dc.interact.floorNoRoomInBuilding"),
        "…et le message dit la VRAIE cause (D4) : ce bout EST placé, c'est la vue qui ne peut pas l'atteindre");
      ck.eq(dv8.selCables.size, 0, "…et rien n'est sélectionné (aucune extrémité n'a été retenue)");

      /* ---- 5. LE CHEMIN D'ÉTAGE SE DÉSISTE pour un bout de salle (contrat de `locateFloorEquip`) ---- */
      const dv9 = vueNeuve();
      ck.eq(dv9.locateFloorCable(cSalle.id, s.cableLocatableEnd(cSalle)), false, "locateFloorCable : bout de SALLE → se désiste, l'appelant poursuit");
      ck.eq(dv9._focusTarget, null, "…sans rien programmer au passage");
      // GARDE FERMÉE, atteignable seulement en contournant la règle d'extrémité : on la mesure telle quelle.
      dernierToast = null;
      ck.eq(dv9.locateFloorCable(cNamur.id, s.get("cables", cNamur.id).from_port_id), true, "locateFloorCable : bout d'étage → PREND la main (même quand il refuse)");
      ck.eq(dernierToast, I18n.t("dc.interact.floorNoRoomInBuilding"), "…et refuse par le toast quand le bâtiment n'a aucune salle");
      ck.eq(dv9._focusTarget, null, "…sans cadrer le vide");
      ck.eq(dv9.selCables.size, 0, "…et sans rien sélectionner : le chemin d'ÉTAGE pose l'état de sélection APRÈS ses refus, comme le chemin salle");

      /* ---- 6. L'ÉQUIVALENCE, énoncée entre les DEUX MESURES et non contre la constante ----
         Une dérive SIMULTANÉE (on « corrige » l'attente en même temps que le code) passerait au vert si
         chaque côté n'était épinglé qu'à `attendu` ; c'est la leçon mesurée du lot 2 (§6.28). */
      const cEtageEtage = await mkCable("étage → même étage", eqF, eqF2);
      const cVide = await s.create("cables", { name: "aucun port", from_port_id: null, to_port_id: null });
      const cas = [
        ["libre positionné en salle", cSalle, true],
        ["non placé → libre en salle", cRienSalle, true],
        ["posé d'ÉTAGE (bâtiment ayant une salle)", cEtage, true],
        ["salle en A, étage en B", cSalleEtage, true],
        ["étage en A, salle en B", cEtageSalle, true],
        ["DEUX bouts sur le même étage", cEtageEtage, true],
        ["étage en A d'un bâtiment SANS salle, salle en B", cNamurSalle, true],
        ["posé d'étage d'un bâtiment SANS salle, seul", cNamur, false],
        ["deux bouts non placés", cRien, false],
        ["câble sans aucun port", cVide, false],
      ];
      let vus = 0;
      for (const [nom, cable, attendu] of cas) {
        vus++;
        ck(cable, `fixture créée — ${nom} (un null ici = liaison REFUSÉE par la validation, pas un défaut du prédicat)`);
        if (!cable) continue;
        const propose = s.cableLocatable(cable);
        ck.eq(propose, attendu, `prédicat — ${nom}`);
        const dvc = vueNeuve(); dernierToast = null;
        dvc.locateCable(cable.id);
        const aAbouti = dvc._focusTarget !== null;
        ck.eq(aAbouti, attendu, `action — ${nom} : « Localiser » programme une cible caméra`);
        ck.eq(aAbouti, propose, `ÉQUIVALENCE — ${nom} : bouton proposé ⟺ « Localiser » aboutit`);
        ck.eq(dernierToast === null, attendu, `…et le refus passe bien par un toast (signal redondant, il ne doit pas diverger de la cible)`);
      }
      ck.eq(vus, 10, "les dix liaisons ont bien été jouées (garde anti-boucle vide : une liste tronquée passerait sinon au vert)");

      /* ⚠ ÉCART CONNU, NOMMÉ ET VERROUILLÉ — il n'est PAS une exception à l'équivalence ci-dessus, dont
         aucun cas ne le met en jeu. Un libre rattaché à une salle mais SANS `dc_x`/`dc_y` est jugé
         localisable (§6.28) alors que `Resolver3D` refuse de résoudre ses PORTS : une liaison qui n'a que
         ce bout-là voit son bouton proposé et n'obtient qu'un toast. C'est ANTÉRIEUR à ce lot — l'ancien
         `cableDcId` se comportait à l'identique — et sans occurrence dans les deux corpus. */
      const cSansPos = await mkCable("libre sans position → rien", eqSansPos, null);
      ck.eq(s.cableLocatable(cSansPos), true, "écart connu : la liaison d'un libre NON positionné est jugée localisable…");
      // …et pour la RAISON qui le rendait déjà vrai avant : la chaîne du bout A traverse bien la salle,
      // ce qui suffisait à l'ancien `cableDcId` (RETIRÉ §6.33) comme cela suffit au prédicat actuel.
      ck.eq(JSON.stringify(s.equipmentNamedContainer(eqSansPos.id)), JSON.stringify({ kind: "room", id: dcA.id }),
        "…parce que sa chaîne traverse la salle — l'écart n'est ni créé ni refermé, ni par le lot 6 ni par le retrait du lot 7");
      const dv10 = vueNeuve(); dernierToast = null; dv10.locateCable(cSansPos.id);
      ck.eq(dv10._focusTarget, null, "…alors que « Localiser » REFUSE (bout non résolu en 3D)");
      ck.eq(dernierToast, I18n.t("dc.interact.cableEndNotFound"), "…avec le message de SALLE, puisque c'est bien une salle qu'on n'a pas su résoudre");

      /* ⚠ CET ÉCART A UN JUMEAU CÔTÉ ÉTAGE, trouvé en éprouvant ce lot et VERROUILLÉ ici. `dim_mode` est
         conservé tel quel quand il vaut « u » (`Equipment.ts` ~224), quel que soit le `placement_mode` :
         un posé d'étage peut donc porter un dimensionnement en U, et `Resolver3D.resolveFaceAnchorWorld3D`
         refuse alors de résoudre ses ports (« seul un dimensionnement LIBRE porte une boîte 6 faces »).
         La garde `!pt` de `locateFloorCable` n'est donc PAS défensive — elle est atteignable, et c'est
         pourquoi elle mérite son propre message (D4 : « sur cet étage », pas « dans cette salle »).
         Même famille que l'écart ci-dessus, et tout aussi ANTÉRIEUR : `locateFloorPort` refuse déjà de la
         même façon depuis §6.27. 0 occurrence dans les deux corpus (aucun posé d'étage). */
      const eqFU = await s.create("equipments", { name: "posé-en-U", placement_mode: "floor", dim_mode: "u", u_height: 2, location: liege.id, floor: "1", floor_x: 6000, floor_y: 3000 });
      ck(eqFU, "fixture créée — posé d'étage au dimensionnement « u »");
      const cFU = eqFU ? await mkCable("étage dim_mode u → rien", eqFU, null) : null;
      if (cFU) {
        ck.eq(s.cableLocatable(cFU), true, "écart JUMEAU : la liaison d'un posé d'étage en dim_mode « u » est jugée localisable…");
        const dv11 = vueNeuve(); dernierToast = null; dv11.locateCable(cFU.id);
        ck.eq(dv11._focusTarget, null, "…alors que « Localiser » REFUSE (aucune boîte 6 faces d'où faire émerger le port)");
        ck.eq(dernierToast, I18n.t("dc.interact.cableEndNotFoundFloor"), "…et le message dit ÉTAGE, pas « dans cette salle » (D4)");
        ck.eq(dv11.selCables.size, 0, "…et ce refus-là non plus ne sélectionne rien (le SEUL refus atteignable DANS le chemin d'étage)");
      }
    } finally {
      Notify.toast = toastOrigine;   // le stub ne doit pas fuir dans les sections suivantes
    }
  }
  });

  /* ============================================================================================
     PORTÉE DU PANNEAU LATÉRAL : l'appartenance à « ce qui est affiché » se dit en CONTENEURS (D3).
     Cf. docs/placement.md §6.32. `DcBase.containerShown` est le pendant « conteneur » de
     `displayedDcIds` — la même question que `CableRouting.worldEndIn` pose au TRACÉ, posée aux cartes.
     ============================================================================================ */
  await section("Portée du panneau : un ÉTAGE affiché compte comme une salle affichée (D3)", async () => {
  {
    const s = await makeStore();
    const liege = await s.create("sites", { name: "Liege" });
    await s.create("floors", { location: liege.id, floor: "0", width_mm: 30000, depth_mm: 20000, cell_mm: 600, height_mm: 4000 });
    await s.create("floors", { location: liege.id, floor: "1", width_mm: 30000, depth_mm: 20000, cell_mm: 600, height_mm: 4000 });
    const dcA = await s.create("datacenters", { name: "A", location: liege.id, floor: "0", width_mm: 8000, depth_mm: 6000, floor_x: 1000, floor_y: 1000 });
    const dcB = await s.create("datacenters", { name: "B", location: liege.id, floor: "0", width_mm: 8000, depth_mm: 6000, floor_x: 12000, floor_y: 1000 });
    const rA = await s.create("racks", { name: "RA", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dcA.id, dc_x: 1000, dc_y: 1000 });
    const rB = await s.create("racks", { name: "RB", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dcB.id, dc_x: 2000, dc_y: 2000 });
    const libre = { dim_mode: "free", free_w_mm: 200, free_l_mm: 300, free_h_mm: 150 };
    // ⚠ T11 : une extrémité de FAISCEAU doit être un `patch_panel` — sans ce type, `create` rend `null`.
    const patchA = await s.create("equipments", { name: "patchA", type: "patch_panel", placement_mode: "rack", rack_id: rA.id, rack_u: 5, u_height: 1 });
    const patchB = await s.create("equipments", { name: "patchB", type: "patch_panel", placement_mode: "rack", rack_id: rB.id, rack_u: 5, u_height: 1 });
    const patchF = await s.create("equipments", { name: "patchF", type: "patch_panel", placement_mode: "floor", ...libre, location: liege.id, floor: "1", floor_x: 3000, floor_y: 2000 });
    const patchF2 = await s.create("equipments", { name: "patchF2", type: "patch_panel", placement_mode: "floor", ...libre, location: liege.id, floor: "1", floor_x: 9000, floor_y: 4000 });
    const ct = await s.create("cableTypes", { name: "OM4", family: "fibre" });
    const tAB = await s.create("cableBundles", { name: "T-AB", cable_type_id: ct.id, fiber_count: 12, endpoint_a_equipment_id: patchA.id, endpoint_b_equipment_id: patchB.id });
    const tAF = await s.create("cableBundles", { name: "T-AF", cable_type_id: ct.id, fiber_count: 12, endpoint_a_equipment_id: patchA.id, endpoint_b_equipment_id: patchF.id });
    const tFF = await s.create("cableBundles", { name: "T-FF", cable_type_id: ct.id, fiber_count: 12, endpoint_a_equipment_id: patchF.id, endpoint_b_equipment_id: patchF2.id });
    ck(tAB && tAF && tFF, "fixtures faisceaux créées (un null = extrémité refusée par T11, pas un défaut de portée)");
    let np = 0;
    const p = async (eq) => (await s.create("ports", { equipment_id: eq.id, name: "p" + (++np), face_x: 0.5, face_y: 0.5, face_side: "front" })).id;
    const cAB = await s.create("cables", { name: "C-AB", from_port_id: await p(patchA), to_port_id: await p(patchB) });
    const cFF = await s.create("cables", { name: "C-FF", from_port_id: await p(patchF), to_port_id: await p(patchF2) });

    const salle = (id) => ({ kind: "room", id });
    const etage1 = { kind: "floor", location: liege.id, floor: "1" };

    // ---- LA RÈGLE, état de vue par état de vue ----
    const vue = (v, multi, visibles) => { const dv = new DatacenterView(s, {}, {}); dv.view = v; dv.multiDc = multi; dv.dcId = dcA.id; dv.visibleDcIds = new Set(visibles); return dv; };
    const multiTout = vue("3d", true, [dcA.id, dcB.id]);
    ck.eq(multiTout.containerShown(null, dcA), false, "aucun conteneur → jamais affiché");
    ck.eq(multiTout.containerShown({ kind: "rack", id: rA.id }, dcA), false, "une BAIE n'est pas un conteneur d'affichage : c'est sa SALLE qu'il faut interroger");
    ck.eq(multiTout.containerShown({ kind: "tray", id: "t1" }, dcA), false, "une ÉTAGÈRE non plus");
    ck.eq(multiTout.containerShown(salle(dcA.id), dcA), true, "salle affichée → true");
    ck.eq(multiTout.containerShown(salle(dcB.id), dcA), true, "seconde salle affichée → true");
    ck.eq(multiTout.containerShown(etage1, dcA), true, "ÉTAGE dont le bâtiment a une salle affichée, en Vue étage → true (D3)");
    const mono = vue("3d", false, [dcA.id, dcB.id]);
    ck.eq(mono.containerShown(salle(dcB.id), dcA), false, "salle unique : les autres salles ne sont PAS affichées");
    ck.eq(mono.containerShown(etage1, dcA), false,
      "salle unique : AUCUN plan d'étage n'est dessiné — la garde « Vue étage » n'est pas redondante avec `floorShown`");
    ck.eq(vue("top", true, [dcA.id, dcB.id]).containerShown(etage1, dcA), false, "vue DESSUS : pas davantage de plan d'étage, quoi qu'en dise le layout");

    // ---- BOUTS DE FAISCEAU : ce que la carte « câbles » propose de piloter ----
    const trunksDe = (dv, dc) => s.all("cableBundles").filter((b) => dv.containerShown(dv.trunks.endpointContainer(b, "A"), dc) || dv.containerShown(dv.trunks.endpointContainer(b, "B"), dc)).map((b) => b.name).sort().join(",");
    ck.eq(trunksDe(multiTout, dcA), "T-AB,T-AF,T-FF", "Vue étage, deux salles : les trois faisceaux sont pilotables — dont celui dont les DEUX bouts sont sur l'étage");
    ck.eq(trunksDe(mono, dcA), "T-AB,T-AF", "salle unique A : seuls les faisceaux touchant A (le T-FF, purement d'étage, disparaît)");
    ck.eq(trunksDe(vue("3d", false, [dcB.id]), dcB), "T-AB", "salle unique B : seul le faisceau qui la touche");
    /* PARITÉ : sur des données SANS aucun posé d'étage, la nouvelle portée est celle de l'ancienne.
       ⚠ La règle historique — « la SALLE du bout appartient-elle aux salles affichées ? » — est
       TRANSCRITE ici depuis la chaîne d'attache : `Store.equipmentDcId` est RETIRÉ (§6.33), et c'est
       exactement pour cela qu'un oracle de parité doit vivre dans le test, pas dans le dépôt. */
    const salleHistorique = (eqId) => { const r = PlacementContainers.chain(s.get("equipments", eqId), (coll, id) => s.get(coll, id)).find((c) => c.kind === "room"); return r ? r.id : null; };
    const ancienneTrunks = (dv, dc) => { const shown = new Set(dv.displayedDcIds(dc)); return s.all("cableBundles").filter((b) => { const da = b.endpoint_a_equipment_id ? salleHistorique(b.endpoint_a_equipment_id) : null; const db = b.endpoint_b_equipment_id ? salleHistorique(b.endpoint_b_equipment_id) : null; return (da != null && shown.has(da)) || (db != null && shown.has(db)); }).map((b) => b.name).sort().join(","); };
    ck.eq(ancienneTrunks(mono, dcA), "T-AB,T-AF", "…et l'expression HISTORIQUE (salle de la chaîne ∈ salles affichées) dit exactement la même chose en salle unique");
    ck.eq(ancienneTrunks(multiTout, dcA), "T-AB,T-AF", "…tandis qu'en Vue étage elle RATE le faisceau d'étage : c'est très exactement ce que D3 corrige");

    // ---- LISTE DE CÂBLES de la carte (branche multi-salles) ----
    const listeDe = (dv, dc) => dv.panelCables(dc).map((o) => o.cable.name).sort().join(",");
    ck.eq(listeDe(multiTout, dcA), "C-AB,C-FF", "Vue étage : le câble entre deux posés d'étage est listé par la carte qui prétend le piloter");
    ck(cAB && cFF, "fixtures câbles créées");

    // ---- PRÉDICAT « LOCALISABLE » : on ne propose que ce que « Localiser » sait atteindre ----
    // (Le panneau de recherche 3D qui consommait ce prédicat via `searchResults` a été RETIRÉ — la
    //  localisation passe par la recherche GLOBALE Ctrl+K. La RÈGLE, elle, demeure dans `core/Locatable`
    //  exposé par `Store.cableLocatable` : c'est ELLE que ces assertions verrouillent, à l'identique.)
    const eqNu = await s.create("equipments", { name: "inventaire", dim_mode: "free", free_w_mm: 200, free_l_mm: 300, free_h_mm: 150 });
    const cNu = await s.create("cables", { name: "C-NULLE-PART", from_port_id: await p(eqNu), to_port_id: null });
    ck.eq(s.cableLocatable(cAB), true, "localisable : un câble de SALLE est proposé (parité)");
    ck.eq(s.cableLocatable(cFF), true, "localisable : un câble entre deux posés d'ÉTAGE est proposé — l'ancien `cableDcId` le déclarait « non placé »");
    ck.eq(s.cableLocatable(cNu), false, "localisable : un câble dont aucune extrémité n'est atteignable reste ÉCARTÉ (pas de bouton mort)");
    ck(cNu, "fixture câble non plaçable créée");
  }
  });

  /* ============================================================================================
     🚨 BREAKOUT — UNE LANE DOIT ÊTRE ATTEIGNABLE AU GESTE (correctif T2-B1, 2026-09-01)

     Le retour terrain : « je sais créer un breakout, aucun moyen de l'associer à quoi que ce soit
     via l'UI ». Quatre verrous en série l'expliquaient, dont trois sont DÉLIBÉRÉS et le restent :
       ① une lane n'a pas de position de façade propre (elle émerge du connecteur de son trunk) ;
       ② donc la 3D ne la dessine pas — rien à cliquer ;
       ③ le trunk, lui, EST dessiné… mais il est le seul port INCÂBLABLE (doctrine : les lanes
          portent les câbles) ;
       ④ et il était exclu de `portOpts` SANS échappatoire, si bien qu'un formulaire ouvert sur un
          trunk n'avait même pas son bout A dans sa propre liste d'options.

     Le correctif ne touche NI ① NI ② NI la doctrine ③ : il rend les lanes ATTEIGNABLES (le clic sur
     un trunk demande laquelle câbler) et referme ④ (une valeur RETENUE n'est jamais perdue).

     Ce qui est vérifiable sans DOM : les briques de STORE que le geste consomme, et — par lecture
     des SOURCES, patron du verrou de `test-nav-model` — le fait que le câblage les emprunte bien.
     ============================================================================================ */
  await section("🚨 Breakout : les LANES sont atteignables au geste, le trunk reste incâblable (T2-B1)", async () => {
  {
    const s = await makeStore();
    const eq = await s.create("equipments", { name: "SW-CORE" });
    const trunk = await s.create("ports", { equipment_id: eq.id, name: "QSFP1", role: "data" });
    const lanes = [];
    for (let i = 1; i <= 4; i++) lanes.push(await s.create("ports", { equipment_id: eq.id, name: "QSFP1/" + i, role: "data", parent_port_id: trunk.id, lane: i }));
    const normal = await s.create("ports", { equipment_id: eq.id, name: "Gi1/0/1", role: "data" });

    // ---- les briques que le geste consomme ----
    ck(s.isBreakoutParent(trunk), "le trunk est bien reconnu comme parent de breakout");
    ck.eq(s.isBreakoutParent(normal), false, "un port ordinaire ne l'est pas");
    ck.eq(s.breakoutLanes(trunk.id).length, 4, "les 4 lanes sont retrouvées depuis le trunk");
    ck.eq(s.breakoutLanes(trunk.id).map((l) => l.lane).join(","), "1,2,3,4", "…et ORDONNÉES par n° de lane (l'ordre du choix proposé)");
    ck.eq(s.breakoutLanes(normal.id).length, 0, "un port ordinaire n'a pas de lane");
    ck.eq(s.breakoutLanes(lanes[0].id).length, 0, "une lane n'est pas elle-même un trunk (pas de breakout de breakout ici)");

    // ---- une lane est un port comme un autre pour le câblage : c'est ELLE qui porte le câble ----
    ck.eq(s.portsOf(eq.id).filter((p) => !s.isBreakoutParent(p)).length, 5,
      "ports CÂBLABLES de l'équipement : les 4 lanes + le port ordinaire — le trunk est écarté, doctrine INCHANGÉE");

    // -- Le VERROU, sur les SOURCES : le câblage emprunte bien ces briques --
    const fs = require("fs");
    const src = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", "src-client", ...p), "utf8");

    const dcInteract = src("views", "dc", "DcInteract.ts");
    const resolveur = /resolveLaneToCable\(port: any\): Promise<any> \{([\s\S]*?)\r?\n  \}/.exec(dcInteract);
    ck(!!resolveur, "DcInteract.resolveLaneToCable existe (le geste qui rend les lanes atteignables)");
    ck(/isBreakoutParent\(port\)/.test(resolveur[1]), "…il ne s'active QUE sur un trunk (un port ordinaire passe tout droit)");
    ck(/breakoutLanes\(port\.id\)/.test(resolveur[1]), "…et propose les lanes DU trunk cliqué");
    ck(/cableOnPort/.test(resolveur[1]), "…en signalant celles qui sont déjà câblées (jamais un choix qui échouera)");

    const connect = /protected async connectPort\(portClique: any\): Promise<void> \{([\s\S]*?)\r?\n    const cands/.exec(dcInteract);
    ck(!!connect, "connectPort est bien lu");
    ck(/await this\.resolveLaneToCable\(portClique\)/.test(connect[1]),
      "🚨 le clic de port PASSE par la résolution de lane — c'est le chemin que le clic 3D ET le menu contextuel empruntent tous deux");

    // ④ l'échappatoire : une valeur RETENUE n'est jamais perdue, même devenue trunk
    const cableForms = src("views", "forms", "CableForms.ts");
    ck(/!store\.isBreakoutParent\(p\) \|\| p\.id === selectedPortId/.test(cableForms),
      "🚨 portOpts : un trunk DÉJÀ retenu reste dans sa propre liste (un port peut être devenu trunk APRÈS avoir reçu un câble)");
    ck(/trunkSuffix/.test(cableForms), "…et il est NOMMÉ comme trunk, sinon rien n'expliquerait sa présence");
  }
  });

  /* ============================================================================================
     🚨 « LOCALISER » AU PREMIER PASSAGE EN 3D — le montage DIFFÉRÉ ne doit pas écraser le focus.

     Retour terrain (2026-09-01) : depuis un onglet Datacenter JAMAIS ouvert, « Localiser » cadrait
     bien l'objet **puis la caméra repartait aussitôt** sur un cadrage par défaut (milieu de la
     salle, ou milieu du bâtiment en cadrage MULTI sans qu'aucune vue multi ait été demandée).
     Une seule fois — la 2ᵉ localisation était correcte.

     MÉCANIQUE : le 1er passage en 3D enchaîne DEUX montages. `show()` en demande un DIFFÉRÉ
     (branche lourde : overlay + double rAF) qui CAPTURE options/salle ; puis `locate()` en demande
     un second, IMMÉDIAT cette fois (`Notify.isBusy()` est déjà vrai), qui construit et pose la
     caméra. Le différé se réveille ENSUITE avec ses options périmées et re-cadre.

     La garde d'hôte préexistante ne pouvait pas l'attraper : l'hôte WebGL est PERSISTANT, donc
     c'est le MÊME objet dans les deux montages. Il fallait comparer la FRAÎCHEUR de la demande.

     Ce qui est vérifiable sans DOM (`render`/`renderWebGL` sortent sur `typeof document`) : la
     forme du garde-fou, par lecture des SOURCES — patron du verrou de `test-nav-model`.
     ============================================================================================ */
  await section("🚨 « Localiser » : un montage 3D DIFFÉRÉ périmé abandonne au lieu d'écraser le focus", async () => {
  {
    const fs = require("fs");
    const dcBase = fs.readFileSync(path.join(__dirname, "..", "..", "src-client", "views", "dc", "DcBase.ts"), "utf8");

    ck(/protected _webglMountSeq = 0;/.test(dcBase), "DcBase porte un compteur de montage 3D (`_webglMountSeq`)");

    // ⚠ `\r?\n` PARTOUT dans les verrous qui lisent des SOURCES : le dépôt stocke en LF mais la copie de
    // travail Windows est en CRLF (autocrlf). Un motif ancré sur `\n` seul passe ou casse selon la machine
    // et selon l'outil qui a écrit le fichier en dernier — c'est un faux négatif qui ne prouve rien.
    const corps = /protected renderWebGL\(dc: any\): void \{([\s\S]*?)\r?\n  \}\r?\n/.exec(dcBase);
    ck(!!corps, "renderWebGL est bien lu");

    const iSeq = corps[1].indexOf("const seq = ++this._webglMountSeq;");
    const iMount = corps[1].indexOf("const doMount");
    const iBail = corps[1].indexOf("if (seq !== this._webglMountSeq) return;");
    ck(iSeq >= 0, "chaque demande de montage prend un NUMÉRO");
    ck(iBail >= 0, "🚨 le montage ABANDONNE s'il n'est plus le plus récent — c'est tout le correctif");
    ck(iSeq < iMount, "🚨 le numéro est pris À LA DEMANDE (hors du callback) : capturé dedans, il vaudrait toujours le dernier et ne garderait RIEN");
    ck(iBail > iMount, "…et il est comparé À L'EXÉCUTION, dans le callback du montage");

    // La garde de SÉQUENCE passe AVANT celle de l'hôte : c'est la plus discriminante des deux
    // (l'hôte étant persistant, la sienne ne voit rien dans ce scénario).
    const iHost = corps[1].indexOf("if (this._webglHost !== hostDiv) return;");
    ck(iHost > iBail, "la garde d'hôte (préexistante, insuffisante ici) est CONSERVÉE, après celle de séquence");

    // L'overlay doit être levé MÊME quand le montage différé abandonne, sinon « Rendu 3D… » resterait à l'écran.
    ck(/doMount\(\)\.finally\(\(\) => Notify\.idle\(\)\)/.test(corps[1]),
      "🚨 l'overlay est levé dans un `finally` : un montage qui ABANDONNE ne doit pas laisser « Rendu 3D… » collé à l'écran");
  }
  });

  /* ============================================================================================
     FLÈCHE DE LOCALISATION — style, thème, clé de cache et GÉOMÉTRIE du contour.

     Deux décisions utilisateur (2026-09-02) que ce bloc verrouille :
       1. **on ne touche PLUS aux images de façade** — l'app les teintait en ambre pour compenser
          l'émissive invisible sous une texture, ce qui dénaturait la photo pour un gain nul ;
       2. la désignation passe par une flèche AJOUTÉE à la scène, toujours face au viewport, de
          taille écran constante, qui **respire avec la mise en évidence**.

     Ce qui est décidable se teste ici (module PUR, jumeau de `PivotMarker`) ; le reste — un sprite
     Three, une texture rastérisée — se regarde. Le point 1, qui vit dans le moteur (non chargeable
     hors navigateur), est verrouillé par lecture des SOURCES en fin de section.
     ============================================================================================ */
  await section("Flèche de localisation : contour, encres par thème, clé de cache, et images de façade INTACTES", async () => {
  {
    const NOIR = 0x0e1116, BLANC = 0xffffff;

    // ---- même règle de thème que le pivot : une seule dans l'app (Color.isLightHex) ----
    ck.eq(FocusArrowMarker.isLight(NOIR), false, "fond sombre → thème sombre");
    ck.eq(FocusArrowMarker.isLight(BLANC), true, "fond blanc → thème clair");
    ck.eq(FocusArrowMarker.isLight(0x818181), Color.isLightHex(0x818181), "…c'est la règle PARTAGÉE, pas une seconde règle");

    // ---- CLÉ DE CACHE dépendante du thème (les clés « ## » ne sont JAMAIS évincées) ----
    ck.eq(FocusArrowMarker.cacheKey(NOIR), "##focusarrow|dark", "clé de cache : variante SOMBRE nommée");
    ck.eq(FocusArrowMarker.cacheKey(BLANC), "##focusarrow|light", "clé de cache : variante CLAIRE nommée");
    ck(FocusArrowMarker.cacheKey(NOIR) !== FocusArrowMarker.cacheKey(BLANC), "🚨 clé DIFFÉRENTE par thème (sinon la texture du 1er thème serait resservie à vie)");
    ck(FocusArrowMarker.cacheKey(NOIR) !== PivotMarker.cacheKey(NOIR), "…et distincte de celle du pivot (deux sprites, deux textures)");

    // ---- ENCRES : le CORPS est neutre (sa couleur utile vient du PULSE), le halo suit le fond ----
    const surSombre = FocusArrowMarker.ink(NOIR), surClair = FocusArrowMarker.ink(BLANC);
    ck.eq(surSombre.core, "#ffffff", "corps BLANC : c'est le pulse qui le teinte à l'exécution, pas la texture");
    ck.eq(surClair.core, "#ffffff", "…dans les deux thèmes (la forme est neutre, la couleur est dynamique)");
    ck(surClair.halo !== surSombre.halo, "🚨 le HALO, lui, suit le thème — c'est lui qui détache la flèche d'un fond quelconque");

    // ---- GÉOMÉTRIE du contour : c'est la seule partie décidable du dessin ----
    const S = 128, pts = FocusArrowMarker.outline(S);
    ck.eq(pts.length, 7, "contour à 7 sommets (pointe + 2 ailerons + 2 épaules + 2 coins de hampe)");
    ck.eq(pts[0].x, S / 2, "la POINTE est centrée horizontalement");
    ck(pts[0].y > S * 0.9, "🚨 la POINTE est EN BAS du canvas — c'est ce qui, avec l'ancrage par le bas, la pose sur la cible sans la recouvrir");
    ck.eq(pts[0].y, Math.max(...pts.map((p) => p.y)), "…et c'est le point le plus bas du contour");
    // symétrie gauche/droite autour de l'axe : une flèche de travers se verrait, mais tard.
    const miroir = pts.map((p) => S - p.x).sort((a, b) => a - b);
    const droits = pts.map((p) => p.x).sort((a, b) => a - b);
    ck.eq(miroir.join(","), droits.join(","), "contour SYMÉTRIQUE par rapport à l'axe vertical");
    // la tête doit être plus large que la hampe, sinon ce n'est plus une flèche mais un trait.
    ck(FocusArrowMarker.HEAD_HALF_RATIO > FocusArrowMarker.SHAFT_HALF_RATIO, "la TÊTE est plus large que la hampe");
    ck(FocusArrowMarker.SCREEN_SIZE_PX > PivotMarker.SCREEN_SIZE_PX, "la flèche est plus grande que le pivot : elle DÉSIGNE, quand le pivot se cherche");

    // ---- TRACÉ : contexte 2D ENREGISTREUR (aucun canvas, aucun DOM) — halo D'ABORD, corps ENSUITE ----
    const journal = [];
    const g = {
      set fillStyle(v) { journal.push(["fillStyle", v]); }, set strokeStyle(v) { journal.push(["strokeStyle", v]); },
      set lineWidth(v) { journal.push(["lineWidth", v]); }, set lineJoin(v) {}, set lineCap(v) {},
      beginPath() { journal.push(["beginPath"]); }, moveTo() {}, lineTo() {}, closePath() {},
      fill() { journal.push(["fill"]); }, stroke() { journal.push(["stroke"]); },
    };
    FocusArrowMarker.draw(g, S, surSombre);
    const iStroke = journal.findIndex((e) => e[0] === "stroke");
    const iFill = journal.findIndex((e) => e[0] === "fill");
    ck(iStroke >= 0 && iFill >= 0, "le tracé fait bien les DEUX passes");
    ck(iStroke < iFill, "🚨 HALO d'abord (stroke), CORPS ensuite (fill) — inversé, le halo mangerait le corps");
    ck.eq(journal.filter((e) => e[0] === "beginPath").length, 2, "un chemin RECONSTRUIT pour chaque passe (un fill après un stroke ne rejoue pas le chemin)");
    ck.eq(journal.find((e) => e[0] === "strokeStyle")[1], surSombre.halo, "la passe au trait utilise l'encre de HALO");
    ck.eq(journal.find((e) => e[0] === "fillStyle")[1], surSombre.core, "la passe remplie utilise l'encre de CORPS");

    /* -- Le VERROU du point 1, sur les SOURCES : plus AUCUNE altération des images de façade. -- */
    const fs = require("fs");
    const cam = fs.readFileSync(path.join(__dirname, "..", "..", "src-client", "views", "dc", "three", "DcThreeCamera.ts"), "utf8");
    ck(/canHighlight\(material: any\): boolean \{ return !!\(material && material\.emissive\); \}/.test(cam),
      "🚨 `canHighlight` : SEUL un matériau à ÉMISSIVE est surlignable — un matériau sans émissive EST une image de façade");
    // La teinte ambre des TEXTURES a disparu du CODE. On vise le corps de `setFocusHi`, pas le fichier
    // entier : les commentaires citent encore l'ancienne valeur pour dire d'où l'on vient, et c'est utile.
    const hiBody = /protected setFocusHi\(mesh: THREE\.Object3D \| null, on: boolean\): void \{([\s\S]*?)\r?\n  \}/.exec(cam);
    ck(!!hiBody, "setFocusHi est bien lu");
    ck.eq(/\.color\.setHex\(/.test(hiBody[1]), false,
      "🚨 setFocusHi n'écrit PLUS AUCUNE couleur de base — c'est elle qui dénaturait les photos de façade");
    ck(/emissive\.setHex\(HI\)/.test(hiBody[1]), "…mais il pose toujours l'émissive ambre là où elle existe (corps, ports)");
    ck(/if \(ud\.layer === "faceImage"\) return;/.test(cam),
      "🚨 les PLANS d'image de façade sont ÉCARTÉS de la collecte du focus (ils y entraient par leur tag `eqId`)");
    // …et la flèche, elle, respire bien avec le reste.
    ck(/_focusArrow[\s\S]{0,120}color\.setHex\(basicHex\)/.test(cam),
      "🚨 la FLÈCHE est modulée par la MÊME frame de pulse que la mise en évidence (même horloge, aucun déphasage possible)");
  }
  });
};

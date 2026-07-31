/* Tests modules — ÉLIGIBILITÉ D'UN WAYPOINT DANS UNE ROUTE (`core/RouteEligibility`, pur).

   Le module ne réimplémente pas la grammaire : il CONSOMME `store.cableRoute` /
   `store.bundleRoute`. Les assertions ci-dessous sont donc, littéralement, les états de la
   maquette `design-system/briefs/route-editor-waypoints.maquette.html` (§03 « états de la
   chaîne » 6.1–6.7, §04 « popover d'ajout ») transposés en verdicts.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, PlacementContainers, RouteEligibility, makeStore } = require("./harness.js");

/** Décor commun : deux salles + une troisième, un étage, des exits, des points, un non posé.
    Volontairement calqué sur les fixtures de `test-core-store.js` (mêmes idiomes, même bâtiment). */
async function decor() {
  const s = await makeStore();
  const dcA = await s.create("datacenters", { name: "Salle A", location: "liege", floor: "1" });
  const dcB = await s.create("datacenters", { name: "Salle B", location: "liege", floor: "1" });
  const dcC = await s.create("datacenters", { name: "Salle C", location: "liege", floor: "1" });
  const rkA = await s.create("racks", { name: "RA", u_count: 42, datacenter_id: dcA.id, dc_x: 500, dc_y: 500 });
  const rkB = await s.create("racks", { name: "RB", u_count: 42, datacenter_id: dcB.id, dc_x: 500, dc_y: 500 });
  const mk = async (nom, patch) => {
    const e = await s.create("equipments", Object.assign({ name: nom }, patch));
    return { e, p: (await s.create("ports", { equipment_id: e.id, name: "p" + nom })).id };
  };
  const eqA = await mk("A", { placement_mode: "rack", rack_id: rkA.id, rack_u: 1 });
  const eqB = await mk("B", { placement_mode: "rack", rack_id: rkB.id, rack_u: 1 });
  const patchA = await s.create("equipments", { name: "PatchA", type: "patch_panel", placement_mode: "rack", rack_id: rkA.id, rack_u: 10 });
  const patchB = await s.create("equipments", { name: "PatchB", type: "patch_panel", placement_mode: "rack", rack_id: rkB.id, rack_u: 10 });

  const wp = {
    exitA: await s.create("waypoints", { name: "SortieA", wp_type: "exit", datacenter_id: dcA.id, dc_x: 0, dc_y: 0 }),
    exitA2: await s.create("waypoints", { name: "SortieA-bis", wp_type: "exit", datacenter_id: dcA.id, dc_x: 10, dc_y: 10 }),
    exitB: await s.create("waypoints", { name: "SortieB", wp_type: "exit", datacenter_id: dcB.id, dc_x: 0, dc_y: 0 }),
    exitC: await s.create("waypoints", { name: "SortieC", wp_type: "exit", datacenter_id: dcC.id, dc_x: 0, dc_y: 0 }),
    pointA: await s.create("waypoints", { name: "PointA", wp_type: "datacenter", datacenter_id: dcA.id, dc_x: 600, dc_y: 600 }),
    brushA: await s.create("waypoints", { name: "Brosse 3", kind: "brush", wp_type: "datacenter", datacenter_id: dcA.id, rack_id: rkA.id, rack_u: 20, u_height: 2 }),
    pointB: await s.create("waypoints", { name: "PointB", wp_type: "datacenter", datacenter_id: dcB.id, dc_x: 600, dc_y: 600 }),
    pin1: await s.create("waypoints", { name: "WP étage", wp_type: "oob", location: "liege", floor: "2", floor_x: 2000, floor_y: 2000 }),
    // Rattaché à une SALLE mais SANS coordonnées → « non posé » (état historique, maquette 6.9).
    flottant: await s.create("waypoints", { name: "Power WP 4", wp_type: "datacenter", datacenter_id: dcA.id }),
  };
  const salle = (d) => ({ kind: "room", id: d.id });
  const etage = (f) => PlacementContainers.floorOf("liege", f);
  return { s, dcA, dcB, dcC, eqA, eqB, patchA, patchB, wp, salle, etage };
}

/** L'ANALYSE injectée, façon formulaire CÂBLE : les deux bouts sont fixes, la route varie. */
const analyseCable = (s, fromPortId, toPortId) => (ids) => s.cableRoute({ from_port_id: fromPortId || null, to_port_id: toPortId || null, waypoint_ids: ids });
/** L'ANALYSE injectée, façon formulaire FAISCEAU (extrémités = patchs). */
const analyseBundle = (s, epA, epB) => (ids) => s.bundleRoute({ endpoint_a_equipment_id: epA || null, endpoint_b_equipment_id: epB || null, waypoint_ids: ids });

/** Candidat au format attendu par le module (ce que le formulaire dérive de `Waypoint`). */
const candidat = (s, w) => ({
  id: w.id,
  container: w.wp_type === "exit" || w.datacenter_id
    ? (w.datacenter_id ? { kind: "room", id: w.datacenter_id } : null)
    : PlacementContainers.floorOf(w.location, w.floor),
  type: w.wp_type === "exit" ? "exit" : (!w.datacenter_id && (w.location || w.floor_x != null) ? "floor" : "datacenter"),
  placed: (!w.datacenter_id && (w.location || w.floor_x != null)) ? true : s.waypointIsPlaced(w),
});

/** Motif rendu sur un candidat donné (`""` = utilisable). */
const motif = (plan, id) => {
  const v = plan.flat.find((x) => x.candidate.id === id);
  if (!v) return "(absent)";
  return v.usable ? "" : String(v.reason);
};

module.exports = async () => {

  await section("RouteEligibility : rattacher chaque erreur à SON étape (carton §3, maquette 6.6)", async () => {
    const { s, wp, eqA, eqB } = await decor();
    const analyse = analyseCable(s, null, null);
    /** Codes rattachés, étape par étape (« - » = étape saine) — la lecture qu'affiche la chaîne. */
    const parEtape = (ids) => RouteEligibility.stepErrors(ids, analyse).map((e) => (e ? e.code : "-")).join("|");

    ck.eq(parEtape([]), "", "route vide : aucune étape, donc aucune erreur d'étape (maquette 6.1)");
    ck.eq(parEtape([wp.brushA.id, wp.pointA.id]), "-|-", "route intra-salle cohérente : deux étapes saines (maquette 6.2)");
    ck.eq(parEtape([wp.exitA.id, wp.exitB.id]), "-|-", "inter-salles nominal : les deux exits sont sains (maquette 6.3)");
    ck.eq(parEtape([wp.exitA.id, wp.pin1.id, wp.exitB.id]), "-|-|-", "inter-salles VIA ÉTAGE : le pin d'étage referme le tronçon (maquette 6.4)");

    // 6.6 — l'erreur se pose sur l'étape FAUTIVE, pas sur la première ni sur toutes.
    ck.eq(parEtape([wp.exitA.id, wp.pointA.id]), "-|room_wp_outside",
      "waypoint de salle APRÈS l'exit de sa salle : l'erreur est sur l'étape 2, l'étape 1 reste saine");
    ck.eq(parEtape([wp.exitA.id, wp.exitA.id]), "-|exit_reentry", "ré-entrée par l'exit quitté : erreur sur l'étape 2 (maquette 6.6)");
    ck.eq(parEtape([wp.pointA.id, wp.exitB.id]), "-|exit_wrong_room", "exit d'une AUTRE salle : erreur sur l'étape 2");
    ck.eq(parEtape([wp.pointA.id, wp.pin1.id]), "-|floor_outside", "pin d'étage À L'INTÉRIEUR d'une salle : erreur sur l'étape 2");
    ck.eq(parEtape([wp.brushA.id, wp.flottant.id, wp.exitA.id]), "-|unplaced|-",
      "waypoint NON POSÉ : l'étape 2 est signalée, les voisines restent saines (maquette 6.9)");

    // Ce qui NE se rattache à AUCUNE étape — et c'est tout l'intérêt du filtre `STEP_CODES`.
    ck.eq(parEtape([wp.exitA.id]), "-",
      "`exit_unpaired` ne salit AUCUNE étape : c'est un état de FIN de route (le bandeau Transit, maquette 6.5)");
    const avecBouts = RouteEligibility.stepErrors([wp.exitA.id, wp.exitB.id], analyseCable(s, eqA.p, eqA.p));
    ck.eq(avecBouts.filter((e) => e).length, 0,
      "`portA_room`/`portB_room` ne salissent aucune étape non plus : ils parlent des ANCRES (maquette 6.7)");

    // Un id PENDANT (waypoint supprimé) ne produit pas d'étape → l'indexation reste celle des `steps`.
    ck.eq(parEtape(["inexistant", wp.exitA.id, wp.pointA.id]), "-|room_wp_outside",
      "id pendant : indexé par ÉTAPE (pas par waypoint_ids) — il ne décale pas le rattachement");
    ck.eq(RouteEligibility.stepErrors([wp.exitA.id, wp.pointA.id], analyse).length,
      analyse([wp.exitA.id, wp.pointA.id]).steps.length,
      "stepErrors a EXACTEMENT la longueur de `steps` (contrat d'appariement du composant)");
    ck(eqB && eqB.p, "fixture : le second équipement porte bien un port (décor partagé)");
  });

  await section("RouteEligibility : état APRÈS chaque étape — ce qui fait les bandeaux (maquette 6.3 vs 6.6)", async () => {
    const { s, wp, dcA, dcB, salle, etage } = await decor();
    const analyse = analyseCable(s, null, null);
    /** Lecture des bandeaux : « T » = tronçon RESTÉ ouvert après l'étape, sinon le conteneur atteint. */
    const apres = (ids) => RouteEligibility.stepReports(ids, analyse)
      .map((r) => (r.after.transit ? "T" : JSON.stringify(r.after.container))).join("|");

    ck.eq(apres([wp.brushA.id, wp.pointA.id]), [JSON.stringify(salle(dcA)), JSON.stringify(salle(dcA))].join("|"),
      "6.2 intra-salle : la route reste dans Salle A après chaque étape (un seul bandeau)");
    ck.eq(apres([wp.exitA.id, wp.exitB.id]), ["T", JSON.stringify(salle(dcB))].join("|"),
      "6.3 inter-salles NOMINAL : le tronçon ouvert par l'exit 1 est REFERMÉ par l'exit 2 — aucun bandeau « Transit » au milieu");
    ck.eq(apres([wp.exitA.id, wp.pointA.id, wp.exitB.id]), ["T", "T", JSON.stringify(salle(dcB))].join("|"),
      "6.6 le waypoint fautif NE referme PAS le tronçon : le bandeau « Transit » s'intercale avant lui");
    ck.eq(apres([wp.exitA.id, wp.pin1.id]), ["T", JSON.stringify(etage("2"))].join("|"),
      "6.4 le pin d'étage referme le tronçon : bandeau d'ÉTAGE, pas « Transit »");
    ck.eq(apres([wp.brushA.id, wp.exitA.id]).split("|").pop(), "T",
      "6.5 la route se TERMINE en transit : c'est le bandeau + bloc pointillé de fin (état visible, plus une erreur au save)");
    ck.eq(RouteEligibility.stepReports([], analyse).length, 0, "route vide : aucun rapport d'étape");
    ck.eq(RouteEligibility.stepReports([wp.exitA.id], analyse)[0].after.left ? JSON.stringify(RouteEligibility.stepReports([wp.exitA.id], analyse)[0].after.left) : "",
      JSON.stringify(salle(dcA)), "…et l'état d'après nomme la salle QUITTÉE (libellé du bloc de transit)");
  });

  await section("RouteEligibility : route saisie À L'ENVERS → une ACTION, pas une erreur (maquette 6.7b)", async () => {
    const { s, wp, eqA, eqB, patchA, patchB } = await decor();
    // Câble : bout A en Salle A, bout B en Salle B, route saisie B → A.
    const alEnvers = s.cableRoute({ from_port_id: eqA.p, to_port_id: eqB.p, waypoint_ids: [wp.exitB.id, wp.exitA.id] });
    ck.eq(RouteEligibility.isReversed(alEnvers), true, "câble : bouts dans l'autre sens que la route → « sens à confirmer »");
    const aLEndroit = s.cableRoute({ from_port_id: eqA.p, to_port_id: eqB.p, waypoint_ids: [wp.exitA.id, wp.exitB.id] });
    ck.eq(RouteEligibility.isReversed(aLEndroit), false, "câble : route à l'endroit → aucune inversion à proposer");
    ck.eq(aLEndroit.valid, true, "…et cette route-là est valide (référence)");

    // Le MÊME prédicat, une seule écriture, doit coïncider avec le `sens` que le faisceau expose déjà.
    const bundleEnvers = s.bundleRoute({ endpoint_a_equipment_id: patchA.id, endpoint_b_equipment_id: patchB.id, waypoint_ids: [wp.exitB.id, wp.exitA.id] });
    ck.eq(bundleEnvers.sens, "swapped", "faisceau : le moteur dit déjà `sens: swapped`…");
    ck.eq(RouteEligibility.isReversed(bundleEnvers), true, "…et `isReversed` rend le MÊME verdict (une seule règle pour les deux formulaires)");
    const bundleEndroit = s.bundleRoute({ endpoint_a_equipment_id: patchA.id, endpoint_b_equipment_id: patchB.id, waypoint_ids: [wp.exitA.id, wp.exitB.id] });
    ck.eq(bundleEndroit.sens, "aligned", "faisceau à l'endroit : `sens: aligned`…");
    ck.eq(RouteEligibility.isReversed(bundleEndroit), false, "…et aucune inversion proposée");

    // Une ancre manquante ou une route sans exits ne sont PAS une inversion (on ne propose rien).
    ck.eq(RouteEligibility.isReversed(s.cableRoute({ from_port_id: eqA.p, to_port_id: null, waypoint_ids: [wp.exitB.id, wp.exitA.id] })), false,
      "un seul bout renseigné : rien à inverser (on n'invente pas une symétrie)");
    ck.eq(RouteEligibility.isReversed(s.cableRoute({ from_port_id: eqA.p, to_port_id: eqB.p, waypoint_ids: [] })), false,
      "route VIDE : aucune inversion (le désaccord est `ports_split`, pas un sens)");
  });

  await section("RouteEligibility : état de l'automate à la position d'insertion + suggestion de fin", async () => {
    const { s, wp, dcA, dcB, salle, etage } = await decor();
    const analyse = analyseCable(s, null, null);
    const etat = (ids, at) => RouteEligibility.insertState(ids, analyse, at);

    const vide = etat([]);
    ck.eq(vide.transit, false, "6.1 route vide : pas de transit");
    ck.eq(vide.container, null, "6.1 route vide : aucun conteneur courant (le premier waypoint l'ouvrira)");

    ck.eq(JSON.stringify(etat([wp.brushA.id]).container), JSON.stringify(salle(dcA)),
      "6.2 intra-salle : le conteneur courant est la salle du waypoint");

    const transit = etat([wp.exitA.id]);
    ck.eq(transit.transit, true, "6.5 après un exit : la route est EN TRANSIT (bandeau pointillé)");
    ck.eq(transit.container, null, "6.5 en transit : aucun conteneur courant");
    ck.eq(JSON.stringify(transit.left), JSON.stringify(salle(dcA)), "6.5 en transit : la « salle quittée » est nommée");

    ck.eq(JSON.stringify(etat([wp.exitA.id, wp.pin1.id]).container), JSON.stringify(etage("2")),
      "6.4 le pin d'étage referme le tronçon : le conteneur courant devient l'ÉTAGE");
    ck.eq(etat([wp.exitA.id, wp.pin1.id]).transit, false, "6.4 …et l'on n'est plus en transit (un étage est une ARRIVÉE)");

    // La POSITION compte : au milieu d'une route valide, l'état est celui du PRÉFIXE.
    ck.eq(etat([wp.exitA.id, wp.exitB.id], 1).transit, true, "insertion au MILIEU : l'état lu est celui du préfixe (ici, transit)");
    ck.eq(etat([wp.exitA.id, wp.exitB.id], 0).container, null, "insertion en TÊTE : le préfixe est vide");
    ck.eq(etat([wp.exitA.id, wp.exitB.id], 99).transit, false, "position hors bornes : ramenée à la FIN de route");

    // Suggestion « il manque l'exit de X pour rejoindre le bout B » (carton §4.3).
    ck.eq(JSON.stringify(RouteEligibility.endGap(analyse([wp.exitA.id]), salle(dcB))), JSON.stringify(salle(dcB)),
      "6.5 transit ouvert + bout B en Salle B : la suggestion nomme Salle B");
    ck.eq(RouteEligibility.endGap(analyse([wp.exitA.id, wp.exitB.id]), salle(dcB)), null,
      "route qui arrive bien en Salle B : aucune suggestion");
    ck.eq(RouteEligibility.endGap(analyse([]), salle(dcB)), null,
      "route VIDE : aucune suggestion (tracé direct entre les deux bouts — maquette 6.1)");
    ck.eq(RouteEligibility.endGap(analyse([wp.exitA.id]), null), null, "bout non localisable : rien à suggérer");
    ck.eq(JSON.stringify(RouteEligibility.endGap(analyse([wp.exitA.id, wp.exitB.id]), salle(dcA))), JSON.stringify(salle(dcA)),
      "route qui arrive AILLEURS que le bout : la suggestion nomme le conteneur du bout (maquette 6.7)");
  });

  await section("RouteEligibility : classification des candidats (maquette §04, câble)", async () => {
    const { s, wp, dcA, dcB, salle } = await decor();
    const analyse = analyseCable(s, null, null);
    const tous = [wp.exitA, wp.exitA2, wp.exitB, wp.exitC, wp.pointA, wp.brushA, wp.pointB, wp.pin1, wp.flottant].map((w) => candidat(s, w));
    const ancres = { a: salle(dcA), b: salle(dcB) };
    const plan = (ids, at) => RouteEligibility.plan(tous, ids, analyse, ancres, at);

    // ---- ROUTE VIDE : la grammaire n'a encore rien fixé → tout waypoint POSÉ ouvre la route.
    const vide = plan([]);
    ck.eq(motif(vide, wp.pointA.id), "", "route vide : un point de salle est utilisable (il OUVRE la route)");
    ck.eq(motif(vide, wp.pointB.id), "", "route vide : un point d'une AUTRE salle l'est aussi — rien n'est encore fixé");
    ck.eq(motif(vide, wp.pin1.id), "", "route vide : un pin d'étage est utilisable (une route peut COMMENCER sur un étage)");
    ck.eq(motif(vide, wp.flottant.id), "unplaced", "route vide : un waypoint NON POSÉ est visible mais refusé (carton §5.7)");

    // ---- DANS UNE SALLE : ses waypoints et son exit, rien d'autre (carton §5.2).
    const dansA = plan([wp.pointA.id]);
    ck.eq(motif(dansA, wp.brushA.id), "", "dans Salle A : une brosse de Salle A passe");
    ck.eq(motif(dansA, wp.exitA.id), "", "dans Salle A : l'exit de Salle A passe (c'est la sortie)");
    ck.eq(motif(dansA, wp.pointB.id), "wrong_room", "dans Salle A : un waypoint de Salle B est REFUSÉ (wrong_room)");
    ck.eq(motif(dansA, wp.exitB.id), "exit_wrong_room", "dans Salle A : l'exit d'une autre salle est refusé (exit_wrong_room)");
    ck.eq(motif(dansA, wp.pin1.id), "floor_pin_in_room", "dans une salle : un pin d'étage n'y a pas sa place (carton §5.4)");
    ck.eq(motif(dansA, wp.pointA.id), "already_in_route", "un waypoint DÉJÀ dans la route ne se propose pas deux fois");

    // ---- EN TRANSIT : seuls l'exit d'une AUTRE salle et le pin d'étage referment (carton §5.3).
    const enTransit = plan([wp.exitA.id]);
    ck.eq(motif(enTransit, wp.exitB.id), "", "en transit : l'exit d'une AUTRE salle referme le tronçon");
    ck.eq(motif(enTransit, wp.pin1.id), "", "en transit : un pin d'étage referme aussi le tronçon");
    ck.eq(motif(enTransit, wp.pointA.id), "in_transit", "en transit : un waypoint de salle est refusé — il faut d'abord ENTRER par un exit");
    ck.eq(motif(enTransit, wp.pointB.id), "in_transit", "en transit : même celui de la salle d'arrivée (l'exit doit précéder)");
    ck.eq(motif(enTransit, wp.exitA2.id), "exit_reentry", "en transit : re-rentrer dans la salle QUITTÉE est refusé (exit_reentry)");
    ck.eq(motif(enTransit, wp.exitA.id), "already_in_route", "en transit : l'exit déjà employé est marqué « déjà dans la route », pas « ré-entrée »");

    // ---- SUR UN ÉTAGE : un waypoint de SALLE n'y est pas non plus, mais le motif DIFFÈRE du transit.
    const surEtage = plan([wp.exitA.id, wp.pin1.id]);
    ck.eq(motif(surEtage, wp.pointB.id), "room_wp_on_floor",
      "sur un étage : le refus dit « la route est sur un étage » et non « en transit » (même code de grammaire, deux mots justes — décision D4)");
    ck.eq(motif(surEtage, wp.exitB.id), "", "sur un étage : l'exit d'une salle y fait ENTRER");

    // ---- INSERTION AU MILIEU : le candidat lui-même passe, mais il CASSE la suite.
    const auMilieu = plan([wp.exitA.id, wp.exitB.id], 1);
    ck.eq(motif(auMilieu, wp.exitC.id), "breaks_route",
      "insertion au milieu : l'exit de Salle C est correct à SA place mais rendrait l'étape suivante fautive");
    ck.eq(motif(auMilieu, wp.pin1.id), "", "insertion au milieu : un pin d'étage s'insère sans casser la suite (maquette 6.4)");
    ck.eq(motif(plan([wp.exitA.id, wp.exitB.id]), wp.exitC.id), "exit_wrong_room",
      "…alors qu'en FIN de la même route, le refus vient de la grammaire elle-même (la route est DANS Salle B) — la POSITION change le verdict, et le MOTIF avec elle");

    ck.eq(RouteEligibility.plan([], [], analyse, ancres).flat.length, 0, "aucun candidat → plan vide (aucune analyse inutile)");
  });

  await section("RouteEligibility : groupes par CONTENEUR et ordre de PERTINENCE (maquette §04)", async () => {
    const { s, wp, dcA, dcB, salle } = await decor();
    const analyse = analyseCable(s, null, null);
    const tous = [wp.pointA, wp.exitA, wp.pointB, wp.exitB, wp.exitC, wp.pin1].map((w) => candidat(s, w));
    const ancres = { a: salle(dcA), b: salle(dcB) };

    // ---- ROUTE VIDE : le conteneur COURANT n'existe pas encore → les bouts mènent la danse.
    const vide = RouteEligibility.plan(tous, [], analyse, ancres);
    ck.eq(vide.groups.map((g) => g.relevance).join(","), "endpointA,endpointB,,",
      "route vide : les groupes des DEUX bouts passent devant, puis le reste dans l'ordre reçu");

    // ---- DANS SALLE A : le conteneur courant passe en tête, même s'il est aussi le bout A.
    const dansA = RouteEligibility.plan(tous, [wp.pointA.id], analyse, ancres);
    ck.eq(dansA.groups[0].relevance, "current", "dans Salle A : ① le conteneur COURANT de l'automate");
    ck.eq(JSON.stringify(dansA.groups[0].container), JSON.stringify(salle(dcA)), "…et c'est bien Salle A");
    ck.eq(dansA.groups[1].relevance, "endpointB", "② puis le conteneur du bout B");

    // ---- EN TRANSIT : la salle QUITTÉE tombe en dernier — c'est le seul endroit interdit.
    const enTransit = RouteEligibility.plan(tous, [wp.exitA.id], analyse, ancres);
    ck.eq(enTransit.groups.map((g) => g.relevance).join(","), "endpointB,,,left",
      "en transit : bout B d'abord, la salle QUITTÉE en dernier (elle est pourtant aussi le bout A — « quittée » l'emporte, elle EXPLIQUE le refus)");
    ck.eq(JSON.stringify(enTransit.groups[enTransit.groups.length - 1].container), JSON.stringify(salle(dcA)),
      "…et le groupe relégué est bien Salle A");

    // ---- EXITS EN TÊTE de leur groupe (les articulations de la route).
    const groupeA = dansA.groups[0];
    ck.eq(groupeA.items[0].candidate.id, wp.exitA.id, "dans un groupe, l'EXIT vient en tête (articulation) même s'il a été fourni après");
    ck.eq(groupeA.items.length, 2, "…et le groupe garde bien ses deux waypoints de Salle A");

    // ---- La liste PLATE est la concaténation exacte des groupes (ce que consomme le popover L2).
    const plat = [];
    enTransit.groups.forEach((g) => g.items.forEach((i) => plat.push(i.candidate.id)));
    ck.eq(enTransit.flat.map((v) => v.candidate.id).join(","), plat.join(","),
      "`flat` est EXACTEMENT la concaténation des groupes — une seule vérité d'ordre pour L2 et L3");
    ck.eq(enTransit.flat.length, tous.length, "…et aucun candidat n'est perdu en route");

    // ---- Un candidat SANS conteneur ne casse pas le groupement (`same(null, null)` vaut false).
    const orphelin = { id: "orphelin", container: null, type: "datacenter", placed: false };
    const avecOrphelins = RouteEligibility.plan([orphelin, { id: "orphelin2", container: null, type: "datacenter", placed: false }], [], analyse, ancres);
    ck.eq(avecOrphelins.groups.length, 1, "deux candidats SANS conteneur forment UN groupe (le piège `same(null,null) === false` est traité)");
    ck.eq(avecOrphelins.groups[0].relevance, null, "…et ce groupe n'a aucune étiquette de pertinence");
  });

  await section("RouteEligibility : PARITÉ faisceau — le même module sur `bundleRoute` (carton §4.5)", async () => {
    const { s, wp, dcA, dcB, patchA, patchB, salle } = await decor();
    const analyse = analyseBundle(s, patchA.id, patchB.id);
    const tous = [wp.exitA, wp.exitB, wp.pointA, wp.pointB, wp.pin1, wp.flottant].map((w) => candidat(s, w));
    const ancres = { a: salle(dcA), b: salle(dcB) };

    // Le faisceau ajoute des codes qui lui sont propres — ils ne doivent RIEN bloquer ni salir.
    const routeVide = analyse([]);
    ck(routeVide.errors.some((e) => e.code === "endpoints_split"),
      "fixture : deux extrémités dans deux salles sans exit → `endpoints_split` (le verdict propre au faisceau)");
    ck.eq(RouteEligibility.stepErrors([], analyse).length, 0, "…mais `endpoints_split` ne se rattache à AUCUNE étape");

    const vide = RouteEligibility.plan(tous, [], analyse, ancres);
    ck.eq(motif(vide, wp.exitA.id), "", "faisceau : l'exit de Salle A reste proposable malgré `endpoints_split` (ce n'est pas une erreur d'ÉTAPE)");
    ck.eq(motif(vide, wp.flottant.id), "unplaced", "faisceau : un waypoint non posé est refusé, comme côté câble");

    const enTransit = RouteEligibility.plan(tous, [wp.exitA.id], analyse, ancres);
    ck.eq(motif(enTransit, wp.pointA.id), "in_transit", "faisceau : la grammaire de transit est la MÊME (aucun code propre au câble)");
    ck.eq(motif(enTransit, wp.exitB.id), "", "faisceau : l'exit de l'autre salle referme le tronçon");
    ck.eq(enTransit.groups.map((g) => g.relevance).join(","), "endpointB,,left",
      "faisceau : la pertinence se calcule sur les extrémités PATCH exactement comme sur les ports d'un câble");

    // Le SENS inversé (toléré par le moteur) n'est pas non plus un motif de refus d'étape.
    const inverse = analyse([wp.exitB.id, wp.exitA.id]);
    ck.eq(inverse.sens, "swapped", "fixture : route saisie à l'envers → `sens: swapped` (maquette 6.7b)");
    ck.eq(RouteEligibility.stepErrors([wp.exitB.id, wp.exitA.id], analyse).filter((e) => e).length, 0,
      "…et aucune étape n'est fautive : c'est une ACTION à proposer (« Inverser la route »), pas une erreur");
  });

  await section("RouteEligibility : insertion — une seule écriture de la route sondée", async () => {
    const { s, wp } = await decor();
    ck.eq(RouteEligibility.insertAt(["a", "b"], "x").join(","), "a,b,x", "insertAt sans position : en FIN de route (défaut du carton §4.2)");
    ck.eq(RouteEligibility.insertAt(["a", "b"], "x", 0).join(","), "x,a,b", "insertAt en tête");
    ck.eq(RouteEligibility.insertAt(["a", "b"], "x", 1).join(","), "a,x,b", "insertAt au milieu");
    ck.eq(RouteEligibility.insertAt(["a", "b"], "x", 9).join(","), "a,b,x", "insertAt hors bornes : ramené en fin");
    ck.eq(RouteEligibility.insertAt(["a", "b"], "x", -3).join(","), "x,a,b", "insertAt négatif : ramené en tête");
    const source = ["a", "b"];
    RouteEligibility.insertAt(source, "x", 1);
    ck.eq(source.join(","), "a,b", "insertAt ne MUTE PAS la route reçue (le brouillon n'est écrit que par le composant)");

    // La sonde d'éligibilité et l'ajout réel doivent produire la MÊME route — sinon le popover ment.
    const analyse = analyseCable(s, null, null);
    const ids = [wp.exitA.id];
    const plan = RouteEligibility.plan([candidat(s, wp.exitB)], ids, analyse, { a: null, b: null });
    const apres = RouteEligibility.insertAt(ids, wp.exitB.id);
    ck.eq(plan.flat[0].usable, true, "le popover annonce l'exit B utilisable…");
    ck.eq(RouteEligibility.stepErrors(apres, analyse).filter((e) => e).length, 0, "…et l'ajout réel produit bien une route sans erreur d'étape");
    ck.eq(RouteEligibility.isTransit(analyse(apres)), false, "…qui n'est plus en transit (le tronçon est refermé)");
  });
};

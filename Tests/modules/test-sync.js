/* Tests modules — rechargement granulaire REST (impact, changeset, planner).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("sync : RenderImpact (carte d'impact 3D)", async () => {
  {
    // Invariant CRITIQUE : toute collection du registre a un impact déclaré (sinon défaut prudent, mais on veut un choix EXPLICITE).
    ck.eq(RenderImpact.unmapped().length, 0, "RenderImpact : toutes les collections sont mappées (" + EntityRegistry.COLLECTIONS.length + ")");
    // Classification (cf. docs/render-impact.md) — quelques ancres représentatives de chaque niveau.
    ck.eq(COLLECTION_THREE_IMPACT.racks, "geometry", "racks → geometry");
    ck.eq(COLLECTION_THREE_IMPACT.portTypes, "geometry", "portTypes → geometry (taille connecteur, dépendance indirecte)");
    ck.eq(COLLECTION_THREE_IMPACT.networks, "recolor", "networks → recolor (couleur câbles)");
    ck.eq(COLLECTION_THREE_IMPACT.groups, "recolor", "groups → recolor (couleur occupants)");
    ck.eq(COLLECTION_THREE_IMPACT.ipAddresses, "none", "ipAddresses → none (hors 3D)");
    ck.eq(COLLECTION_THREE_IMPACT.spares, "none", "spares → none (hors 3D)");
    ck.eq(COLLECTION_THREE_IMPACT.cableBundles, "none", "cableBundles → none (tooltip seul)");
    ck.eq(RenderImpact.of("collection_inexistante"), "geometry", "collection inconnue → défaut PRUDENT geometry");
    ck.eq(RenderImpact.worst("none", "geometry"), "geometry", "RenderImpact.worst : none < geometry");
    ck.eq(RenderImpact.worst("recolor", "none"), "recolor", "RenderImpact.worst : recolor > none");
  }
  });

  await section("sync : Changeset (fusion + coercition)", async () => {
  {
    ck.eq(Changeset.empty().full, false, "Changeset.empty : full=false");
    ck.eq(Changeset.full().full, true, "Changeset.full : full=true");
    // coercition d'une valeur réseau non fiable
    ck.eq(Changeset.coerce(null).full, true, "coerce(null) → full (repli sûr)");
    ck.eq(Changeset.coerce({ full: true }).full, true, "coerce({full:true}) → full");
    const coerced = Changeset.coerce({ collections: ["racks", 42, "cables"], meta: 1, images: 0 });
    ck.eq(JSON.stringify(coerced.collections), JSON.stringify(["racks", "cables"]), "coerce : collections filtrées (non-strings retirées)");
    ck.eq(coerced.meta, true, "coerce : meta coercé en booléen");
    // prédicat INJECTÉ (garde `shared/` auto-suffisant) : filtre les collections inconnues
    const filtered = Changeset.coerce({ collections: ["racks", "bidon", "cables"] }, (c) => c === "racks" || c === "cables");
    ck.eq(JSON.stringify(filtered.collections), JSON.stringify(["racks", "cables"]), "coerce : collection inconnue retirée via prédicat");
    ck.eq(Changeset.coerce({ collections: ["racks", "bidon"] }).collections.length, 2, "coerce : sans prédicat → aucun filtre (compat)");
    // fusion : union des collections, OU des drapeaux
    const merged = Changeset.merge(
      { full: false, collections: ["racks"], meta: false, images: true },
      { full: false, collections: ["racks", "cables"], meta: true, images: false },
    );
    ck.eq(JSON.stringify(merged.collections), JSON.stringify(["racks", "cables"]), "merge : union dédupliquée des collections");
    ck.eq(merged.meta && merged.images, true, "merge : drapeaux meta/images en OU");
    ck.eq(Changeset.merge(Changeset.full(), Changeset.empty()).full, true, "merge : full domine");
  }
  });

  await section("sync : ReloadPlanner (changeset → plan)", async () => {
  {
    const planner = new ReloadPlanner();
    // collections HORS 3D → aucune reconstruction (le gain : pas de gel d'UI pour une IP / un spare / un réseau IP)
    const ipPlan = planner.plan({ full: false, collections: ["ipAddresses", "spares"], meta: false, images: false });
    ck.eq(ipPlan.threeRebuild, "none", "plan : IP+spare → threeRebuild none (PAS de rebuild 3D)");
    ck.eq(JSON.stringify(ipPlan.refetchCollections), JSON.stringify(["ipAddresses", "spares"]), "plan : refetch ciblé (P2)");
    // collection géométrique → reconstruction complète
    ck.eq(planner.plan({ full: false, collections: ["racks"], meta: false, images: false }).threeRebuild, "geometry", "plan : racks → geometry");
    // collection couleur seule → recolor
    ck.eq(planner.plan({ full: false, collections: ["networks"], meta: false, images: false }).threeRebuild, "recolor", "plan : networks → recolor");
    // pire impact d'un lot mixte
    ck.eq(planner.plan({ full: false, collections: ["spares", "networks", "racks"], meta: false, images: false }).threeRebuild, "geometry", "plan : lot mixte → pire impact (geometry)");
    // image changée → au moins geometry (textures dessinées)
    ck.eq(planner.plan({ full: false, collections: [], meta: false, images: true }).threeRebuild, "geometry", "plan : image changée → geometry");
    ck.eq(planner.plan({ full: false, collections: ["spares"], meta: false, images: true }).refreshImages, true, "plan : images → refreshImages true");
    ck.eq(planner.plan({ full: false, collections: ["spares"], meta: false, images: false }).refreshImages, false, "plan : pas d'image → refreshImages false");
    // périmètre indéterminé → tout recharger + rebuild complet
    const fullPlan = planner.plan(Changeset.full());
    ck.eq(fullPlan.refetchCollections, null, "plan : full → refetch null (tout le document)");
    ck.eq(fullPlan.threeRebuild, "geometry", "plan : full → geometry");
  }
  });
};

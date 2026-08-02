/* Tests modules — COMPLÉTUDE de la spec partagée (régularisation D3a, chantier migration DB).
   ----------------------------------------------------------------------------
   LE VERROU DE CE FICHIER EST LA PIÈCE MAÎTRESSE DU LOT : depuis la régularisation
   2026-07-31, la spec `SPEC_FIELDS` est COMPLÈTE (tout champ persisté déclaré), parce que
   la future dérivation du DDL relationnel (colonnes strictes) PERDRAIT tout champ non
   déclaré à l'écriture. Ce test confronte le CORPUS DE DÉMO VERSIONNÉ à la spec : si un
   futur champ apparaît dans les données sans être déclaré, il échoue en NOMMANT
   collection + champ — un champ ne peut plus redevenir passthrough en silence.
   ⚠ Corpus : `samples-public/demo-infra.json` UNIQUEMENT (fictif, versionné). Ne JAMAIS
   pointer `Samples/` ici : données réelles, non versionnées.
   S'y ajoutent : la sémantique MINIMALE du nouveau `FieldType` "json" et le contrat des
   défauts « sensibles » (une géométrie absente reste null — jamais transformée en 0).
   Doctrine : docs/validation.md §10 ; harnais et assertions : harness.js. */
"use strict";
const fs = require("fs");
const { ck, section, path, Validation, SharedSchema } = require("./harness.js");

module.exports = async () => {
  await section("shared : COMPLÉTUDE de la spec — chaque champ du corpus de démo est déclaré (verrou D3a)", async () => {
  {
    const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "samples-public", "demo-infra.json"), "utf8"));

    // LISTE FERMÉE des clés tolérées HORS spec — chaque entrée est un choix documenté, pas une commodité :
    // - `id` : clé primaire de tout enregistrement, posée par le générateur DDL (jamais un champ de spec) ;
    // - les 4 champs d'AUDIT : posés/écrasés PAR LE SERVEUR (AuditStamp) après validation — passthrough
    //   ASSUMÉ (cf. doctrine en tête de `CollectionSpec`), colonnes standard du générateur DDL ;
    // - `equipments.face_image` / `face_image_rear` : LEGACY inline (toujours null), à PURGER à la
    //   migration L4 — les déclarer aurait fait entrer un champ mort dans le schéma cible.
    // AJOUTER ICI = décision d'architecture (élargir le passthrough), à documenter dans validation.md §10.
    const TOLERATED_EVERYWHERE = new Set(["id", "created_by", "updated_by", "created_date", "updated_date"]);
    const TOLERATED_BY_COLLECTION = { equipments: new Set(["face_image", "face_image_rear"]) };

    // Le DÉTECTEUR, factorisé pour être aussi retourné CONTRE lui-même (contrôle de discrimination plus
    // bas) : renvoie les « collection.champ » présents dans les données et absents de la spec.
    const undeclaredOf = (data) => {
      const violations = [];
      for (const collection of SharedSchema.COLLECTIONS) {
        const fields = (Validation.COLLECTION_SPECS[collection] || {}).fields || {};
        const tolerated = TOLERATED_BY_COLLECTION[collection] || new Set();
        for (const record of (data[collection] || [])) {
          for (const key of Object.keys(record)) {
            const label = collection + "." + key;
            if (!(key in fields) && !TOLERATED_EVERYWHERE.has(key) && !tolerated.has(key) && !violations.includes(label)) violations.push(label);
          }
        }
      }
      return violations;
    };

    // ANTI-VACUITÉ : un corpus introuvable/vide rendrait le verrou trivialement vert. On exige un volume
    // réel (246 enregistrements au moment de l'écriture) et la présence des collections structurantes.
    const totalRecords = SharedSchema.COLLECTIONS.reduce((sum, c) => sum + ((corpus[c] || []).length), 0);
    ck(totalRecords > 200, "complétude : corpus de démo réellement lu (" + totalRecords + " enregistrements > 200)");
    ck((corpus.equipments || []).length >= 10 && (corpus.ports || []).length >= 50, "complétude : collections structurantes peuplées (equipments, ports)");

    // LE VERROU : aucune clé du corpus hors spec (l'échec NOMME les fautifs).
    const violations = undeclaredOf(corpus);
    ck.eq(violations.length, 0, "complétude : AUCUN champ du corpus hors spec — fautifs éventuels : [" + violations.join(", ") + "]");

    // CONTRÔLE DE DISCRIMINATION : prouver que le détecteur VOIT un champ non déclaré (un verrou qui ne
    // mord pas donne une fausse sécurité — même précaution que l'isolement de src-shared/). On rejoue le
    // détecteur sur un enregistrement DE SYNTHÈSE portant une clé inconnue et une clé legacy tolérée.
    const probe = { equipments: [{ id: "e-probe", name: "probe", champ_fantome: 1, face_image: null }] };
    const probeViolations = undeclaredOf(probe);
    ck.eq(JSON.stringify(probeViolations), JSON.stringify(["equipments.champ_fantome"]),
      "complétude : le détecteur MORD (clé inconnue signalée, legacy toléré ignoré)");

    // Les EXCEPTIONS restent EXCEPTIONNELLES : les champs tolérés ne doivent PAS être (re)déclarés dans la
    // spec — sinon la liste fermée ci-dessus et la spec divergeraient (deux vérités sur le même champ).
    for (const key of ["face_image", "face_image_rear", "created_by", "updated_date"]) {
      ck(!(key in Validation.COLLECTION_SPECS.equipments.fields), "complétude : « equipments." + key + " » toléré HORS spec, donc pas déclaré dedans");
    }
  }
  });

  await section("shared : FieldType « json » — sémantique MINIMALE (passthrough, défaut, scalaire refusé, nullable)", async () => {
  {
    const DV = Validation.DataValidator;

    // -- NORMALISATION : une valeur PRÉSENTE traverse TELLE QUELLE (le contenu appartient au client). --
    const doors = [{ id: "d1", wall: "left", offset: 200, width_mm: 900 }];
    ck.eq(JSON.stringify(DV.normalizeRecord("datacenters", { name: "S", doors }).doors), JSON.stringify(doors), "json : datacenters.doors présent → traversé inchangé");
    const door = { enabled: true, thickness_mm: 40, hinge: "left", leaves: 1, hollow: false, hollow_mm: 0 };
    ck.eq(JSON.stringify(DV.normalizeRecord("racks", { name: "R", door_front: door }).door_front), JSON.stringify(door), "json : racks.door_front présent → traversé inchangé");
    const nics = [{ name: "net0", mac: "AA:BB", bridge: "vmbr0", vlan_tag: 42, ips: ["10.0.0.5"] }];
    ck.eq(JSON.stringify(DV.normalizeRecord("vms", { name: "web", nics }).nics), JSON.stringify(nics), "json : vms.nics présent → traversé inchangé");

    // -- DÉFAUT posé quand le champ est ABSENT (parité constructeurs client : [] pour les tableaux). --
    ck.eq(JSON.stringify(DV.normalizeRecord("vms", { name: "web" }).nics), "[]", "json : vms.nics absent → [] (défaut)");
    ck.eq(JSON.stringify(DV.normalizeRecord("datacenters", { name: "S" }).doors), "[]", "json : datacenters.doors absent → [] (défaut)");
    // Champ json NULLABLE (portes de baie) : absent → null (« pas de porte déclarée », pas un objet inventé).
    ck.eq(DV.normalizeRecord("racks", { name: "R" }).door_front, null, "json nullable : racks.door_front absent → null");
    ck.eq(DV.normalizeRecord("racks", { name: "R", door_rear: null }).door_rear, null, "json nullable : racks.door_rear null explicite → null conservé");

    // -- VALIDATION : objet et tableau acceptés, SCALAIRE refusé (code « type »). --
    ck.eq(DV.validateRecord("racks", { name: "R", door_front: door }).filter((e) => e.path === "door_front").length, 0, "json : objet accepté (door_front)");
    ck.eq(DV.validateRecord("datacenters", { name: "S", doors }).filter((e) => e.path === "doors").length, 0, "json : tableau accepté (doors)");
    for (const scalar of [42, "grillagée", true]) {
      ck(DV.validateRecord("racks", { name: "R", door_front: scalar }).some((e) => e.path === "door_front" && e.code === "type"),
        "json : scalaire " + JSON.stringify(scalar) + " refusé (code 'type')");
    }
    ck(DV.validateRecord("vms", { name: "web", nics: "net0" }).some((e) => e.path === "nics" && e.code === "type"), "json : vms.nics scalaire refusé");

    // -- NULL : absorbé par `isEmpty` comme pour TOUS les types (le trou `nullable` mesuré et verrouillé
    //    ailleurs vaut aussi pour json — aucune règle spéciale, c'est le point). --
    ck.eq(DV.validateRecord("racks", { name: "R", door_front: null }).filter((e) => e.path === "door_front").length, 0, "json nullable : null → accepté");
    ck.eq(JSON.stringify(DV.normalizeRecord("datacenters", { name: "S", doors: null }).doors), "[]", "json non-nullable : null explicite → défaut posé par la normalisation");

    // -- Le CONTENU reste jugé par les INVARIANTS (la déclaration json n'a rien retiré) : IPv4 des vNIC. --
    ck(DV.validateRecord("vms", { name: "web", nics: [{ name: "net0", ips: ["999.0.0.1"] }] }).some((e) => e.path === "nics" && e.code === "invariant"),
      "json : le contenu des nics reste validé par l'invariant IPv4 (inchangé)");
  }
  });

  await section("shared : défauts SENSIBLES de la régularisation — une géométrie absente reste null, jamais 0", async () => {
  {
    const DV = Validation.DataValidator;
    // Déclarer un champ fait poser son défaut par la normalisation : un défaut FAUX corromprait les
    // données à la première réécriture. Ces assertions verrouillent les choix CONSERVATEURS du lot.

    // ÉQUIPEMENT : position en salle / en baie / dimensions libres — l'absence n'est PAS une coordonnée.
    const eq = DV.normalizeRecord("equipments", { name: "sw" });
    ck.eq(eq.dc_x, null, "equipments.dc_x absent → null (PAS 0 : 0 téléporterait à l'origine de la salle)");
    ck.eq(eq.dc_y, null, "equipments.dc_y absent → null");
    ck.eq(eq.rack_u, null, "equipments.rack_u absent → null (pool non placé — T1 continue de tenir)");
    ck.eq(eq.free_w_mm, null, "equipments.free_w_mm absent → null (aucune dimension inventée)");
    ck.eq(eq.floor_x, null, "equipments.floor_x absent → null (plan d'étage : non localisé)");
    ck.eq(eq.dc_z, 0, "equipments.dc_z absent → 0 (défaut RÉEL du constructeur client — au sol)");
    ck.eq(eq.rack_side, "front", "equipments.rack_side absent → 'front' (défaut du constructeur, enum partagé)");
    ck.eq(eq.dim_mode, "", "equipments.dim_mode absent → '' (= « le client dérive » — jamais un mode figé)");

    // WAYPOINT : le défaut client de dc_z est CONDITIONNEL (2400, mais 3000 pour un pin d'étage) → la spec
    // ne fige RIEN (null = le client dérive). Les défauts INCONDITIONNELS, eux, sont repris tels quels.
    const wp = DV.normalizeRecord("waypoints", { name: "w" });
    ck.eq(wp.dc_z, null, "waypoints.dc_z absent → null (défaut client conditionnel : rien d'inventé)");
    ck.eq(wp.dc_x, null, "waypoints.dc_x absent → null (pool non posé)");
    ck.eq(wp.depth_mm, 100, "waypoints.depth_mm absent → 100 (parité Waypoint.ts ET RackDepth.brushDepth)");
    ck.eq(wp.width_mm, 300, "waypoints.width_mm absent → 300 (CONDUIT_W_DEFAULT répliqué)");

    // BAIE : marges au défaut CONDITIONNEL client (repli lmargin/vmargin → mount_margin_mm) → null ;
    // le défaut FIXE (mount_margin_mm = 50) est, lui, repris.
    const rack = DV.normalizeRecord("racks", { name: "R" });
    ck.eq(rack.lmargin_mm, null, "racks.lmargin_mm absent → null (le client replie sur mount_margin_mm)");
    ck.eq(rack.vmargin_mm, null, "racks.vmargin_mm absent → null (même repli)");
    ck.eq(rack.mount_margin_mm, 50, "racks.mount_margin_mm absent → 50 (défaut fixe RACK_MOUNT_MARGIN_DEFAULT répliqué)");
    ck.eq(rack.cage_depth_mm, null, "racks.cage_depth_mm absent → null (RackDepthPolicy retombe sur la profondeur extérieure)");
    ck.eq(rack.orientation, 0, "racks.orientation absent → 0 (défaut réel de Normalize.rackOrientation)");

    // PORT : la position de façade absente n'est pas le coin (0,0) ; le rôle absent est « data ».
    const port = DV.normalizeRecord("ports", { name: "p1" });
    ck.eq(port.face_x, null, "ports.face_x absent → null (PAS 0 : 0 collerait le port au coin de façade)");
    ck.eq(port.lane, null, "ports.lane absent → null (pas un port-lane)");
    ck.eq(port.role, "data", "ports.role absent → 'data' (défaut du constructeur Port.ts)");

    // ÉTAGE : ici 0 EST le vrai défaut client (ancrage en origine de pile 3D) — pas une invention.
    const floor = DV.normalizeRecord("floors", { location: "brux" });
    ck.eq(floor.anchor_x, 0, "floors.anchor_x absent → 0 (défaut réel du constructeur Floor.ts — lu par T13)");
    ck.eq(floor.height_mm, 0, "floors.height_mm absent → 0 (= auto, hauteur du contenu)");
    ck.eq(floor.width_mm, 20000, "floors.width_mm absent → 20000 (FLOOR_WIDTH_DEFAULT répliqué)");

    // Et l'ensemble normalisé reste VALIDE (aucune sur-contrainte introduite par la régularisation).
    for (const [coll, rec] of [["equipments", { name: "sw" }], ["waypoints", { name: "w" }], ["racks", { name: "R", width_mm: 600, depth: 1000 }], ["ports", { name: "p1" }], ["floors", { location: "brux" }], ["spares", {}], ["vms", { name: "web" }]]) {
      ck.eq(DV.normalizeAndValidate(coll, rec).errors.length, 0, coll + " : enregistrement minimal normalisé → 0 erreur");
    }
  }
  });
};

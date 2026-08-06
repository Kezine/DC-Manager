/* Tests modules — GÉNÉRATEUR DE SCHÉMA RELATIONNEL (src-shared/RelationalSchema, lot L1 migration DB).
   ----------------------------------------------------------------------------
   Vérifie que le DDL DÉRIVÉ de la spec `DataValidation.COLLECTION_SPECS` est CORRECT et DÉTERMINISTE :
   - GOLDEN DDL de 3 collections représentatives (racks : json nullable + string[] + NUMERIC + booléens ;
     vms : json nics + tags_src ; groups : petite) — chaînes EXACTES écrites EN CLAIR ici (recette maison :
     attentes explicites, JAMAIS dérivées du générateur, sinon le test ne prouverait rien) ;
   - assertions STRUCTURELLES sur TOUTES les collections (colonne par champ, NOT NULL ⇔ required, id PK,
     aucun REFERENCES/CHECK/DEFAULT hors search/updated_rev, déterminisme) ;
   - INDEX : liste exacte attendue (L0 §3.4 amendée), aucun index sur un champ string[]/json, et
     anti-divergence du RÉ-EXPORT client (config.ts) ≡ liste shared.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, SHARED, D, Validation, SharedSchema } = require("./harness.js");

module.exports = async () => {
  const { RelationalSchema, INDEX_SPEC } = SHARED("src-shared/RelationalSchema.js");
  const COLLECTION_SPECS = Validation.COLLECTION_SPECS;

  // Réplique LOCALE de l'affinité de type (indépendante du module — on prouve le générateur, on ne le
  // réutilise pas pour se juger lui-même). string / string[] / json → TEXT ; number → NUMERIC ; boolean → INTEGER.
  const sqlOf = (type) => (type === "number" ? "NUMERIC" : type === "boolean" ? "INTEGER" : "TEXT");

  // Décompose un CREATE TABLE en map { colonne → définition } (hors CREATE/parenthèses).
  const colDefs = (ddl) => {
    const map = {};
    ddl.split("\n").forEach((raw) => {
      const m = raw.trim().replace(/,$/, "").match(/^"([^"]+)"\s+(.+)$/);
      if (m) map[m[1]] = m[2];
    });
    return map;
  };

  await section("shared : RelationalSchema — GOLDEN DDL (racks, vms, groups) attentes EXPLICITES", async () => {
  {
    // racks : json nullable (door_front/rear) + string[] (roof_cells/floor_cells) + NUMERIC + INTEGER (booléens).
    const goldenRacks = [
      'CREATE TABLE IF NOT EXISTS "racks" (',
      '  "id" TEXT PRIMARY KEY,',
      '  "name" TEXT NOT NULL,',
      '  "location" TEXT,',
      '  "floor" TEXT,',
      '  "room" TEXT,',
      '  "row" TEXT,',
      '  "description" TEXT,',
      '  "u_count" NUMERIC,',
      '  "width_mm" NUMERIC,',
      '  "depth" NUMERIC,',
      '  "sides" TEXT,',
      '  "has_caps" INTEGER,',
      '  "locked" INTEGER,',
      '  "datacenter_id" TEXT,',
      '  "dc_x" NUMERIC,',
      '  "dc_y" NUMERIC,',
      '  "orientation" NUMERIC,',
      '  "mount_margin_mm" NUMERIC,',
      '  "lmargin_mm" NUMERIC,',
      '  "vmargin_mm" NUMERIC,',
      '  "vmargin_bottom_mm" NUMERIC,',
      '  "cage_depth_mm" NUMERIC,',
      '  "front_margin_mm" NUMERIC,',
      '  "height_mm" NUMERIC,',
      '  "allow_side_front" INTEGER,',
      '  "allow_side_rear" INTEGER,',
      '  "door_front" TEXT,',
      '  "door_rear" TEXT,',
      '  "roof_cells" TEXT,',
      '  "floor_cells" TEXT,',
      '  "created_by" TEXT,',
      '  "updated_by" TEXT,',
      '  "created_date" TEXT,',
      '  "updated_date" TEXT,',
      "  \"search\" TEXT NOT NULL DEFAULT '',",
      '  "updated_rev" INTEGER NOT NULL DEFAULT 0',
      ')',
    ].join("\n");
    ck.eq(RelationalSchema.tableDdl("racks"), goldenRacks, "golden : DDL racks exact");

    // vms : json (nics) + string[] (tags_src) + NUMERIC nullable (cpu/ram_mb/disk_gb).
    const goldenVms = [
      'CREATE TABLE IF NOT EXISTS "vms" (',
      '  "id" TEXT PRIMARY KEY,',
      '  "name" TEXT NOT NULL,',
      '  "vm_type" TEXT,',
      '  "status" TEXT,',
      '  "provider_id" TEXT,',
      '  "ext_id" TEXT,',
      '  "description_src" TEXT,',
      '  "host_node" TEXT,',
      '  "cpu" NUMERIC,',
      '  "ram_mb" NUMERIC,',
      '  "disk_gb" NUMERIC,',
      '  "tags_src" TEXT,',
      '  "nics" TEXT,',
      '  "orphan" INTEGER,',
      '  "last_sync" TEXT,',
      '  "notes" TEXT,',
      '  "description" TEXT,',
      '  "host_equipment_id" TEXT,',
      '  "group_id" TEXT,',
      '  "group_ids" TEXT,',
      '  "created_by" TEXT,',
      '  "updated_by" TEXT,',
      '  "created_date" TEXT,',
      '  "updated_date" TEXT,',
      "  \"search\" TEXT NOT NULL DEFAULT '',",
      '  "updated_rev" INTEGER NOT NULL DEFAULT 0',
      ')',
    ].join("\n");
    ck.eq(RelationalSchema.tableDdl("vms"), goldenVms, "golden : DDL vms exact");

    // groups : petite collection (label requis, color nullable, type enum sans required → nullable).
    const goldenGroups = [
      'CREATE TABLE IF NOT EXISTS "groups" (',
      '  "id" TEXT PRIMARY KEY,',
      '  "label" TEXT NOT NULL,',
      '  "description" TEXT,',
      '  "color" TEXT,',
      '  "type" TEXT,',
      '  "created_by" TEXT,',
      '  "updated_by" TEXT,',
      '  "created_date" TEXT,',
      '  "updated_date" TEXT,',
      "  \"search\" TEXT NOT NULL DEFAULT '',",
      '  "updated_rev" INTEGER NOT NULL DEFAULT 0',
      ')',
    ].join("\n");
    ck.eq(RelationalSchema.tableDdl("groups"), goldenGroups, "golden : DDL groups exact");

    // ANTI-VACUITÉ : un générateur qui rendrait "" passerait des tests trop laxistes — on exige du volume.
    ck(RelationalSchema.tableDdl("racks").length > 200, "anti-vacuité : le DDL racks est substantiel (> 200 car.)");
    ck(Object.keys(colDefs(RelationalSchema.tableDdl("groups"))).length === 4 + 4 + 2 + 1,
      "anti-vacuité : groups a bien 4 champs + 4 audit + search/updated_rev + id");
  }
  });

  await section("shared : RelationalSchema — assertions STRUCTURELLES sur TOUTES les collections", async () => {
  {
    for (const collection of SharedSchema.COLLECTIONS) {
      const ddl = RelationalSchema.tableDdl(collection);
      const defs = colDefs(ddl);

      // En-tête + id PRIMARY KEY + colonnes opérationnelles + audit.
      ck(ddl.startsWith('CREATE TABLE IF NOT EXISTS "' + collection + '" (\n'), collection + " : en-tête CREATE TABLE IF NOT EXISTS quotée");
      ck.eq(defs["id"], "TEXT PRIMARY KEY", collection + " : id TEXT PRIMARY KEY");
      ck.eq(defs["search"], "TEXT NOT NULL DEFAULT ''", collection + " : search TEXT NOT NULL DEFAULT ''");
      ck.eq(defs["updated_rev"], "INTEGER NOT NULL DEFAULT 0", collection + " : updated_rev INTEGER NOT NULL DEFAULT 0");
      for (const audit of ["created_by", "updated_by", "created_date", "updated_date"]) {
        ck.eq(defs[audit], "TEXT", collection + " : colonne d'audit " + audit + " TEXT");
      }

      // Chaque champ DÉCLARÉ a SA colonne, du bon type, NOT NULL SSI required.
      const fields = COLLECTION_SPECS[collection].fields;
      for (const field of Object.keys(fields)) {
        const expected = sqlOf(fields[field].type) + (fields[field].required ? " NOT NULL" : "");
        ck.eq(defs[field], expected, collection + "." + field + " : colonne " + expected);
      }

      // AUCUNE FK/CHECK, et AUCUN DEFAULT hors search/updated_rev (exactement 2 occurrences).
      ck(!/REFERENCES/.test(ddl), collection + " : aucune clé étrangère SQL (REFERENCES)");
      ck(!/\bCHECK\b/.test(ddl), collection + " : aucune contrainte CHECK");
      ck.eq((ddl.match(/DEFAULT/g) || []).length, 2, collection + " : DEFAULT uniquement sur search + updated_rev");

      // DÉTERMINISME : deux appels → chaîne IDENTIQUE.
      ck.eq(RelationalSchema.tableDdl(collection), ddl, collection + " : DDL déterministe (2 appels identiques)");
    }

    // Collection inconnue → erreur explicite (garde du générateur).
    let threw = false;
    try { RelationalSchema.tableDdl("inconnue"); } catch (e) { threw = true; }
    ck(threw, "structurel : tableDdl(collection inconnue) lève une erreur");
  }
  });

  await section("shared : RelationalSchema — INDEX (liste exacte, pas d'index sur string[]/json, ré-export client)", async () => {
  {
    // Liste ATTENDUE des CREATE INDEX de allIndexDdls(), dans l'ordre de Schema.COLLECTIONS.
    // = INDEX_SPEC amendé (L0 §3.4), moins les champs string[]/json (non indexables utilement).
    const expectedIndexes = [
      'CREATE INDEX IF NOT EXISTS "idx_equipments_name" ON "equipments" ("name")',
      'CREATE INDEX IF NOT EXISTS "idx_equipments_group_id" ON "equipments" ("group_id")',
      'CREATE INDEX IF NOT EXISTS "idx_equipments_rack_id" ON "equipments" ("rack_id")',
      'CREATE INDEX IF NOT EXISTS "idx_equipments_dc_id" ON "equipments" ("dc_id")',
      'CREATE INDEX IF NOT EXISTS "idx_equipments_tray_item_id" ON "equipments" ("tray_item_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ports_equipment_id" ON "ports" ("equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ports_parent_port_id" ON "ports" ("parent_port_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ports_port_type_id" ON "ports" ("port_type_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ports_aggregate_id" ON "ports" ("aggregate_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ports_sub_equipment_id" ON "ports" ("sub_equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ports_bundle_id" ON "ports" ("bundle_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ports_network_id" ON "ports" ("network_id")',
      'CREATE INDEX IF NOT EXISTS "idx_aggregates_equipment_id" ON "aggregates" ("equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_subEquipments_equipment_id" ON "subEquipments" ("equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_subEquipments_group_id" ON "subEquipments" ("group_id")',
      'CREATE INDEX IF NOT EXISTS "idx_cables_name" ON "cables" ("name")',
      'CREATE INDEX IF NOT EXISTS "idx_cables_from_port_id" ON "cables" ("from_port_id")',
      'CREATE INDEX IF NOT EXISTS "idx_cables_to_port_id" ON "cables" ("to_port_id")',
      'CREATE INDEX IF NOT EXISTS "idx_cables_cable_type_id" ON "cables" ("cable_type_id")',
      'CREATE INDEX IF NOT EXISTS "idx_cables_network_id" ON "cables" ("network_id")',
      'CREATE INDEX IF NOT EXISTS "idx_networks_ip_network_id" ON "networks" ("ip_network_id")',
      'CREATE INDEX IF NOT EXISTS "idx_racks_datacenter_id" ON "racks" ("datacenter_id")',
      'CREATE INDEX IF NOT EXISTS "idx_rackItems_rack_id" ON "rackItems" ("rack_id")',
      'CREATE INDEX IF NOT EXISTS "idx_cableBundles_endpoint_a_equipment_id" ON "cableBundles" ("endpoint_a_equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_cableBundles_endpoint_b_equipment_id" ON "cableBundles" ("endpoint_b_equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_waypoints_datacenter_id" ON "waypoints" ("datacenter_id")',
      'CREATE INDEX IF NOT EXISTS "idx_waypoints_rack_id" ON "waypoints" ("rack_id")',
      'CREATE INDEX IF NOT EXISTS "idx_floors_location" ON "floors" ("location")',
      'CREATE INDEX IF NOT EXISTS "idx_ipAddresses_network_id" ON "ipAddresses" ("network_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ipAddresses_equipment_id" ON "ipAddresses" ("equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ipAddresses_vm_id" ON "ipAddresses" ("vm_id")',
      'CREATE INDEX IF NOT EXISTS "idx_ipAddresses_address" ON "ipAddresses" ("address")',
      'CREATE INDEX IF NOT EXISTS "idx_dhcpRanges_network_id" ON "dhcpRanges" ("network_id")',
      'CREATE INDEX IF NOT EXISTS "idx_dhcpRanges_server_id" ON "dhcpRanges" ("server_id")',
      'CREATE INDEX IF NOT EXISTS "idx_spares_assigned_equipment_id" ON "spares" ("assigned_equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_vms_host_equipment_id" ON "vms" ("host_equipment_id")',
      'CREATE INDEX IF NOT EXISTS "idx_vms_group_id" ON "vms" ("group_id")',
      // wifiClients (chantier provider wifi) : `provider_id` est le chemin CHAUD de la synchro
      // (findBy à chaque passe) et `ap_equipment_id` la FK que la cascade `equipments` détache.
      'CREATE INDEX IF NOT EXISTS "idx_wifiClients_provider_id" ON "wifiClients" ("provider_id")',
      'CREATE INDEX IF NOT EXISTS "idx_wifiClients_ap_equipment_id" ON "wifiClients" ("ap_equipment_id")',
      // issues (chantier remote issue tracker) : `ext_id` est l'identité STABLE côté tracker (clé de
      // réconciliation — la clé lisible `key` bouge, cf. D2), `provider_id` délimite le périmètre d'un
      // provider, `status_category` porte le filtre/tri sémantique. ⚠ `targets` figure bien dans
      // INDEX_SPEC (index CLIENT élément par élément, lu par les 4 `custom` de cascade) mais N'A PAS
      // d'index SQL : c'est un `string[]`, donc une colonne TEXT JSON — le contrôle POSITIF plus bas
      // vérifie précisément qu'il est écarté.
      'CREATE INDEX IF NOT EXISTS "idx_issues_ext_id" ON "issues" ("ext_id")',
      'CREATE INDEX IF NOT EXISTS "idx_issues_provider_id" ON "issues" ("provider_id")',
      'CREATE INDEX IF NOT EXISTS "idx_issues_status_category" ON "issues" ("status_category")',
    ];
    const allIndexes = RelationalSchema.allIndexDdls();
    ck.eq(JSON.stringify(allIndexes), JSON.stringify(expectedIndexes), "index : liste exacte (42 index, ordre COLLECTIONS)");
    // Et la phase TABLES ne contient QUE des CREATE TABLE, une par collection (le phasage tables → index
    // est la condition de l'évolution additive — cf. test-relational-evolution.js).
    const allTables = RelationalSchema.allTableDdls();
    ck.eq(allTables.length, SharedSchema.COLLECTIONS.length, "phases : allTableDdls → une table par collection");
    ck(allTables.every((s) => s.startsWith("CREATE TABLE IF NOT EXISTS")), "phases : allTableDdls ne contient QUE des CREATE TABLE");
    ck(allIndexes.every((s) => s.startsWith("CREATE INDEX IF NOT EXISTS")), "phases : allIndexDdls ne contient QUE des CREATE INDEX");

    // GOLDEN indexDdls par collection (représentatives).
    ck.eq(JSON.stringify(RelationalSchema.indexDdls("racks")), JSON.stringify(['CREATE INDEX IF NOT EXISTS "idx_racks_datacenter_id" ON "racks" ("datacenter_id")']), "index : racks → 1 (datacenter_id)");
    ck.eq(JSON.stringify(RelationalSchema.indexDdls("groups")), "[]", "index : groups → aucun (hors INDEX_SPEC)");

    // AUCUN index sur un champ string[] ou json : on relit CHAQUE index émis et on refuse ces types.
    for (const ddl of allIndexes) {
      const m = ddl.match(/ON "([^"]+)" \("([^"]+)"\)/);
      const type = COLLECTION_SPECS[m[1]].fields[m[2]].type;
      ck(type !== "string[]" && type !== "json", "index : " + m[1] + "." + m[2] + " n'est ni string[] ni json (type " + type + ")");
    }
    // Contrôle POSITIF : les champs string[] présents dans INDEX_SPEC sont bien ÉCARTÉS (le filtre MORD).
    for (const [collection, fields] of Object.entries(INDEX_SPEC)) {
      for (const field of fields) {
        if (COLLECTION_SPECS[collection].fields[field].type === "string[]") {
          ck(!allIndexes.some((d) => d.includes('"idx_' + collection + "_" + field + '"')), "index : " + collection + "." + field + " (string[]) écarté");
        }
      }
    }

    // Les 2 AJOUTS d'unicité (L0 §3.4) sont bien présents ; les 7 RETRAITS bien absents.
    ck(allIndexes.some((d) => d.includes('"idx_equipments_name"')), "index : equipments.name AJOUTÉ (unicité V6g)");
    ck(allIndexes.some((d) => d.includes('"idx_cables_name"')), "index : cables.name AJOUTÉ (unicité V6h)");
    for (const dead of ["idx_equipments_face_image_id", "idx_equipments_face_image_rear_id", "idx_cableBundles_cable_type_id"]) {
      ck(!allIndexes.some((d) => d.includes('"' + dead + '"')), "index : " + dead + " RETIRÉ (mort)");
    }

    // ANTI-DIVERGENCE : le RÉ-EXPORT client (config.ts) est EXACTEMENT la liste shared (même objet re-exporté).
    const clientConfig = D("data/config.js");
    ck.eq(JSON.stringify(clientConfig.INDEX_SPEC), JSON.stringify(INDEX_SPEC), "anti-divergence : config.ts INDEX_SPEC ≡ shared");
    ck(clientConfig.INDEX_SPEC === INDEX_SPEC, "anti-divergence : config.ts ré-exporte le MÊME objet (pas une copie)");
  }
  });
};

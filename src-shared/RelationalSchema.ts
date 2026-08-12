/* ============================================================================
   GÉNÉRATEUR DE SCHÉMA RELATIONNEL — code PARTAGÉ front ⇄ back (TS PUR).

   DÉRIVE le DDL SQLite (CREATE TABLE / CREATE INDEX) d'une base CŒUR de document
   à partir de la SPEC déclarative des collections (`DataValidation.COLLECTION_SPECS`).
   La spec est la définition CANONIQUE du modèle : le schéma relationnel en est un
   PRODUIT, jamais écrit à la main (décision migration DB 2026-07-31, cadrage
   `.notes/toDos/migration-db-relationnelle-cadrage-2026-07-31.md`, D3a). Une table
   par collection : `id` + les champs de la spec (dans l'ORDRE DE DÉCLARATION) + les
   4 colonnes d'audit + `search` + `updated_rev`.

   ── Ce que ce générateur émet DÉLIBÉRÉMENT, et ce qu'il N'ÉMET PAS ──────────────
   Il pose : les COLONNES (type affiné depuis la spec), la clé primaire, et les
   INDEX d'égalité sur les FK/identités du chemin chaud (`INDEX_SPEC` ci-dessous).
   Il n'émet AUCUNE des contraintes suivantes, et c'est un CHOIX, pas un oubli :
   - AUCUNE clé étrangère SQL (`REFERENCES`), décision D2b. SQLite vérifie les FK
     IMMÉDIATEMENT ; l'ordre libre des lots `transact` (creates non ordonnés entre
     eux) et la cascade métier MULTI-BASES de `src-shared/Cascade` s'en trouveraient
     doublés/contredits. L'intégrité référentielle reste l'autorité UNIQUE de la
     validation partagée (V2), comme aujourd'hui et comme les bases des modules.
   - AUCUN `CHECK`, ni traduction d'`enum`/`min`/`max` en contrainte SQL, décision
     D6. Les règles de VALEUR restent dans la validation partagée : les doubler en
     SQL créerait une seconde source de vérité à faire dériver.
   - AUCUN `DEFAULT` SQL sur les colonnes de spec, décision D3/cadrage §3 : les
     défauts vivent dans la NORMALISATION partagée (`DataValidator.normalizeRecord`),
     source UNIQUE. Les deux seules colonnes OPÉRATIONNELLES (`search`, `updated_rev`)
     portent un défaut parce qu'elles ne passent PAS par la normalisation métier.
   Le gain visé par la migration est l'INDEX sur le chemin chaud des `find`, pas un
   second gardien d'intégrité — cf. `docs/persistance.md`.

   ── Affinités de type (SQLite) ─────────────────────────────────────────────────
   `string`→TEXT · `number`→NUMERIC (PAS REAL : préserve les entiers) · `boolean`→
   INTEGER (0/1, re-mappé booléen à la lecture par L2, la spec connaît le type) ·
   `string[]`→TEXT (JSON sérialisé, décision D1b) · `json`→TEXT (JSON sérialisé).

   ── NULL ───────────────────────────────────────────────────────────────────────
   `NOT NULL` UNIQUEMENT si le champ est `required`. TOUTE autre colonne accepte
   NULL — y compris les champs historiques sans `required`/`nullable`/`default` :
   NULL est le choix qui n'invente rien (cadrage §3).

   ── Évolution ADDITIVE du schéma ───────────────────────────────────────────────
   `CREATE TABLE IF NOT EXISTS` est un no-op sur une base existante : quand la spec
   GAGNE un champ, la table déjà créée ne le rattrape pas seule. `missingColumns`
   produit les `ALTER TABLE … ADD COLUMN` du diff colonnes existantes ⇄ spec ; le
   DDL est donc exposé en DEUX phases (`allTableDdls` / `allIndexDdls`) pour que
   l'ouverture intercale ces ALTER ENTRE tables et index (un index sur un champ
   ajouté doit trouver sa colonne). Exécution, backfill des défauts et limites :
   `RelationalRepository.ensureSpecColumns` + docs/persistance.md § « Évolution du
   schéma ».

   Ce module est PUR (aucun DOM, aucun Node) : il ne fait que produire des CHAÎNES.
   Leur exécution vit dans le Repository relationnel (`RelationalRepository.open`)
   et la migration legacy (`LegacyMigration`). ⚠ Import interne partagé : extension
   `.js` IMPÉRATIVE (NodeNext l'exige côté serveur — cf. CLAUDE.md § « Code partagé
   front/back »).
   ============================================================================ */

import { COLLECTION_SPECS, FieldSpec, FieldType } from "./DataValidation.js";
import { Schema } from "./Schema.js";

/* ---- INDEX SECONDAIRES — champs d'égalité indexés par collection. SOURCE UNIQUE front ⇄ back ----
   Vivait dans `src-client/data/config.ts` ; REMONTÉ ici (le générateur en dérive les CREATE INDEX ;
   le client le RÉ-EXPORTE — cf. config.ts). Deux consommateurs distincts partagent la MÊME liste :
   - CÔTÉ CLIENT : l'adapter local indexe les enregistrements persistés (findBy/list sans scan) et le
     Store indexe les entités hydratées (helpers métier en O(1)) via `FieldIndex` ; un champ NON listé
     retombe en scan (`Store._byFk`), jamais en erreur ;
   - CÔTÉ SERVEUR (futur L2) : le générateur ci-dessous en tire les index SQL du chemin chaud.
   Un champ tableau (ex. `cables.network_ids`) est indexé élément par élément CÔTÉ CLIENT ; CÔTÉ SQL il
   n'a PAS d'index (colonne TEXT JSON, l'appartenance passe par `json_each`, hors chemin chaud) —
   `indexDdls` l'écarte d'après le type de la spec. Les valeurs vides tombent sous `IDX_NULL` côté client
   → findBy(coll, champ, null) répond « éléments non rattachés » sans parcourir la collection.

   ⚠ Contenu RÉVISÉ à la remontée (mesure L0 §3.4, arbitrage 4 tranché le 2026-07-31) :
   - AJOUTÉ `equipments.name` + `cables.name` : les scans d'unicité V6g/V6h (`find(...,"name",...)`) sont
     exactement le chemin chaud que la migration vise à indexer ; ils manquaient (`ipAddresses.address`,
     même mécanique V6a, l'était déjà — asymétrie corrigée). Côté CLIENT, l'ajout accélère aussi ces
     scans en mode fichier (le finder de validation passe par `Store._byFk`).
   - RETIRÉ les 6 `equipments.face_image_*_id` (jamais interrogés : la purge d'images itère en JS) et
     `cableBundles.cable_type_id` (aucun `_byFk`) — 7 index morts, cf. L0 §3.4. */
export const INDEX_SPEC: Record<string, string[]> = {
  equipments:    ["name", "group_id", "group_ids", "rack_id", "dc_id", "tray_item_id"],
  ports:         ["equipment_id", "parent_port_id", "port_type_id", "aggregate_id", "sub_equipment_id", "bundle_id", "network_id", "network_ids"],
  cables:        ["name", "from_port_id", "to_port_id", "cable_type_id", "network_id", "network_ids", "waypoint_ids"],
  cableBundles:  ["waypoint_ids", "endpoint_a_equipment_id", "endpoint_b_equipment_id"],
  aggregates:    ["equipment_id"],
  subEquipments: ["equipment_id", "group_id", "group_ids"],   // cascade du maître + des groupes ; liste par équipement
  racks:         ["datacenter_id"],
  rackItems:     ["rack_id"],
  waypoints:     ["datacenter_id", "rack_id"],
  floors:        ["location"],
  ipAddresses:   ["network_id", "equipment_id", "vm_id", "address"],   // vm_id : la cascade vms détache par ce champ
  dhcpRanges:    ["network_id", "server_id"],
  networks:      ["ip_network_id"],
  spares:        ["assigned_equipment_id"],
  vms:           ["host_equipment_id", "group_id", "group_ids"],   // cascades hôte + groupes
  // CLIENTS WIFI : `provider_id` est le chemin CHAUD de la synchro (`WifiReconcile` réconcilie le
  // périmètre d'UN provider, retrouvé par `repo.findBy("wifiClients","provider_id",…)` à CHAQUE passe —
  // c'est exactement l'usage que la migration relationnelle vise à indexer) ; `ap_equipment_id` est la FK
  // que la cascade `equipments` détache. ⚠ ÉCART VOLONTAIRE avec `vms`, qui n'indexe PAS son `provider_id`
  // alors que sa synchro fait le même `findBy` : asymétrie CONSTATÉE, non reproduite ici (l'aligner côté
  // vms est un ajustement à part, hors périmètre de ce chantier).
  wifiClients:   ["provider_id", "ap_equipment_id"],
  // APPLICATIONS : les deux FK d'hôte sont le chemin CHAUD — la cascade `equipments`/`vms` détache par
  // elles, le filtre cible « Hébergée sur » des listings part au serveur en `where` dessus, et
  // l'invalidation de la colonne `search` (renommage de l'hôte) les interroge à chaque écriture.
  applications:  ["equipment_id", "vm_id"],
  // PIÈCES JOINTES : mêmes motifs que `applications` sur le couple de FK cible — la cascade
  // `equipments`/`subEquipments` SUPPRIME par elles (D3), les sections « Pièces jointes » des fiches
  // lisent par elles (Store.attachmentsOf*), et l'invalidation de `search` (renommage de la cible)
  // les interroge à chaque écriture (SEARCH_SPECS.attachments).
  attachments:   ["equipment_id", "sub_equipment_id"],
};

/** GÉNÉRATEUR de DDL relationnel (méthodes statiques — cf. CLAUDE.md). Toutes les chaînes émises quotent
    les identifiants en GUILLEMETS DOUBLES (robustesse : un champ de spec pourrait coïncider avec un mot-clé
    SQL — `row` de `racks`, p. ex. — et le générateur ne connaît pas la liste des réservés). */
export class RelationalSchema {
  /** Colonnes d'AUDIT posées par le serveur (AuditStamp) APRÈS validation — NON déclarées dans la spec
      (passthrough assumé, cf. doctrine `CollectionSpec`), mais colonnes standard du schéma cible. Ordre FIXE.
      PUBLIQUE : `ListOrder` (liste blanche des colonnes triables) en dérive les critères d'audit —
      une seconde liste divergerait au premier ajout (principe n°3). */
  static readonly AUDIT_COLUMNS: readonly string[] = ["created_by", "updated_by", "created_date", "updated_date"];

  /** Affinité SQLite d'un type de spec. `number`→NUMERIC (jamais REAL, pour préserver les entiers) ;
      `boolean`→INTEGER (0/1) ; tout le reste (`string`, `string[]`, `json`)→TEXT (tableaux/structures = JSON).
      PUBLIQUE : `ListOrder` s'en sert pour décider `COLLATE NOCASE` (colonnes TEXT seulement) — la MÊME
      source d'affinité que le DDL, jamais une table parallèle. */
  static sqlType(type: FieldType): string {
    switch (type) {
      case "number":  return "NUMERIC";
      case "boolean": return "INTEGER";
      default:        return "TEXT";   // string · string[] (JSON) · json (JSON)
    }
  }

  /** Identifiant SQL entre guillemets doubles. PUBLIQUE : `ListOrder` (fragment ORDER BY du tri
      serveur) quote avec la MÊME convention — dupliquer un quoting SQL serait s'offrir une divergence. */
  static quote(identifier: string): string {
    return '"' + identifier + '"';
  }

  /** `CREATE TABLE IF NOT EXISTS "<collection>" (…)` : `id` (PK), les champs de la spec DANS L'ORDRE DE
      DÉCLARATION, les 4 colonnes d'audit, `search`, `updated_rev`. Ordre DÉTERMINISTE (les tests golden en
      dépendent). `NOT NULL` seulement si le champ est `required` ; aucun DEFAULT hors `search`/`updated_rev`. */
  static tableDdl(collection: string): string {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) throw new Error("collection inconnue: " + collection);
    const columns: string[] = [];
    columns.push(RelationalSchema.quote("id") + " TEXT PRIMARY KEY");
    // Champs de la spec, dans l'ordre d'insertion de l'objet `fields` (= ordre de déclaration source).
    for (const field of Object.keys(spec.fields)) {
      const fieldSpec = spec.fields[field] as FieldSpec;
      const nullability = fieldSpec.required ? " NOT NULL" : "";   // NULL par défaut : on n'invente aucune contrainte
      columns.push(RelationalSchema.quote(field) + " " + RelationalSchema.sqlType(fieldSpec.type) + nullability);
    }
    for (const audit of RelationalSchema.AUDIT_COLUMNS) columns.push(RelationalSchema.quote(audit) + " TEXT");
    // Colonnes OPÉRATIONNELLES (hors normalisation métier) — SEULES à porter un DEFAULT SQL (cf. en-tête).
    columns.push(RelationalSchema.quote("search") + " TEXT NOT NULL DEFAULT ''");
    columns.push(RelationalSchema.quote("updated_rev") + " INTEGER NOT NULL DEFAULT 0");
    return "CREATE TABLE IF NOT EXISTS " + RelationalSchema.quote(collection) + " (\n  " + columns.join(",\n  ") + "\n)";
  }

  /** `CREATE INDEX IF NOT EXISTS …` pour chaque champ d'`INDEX_SPEC[collection]`, SAUF les champs `string[]`
      ou `json` (colonne TEXT JSON, index d'égalité inutile — le filtre d'appartenance passe par `json_each`).
      Nom d'index déterministe : `idx_<collection>_<champ>`. */
  static indexDdls(collection: string): string[] {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) throw new Error("collection inconnue: " + collection);
    const out: string[] = [];
    for (const field of INDEX_SPEC[collection] || []) {
      const fieldSpec = spec.fields[field] as FieldSpec | undefined;
      if (fieldSpec && (fieldSpec.type === "string[]" || fieldSpec.type === "json")) continue;   // non indexable utilement
      out.push(
        "CREATE INDEX IF NOT EXISTS " + RelationalSchema.quote("idx_" + collection + "_" + field) +
        " ON " + RelationalSchema.quote(collection) + " (" + RelationalSchema.quote(field) + ")",
      );
    }
    return out;
  }

  /** Le DDL des TABLES, dans l'ordre de `Schema.COLLECTIONS`. Séparé du DDL des INDEX (l'ancien `allDdl`
      monolithique entremêlait les deux) parce que l'ouverture d'une base EXISTANTE doit intercaler un
      temps entre eux : tables → colonnes de spec MANQUANTES (`missingColumns`, évolution additive) →
      index — sinon le `CREATE INDEX` d'un champ ajouté à la spec lèverait « no such column » avant
      l'`ALTER TABLE` qui crée sa colonne. */
  static allTableDdls(): string[] {
    return Schema.COLLECTIONS.map((collection) => RelationalSchema.tableDdl(collection));
  }

  /** Le DDL de TOUS les index, dans l'ordre de `Schema.COLLECTIONS` (cf. `allTableDdls` pour le phasage
      tables → colonnes manquantes → index). */
  static allIndexDdls(): string[] {
    const out: string[] = [];
    for (const collection of Schema.COLLECTIONS) out.push(...RelationalSchema.indexDdls(collection));
    return out;
  }

  /** ÉVOLUTION ADDITIVE du schéma : pour une table EXISTANTE dont on donne les colonnes actuelles
      (`PRAGMA table_info`), rend les `ALTER TABLE … ADD COLUMN` des champs de spec MANQUANTS — MÊME
      source de dérivation que `tableDdl` (l'objet `fields` de la spec, même affinité `sqlType`, mêmes
      identifiants quotés), jamais une seconde liste qui pourrait dériver.
      ⚠ SANS `NOT NULL`, même pour un champ `required` : SQLite interdit `ADD COLUMN … NOT NULL` sans
      DEFAULT sur une table peuplée, et le DEFAULT SQL est banni de ce schéma (cf. en-tête). La contrainte
      de nullité d'un NOUVEAU champ requis n'est donc portée que par les tables NEUVES — assumé : la
      validation partagée reste l'autorité de toute façon (D2b), et l'appelant journalise l'écart.
      Périmètre : les champs de SPEC uniquement — id/audit/`search`/`updated_rev` sont dans le DDL depuis
      le premier schéma relationnel (L1), ils ne peuvent pas manquer. Une colonne ORPHELINE (présente en
      base, absente de la spec) est IGNORÉE : l'upsert dérivé de la spec ne la nomme jamais, elle est
      inoffensive. Fonction PURE (elle ne fait que produire des chaînes) : le diff pragma ⇄ spec est
      testable sans base — l'exécution vit dans `RelationalRepository` (ensureSpecColumns). */
  static missingColumns(collection: string, existingColumns: readonly string[]): Array<{ field: string; ddl: string }> {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) throw new Error("collection inconnue: " + collection);
    const existing = new Set(existingColumns);
    const out: Array<{ field: string; ddl: string }> = [];
    for (const field of Object.keys(spec.fields)) {
      if (existing.has(field)) continue;
      const fieldSpec = spec.fields[field] as FieldSpec;
      out.push({
        field,
        ddl: "ALTER TABLE " + RelationalSchema.quote(collection) + " ADD COLUMN " +
             RelationalSchema.quote(field) + " " + RelationalSchema.sqlType(fieldSpec.type),
      });
    }
    return out;
  }
}

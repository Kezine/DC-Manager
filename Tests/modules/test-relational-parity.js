/* Tests modules — PARITÉ blob ⇄ relationnel (lot L3 migration DB — le lot de PREUVE).
   ----------------------------------------------------------------------------
   Prouve que `RelationalRepository` (L2) rend LE MÊME SERVICE que le `Repository` blob (db.ts,
   chemin de prod) sur un corpus réel — la condition de la bascule L4. Les DEUX implémentations
   tournent sur better-sqlite3 RÉEL en `:memory:` (le blob aussi tourne sur ce driver en prod).
   Le comparateur canonique vit dans `parity-comparator.js` (partagé avec la sonde HORS dépôt sur
   le corpus réel — cf. cadrage §5 L3) ; les divergences VOULUES du contrat L2 y sont ENCODÉES
   comme attendues, jamais tolérées en silence :
   1. CLÉS : blob = tel que stocké ; relationnel = forme normalisée (spec présente, absents → null,
      legacy disparus, id/audit si non-NULL) — règle par champ + liste tolérée FERMÉE ;
   2. RECHERCHE : comparée par RÉSULTATS (ensembles d'ids), jamais par colonne `search` — la
      prémisse (colonnes divergentes après le cycle GET→PUT d'un client) est MESURÉE ici ;
   3. FILTRE INCONNU : blob « "null" sur champ inconnu » matche TOUT (accident), relationnel → 0 —
      les deux comportements testés explicitement ;
   4. NOT NULL : un record sans champ `required` — le blob l'avale, le relationnel REJETTE
      (contrainte SQL, abort ATOMIQUE en snapshot) — sondé des deux côtés (matière pour L4).
   ⚠ Corpus : `samples-public/demo-infra.json` UNIQUEMENT (fictif, versionné). Ne JAMAIS pointer
   `Samples/` ici : données réelles, non versionnées — la sonde de scratchpad s'en charge, hors dépôt.
   Harnais et assertions : harness.js. */
"use strict";
const fs = require("fs");
const { ck, section, path, SERVER, SharedSchema, Validation } = require("./harness.js");
const { ParityComparator } = require("./parity-comparator.js");

/* -------- better-sqlite3 RÉEL (src-server/node_modules) --------
   Même politique que le lot L2 (test-relational-repository.js) : l'indisponibilité est un ÉCHEC avec
   message actionnable, jamais un saut silencieux — un skip ferait passer le lot de PREUVE sans preuve. */
let SQLITE = null, SQLITE_ERROR = "";
try {
  const candidatePath = path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3");
  const Candidate = require(candidatePath);
  new Candidate(":memory:").close();
  SQLITE = Candidate;
} catch (e) { SQLITE_ERROR = ((e && e.message) || String(e)).split("\n")[0]; }
const requireSqlite = () => {
  if (SQLITE) return true;
  ck(false, "better-sqlite3 RÉEL indisponible (" + SQLITE_ERROR + ") — `npm install` (ou `npm rebuild better-sqlite3`) dans src-server/ ; ce test ÉCHOUE au lieu de sauter (lot L3)");
  return false;
};

/** Corpus de démo — RE-PARSÉ à chaque section (isolation : aucune mutation ne fuit entre sections). */
const CORPUS = () => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "samples-public", "demo-infra.json"), "utf8"));

/** Ouvre le COUPLE d'implémentations sur le même driver réel (`:memory:` chacun). */
const openPair = () => {
  const { Repository } = SERVER("db.js");
  const { RelationalRepository } = SERVER("RelationalRepository.js");
  return { blob: Repository.open(":memory:", SQLITE), relational: RelationalRepository.open(":memory:", SQLITE) };
};

/** Record equipments sous forme NORMALISÉE de synthèse : chaque champ de la spec présent (null par
    défaut), puis les valeurs fournies — la forme que `RelationalRepository.rebuild` produit. */
const normalizedForm = (collection, values) => {
  const out = {};
  if (values.id != null) out.id = values.id;
  for (const field of Object.keys(Validation.COLLECTION_SPECS[collection].fields)) out[field] = null;
  return Object.assign(out, values);
};

module.exports = async () => {
  await section("Parité L3 : comparateur canonique — règle par champ, liste tolérée FERMÉE, discriminance", async () => {
  {
    const C = ParityComparator;

    // -- Canonicalisation : clés d'OBJET triées récursivement ; ordre des TABLEAUX conservé. --
    ck.eq(C.canonical({ b: 1, a: { d: 2, c: 3 } }), C.canonical({ a: { c: 3, d: 2 }, b: 1 }), "canonique : l'ordre des clés d'objet est neutralisé (récursif)");
    ck(C.canonical({ a: ["x", "y"] }) !== C.canonical({ a: ["y", "x"] }), "canonique : l'ordre des TABLEAUX reste significatif (waypoint_ids = étapes ordonnées)");

    // -- Cas de PARITÉ nominal : blob à clés partielles + legacy null + audit ; relationnel normalisé. --
    const blobRecord = { id: "e1", name: "Cœur α", u_height: 2, locked: true, group_ids: ["g1", "g2"], created_date: "2026-01-01", created_by: null, face_image: null };
    const relationalRecord = normalizedForm("equipments", { id: "e1", name: "Cœur α", u_height: 2, locked: true, group_ids: ["g1", "g2"], created_date: "2026-01-01" });
    ck.eq(C.compareRecord("equipments", blobRecord, relationalRecord).join(" | "), "",
      "parité nominale : clés partielles → null, legacy null disparu, audit null absent, audit non-null égal — 0 divergence");

    // -- Chaque volet de la règle DISCRIMINE (un comparateur qui ne mord pas = fausse sécurité). --
    const divergesOn = (blob, relational, expectedField) => {
      const divergences = C.compareRecord("equipments", blob, relational);
      return divergences.length >= 1 && divergences.some((d) => d.startsWith("equipments/e1/" + expectedField + " "));
    };
    ck(divergesOn(blobRecord, { ...relationalRecord, name: "Autre" }, "name"), "discriminance : valeur divergente sur champ déclaré → nommée collection/id/champ");
    ck(divergesOn(blobRecord, { ...relationalRecord, group_ids: ["g2", "g1"] }, "group_ids"), "discriminance : ordre de tableau inversé → divergence");
    ck(divergesOn(blobRecord, { ...relationalRecord, depth_mm: 450 }, "depth_mm"), "discriminance : champ absent côté blob mais NON-null côté relationnel → divergence");
    const missingSpecKey = { ...relationalRecord }; delete missingSpecKey.depth_mm;
    ck(divergesOn(blobRecord, missingSpecKey, "depth_mm"), "discriminance : clé de spec absente du record relationnel (forme non normalisée) → divergence");
    const missingAudit = { ...relationalRecord }; delete missingAudit.created_date;
    ck(divergesOn(blobRecord, missingAudit, "created_date"), "discriminance : audit non-null côté blob, absent côté relationnel → divergence");
    ck(divergesOn(blobRecord, { ...relationalRecord, updated_by: "u1" }, "updated_by"), "discriminance : audit absent côté blob mais présent côté relationnel → divergence");
    ck(divergesOn(blobRecord, { ...relationalRecord, face_image: null }, "face_image"), "discriminance : clé legacy tolérée PRÉSENTE côté relationnel → divergence (elle doit disparaître)");
    ck(divergesOn(blobRecord, { ...relationalRecord, champ_fantome: 1 }, "champ_fantome"), "discriminance : clé inattendue côté relationnel → divergence");
    ck(divergesOn({ ...blobRecord, champ_fantome: 1 }, relationalRecord, "champ_fantome"),
      "discriminance : clé blob HORS liste tolérée → ÉCHEC nommé (jamais une tolérance du comparateur)");

    // -- json : parité INSENSIBLE à l'ordre des clés d'un value-object (racks.door_front). --
    const blobRack = { id: "r1", name: "R", door_front: { hinge: "left", thickness_mm: 40 } };
    const relationalRack = normalizedForm("racks", { id: "r1", name: "R", door_front: { thickness_mm: 40, hinge: "left" } });
    ck.eq(C.compareRecord("racks", blobRack, relationalRack).join(" | "), "", "json : même value-object à clés réordonnées → parité (comparaison canonique)");

    // -- Records absents. --
    ck.eq(C.compareRecord("equipments", null, null).length, 0, "absent des deux côtés (getOne d'un id inconnu) → parité");
    ck.eq(C.compareRecord("equipments", blobRecord, null).length, 1, "présent d'un seul côté → divergence");
  }
  });

  await section("Parité L3 : LECTURE sur corpus démo — dump, getOne/getMany, findBy INDEX_SPEC, pagination, recherche, conflicts, meta", async () => {
  {
    if (!requireSqlite()) return;
    const corpus = CORPUS();
    const { blob, relational } = openPair();

    // -- LE balayage : import du même corpus des deux côtés puis toutes les lectures du contrat. --
    const stats = ParityComparator.compareCorpusReads(blob, relational, corpus, 0);
    console.log("    corpus démo : " + stats.records + " records, " + stats.cases + " cas comparés, " +
      stats.findByProbeCount + " sondes findBy (" + stats.findByNonEmpty + " non vides), " +
      stats.searchProbeCount + " sondes de recherche (" + stats.searchNonEmpty + " non vides)");
    ck.eq(stats.divergences.length, 0, "🎯 parité de LECTURE corpus démo : 0 divergence hors attendues — fautifs : [" + stats.divergences.slice(0, 8).join(" | ") + "]");

    // -- ANTI-VACUITÉ : le verdict ci-dessus porte sur un vrai volume, pas sur un balayage creux. --
    ck(stats.records > 200, "anti-vacuité : > 200 records réellement importés (" + stats.records + ")");
    ck(stats.populated.length >= 15, "anti-vacuité : " + stats.populated.length + " collections peuplées balayées");
    ck(stats.populated.every((c) => (stats.perCollection[c] || 0) >= 1), "anti-vacuité : au moins un cas de parité par collection PEUPLÉE");
    ck(stats.findByProbeCount >= 100 && stats.findByNonEmpty >= 20,
      "anti-vacuité : sondes findBy sur chaque champ d'INDEX_SPEC, dont des non-vides (" + stats.findByProbeCount + "/" + stats.findByNonEmpty + ")");
    ck(stats.searchHasAccent, "anti-vacuité : la batterie de recherche contient une valeur ACCENTUÉE réelle du corpus");
    ck(stats.searchNonEmpty >= 3, "anti-vacuité : des sondes de recherche matchent réellement (" + stats.searchNonEmpty + ")");

    // -- conflicts : même scénario de rev DES DEUX CÔTÉS (écrit rev 7, lu à baseRev 6 puis 7). --
    const target = [{ collection: "equipments", id: corpus.equipments[0].id }];
    blob.upsert("equipments", corpus.equipments[0], 7);
    relational.upsert("equipments", corpus.equipments[0], 7);
    ck.eq(ParityComparator.canonical(blob.conflicts(target, 6)), ParityComparator.canonical(relational.conflicts(target, 6)),
      "conflicts : sortie IDENTIQUE à baseRev 6 (l'entité écrite en rev 7 ressort avec la même rev)");
    ck.eq(blob.conflicts(target, 6).length, 1, "conflicts : le conflit existe réellement (anti-vacuité)");
    ck.eq(ParityComparator.canonical(blob.conflicts(target, 7)), ParityComparator.canonical(relational.conflicts(target, 7)),
      "conflicts : sortie IDENTIQUE (vide) à baseRev 7");

    // -- DISCRIMINANCE de bout en bout : une divergence de SYNTHÈSE dans un des dépôts → le
    //    comparateur échoue en NOMMANT collection/id/champ (la preuve que le vert du 🎯 mord). --
    const tamperedId = corpus.equipments[0].id;
    relational.upsert("equipments", { ...corpus.equipments[0], name: corpus.equipments[0].name + " (TAMPER)" }, 7);
    const tampered = ParityComparator.compareRecord("equipments", blob.getOne("equipments", tamperedId), relational.getOne("equipments", tamperedId));
    ck(tampered.length === 1 && tampered[0].startsWith("equipments/" + tamperedId + "/name"),
      "discriminance : la divergence de synthèse est détectée et NOMMÉE collection/id/champ (" + tampered.join(" | ") + ")");

    blob.close(); relational.close();
  }
  });

  await section("Parité L3 : divergences ENCODÉES — filtre sur champ INCONNU (blob matche tout) + sonde NOT NULL (blob avale, relationnel rejette)", async () => {
  {
    if (!requireSqlite()) return;
    const { blob, relational } = openPair();
    const applyBoth = (fn) => { fn(blob); fn(relational); };

    // -- DIVERGENCE ASSUMÉE n°3 : filtre `where` sur champ INCONNU de la spec. `status` fourni
    //    (required → NOT NULL côté relationnel ; le Repository ne normalise pas, il stocke). --
    applyBoth((repo) => {
      repo.upsert("cables", { id: "c1", name: "câble un", status: "brouillon", network_id: "n1" }, 1);
      repo.upsert("cables", { id: "c2", name: "câble deux", status: "brouillon" }, 1);
      repo.upsert("cables", { id: "c3", name: "câble trois", status: "brouillon", network_id: null }, 1);
    });
    ck.eq(blob.list("cables", { where: { champ_fantome: "null" } }).total, 3,
      "divergence assumée — blob : sentinelle 'null' sur champ INCONNU matche TOUT (accident json_extract IS NULL, aucun émetteur réel — mesure L0 §3.3)");
    ck.eq(relational.list("cables", { where: { champ_fantome: "null" } }).total, 0,
      "divergence assumée — relationnel : champ inconnu → 0 ligne (1=0, décision du contrat L2)");
    ck.eq(blob.findBy("cables", "champ_fantome", "null").length, 3, "divergence assumée — blob findBy : même accident (3 lignes)");
    ck.eq(relational.findBy("cables", "champ_fantome", "null").length, 0, "divergence assumée — relationnel findBy : 0 ligne");
    // Avec une VALEUR (pas la sentinelle), les deux implémentations coïncident : 0 ligne chacune.
    ck.eq(blob.list("cables", { where: { champ_fantome: "x" } }).total, 0, "champ inconnu + valeur : blob → 0 (la divergence ne concerne QUE la sentinelle)");
    ck.eq(relational.list("cables", { where: { champ_fantome: "x" } }).total, 0, "champ inconnu + valeur : relationnel → 0 aussi");

    // -- DIVERGENCE ASSUMÉE n°4 (sonde NOT NULL) : record SANS champ `required` (equipments.name).
    //    Les corpus mesurés n'ont AUCUN cas — cette sonde ENCODE le comportement des deux côtés ;
    //    ce que L4 doit en faire (abort de migration nommant le record fautif) reste à trancher là-bas. --
    blob.upsert("equipments", { id: "nn1" }, 1);
    ck.eq(blob.getOne("equipments", "nn1").id, "nn1", "sonde NOT NULL — blob : record sans `name` AVALÉ (la DB blob n'impose rien)");
    let upsertError = "";
    try { relational.upsert("equipments", { id: "nn1" }, 1); } catch (e) { upsertError = String((e && e.message) || e); }
    ck(/NOT NULL/.test(upsertError) && upsertError.includes("equipments.name"),
      "sonde NOT NULL — relationnel : REJET SQL nommant la colonne (« " + upsertError + " »)");
    ck.eq(relational.getOne("equipments", "nn1"), null, "sonde NOT NULL — relationnel : rien n'a été écrit");

    // Le même record fautif DANS UN SNAPSHOT : blob l'avale ; relationnel = transaction REJETÉE en
    // bloc, l'état ANTÉRIEUR survit (abort atomique — le filet dont la migration L4 héritera).
    relational.upsert("equipments", { id: "nn0", name: "présent avant le snapshot" }, 1);
    let snapshotThrew = false;
    const faultySnapshot = { equipments: [{ id: "ok1", name: "valide" }, { id: "bad1", type: "switch" }] };
    try { relational.replaceSnapshot(faultySnapshot, 0); } catch { snapshotThrew = true; }
    ck(snapshotThrew, "sonde NOT NULL — relationnel : snapshot contenant le record fautif → transaction rejetée");
    ck(!!relational.getOne("equipments", "nn0") && relational.getOne("equipments", "ok1") === null,
      "sonde NOT NULL — relationnel : abort ATOMIQUE (état antérieur intact, rien de partiel)");
    blob.replaceSnapshot(faultySnapshot, 0);
    ck(!!blob.getOne("equipments", "bad1"), "sonde NOT NULL — blob : le même snapshot passe et stocke le record fautif (contraste à arbitrer en L4)");

    blob.close(); relational.close();
  }
  });

  await section("Parité L3 : ÉCRITURES — même séquence de mutations, re-dump comparé, updated_rev, aller-retour recherche, snapshot partiel", async () => {
  {
    if (!requireSqlite()) return;
    const corpus = CORPUS();
    const { blob, relational } = openPair();
    const applyBoth = (fn) => { fn(blob); fn(relational); };
    const corpusTotal = SharedSchema.COLLECTIONS.reduce((sum, c) => sum + ((corpus[c] || []).length), 0);

    blob.replaceSnapshot(corpus, 0);
    relational.replaceSnapshot(corpus, 0);

    // -- La MÊME séquence de mutations des deux côtés (records dérivés du corpus : déterministe,
    //    et les champs `required` sont garantis présents — clones + surcharges). --
    // 1. CREATES (rev 1) : json (porte de baie), string[] (cellules), appartenance (network_ids).
    const createdRack = { ...corpus.racks[0], id: "l3-rack", name: "Baie parité L3",
      door_front: { enabled: true, thickness_mm: 40, hinge: "left", leaves: 1, hollow: true, hollow_mm: 20 },
      floor_cells: ["0,0", "0,1"] };
    const createdCable = { ...corpus.cables[0], id: "l3-cable", name: "Câble parité L3", network_ids: ["l3-n1", "l3-n2"] };
    applyBoth((repo) => { repo.upsert("racks", createdRack, 1); repo.upsert("cables", createdCable, 1); });
    // 2. UPDATE simple (rev 2).
    const updatedEquipment = { ...corpus.equipments[0], description: "Parité L3 — description modifiée" };
    applyBoth((repo) => repo.upsert("equipments", updatedEquipment, 2));
    // 3. UPDATE qui RETIRE des clés (rev 3) : déclarées (description/brand/model) ET une legacy tolérée.
    const strippedEquipment = { ...corpus.equipments[1] };
    delete strippedEquipment.description; delete strippedEquipment.brand; delete strippedEquipment.model; delete strippedEquipment.face_image;
    applyBoth((repo) => repo.upsert("equipments", strippedEquipment, 3));
    // 4. DELETE unitaire.
    const deletedPortId = corpus.ports[0].id;
    applyBoth((repo) => repo.delete("ports", deletedPortId));
    // 5. TRANSACT mixte (rev 5) : deletes + updates + creates + meta, UNE transaction.
    const createdGroup = { ...corpus.groups[0], id: "l3-group", label: "Groupe parité L3" };
    const transactMeta = { docName: "Parité L3 — meta transact", parite: true };
    applyBoth((repo) => repo.transact({
      deletes: [{ collection: "ports", id: corpus.ports[1].id }],
      updates: [{ collection: "networks", record: { ...corpus.networks[0], description: "Parité L3" } }],
      creates: [{ collection: "groups", record: createdGroup }],
      meta: transactMeta,
    }, 5));

    // -- Re-DUMP COMPLET comparé (modulo divergences encodées — la règle par champ du comparateur). --
    const dump = ParityComparator.compareDumps(blob, relational);
    ck.eq(dump.divergences.length, 0, "🎯 parité d'ÉCRITURE : re-dump complet sans divergence — fautifs : [" + dump.divergences.slice(0, 8).join(" | ") + "]");
    const expectedRows = corpusTotal - 2 + 3;   // 2 ports supprimés, 3 créations (baie, câble, groupe)
    ck.eq(dump.rowsCompared, expectedRows, "anti-vacuité : " + expectedRows + " records comparés après mutations (créations/suppressions comptées)");
    ck.eq(blob.getMeta().docName, "Parité L3 — meta transact", "meta : la meta du transact a bien été posée (parité déjà comparée dans le dump)");

    // -- `updated_rev` ESTAMPILLÉE À L'IDENTIQUE : conflicts (le lecteur public de l'estampille)
    //    rejoué à chaque baseRev — sorties canoniques identiques, et valeurs de rev vérifiées. --
    const touched = [
      { collection: "racks", id: "l3-rack" }, { collection: "cables", id: "l3-cable" },
      { collection: "equipments", id: updatedEquipment.id }, { collection: "equipments", id: strippedEquipment.id },
      { collection: "networks", id: corpus.networks[0].id }, { collection: "groups", id: "l3-group" },
      { collection: "ports", id: deletedPortId },   // supprimé : absent → jamais en conflit
    ];
    let conflictsMatch = true;
    for (const baseRev of [-1, 0, 1, 2, 3, 4, 5]) {
      if (ParityComparator.canonical(blob.conflicts(touched, baseRev)) !== ParityComparator.canonical(relational.conflicts(touched, baseRev))) conflictsMatch = false;
    }
    ck(conflictsMatch, "updated_rev : conflicts identiques aux 7 baseRev sondées (l'estampille de CHAQUE écriture coïncide)");
    ck.eq(blob.conflicts(touched, 0).length, 6, "updated_rev : 6 entités touchées ressortent à baseRev 0 (le port supprimé, jamais)");
    ck.eq(blob.conflicts(touched, 4).length, 2, "updated_rev : seules les écritures du transact (rev 5) ressortent à baseRev 4");

    // -- DIVERGENCE ASSUMÉE n°2, prémisse MESURÉE : le cycle GET→PUT d'un client (chacun ré-écrit CE
    //    QU'IL A LU) fait diverger les colonnes `search` (Object.values : ordre et clés diffèrent
    //    entre forme stockée et forme normalisée) — mais la recherche par RÉSULTATS reste en parité.
    //    C'est la raison d'être de la règle « jamais comparer la colonne » du comparateur. --
    const roundTripId = updatedEquipment.id;
    blob.upsert("equipments", blob.getOne("equipments", roundTripId), 6);
    relational.upsert("equipments", relational.getOne("equipments", roundTripId), 6);
    // (`repo.db` est privé TypeScript — accessible du test JS, assumé pour l'inspection, cf. lot L2.)
    const blobSearch = blob.db.prepare(`SELECT search FROM "equipments" WHERE id = ?`).get(roundTripId).search;
    const relationalSearch = relational.db.prepare(`SELECT search FROM "equipments" WHERE id = ?`).get(roundTripId).search;
    ck(blobSearch !== relationalSearch, "aller-retour : les colonnes `search` DIVERGENT réellement (prémisse mesurée, pas supposée)");
    for (const query of ["parite", "PARITÉ", corpus.equipments[0].name]) {
      const blobFound = blob.list("equipments", { query, pageSize: SharedSchema.PAGE_SIZE_ALL }).rows.map((r) => r.id).sort().join(" ");
      const relationalFound = relational.list("equipments", { query, pageSize: SharedSchema.PAGE_SIZE_ALL }).rows.map((r) => r.id).sort().join(" ");
      ck.eq(relationalFound, blobFound, "aller-retour : recherche q=" + JSON.stringify(query) + " → MÊMES résultats malgré les colonnes divergentes");
    }
    // Et le record lui-même reste en parité après son aller-retour (blob ré-écrit la forme stockée,
    // relationnel la forme normalisée — la règle par champ les réconcilie).
    ck.eq(ParityComparator.compareRecord("equipments", blob.getOne("equipments", roundTripId), relational.getOne("equipments", roundTripId)).join(" | "), "",
      "aller-retour : le record relu reste en parité (règle par champ)");

    // -- Re-replaceSnapshot PARTIEL : les collections absentes du snapshot sont VIDÉES des deux côtés. --
    const partialSnapshot = { racks: [corpus.racks[0], corpus.racks[1]], meta: { docName: "Snapshot partiel L3" } };
    applyBoth((repo) => repo.replaceSnapshot(partialSnapshot, 0));
    const afterPartial = ParityComparator.compareDumps(blob, relational);
    ck.eq(afterPartial.divergences.length, 0, "snapshot partiel : dump en parité — fautifs : [" + afterPartial.divergences.slice(0, 5).join(" | ") + "]");
    ck.eq(afterPartial.rowsCompared, 2, "snapshot partiel : 2 baies restent, TOUTES les autres collections vidées (des deux côtés)");
    ck(blob.getOne("equipments", roundTripId) === null && relational.getOne("equipments", roundTripId) === null,
      "snapshot partiel : l'équipement d'avant a disparu des deux côtés");
    ck.eq(blob.getMeta().docName, "Snapshot partiel L3", "snapshot partiel : meta remplacée (parité déjà comparée dans le dump)");

    blob.close(); relational.close();
  }
  });
};

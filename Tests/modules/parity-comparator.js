/* ============================================================================
   COMPARATEUR DE PARITÉ blob ⇄ relationnel (lot L3 migration DB) — module de TEST.
   ----------------------------------------------------------------------------
   Compare DEUX IMPLÉMENTATIONS INDÉPENDANTES du contrat `Repository` — le blob
   JSON (`db.ts`, chemin de prod) et le relationnel (`RelationalRepository.ts`,
   lot L2) — sur un MÊME corpus : c'est la pièce de PREUVE qui conditionne la
   bascule L4 (cadrage `.notes/toDos/migration-db-relationnelle-cadrage-2026-07-31.md` §5 L3).

   Ce fichier N'EST PAS un test lui-même : c'est l'outil PARTAGÉ de deux
   consommateurs — `test-relational-parity.js` (corpus de démo versionné) et la
   sonde HORS dépôt sur le corpus réel (script de scratchpad, jamais versionné,
   cf. rapport de lot). D'où son autonomie : il ne requiert PAS harness.js
   (qui charge tout le front et pose des stubs navigateur) mais uniquement les
   modules partagés compilés dont il a besoin.

   ── La RÈGLE DE PARITÉ par champ (divergences VOULUES du contrat L2, encodées
      ici comme ATTENDUES — jamais tolérées en silence) ─────────────────────────
   Le blob rend le record TEL QUE STOCKÉ (clés du corpus) ; le relationnel rend
   la forme NORMALISÉE (toutes les clés de spec présentes, absentes → null ;
   legacy/inconnues disparues ; id/audit seulement si non-NULL). Donc :
   - champ DÉCLARÉ présent côté blob   → valeurs STRICTEMENT égales (canonique) ;
   - champ DÉCLARÉ absent côté blob    → null côté relationnel (clé PRÉSENTE) ;
   - audit non-null côté blob          → égal strict côté relationnel ;
   - audit null OU absent côté blob    → clé ABSENTE côté relationnel ;
   - clé blob HORS spec∪audit∪id      → doit appartenir EXACTEMENT à la liste
     tolérée du verrou de complétude (`test-spec-completude.js` — les legacy
     `equipments.face_image`/`face_image_rear`, purge L4 actée) et DISPARAÎTRE
     côté relationnel. TOUTE AUTRE clé = ÉCHEC nommé, pas une tolérance : le
     comparateur ne « passe » jamais une divergence qu'il ne connaît pas.
   - clé côté relationnel HORS spec∪audit∪id → ÉCHEC (le relationnel ne peut
     RIEN inventer).
   La comparaison de valeur est CANONIQUE (clés d'objet triées récursivement —
   l'ordre des clés d'un record reconstruit diffère du blob, piège §6 du
   cadrage) ; l'ordre des TABLEAUX, lui, est significatif (waypoint_ids…) et
   reste comparé tel quel.

   ⚠ La colonne `search` n'est JAMAIS comparée : la recherche se compare par
   RÉSULTATS (ensembles d'ids) — la colonne diverge légitimement après un
   aller-retour d'un record à clés legacy (concaténation d'`Object.values`,
   piège §6 du cadrage ; démonstration mesurée dans test-relational-parity.js).
   ============================================================================ */
"use strict";
const path = require("path");

/* Modules PARTAGÉS compilés — les mêmes définitions que le serveur (jamais une relecture manuelle). */
const DIST = (p) => require(path.join(__dirname, "..", "..", "dist-test", "src-shared", p));
const { COLLECTION_SPECS } = DIST("DataValidation.js");
const { Schema } = DIST("Schema.js");
const { INDEX_SPEC } = DIST("RelationalSchema.js");

/** Colonnes d'audit posées par le serveur (AuditStamp) — hors spec, passthrough assumé. */
const AUDIT_FIELDS = ["created_by", "updated_by", "created_date", "updated_date"];

/** Liste FERMÉE des clés blob tolérées hors spec — MIROIR du verrou de complétude
    (`test-spec-completude.js`, TOLERATED_BY_COLLECTION) : les deux legacy d'équipement, RIEN d'autre.
    Duplication assumée (le verrou les déclare dans le corps de sa section) ; toute divergence entre les
    deux listes ferait échouer soit le verrou, soit la parité — le couple se surveille lui-même. */
const TOLERATED_BLOB_KEYS = { equipments: new Set(["face_image", "face_image_rear"]) };

/** Comparateur de PARITÉ entre les deux implémentations du contrat `Repository` (méthodes statiques). */
class ParityComparator {
  /* ---- canonicalisation ---- */

  /** Valeur → forme canonique : clés d'objet TRIÉES récursivement (l'ordre des clés d'un record
      reconstruit diffère du blob — parité STRUCTURELLE, pas byte-à-byte). L'ordre des tableaux est
      CONSERVÉ : il est porteur de sens (waypoint_ids = étapes ordonnées d'une route). */
  static sortedClone(value) {
    if (Array.isArray(value)) return value.map((item) => ParityComparator.sortedClone(item));
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = ParityComparator.sortedClone(value[key]);
      return out;
    }
    return value;
  }

  /** Représentation canonique comparable (JSON de la forme triée). */
  static canonical(value) { return JSON.stringify(ParityComparator.sortedClone(value)); }

  /* ---- règle de parité par champ (cf. en-tête) ---- */

  /** Compare UN record blob (tel que stocké) à son homologue relationnel (forme normalisée).
      Renvoie les divergences sous la forme « collection/id/champ : détail » (liste vide = parité).
      `null` des deux côtés (record absent des deux implémentations) = parité. */
  static compareRecord(collection, blobRecord, relationalRecord) {
    const divergences = [];
    if (blobRecord == null && relationalRecord == null) return divergences;
    const id = (blobRecord && blobRecord.id) || (relationalRecord && relationalRecord.id) || "?";
    const at = (field, detail) => divergences.push(collection + "/" + id + "/" + field + " : " + detail);
    if (blobRecord == null || relationalRecord == null) {
      at("(record)", "présent d'un seul côté (blob " + (blobRecord ? "oui" : "non") + ", relationnel " + (relationalRecord ? "oui" : "non") + ")");
      return divergences;
    }
    const fields = (COLLECTION_SPECS[collection] || { fields: {} }).fields;

    // id : toujours présent des deux côtés (l'upsert l'exige), strictement égal.
    if (blobRecord.id !== relationalRecord.id) at("id", "blob " + JSON.stringify(blobRecord.id) + " ≠ relationnel " + JSON.stringify(relationalRecord.id));

    // Champs DÉCLARÉS : présent côté blob → égalité canonique ; absent → null côté relationnel (clé présente).
    for (const field of Object.keys(fields)) {
      if (field in blobRecord) {
        const blobCanonical = ParityComparator.canonical(blobRecord[field]);
        const relationalCanonical = ParityComparator.canonical(relationalRecord[field]);
        if (blobCanonical !== relationalCanonical) at(field, "valeurs divergentes (blob " + blobCanonical + ", relationnel " + relationalCanonical + ")");
      } else if (!(field in relationalRecord)) {
        at(field, "clé de spec ABSENTE du record relationnel (la forme normalisée doit la porter)");
      } else if (relationalRecord[field] !== null) {
        at(field, "absent côté blob mais non-null côté relationnel (" + ParityComparator.canonical(relationalRecord[field]) + ")");
      }
    }

    // Audit : non-null côté blob → égal strict ; null/absent côté blob → clé ABSENTE côté relationnel
    // (contrat L2 : id/audit inclus seulement si non-NULL — pas de clé null inventée).
    for (const audit of AUDIT_FIELDS) {
      if (blobRecord[audit] != null) {
        if (relationalRecord[audit] !== blobRecord[audit]) at(audit, "audit divergent (blob " + JSON.stringify(blobRecord[audit]) + ", relationnel " + JSON.stringify(relationalRecord[audit]) + ")");
      } else if (audit in relationalRecord) {
        at(audit, "audit null/absent côté blob mais clé présente côté relationnel");
      }
    }

    // Clés blob HORS spec∪audit∪id : EXACTEMENT la liste tolérée du verrou de complétude — toute
    // autre est un ÉCHEC (jamais une tolérance du comparateur) ; et une clé tolérée DISPARAÎT du relationnel.
    const tolerated = TOLERATED_BLOB_KEYS[collection] || new Set();
    for (const key of Object.keys(blobRecord)) {
      if (key === "id" || key in fields || AUDIT_FIELDS.includes(key)) continue;
      if (!tolerated.has(key)) at(key, "clé blob HORS spec∪audit∪id et HORS liste tolérée (verrou de complétude)");
      else if (key in relationalRecord) at(key, "clé legacy tolérée présente côté relationnel (elle doit disparaître — purge L4)");
    }

    // Clés relationnelles HORS spec∪audit∪id : le relationnel ne peut RIEN inventer.
    for (const key of Object.keys(relationalRecord)) {
      if (key === "id" || key in fields || AUDIT_FIELDS.includes(key)) continue;
      at(key, "clé INATTENDUE côté relationnel (hors spec, audit et id)");
    }
    return divergences;
  }

  /* ---- balayages ---- */

  /** Compare le DUMP COMPLET des deux dépôts (chaque collection : total/pages, ORDRE du tri
      created_date/id, chaque record par la règle de parité) + la meta. Réutilisé après un scénario de
      MUTATIONS (les totaux se comparent alors entre eux, plus à un corpus). */
  static compareDumps(blobRepo, relationalRepo) {
    const stats = { cases: 0, rowsCompared: 0, divergences: [], perCollection: {} };
    const note = (collection, n = 1) => { stats.cases += n; stats.perCollection[collection] = (stats.perCollection[collection] || 0) + n; };
    for (const collection of Schema.COLLECTIONS) {
      const blobList = blobRepo.list(collection, { pageSize: Schema.PAGE_SIZE_ALL });
      const relationalList = relationalRepo.list(collection, { pageSize: Schema.PAGE_SIZE_ALL });
      note(collection);
      if (blobList.total !== relationalList.total || blobList.pages !== relationalList.pages) {
        stats.divergences.push(collection + " : total/pages du dump divergent (blob " + blobList.total + "/" + blobList.pages + ", relationnel " + relationalList.total + "/" + relationalList.pages + ")");
        continue;
      }
      // L'ORDRE est contractuel (ORDER BY created_date ASC, id ASC des deux côtés) — comparé tel quel.
      note(collection);
      const blobIds = blobList.rows.map((r) => r.id).join("\0");
      const relationalIds = relationalList.rows.map((r) => r.id).join("\0");
      if (blobIds !== relationalIds) {
        stats.divergences.push(collection + " : ORDRE du dump divergent (tri created_date ASC, id ASC)");
        continue;
      }
      for (let i = 0; i < blobList.rows.length; i++) {
        note(collection); stats.rowsCompared++;
        stats.divergences.push(...ParityComparator.compareRecord(collection, blobList.rows[i], relationalList.rows[i]));
      }
    }
    stats.cases++;
    if (ParityComparator.canonical(blobRepo.getMeta()) !== ParityComparator.canonical(relationalRepo.getMeta())) {
      stats.divergences.push("meta : contenu divergent (getMeta canonique)");
    }
    return stats;
  }

  /** Sondes de recherche plein-texte DÉRIVÉES du corpus (aucune valeur codée en dur — le même
      constructeur sert le corpus de démo ET le corpus réel de la sonde) : pour quelques valeurs
      textuelles réelles → exacte, MAJUSCULES, sous-chaîne intérieure, version désaccentuée d'une
      valeur ACCENTUÉE, + une sonde sans aucun résultat. Renvoie { probes, hasAccent }. */
  static searchProbes(corpus) {
    const probes = new Set();
    let hasAccent = false;
    const texts = [];
    for (const collection of Schema.COLLECTIONS) {
      for (const record of (corpus[collection] || [])) {
        for (const value of Object.values(record)) {
          if (typeof value === "string" && value.trim().length >= 4) texts.push(value.trim());
        }
      }
    }
    // Quelques valeurs « ordinaires » (les premières suffisent : la parité ne dépend pas du choix).
    for (const text of texts.slice(0, 3)) {
      probes.add(text);                                        // exacte (normalisée par list() des deux côtés)
      probes.add(text.toUpperCase());                          // casse
      if (text.length >= 6) probes.add(text.slice(2, text.length - 1));   // sous-chaîne intérieure
    }
    // Une valeur ACCENTUÉE (si le corpus en a une) : telle quelle ET désaccentuée — les deux doivent
    // matcher pareil des deux côtés (normSearch partagé aplatit les diacritiques).
    const accented = texts.find((text) => /[À-ſ]/.test(text));
    if (accented) {
      hasAccent = true;
      probes.add(accented);
      probes.add(accented.normalize("NFD").replace(/[̀-ͯ]/g, ""));
    }
    probes.add("zzz-parite-aucun-resultat");                   // aucun résultat, des deux côtés
    return { probes: [...probes], hasAccent };
  }

  /** Valeurs de sonde `findBy` pour un champ : jusqu'à 3 valeurs RÉELLES du corpus (éléments pour un
      champ tableau), + la sentinelle "null", + une valeur absente. */
  static findByProbes(corpusRecords, field) {
    const values = new Set();
    const isArray = Schema.isArrayField(field);
    for (const record of corpusRecords) {
      if (values.size >= 3) break;
      const value = record[field];
      if (isArray) { if (Array.isArray(value)) for (const item of value) { if (item != null && values.size < 3) values.add(String(item)); } }
      else if (value != null) values.add(String(value));
    }
    return [...values, "null", "zzz-parite-absente"];
  }

  /** PARITÉ DE LECTURE sur corpus : importe le MÊME corpus dans les deux dépôts (replaceSnapshot,
      rev `revision` — 0 = contrat PUT /snapshot) puis balaie TOUTES les lectures du contrat :
      dump complet (via compareDumps), getOne sur CHAQUE id (+ un absent), getMany échantillon,
      findBy sur CHAQUE champ d'INDEX_SPEC (valeurs réelles + sentinelle "null" + absente — dont
      l'appartenance aux champs tableaux), list paginé (page 2, tri stable), recherche q par
      ENSEMBLES d'ids (batterie searchProbes), conflicts (baseRev −1 : toutes les lignes ressortent
      avec leur rev — compare l'ESTAMPILLE ; baseRev = revision : aucune), getMeta.
      LECTURE SEULE après l'import : la sonde sur corpus réel rejoue exactement cette routine. */
  static compareCorpusReads(blobRepo, relationalRepo, corpus, revision = 0) {
    blobRepo.replaceSnapshot(corpus, revision);
    relationalRepo.replaceSnapshot(corpus, revision);

    const dump = ParityComparator.compareDumps(blobRepo, relationalRepo);
    const stats = {
      records: 0, populated: [],
      cases: dump.cases, divergences: [...dump.divergences], perCollection: { ...dump.perCollection },
      findByProbeCount: 0, findByNonEmpty: 0, searchProbeCount: 0, searchNonEmpty: 0, searchHasAccent: false,
    };
    const note = (collection, n = 1) => { stats.cases += n; stats.perCollection[collection] = (stats.perCollection[collection] || 0) + n; };
    const sortedIds = (rows) => rows.map((r) => r.id).sort().join("\0");

    for (const collection of Schema.COLLECTIONS) {
      const corpusRecords = corpus[collection] || [];
      stats.records += corpusRecords.length;
      if (corpusRecords.length) stats.populated.push(collection);

      // -- getOne sur CHAQUE id, + un id absent (null des deux côtés). --
      for (const record of corpusRecords) {
        note(collection);
        stats.divergences.push(...ParityComparator.compareRecord(collection, blobRepo.getOne(collection, record.id), relationalRepo.getOne(collection, record.id)));
      }
      note(collection);
      if (blobRepo.getOne(collection, "zzz-parite-absent") !== null || relationalRepo.getOne(collection, "zzz-parite-absent") !== null) {
        stats.divergences.push(collection + "/zzz-parite-absent/(record) : getOne d'un id absent devrait rendre null des deux côtés");
      }

      // -- getMany échantillon (5 premiers ids + un absent) : mêmes ids servis, records en parité.
      //    ⚠ Sans ORDER BY dans les deux implémentations → comparaison PAR id, pas par position. --
      if (corpusRecords.length) {
        const sampleIds = corpusRecords.slice(0, 5).map((r) => r.id).concat("zzz-parite-absent");
        const blobById = new Map(blobRepo.getMany(collection, sampleIds).map((r) => [r.id, r]));
        const relationalById = new Map(relationalRepo.getMany(collection, sampleIds).map((r) => [r.id, r]));
        note(collection);
        if ([...blobById.keys()].sort().join("\0") !== [...relationalById.keys()].sort().join("\0")) {
          stats.divergences.push(collection + " : getMany ne sert pas les mêmes ids");
        } else {
          for (const [id, blobRecord] of blobById) { note(collection); stats.divergences.push(...ParityComparator.compareRecord(collection, blobRecord, relationalById.get(id))); }
        }
      }

      // -- findBy sur CHAQUE champ d'INDEX_SPEC : valeurs réelles + sentinelle + absente. Résultats
      //    comparés en ENSEMBLES d'ids (aucun ORDER BY dans le contrat findBy). --
      for (const field of INDEX_SPEC[collection] || []) {
        for (const probe of ParityComparator.findByProbes(corpusRecords, field)) {
          note(collection); stats.findByProbeCount++;
          const blobRows = blobRepo.findBy(collection, field, probe);
          const relationalRows = relationalRepo.findBy(collection, field, probe);
          if (blobRows.length) stats.findByNonEmpty++;
          if (sortedIds(blobRows) !== sortedIds(relationalRows)) {
            stats.divergences.push(collection + "/(findBy)/" + field + " : ensembles d'ids divergents pour la valeur " + JSON.stringify(probe) +
              " (blob " + blobRows.length + " ligne(s), relationnel " + relationalRows.length + ")");
          }
        }
      }

      // -- list PAGINÉ : page 2 à pageSize 2 (tri stable created_date/id) — ordre, total, bornes. --
      if (corpusRecords.length > 2) {
        note(collection);
        const blobPage = blobRepo.list(collection, { page: 2, pageSize: 2 });
        const relationalPage = relationalRepo.list(collection, { page: 2, pageSize: 2 });
        if (blobPage.rows.map((r) => r.id).join("\0") !== relationalPage.rows.map((r) => r.id).join("\0") ||
            blobPage.total !== relationalPage.total || blobPage.pages !== relationalPage.pages || blobPage.page !== relationalPage.page) {
          stats.divergences.push(collection + " : list paginé (page 2) divergent (ordre/total/pages)");
        }
      }
    }

    // -- Recherche plein-texte : batterie dérivée du corpus, comparée par ENSEMBLES d'ids — JAMAIS
    //    par colonne `search` (divergence assumée après aller-retour, cf. en-tête). --
    const { probes, hasAccent } = ParityComparator.searchProbes(corpus);
    stats.searchHasAccent = hasAccent;
    for (const query of probes) {
      for (const collection of stats.populated) {
        note(collection); stats.searchProbeCount++;
        const blobFound = blobRepo.list(collection, { query, pageSize: Schema.PAGE_SIZE_ALL });
        const relationalFound = relationalRepo.list(collection, { query, pageSize: Schema.PAGE_SIZE_ALL });
        if (blobFound.rows.length) stats.searchNonEmpty++;
        if (sortedIds(blobFound.rows) !== sortedIds(relationalFound.rows)) {
          stats.divergences.push(collection + " : recherche q=" + JSON.stringify(query) + " → ensembles d'ids divergents (blob " +
            blobFound.rows.length + ", relationnel " + relationalFound.rows.length + ")");
        }
      }
    }

    // -- conflicts : baseRev −1 fait RESSORTIR chaque cible avec sa rev (compare l'ESTAMPILLE
    //    updated_rev posée par l'import) ; baseRev = revision n'en laisse aucune. --
    const targets = stats.populated.map((collection) => ({ collection, id: (corpus[collection][0] || {}).id })).filter((t) => t.id);
    stats.cases += 2;
    if (ParityComparator.canonical(blobRepo.conflicts(targets, -1)) !== ParityComparator.canonical(relationalRepo.conflicts(targets, -1))) {
      stats.divergences.push("(conflicts) : sorties divergentes à baseRev -1 (estampille updated_rev)");
    }
    if (ParityComparator.canonical(blobRepo.conflicts(targets, revision)) !== ParityComparator.canonical(relationalRepo.conflicts(targets, revision))) {
      stats.divergences.push("(conflicts) : sorties divergentes à baseRev " + revision + " (aucun conflit attendu)");
    }
    return stats;
  }
}

module.exports = { ParityComparator, AUDIT_FIELDS, TOLERATED_BLOB_KEYS };

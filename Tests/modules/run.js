/* ============================================================================
   DC Manager — Tests AU NIVEAU MODULES (TypeScript compilé, sans navigateur).
   ----------------------------------------------------------------------------
   ORCHESTRATEUR : les sections vivent dans les fichiers test-<domaine>.js
   (découpage de l'audit P5 — l'ancien monolithe de ~2200 lignes), le harnais
   partagé (stubs, loaders, ck, isolation par section) dans harness.js.
   Chaque section est isolée : un crash y est compté comme échec sans
   interrompre le reste de la suite.

   Usage :  npm run test   (compile dist-test/ puis exécute ce fichier)
   ============================================================================ */
"use strict";
const { summary } = require("./harness.js");

const DOMAINS = [
  "./test-core-store.js",        // entités + Store + helpers core
  "./test-geometry.js",          // géométrie pure
  "./test-views-tools.js",       // vues & outils (hôtes injectés)
  "./test-route-eligibility.js", // éditeur de route : éligibilité d'un waypoint + erreur → étape (core/RouteEligibility)
  "./test-ui-modalstack.js",     // primitives UI : politique de la PILE de modales (core/ModalStack)
  "./test-session-expiry.js",    // contrôle d'accès : verrou « session expirée (401) → retour au login » (core/SessionExpiry)
  "./test-ui-draglist.js",       // primitives UI : glisser-déposer de liste (ui/DragList — seule la décision de dépôt est pure)
  "./test-sync.js",              // rechargement granulaire REST
  "./test-shared-validation.js", // code partagé front/back
  "./test-spec-completude.js",   // spec COMPLÈTE (D3a migration DB) : verrou corpus démo ⇄ SPEC_FIELDS + FieldType json + défauts sensibles
  "./test-relational-schema.js", // générateur DDL relationnel (L1 migration DB) : golden CREATE TABLE/INDEX dérivés de la spec + INDEX_SPEC partagé
  "./test-relational-repository.js", // Repository RELATIONNEL (L2 migration DB) : CRUD re-typé, whereClause colonnes, EXPLAIN USING INDEX (better-sqlite3 RÉEL)
  "./test-search-terms.js",      // termes de recherche PARTAGÉS (lot 1 recherche) : golden terms/inverses, colonne search enrichie + invalidation + backfill (better-sqlite3 RÉEL), HydrationStats
  "./test-list-rows.js",         // listings SERVEUR-PILOTÉS (lot 3 recherche) : moteur de lignes local/serveur, parité fichier ⇄ serveur (better-sqlite3 RÉEL), filtre CIBLE unifié
  "./test-entity-candidates.js", // source de CANDIDATS d'entités PARTAGÉE (lot 4 recherche) : parité fichier (golden), chemin serveur (fromRecords), orchestration double mode (repli, annulation)
  "./test-legacy-migration.js",  // BASCULE + migration legacy (L4 migration DB) : backup .bak, normalisation, abort nommé, DocumentStore relationnel (better-sqlite3 RÉEL, fichiers temp)
  "./test-relational-evolution.js", // évolution ADDITIVE du schéma (lot A sous-équipements v2) : missingColumns pur + ALTER/backfill défauts à l'ouverture, ordre tables→colonnes→index (better-sqlite3 RÉEL)
  "./test-i18n.js",              // localisation : complétude des catalogues fr ⇄ en
  "./test-certs.js",             // certificats : crypto client pure (PkiCrypto/PkiSession)
  "./test-lifecycle-format.js",  // cycle de vie matériel (core/LifecycleFormat) : âge d'achat + état de garantie (now injecté), granularité adaptative, frontière 90 j
  "./test-rapprochement-certs.js", // rapprochement cert ↔ équipement/VM (HostnameMatch/CertSubject/CertTargetMatch, pur)
  "./test-interventions.js",     // interventions : logique cliente pure (InterventionsFormat, buildQuery)
  "./test-users.js",             // annuaire utilisateurs serveur (UserProfiles pur, resolver + snapshot SQLite)
  "./test-issues.js",            // COUCHE TRACKER (module serveur amovible `issues/`) : décodage Jira pur + ADF + pagination, adaptateur (stub HTTP), client HTTP sur `fetch` injecté, validation par marque, stockage chiffré (better-sqlite3 RÉEL), plafond ROULANT d'une passe (`TrackerPassScope`), `core/IssueStatus` (dont les PASTILLES et leur échappement), garde d'URL des liens sortants (`Html.externalLink`), miroir KIND_FIELDS ⇄ KIND_OPTION_SPECS et agnosticisme de marque. ⚠ Le MIROIR de tickets qu'elle servait (collection `issues`, onglet, follow) a été démoli au pivot du 2026-08-07 — cf. l'en-tête du fichier
  "./test-wifi.js",              // feature CLIENTS WIFI (module serveur amovible `wifi/`) : frontière partagée, décodage UniFi pur + pagination, adaptateur (stub), validation par marque, stockage chiffré (better-sqlite3 RÉEL), réconciliation, synchro bout en bout, invariants d'agnosticisme de marque (D9)
  "./test-server.js",            // serveur (ApiRules, SQLite réel, protocole REST)
];

(async () => {
  console.log("DC Manager — Tests modules (TypeScript compilé)");
  for (const d of DOMAINS) await require(d)();
  summary();
})().catch((e) => { console.error("\n\u2717 HARNAIS A LEVÉ :", e && e.stack ? e.stack : e); process.exit(1); });

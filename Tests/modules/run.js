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
  "./test-float-placement.js",   // primitives UI : règle de PLACEMENT des surfaces flottantes ancrées (core/FloatPlacement — paramétrages SearchPop portail / Autocomplete / RowMenu + politique tooltip)
  "./test-sync.js",              // rechargement granulaire REST
  "./test-hydration.js",         // état d'HYDRATATION par collection + gardes G1-G3 (lot 0 lazy-load) : module pur core/HydrationState (niveaux/transitions/prédicats, état inerte alwaysFull, erreur nommée), câblage Store (G1 anti-snapshot, G2 hydrateAll, G3 reloadCollections + point d'accroche)
  "./test-shared-validation.js", // code partagé front/back
  "./test-spec-completude.js",   // spec COMPLÈTE (D3a migration DB) : verrou corpus démo ⇄ SPEC_FIELDS + FieldType json + défauts sensibles
  "./test-relational-schema.js", // générateur DDL relationnel (L1 migration DB) : golden CREATE TABLE/INDEX dérivés de la spec + INDEX_SPEC partagé
  "./test-relational-repository.js", // Repository RELATIONNEL (L2 migration DB) : CRUD re-typé, whereClause colonnes, EXPLAIN USING INDEX (better-sqlite3 RÉEL)
  "./test-search-terms.js",      // termes de recherche PARTAGÉS (lot 1 recherche) : golden terms/inverses, colonne search enrichie + invalidation + backfill (better-sqlite3 RÉEL), HydrationStats
  "./test-list-rows.js",         // listings SERVEUR-PILOTÉS (lot 3 recherche) : moteur de lignes local/serveur, parité fichier ⇄ serveur (better-sqlite3 RÉEL), filtre CIBLE unifié
  "./test-entity-candidates.js", // source de CANDIDATS d'entités PARTAGÉE (lot 4 recherche) : parité fichier (golden), chemin serveur (fromRecords), orchestration double mode (repli, annulation)
  "./test-legacy-migration.js",  // BASCULE + migration legacy (L4 migration DB) : backup .bak, normalisation, abort nommé, DocumentStore relationnel (better-sqlite3 RÉEL, fichiers temp)
  "./test-relational-evolution.js", // évolution ADDITIVE du schéma (lot A sous-équipements v2) : missingColumns pur + ALTER/backfill défauts à l'ouverture, ordre tables→colonnes→index (better-sqlite3 RÉEL)
  "./test-vm-purge.js",          // PURGE DE MASSE des VMs (lot A) : règle pure `core/VmPurge` (groupes configuré/disparu/fichier, critère « enrichie » par famille, comptes du plan) + garantie transactionnelle de `Store.removeMany` (60 racines = 1 transaction / 1 undo, puis 1 révision / 1 SSE sur DocumentStore RÉEL)
  "./test-i18n.js",              // localisation : complétude des catalogues fr ⇄ en
  "./test-certs.js",             // certificats : crypto client pure (PkiCrypto/PkiSession)
  "./test-lifecycle-format.js",  // cycle de vie matériel (core/LifecycleFormat) : âge d'achat + état de garantie (now injecté), granularité adaptative, frontière 90 j
  "./test-format.js",            // formatage d'affichage (core/Format) : `bytes()` — taille de fichier lisible (pièces jointes, lot B)
  "./test-attachment-view.js",   // VIEWER intégré des pièces jointes (cadrage B) : choix du rendu par MIME/extension (core/AttachmentViewKind), politique d'images markdown (core/MarkdownImagePolicy), repli extension → MIME du sélecteur (ui/FilePicker.resolveMime)
  "./test-rapprochement-certs.js", // rapprochement cert ↔ équipement/VM (HostnameMatch/CertSubject/CertTargetMatch, pur)
  "./test-interventions.js",     // interventions : logique cliente pure (InterventionsFormat, buildQuery)
  "./test-users.js",             // annuaire utilisateurs serveur (UserProfiles pur, resolver + snapshot SQLite)
  "./test-tracker.js",           // PONT « interventions ⇄ tracker distant » (module serveur amovible `tracker/`) : décodage Jira pur + ADF + priorités + lecture des refus par champ + pagination, étiquettes `DCM-*` et DIFF en verbes (`TrackerLabels`), adaptateur (stub HTTP : création/mise à jour, repli « priorité refusée »), client HTTP sur `fetch` injecté, validation par marque, stockage chiffré (better-sqlite3 RÉEL), plafond ROULANT d'une passe (`TrackerPassScope`), PONT de bout en bout sur interventions.db + DocumentStore RÉELS (poussée tolérante, redémarrage, retour d'état idempotent, auto-réplication), `core/TrackerStatus` (dont la PASTILLE et son échappement) et `core/TrackerReplication` (état de réplication d'une intervention), garde d'URL des liens sortants (`Html.externalLink`), miroir KIND_FIELDS ⇄ KIND_OPTION_SPECS et agnosticisme de marque
  "./test-wifi.js",              // feature CLIENTS WIFI (module serveur amovible `wifi/`) : frontière partagée, décodage UniFi pur + pagination, adaptateur (stub), validation par marque, stockage chiffré (better-sqlite3 RÉEL), réconciliation, synchro bout en bout, invariants d'agnosticisme de marque (D9)
  "./test-attachments.js",       // PIÈCES JOINTES (lot A) : bundle .nmfa via l'enveloppe GÉNÉRALISÉE BinaryBundle + non-régression .nmfb bit-identique, ContentDisposition (nom de download assaini D6), AttachmentFiles (id opaque anti-traversal, purge d'orphelins D5, fs réel), DocumentStore + maintenance (better-sqlite3 RÉEL), helpers/cascade du Store client — la spec/validation/cascade pure vit dans test-shared-validation.js
  "./test-server.js",            // serveur (ApiRules, SQLite réel, protocole REST)
];

(async () => {
  console.log("DC Manager — Tests modules (TypeScript compilé)");
  for (const d of DOMAINS) await require(d)();
  summary();
})().catch((e) => { console.error("\n\u2717 HARNAIS A LEVÉ :", e && e.stack ? e.stack : e); process.exit(1); });

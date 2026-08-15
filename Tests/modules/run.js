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
  "./test-lazy-contacts.js",     // VAGUE 1 du lazy-load (contacts) : liste centrale core/LazyCollections, compteurs async core/CollectionCountCache (G6), boot qui saute contacts + re-déclaration après _hydrate, sémantique syncCatalogs → hydrater d'abord (G1), hydratation à la demande, pager SERVEUR réel (G4 : décision de régime + machinerie de page)
  "./test-lazy-vague2.js",       // VAGUE 2 du lazy-load (attachments + applications) : liste centrale étendue et boot qui les saute, G7 jumeaux ASYNC des sections de fiche (cache ⇄ FK indexée, absorption, tri, parité mode fichier), G5 aperçu de cascade (critère local ⇄ serveur, replis), M4 purge de la cascade RÉSIDUELLE au cache, `sortField` des deux listings ∈ liste blanche partagée
  "./test-lazy-vague3.js",       // VAGUE 3 du lazy-load (wifiClients, la plus VOLUMINEUSE) : liste centrale étendue et boot qui la saute, G8 facettes DISTINCT SERVEUR — liste blanche PARTAGÉE src-shared/ListFacets (dérivation, inclusion dans celle du tri, SQL golden, anti-injection), module pur core/CollectionFacetCache (valeurs async servies en synchrone, `withSelected` anti-purge), Store.facetValues (cache ⇄ serveur, invalidations dont la MISE À JOUR et le SSE sauté), StoreListRowSource.facetOptions, et les sortField/filter.field du listing wifi
  "./test-lazy-vague4.js",       // VAGUE 4 du lazy-load (spares) : liste centrale étendue (contenu EXACT verrouillé ici) et boot qui saute les CINQ, M4b — mises à jour RÉSIDUELLES du serveur consommées (refetch groupé par collection, absorption + rafraîchissement, échec sans casser l'écriture), résolution GROUPÉE des libellés de cibles (core/TargetLabelResolution, remplace l'hydratation en masse), G7 jumeau async sparesOfEquipmentAsync (tri = jumeau synchrone), sortField du listing spares
  "./test-shared-validation.js", // code partagé front/back
  "./test-spec-completude.js",   // spec COMPLÈTE (D3a migration DB) : verrou corpus démo ⇄ SPEC_FIELDS + FieldType json + défauts sensibles
  "./test-relational-schema.js", // générateur DDL relationnel (L1 migration DB) : golden CREATE TABLE/INDEX dérivés de la spec + INDEX_SPEC partagé
  "./test-relational-repository.js", // Repository RELATIONNEL (L2 migration DB) : CRUD re-typé, whereClause colonnes, EXPLAIN USING INDEX (better-sqlite3 RÉEL)
  "./test-search-terms.js",      // termes de recherche PARTAGÉS (lot 1 recherche) : golden terms/inverses, colonne search enrichie + invalidation + backfill (better-sqlite3 RÉEL), HydrationStats
  "./test-list-rows.js",         // listings SERVEUR-PILOTÉS (lot 3 recherche) : moteur de lignes local/serveur, parité fichier ⇄ serveur (better-sqlite3 RÉEL), filtre CIBLE unifié
  "./test-entity-candidates.js", // source de CANDIDATS d'entités PARTAGÉE (lot 4 recherche) : parité fichier (golden), chemin serveur (fromRecords), orchestration double mode (repli, annulation)
  "./test-entity-picker-source.js", // source du PICKER ASYNC (core/EntityPickerSource) : parcours local trié/borné, parcours DISTANT par la route de listing (paramètres, re-tri sans colonne, repli, annulation), recherche déléguée à EntityCandidateSource, libellés, anti-rebond
  "./test-legacy-migration.js",  // BASCULE + migration legacy (L4 migration DB) : backup .bak, normalisation, abort nommé, DocumentStore relationnel (better-sqlite3 RÉEL, fichiers temp)
  "./test-relational-evolution.js", // évolution ADDITIVE du schéma (lot A sous-équipements v2) : missingColumns pur + ALTER/backfill défauts à l'ouverture, ordre tables→colonnes→index (better-sqlite3 RÉEL)
  "./test-vm-purge.js",          // PURGE DE MASSE des VMs (lot A) : règle pure `core/VmPurge` (groupes configuré/disparu/fichier, critère « enrichie » par famille, comptes du plan) + garantie transactionnelle de `Store.removeMany` (60 racines = 1 transaction / 1 undo, puis 1 révision / 1 SSE sur DocumentStore RÉEL)
  "./test-i18n.js",              // localisation : complétude des catalogues fr ⇄ en
  "./test-certs.js",             // certificats : crypto client pure (PkiCrypto/PkiSession)
  "./test-lifecycle-format.js",  // cycle de vie matériel (core/LifecycleFormat) : âge d'achat + état de garantie (now injecté), granularité adaptative, frontière 90 j — délègue à src-shared/Lifecycle (source unique verrouillée ici)
  "./test-warranty-watcher.js",  // veilleur de GARANTIES serveur (module amovible lifecycle/) : WarrantyExpiryWatcher pur (paliers partagés, silencieux 1er balayage, escalade UNE clé, resolve différentiel/prune) + LifecycleDb (marqueur persistant, better-sqlite3 réel)
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

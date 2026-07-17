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
  "./test-sync.js",              // rechargement granulaire REST
  "./test-shared-validation.js", // code partagé front/back
  "./test-i18n.js",              // localisation : complétude des catalogues fr ⇄ en
  "./test-certs.js",             // certificats : crypto client pure (PkiCrypto/PkiSession)
  "./test-server.js",            // serveur (ApiRules, SQLite réel, protocole REST)
];

(async () => {
  console.log("DC Manager — Tests modules (TypeScript compilé)");
  for (const d of DOMAINS) await require(d)();
  summary();
})().catch((e) => { console.error("\n\u2717 HARNAIS A LEVÉ :", e && e.stack ? e.stack : e); process.exit(1); });

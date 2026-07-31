/* Tests modules — EXPIRATION DE SESSION (`core/SessionExpiry`, retour au login sur 401).

   Verrou PUR, sans DOM ni réseau : seul un 401 déclenche l'action de retour au login, et une RAFALE de
   401 (fetches en vol quand le SSO expire) ne doit produire qu'UNE action. On vérifie la classification
   (401 seul déclenche), l'idempotence (2e/3e 401 sans effet), le ré-armement par reset(), et l'innocuité
   d'un report() avant install (no-op sûr).

   ⚠ État STATIQUE partagé (singleton applicatif) : chaque cas ré-arme via reset() avant de mesurer.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");
const { SessionExpiry } = D("core/SessionExpiry.js");

module.exports = async () => {

  await section("SessionExpiry : classification, idempotence, reset", async () => {
    // report SANS install : arme le verrou (latch) mais n'appelle rien — aucun crash (no-op sûr).
    SessionExpiry.reset();
    ck.eq(SessionExpiry.report(401), true, "sans install : 1er 401 arme le verrou (true) sans crash");
    ck.eq(SessionExpiry.report(401), false, "sans install : 2e 401 déjà armé → false");

    // Installe une action à compteur, puis ré-arme.
    let calls = 0;
    SessionExpiry.install(() => { calls++; });
    SessionExpiry.reset();

    // Classification : SEUL 401 déclenche (403 = droits insuffisants, 500 = panne, 0 = réseau).
    ck.eq(SessionExpiry.report(403), false, "403 (droits insuffisants) ne déclenche pas");
    ck.eq(SessionExpiry.report(500), false, "500 (erreur serveur) ne déclenche pas");
    ck.eq(SessionExpiry.report(0), false, "0 (panne réseau) ne déclenche pas");
    ck.eq(calls, 0, "aucun statut non-401 n'a appelé onExpired");

    // 401 déclenche UNE fois malgré la rafale (idempotence).
    ck.eq(SessionExpiry.report(401), true, "1er 401 → true (déclenche l'action)");
    ck.eq(SessionExpiry.report(401), false, "2e 401 en rafale → false");
    ck.eq(SessionExpiry.report(401), false, "3e 401 en rafale → false");
    ck.eq(calls, 1, "onExpired appelé EXACTEMENT une fois pour la rafale");

    // reset() ré-arme : un nouveau 401 re-déclenche (une expiration ultérieure doit ramener au login).
    SessionExpiry.reset();
    ck.eq(SessionExpiry.report(401), true, "après reset : un nouveau 401 re-déclenche");
    ck.eq(calls, 2, "reset ré-arme → onExpired rappelé");
  });
};

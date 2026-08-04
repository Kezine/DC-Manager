/* Tests modules — CYCLE DE VIE matériel (core/LifecycleFormat) : ÂGE depuis la date
   d'achat + ÉTAT de garantie depuis la date de fin. Module PUR, `now` INJECTÉ →
   déterministe. On éprouve la décomposition calendaire (bissextiles, fins de mois),
   la granularité adaptative à ses BORNES, la frontière exacte des 90 jours et la
   borne « expire aujourd'hui ». Les libellés composés (I18n, locale fr du harnais)
   sont vérifiés VERBATIM. Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  const { LifecycleFormat } = D("core/LifecycleFormat.js");
  // Dates ISO COURTES (« YYYY-MM-DD ») → `Date` UTC minuit, comme les champs du modèle.
  const day = (iso) => new Date(iso + "T00:00:00Z");

  await section("Lifecycle : breakdown — décomposition calendaire (bissextiles, fins de mois)", async () => {
    const bd = (a, b) => LifecycleFormat.breakdown(day(a), day(b));
    ck.eq(JSON.stringify(bd("2023-05-10", "2026-07-10")), JSON.stringify({ years: 3, months: 2, days: 0 }), "breakdown : 3 ans 2 mois pile");
    ck.eq(JSON.stringify(bd("2023-05-10", "2026-05-10")), JSON.stringify({ years: 3, months: 0, days: 0 }), "breakdown : 3 ans pile (0 mois)");
    ck.eq(JSON.stringify(bd("2026-06-28", "2026-07-10")), JSON.stringify({ years: 0, months: 0, days: 12 }), "breakdown : 12 jours (emprunt sur juin = 30 j)");
    // Bissextile : 29 fév → 29 fév quatre ans plus tard = exactement 4 ans.
    ck.eq(JSON.stringify(bd("2024-02-29", "2028-02-29")), JSON.stringify({ years: 4, months: 0, days: 0 }), "breakdown : 4 ans pile (bissextile → bissextile)");
    // Fin de mois : 31 jan → 28 fév (même année) → emprunt sur janvier (31 j) → 28 jours.
    ck.eq(JSON.stringify(bd("2024-01-31", "2024-02-28")), JSON.stringify({ years: 0, months: 0, days: 28 }), "breakdown : 31 jan → 28 fév = 28 jours");
    // Garde-fous : `to` ≤ `from` → durée nulle (jamais de négatif).
    ck.eq(JSON.stringify(bd("2026-07-10", "2026-07-10")), JSON.stringify({ years: 0, months: 0, days: 0 }), "breakdown : même jour → nul");
    ck.eq(JSON.stringify(bd("2026-07-10", "2026-01-01")), JSON.stringify({ years: 0, months: 0, days: 0 }), "breakdown : to < from → nul (pas de composante négative)");
  });

  await section("Lifecycle : age — granularité adaptative à ses BORNES, futur/vide → null", async () => {
    const age = (a, b) => LifecycleFormat.age(a, day(b));
    ck.eq(age("2023-05-10", "2026-07-10"), "3 ans 2 mois", "age : ≥ 1 an → « X ans Y mois »");
    ck.eq(age("2023-05-10", "2026-05-10"), "3 ans", "age : mois à 0 omis → « 3 ans »");
    ck.eq(age("2025-11-10", "2026-07-10"), "8 mois", "age : < 1 an → « 8 mois »");
    ck.eq(age("2026-06-28", "2026-07-10"), "12 jours", "age : < 1 mois → « 12 jours »");
    // Bornes de granularité demandées : 364 j / 366 j / 29 j / 31 j.
    ck.eq(age("2025-01-01", "2025-12-31"), "11 mois", "age : 364 j (< 1 an) → « 11 mois »");
    ck.eq(age("2024-01-01", "2025-01-01"), "1 an", "age : 366 j (bissextile) → « 1 an »");
    ck.eq(age("2025-03-01", "2025-03-30"), "29 jours", "age : 29 j (< 1 mois) → « 29 jours »");
    ck.eq(age("2025-03-01", "2025-04-01"), "1 mois", "age : 31 j (bascule mois) → « 1 mois »");
    ck.eq(age("2024-02-29", "2028-02-29"), "4 ans", "age : bissextile → « 4 ans »");
    // Achat DU JOUR : 0 jour affiché (décision assumée — l'âge zéro reste une info).
    ck.eq(age("2026-08-04", "2026-08-04"), "0 jour", "age : achat du jour → « 0 jour » (singulier fr)");
    // Achat FUTUR / vide / illisible → null (jamais d'âge négatif).
    ck.eq(age("2027-01-01", "2026-08-04"), null, "age : achat futur → null");
    ck.eq(age("", "2026-08-04"), null, "age : vide → null");
    ck.eq(age("pas-une-date", "2026-08-04"), null, "age : illisible → null");
    ck.eq(LifecycleFormat.age("2023-05-10", new Date("nawak")), null, "age : now invalide → null");
  });

  await section("Lifecycle : warranty — statut ok/warn/err, frontière 90 j, « expire aujourd'hui »", async () => {
    const NOW = day("2026-08-04");
    const w = (iso) => LifecycleFormat.warranty(iso, NOW);
    // Décalage en jours depuis NOW, en date ISO courte.
    const isoIn = (days) => new Date(NOW.getTime() + days * 86400000).toISOString().slice(0, 10);

    // Expirée (jours < 0) → err + « expirée depuis X ».
    const err = w("2026-01-01");
    ck.eq(err && err.status, "err", "warranty : échéance passée → err");
    ck.eq(err && err.label, "expirée depuis 7 mois", "warranty : err → « expirée depuis 7 mois »");

    // Frontière EXACTE des 90 jours : 90 → warn, 91 → ok.
    ck.eq(w(isoIn(90)).status, "warn", "warranty : 90 j pile → warn (inclusif)");
    ck.eq(w(isoIn(91)).status, "ok", "warranty : 91 j → ok");
    ck.eq(w(isoIn(200)).status, "ok", "warranty : bien au-delà → ok");

    // « expire dans X » (warn et ok partagent la formulation).
    ck.eq(w("2026-09-01").status, "warn", "warranty : ~28 j → warn");
    ck.eq(w("2026-09-01").label, "expire dans 28 jours", "warranty : warn → « expire dans 28 jours »");
    ck.eq(w("2027-01-01").label, "expire dans 4 mois", "warranty : ok → « expire dans 4 mois »");

    // Borne « expire aujourd'hui » (J-0) : encore warn, PAS err — libellé dédié.
    const today = w(isoIn(0));
    ck.eq(today.status, "warn", "warranty : J-0 (aujourd'hui) → warn (pas err)");
    ck.eq(today.label, "expire aujourd'hui", "warranty : J-0 → « expire aujourd'hui »");
    // Veille de l'échéance-frontière : J+1 reste warn.
    ck.eq(w(isoIn(1)).status, "warn", "warranty : J+1 → warn");
    // J-1 (hier) : premier jour STRICTEMENT dépassé → err.
    ck.eq(w(isoIn(-1)).status, "err", "warranty : J-1 (hier) → err");

    // Vide / illisible / now invalide → null.
    ck.eq(w(""), null, "warranty : vide → null");
    ck.eq(w("pas-une-date"), null, "warranty : illisible → null");
    ck.eq(LifecycleFormat.warranty("2027-01-01", new Date("nawak")), null, "warranty : now invalide → null");
  });

  await section("Lifecycle : daysUntil — jours entiers signés, null si invalide", async () => {
    const NOW = day("2026-08-04");
    ck.eq(LifecycleFormat.daysUntil("2026-08-04", NOW), 0, "daysUntil : aujourd'hui → 0");
    ck.eq(LifecycleFormat.daysUntil("2026-08-14", NOW), 10, "daysUntil : dans 10 jours → 10");
    ck.eq(LifecycleFormat.daysUntil("2026-08-01", NOW), -3, "daysUntil : il y a 3 jours → -3");
    ck.eq(LifecycleFormat.daysUntil("", NOW), null, "daysUntil : vide → null");
    ck.eq(LifecycleFormat.daysUntil("pas-une-date", NOW), null, "daysUntil : illisible → null");
  });
};

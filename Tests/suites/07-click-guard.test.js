/* ============================================================================
   Suite 07 — Garde « glissé vs clic » (clickGuardBlocks).
   ----------------------------------------------------------------------------
   Caractérise le cœur PUR extrait lors de la factorisation des 14 gardes inline
   (mousedown + hypot > 4) en `_clickGuard` (v162, §4.1 dedup transverse).
   `clickGuardBlocks(dn, x, y, thresh, reservePan)` → true si le clic doit être
   ANNULÉ (= glissé, ou pan réservé non armé). Deux variantes historiques :
     - normale      : un clic SANS mousedown préalable (dn=null) PASSE  → `dn && …`
     - reservePan   : un clic SANS mousedown armé (dn=null) est BLOQUÉ  → `!dn || …`
   ========================================================================== */
"use strict";
module.exports = {
  name: "Garde glissé/clic (clickGuardBlocks)",
  run: async (NM, ck) => {
    const g = NM.clickGuardBlocks;
    ck(typeof g === "function", "clickGuardBlocks exposée");
    if (typeof g !== "function") return;

    const TH = 4;

    /* --- variante NORMALE (reservePan = false) --- */
    // pointeur immobile depuis le mousedown → vrai clic → NE bloque PAS
    ck.eq(g([100, 100], 100, 100, TH, false), false, "normale : immobile → passe");
    // petit déplacement sous le seuil (3 px) → vrai clic → passe
    ck.eq(g([100, 100], 102, 102, TH, false), false, "normale : <4px (≈2.83) → passe");
    // déplacement au-delà du seuil → glissé → BLOQUE
    ck.eq(g([100, 100], 110, 100, TH, false), true, "normale : >4px → bloque (glissé)");
    // exactement le seuil (4 px) n'est PAS strictement supérieur → passe
    ck.eq(g([100, 100], 104, 100, TH, false), false, "normale : ==4px → passe (seuil strict)");
    // pas de mousedown enregistré (dn=null) → en mode normal, le clic PASSE
    ck.eq(g(null, 100, 100, TH, false), false, "normale : dn=null → passe");

    /* --- variante reservePan = true (faces de scène : sol, baie) --- */
    // mousedown armé + immobile → vrai clic → passe
    ck.eq(g([100, 100], 100, 100, TH, true), false, "reservePan : armé + immobile → passe");
    // mousedown armé + glissé → BLOQUE
    ck.eq(g([100, 100], 110, 100, TH, true), true, "reservePan : armé + glissé → bloque");
    // mousedown NON armé (Maj/clic-droit → dn=null) → clic BLOQUÉ (réservé au pan)
    ck.eq(g(null, 100, 100, TH, true), true, "reservePan : dn=null (pan) → bloque");

    /* --- distance euclidienne, pas Manhattan : (3,3) = 4.24 px > 4 → bloque --- */
    ck.eq(g([0, 0], 3, 3, TH, false), true, "normale : (3,3)=4.24px → bloque");
    ck.eq(g([0, 0], 2, 2, TH, false), false, "normale : (2,2)=2.83px → passe");
  }
};

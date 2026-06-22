/* ============================================================================
   Suite 10 — Helpers purs de la couche de données (uniqIds, makeLabeler).
   ----------------------------------------------------------------------------
   Caractérise les 2 helpers extraits (v166, §4.2 dedup intra-région) :
     - `uniqIds(arr)` : dédoublonne un tableau d'ids EN PRÉSERVANT l'ordre de
       première apparition (idiome `filter((id,i)=>arr.indexOf(id)===i)` ×3).
     - `makeLabeler(list, fallback)` : fabrique un résolveur de libellé sur un
       catalogue [{id,label}] (idiome `LIST.find(...).label` ×5) ; `fallback` =
       valeur ou fonction (v)=>string, défaut "".
   On vérifie aussi 3 libellés réels reconstruits via makeLabeler (depthLabel,
   portRoleLabel, faceLabel) pour garantir l'équivalence après refactor.
   ========================================================================== */
"use strict";
module.exports = {
  name: "Helpers données (uniqIds / makeLabeler)",
  run: async (NM, ck) => {
    const { uniqIds, makeLabeler } = NM;
    ck(typeof uniqIds === "function", "uniqIds exposée");
    ck(typeof makeLabeler === "function", "makeLabeler exposée");

    /* --- uniqIds : ordre de première apparition préservé --- */
    if (typeof uniqIds === "function") {
      ck.eq(JSON.stringify(uniqIds(["a", "b", "a", "c", "b"])), JSON.stringify(["a", "b", "c"]), "uniqIds : dédoublonne, garde le 1er");
      ck.eq(JSON.stringify(uniqIds([])), JSON.stringify([]), "uniqIds : tableau vide");
      ck.eq(JSON.stringify(uniqIds(["x", "x", "x"])), JSON.stringify(["x"]), "uniqIds : tous identiques → 1");
      ck.eq(JSON.stringify(uniqIds(["c", "a", "b"])), JSON.stringify(["c", "a", "b"]), "uniqIds : déjà unique → inchangé (ordre)");
    }

    /* --- makeLabeler : résolution + variantes de fallback --- */
    if (typeof makeLabeler === "function") {
      const list = [{ id: "a", label: "Alpha" }, { id: "b", label: "Bravo" }];
      const lblDefault = makeLabeler(list);                       // fallback défaut ""
      const lblConst = makeLabeler(list, "—");                    // fallback valeur
      const lblFn = makeLabeler(list, (v) => v || "?");           // fallback fonction
      ck.eq(lblDefault("a"), "Alpha", "makeLabeler : trouve le label (a→Alpha)");
      ck.eq(lblDefault("b"), "Bravo", "makeLabeler : trouve le label (b→Bravo)");
      ck.eq(lblDefault("zzz"), "", "makeLabeler : absent + fallback défaut → \"\"");
      ck.eq(lblConst("zzz"), "—", "makeLabeler : absent + fallback valeur → \"—\"");
      ck.eq(lblFn("zzz"), "zzz", "makeLabeler : absent + fallback fonction → f(v)");
      ck.eq(lblFn(""), "?", "makeLabeler : fallback fonction sur valeur vide");
    }

    /* --- équivalence des libellés réels reconstruits via makeLabeler --- */
    if (typeof NM.depthLabel === "function") {
      ck.eq(NM.depthLabel("none"), "No-depth", "depthLabel(none) → No-depth (fallback fn conservé)");
      ck.eq(NM.depthLabel("__inconnu__"), "__inconnu__", "depthLabel(inconnu) → renvoie l'entrée (fallback fn)");
    }
    if (typeof NM.portRoleLabel === "function") {
      ck.eq(NM.portRoleLabel("__inconnu__"), "__inconnu__", "portRoleLabel(inconnu) → id (fallback id||—)");
      ck.eq(NM.portRoleLabel(""), "—", "portRoleLabel(vide) → — (fallback id||—)");
    }
    if (typeof NM.faceLabel === "function") {
      ck.eq(NM.faceLabel("__inconnu__"), "Avant", "faceLabel(inconnu) → Avant (fallback constant)");
    }
  }
};

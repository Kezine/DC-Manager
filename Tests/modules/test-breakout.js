/* Tests modules — BREAKOUT (docs/breakout.md, retours terrain T2-B2/B3).
   Ici : la règle PURE `core/BreakoutRules` (verdicts d'ÉCLATEMENT et de DÉFAIRE en CODES, schéma de nommage des
   lanes, structure trunk → lanes), sa consommation avec l'ÉTAT relu au Store (`cableOnPort`), et — par lecture des
   SOURCES, patron du verrou T2-B1 de test-views-tools.js — le fait que le formulaire d'équipement l'emprunte bien :
   le menu ⋮ passe par `canSplit`/`canUnsplit`, le nommage par `laneNames`, l'ancien « × » qui détruisait trunk ET
   lanes sans garde a disparu, les sélecteurs de types sont À RECHERCHE, et le style inline des lanes a cédé la place
   à des classes thématisées sans couleur en dur. Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, makeStore } = require("./harness.js");

module.exports = async () => {
  const { BreakoutRules } = D("core/BreakoutRules.js");
  const fs = require("fs");
  const src = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", "src-client", ...p), "utf8");

  await section("BreakoutRules.canSplit : verdicts en CODES, du STRUCTUREL au CIRCONSTANCIEL", async () => {
    const base = { kind: "data", isLane: false, isTrunk: false, hasCable: false };
    ck.eq(BreakoutRules.canSplit(base), "ok", "port de données, ni lane ni trunk, sans câble → ok");
    ck.eq(BreakoutRules.canSplit(Object.assign({}, base, { kind: "power" })), "not-data", "port d'énergie → not-data (un breakout est une affaire de données)");
    ck.eq(BreakoutRules.canSplit(Object.assign({}, base, { kind: null })), "not-data", "genre inconnu → not-data (on ne déduit rien d'une absence)");
    ck.eq(BreakoutRules.canSplit(Object.assign({}, base, { isLane: true })), "is-lane", "une lane → is-lane (pas de breakout imbriqué par l'UI)");
    ck.eq(BreakoutRules.canSplit(Object.assign({}, base, { isTrunk: true })), "is-trunk", "déjà un trunk → is-trunk");
    ck.eq(BreakoutRules.canSplit(Object.assign({}, base, { hasCable: true })), "cabled", "port câblé → cabled (un trunk est incâblable : décâbler d'abord)");
    // ORDRE des verdicts : ce qui ne changera pas AVANT ce qui pourrait changer.
    ck.eq(BreakoutRules.canSplit({ kind: "data", isLane: true, isTrunk: true, hasCable: true }), "is-lane", "🚨 priorité lane > trunk > genre > câble — une lane câblée est d'abord une lane");
    ck.eq(BreakoutRules.canSplit({ kind: "power", isLane: false, isTrunk: true, hasCable: true }), "is-trunk", "…trunk avant genre");
    ck.eq(BreakoutRules.canSplit({ kind: "power", isLane: false, isTrunk: false, hasCable: true }), "not-data", "…genre avant câble");
  });

  await section("BreakoutRules.canUnsplit : accepté, ou refusé EN NOMMANT les lanes câblées", async () => {
    ck.eq(BreakoutRules.canUnsplit([]).ok, true, "aucune lane → accepté (rien à perdre)");
    ck.eq(BreakoutRules.canUnsplit([{ id: "a", name: "Q/1", hasCable: false }, { id: "b", name: "Q/2", hasCable: false }]).ok, true, "lanes sans câble → accepté");
    const refus = BreakoutRules.canUnsplit([{ id: "a", name: "Q/1", hasCable: true }, { id: "b", name: "Q/2", hasCable: false }, { id: "c", name: "Q/3", hasCable: true }]);
    ck.eq(refus.ok, false, "une lane câblée suffit à refuser");
    ck.eq(refus.cabledLanes.map((l) => l.id).join(","), "a,c", "🚨 le refus NOMME les lanes câblées — toutes, dans l'ordre reçu");
    ck.eq(refus.cabledLanes.map((l) => l.name).join(","), "Q/1,Q/3", "…par leur nom (c'est ce que l'utilisateur lit dans l'infobulle)");
    ck.eq(Object.keys(refus.cabledLanes[0]).sort().join(","), "id,name", "…et rien d'autre (l'état, déjà connu, ne se répète pas)");
  });

  await section("BreakoutRules.laneNames : SEULE source du schéma « trunk/1 … trunk/N »", async () => {
    ck.eq(BreakoutRules.laneNames("QSFP1", 4).join(","), "QSFP1/1,QSFP1/2,QSFP1/3,QSFP1/4", "4 lanes numérotées à partir de 1");
    ck.eq(BreakoutRules.laneNames("  Eth1/49 ", 2).join(","), "Eth1/49/1,Eth1/49/2", "nom trimé ; un nom qui contient déjà le séparateur est simplement prolongé");
    ck.eq(BreakoutRules.laneNames("Q", 0).length, 0, "0 lane → liste vide");
    ck.eq(BreakoutRules.laneNames("Q", -3).length, 0, "compte négatif → liste vide");
    ck.eq(BreakoutRules.laneNames("Q", 2.9).length, 2, "compte non entier → plancher");
    ck.eq(BreakoutRules.laneNames("Q", NaN).length, 0, "NaN → liste vide");
    ck.eq(BreakoutRules.laneNames("", 1).join(","), "/1", "nom VIDE → « /1 » : le module n'invente pas de nom, c'est au dialogue d'en exiger un");
    ck.eq(BreakoutRules.LANE_SEPARATOR, "/", "le séparateur est exposé par son nom (pas un littéral recopié)");
  });

  await section("BreakoutRules.groupByTrunk / orderWithLanes : lanes SOUS leur trunk, triées, orphelines jamais perdues", async () => {
    const ports = [
      { id: "n1", parent_port_id: null, lane: null },
      { id: "l3", parent_port_id: "t", lane: 3 },
      { id: "t", parent_port_id: null, lane: null },
      { id: "l1", parent_port_id: "t", lane: 1 },
      { id: "o", parent_port_id: "absent", lane: 2 },   // orpheline : parent hors liste
      { id: "l2", parent_port_id: "t", lane: 2 },
      { id: "n2", parent_port_id: null, lane: null },
    ];
    const groups = BreakoutRules.groupByTrunk(ports);
    ck.eq(groups.map((g) => g.port.id).join(","), "n1,t,n2,o", "racines dans l'ordre d'entrée, l'orpheline en FIN");
    ck.eq(groups[1].lanes.map((l) => l.id).join(","), "l1,l2,l3", "🚨 lanes du trunk TRIÉES par n° de lane, pas par ordre de saisie");
    ck.eq(groups[0].lanes.length + groups[2].lanes.length + groups[3].lanes.length, 0, "un port ordinaire (ou une orpheline) n'a pas de lanes");
    ck.eq(BreakoutRules.orderWithLanes(ports).map((p) => p.id).join(","), "n1,t,l1,l2,l3,n2,o", "ordre aplati (fiche) : trunk puis ses lanes, puis la suite");
    ck.eq(BreakoutRules.orderWithLanes(ports).length, ports.length, "aucun port perdu dans l'aplatissement");
    ck.eq(BreakoutRules.groupByTrunk([]).length, 0, "liste vide → aucun groupe");
  });

  await section("Breakout sur le Store : l'ÉTAT « porte un câble » est relu par cableOnPort et transmis en booléen", async () => {
    const s = await makeStore();
    const eq = await s.create("equipments", { name: "SW-1" });
    const peer = await s.create("equipments", { name: "SRV-1" });
    const far1 = await s.create("ports", { equipment_id: peer.id, name: "eth0" });
    const far2 = await s.create("ports", { equipment_id: peer.id, name: "eth1" });
    const trunk = await s.create("ports", { equipment_id: eq.id, name: "QSFP1" });
    const lanes = {};
    for (const n of [3, 1, 4, 2]) lanes[n] = await s.create("ports", { equipment_id: eq.id, name: "QSFP1/" + n, parent_port_id: trunk.id, lane: n });
    const plain = await s.create("ports", { equipment_id: eq.id, name: "Gi1/0/1" });
    // Les DEUX entrées de la règle telles que le formulaire les construit (mêmes expressions).
    const laneState = () => s.breakoutLanes(trunk.id).map((l) => ({ id: l.id, name: l.name, hasCable: !!s.cableOnPort(l.id) }));
    const splitInput = (p) => ({ kind: "data", isLane: !!p.parent_port_id, isTrunk: s.isBreakoutParent(p), hasCable: !!s.cableOnPort(p.id) });

    ck.eq(s.cableOnPort("jamais-enregistre"), null, "un port BROUILLON jamais enregistré n'a pas de câble (le formulaire n'a rien de spécial à faire)");
    ck.eq(BreakoutRules.canUnsplit(laneState()).ok, true, "aucune lane câblée → défaire accepté");
    ck.eq(BreakoutRules.canSplit(splitInput(plain)), "ok", "port ordinaire sans câble → éclater accepté");
    ck.eq(BreakoutRules.canSplit(splitInput(trunk)), "is-trunk", "le trunk (reconnu par le Store) → is-trunk");
    ck.eq(BreakoutRules.canSplit(splitInput(lanes[1])), "is-lane", "une lane → is-lane");

    const cable = await s.create("cables", { from_port_id: lanes[1].id, to_port_id: far1.id });
    ck(!!cable, "un câble est posé sur la lane 1");
    const refus = BreakoutRules.canUnsplit(laneState());
    ck.eq(refus.ok, false, "🚨 une lane câblée → défaire REFUSÉ");
    ck.eq(refus.cabledLanes.map((l) => l.name).join(","), "QSFP1/1", "…en nommant la lane câblée");
    const cablePlain = await s.create("cables", { from_port_id: plain.id, to_port_id: far2.id });
    ck(!!cablePlain, "un câble est posé sur le port ordinaire");
    ck.eq(BreakoutRules.canSplit(splitInput(plain)), "cabled", "🚨 port câblé → éclater REFUSÉ (symétrique du refus de défaire)");
    await s.remove("cables", cable.id);
    ck.eq(BreakoutRules.canUnsplit(laneState()).ok, true, "câble retiré → défaire accepté de nouveau");

    // Ordre de la FICHE : trunk puis lanes 1..4, quel que soit l'ordre de création (3, 1, 4, 2 ici).
    const names = BreakoutRules.orderWithLanes(s.portsOf(eq.id)).map((p) => p.name);
    const at = names.indexOf("QSFP1");
    ck(at >= 0, "le trunk est dans la liste ordonnée");
    ck.eq(names.slice(at, at + 5).join(","), "QSFP1,QSFP1/1,QSFP1/2,QSFP1/3,QSFP1/4", "🚨 fiche : les lanes suivent IMMÉDIATEMENT leur trunk, triées par n°");
    ck.eq(names.length, s.portsOf(eq.id).length, "…sans perdre le port ordinaire");
  });

  /* ============================================================================================
     🚨 VERROU sur les SOURCES (patron T2-B1) : la règle ne sert à rien si le formulaire ne l'emprunte
     pas. On relit `EquipmentForms.ts`, `FormBase.ts` et la CSS — jamais le compilé.
     ⚠ `\r?\n` dans les motifs multi-lignes : le dépôt est en LF, la copie Windows en CRLF.
     ============================================================================================ */
  await section("🚨 VERROU sources : le formulaire emprunte la règle, l'ancien « × » a disparu, sélecteurs à recherche, CSS thématisée", async () => {
    const forms = src("views", "forms", "EquipmentForms.ts");
    ck(/BreakoutRules\.canSplit\(/.test(forms), "EquipmentForms appelle BreakoutRules.canSplit (item « Éclater… » du menu ⋮)");
    ck(/BreakoutRules\.canUnsplit\(/.test(forms), "…et BreakoutRules.canUnsplit (item « Défaire le breakout »)");
    ck((forms.match(/BreakoutRules\.laneNames\(/g) || []).length >= 2, "🚨 le nommage des lanes passe par laneNames sur les DEUX chemins (trunk neuf, port éclaté)");
    ck(!/\.name\s*\+\s*"\/"\s*\+/.test(forms), "…et plus aucun `nom + \"/\" + i` recopié");
    ck(/BreakoutRules\.groupByTrunk\(draftPorts\)/.test(forms), "le rendu des ports du formulaire suit la structure trunk → lanes de la règle");
    ck(/BreakoutRules\.orderWithLanes\(ports\)/.test(forms), "la fiche range les lanes sous leur trunk par la MÊME règle");
    ck(/RowMenu\.open\(/.test(forms), "les actions de breakout vivent dans un menu ⋮ (ui/RowMenu), pas dans des boutons ad hoc");
    ck(/hasCable: !!store\.cableOnPort\(/.test(forms), "l'état « porte un câble » est relu au Store, en booléen");
    ck(/mode: "split"/.test(forms), "éclater un port existant ouvre le dialogue en mode `split`");
    // L'ancien bouton : un « × » titré `removeBreakout` sur la ligne du trunk (le « × » des agrégats, lui, reste).
    ck(!/textContent = "×"[^\n]*removeBreakout|removeBreakout[^\n]*textContent = "×"/.test(forms), "🚨 l'ancien « × » (titré removeBreakout) qui détruisait trunk ET lanes sans garde a disparu");
    ck(/label: I18n\.t\("equipment\.equip\.removeBreakout"\)[^\n]*danger: true/.test(forms), "…la suppression du trunk et de ses lanes est un item de menu EXPLICITE, marqué danger");
    ck(!/lockedRow/.test(forms), "…avec la ligne verrouillée qu'il habitait");
    ck(!/margin-left:18px;border-left/.test(forms), "🚨 plus de style inline sur les lanes : le retrait vient de la CSS");
    ck(/className = "port-breakout"/.test(forms) && /className = "port-breakout-lane"/.test(forms), "le groupe et ses lanes portent les classes thématisées");
    ck(/"port-trunk"/.test(forms) && /"port-lane"/.test(forms), "les lignes de la fiche portent `port-trunk` / `port-lane`");

    const formBase = src("views", "forms", "FormBase.ts");
    const dialog = /protected static configureBreakout\(([\s\S]*?)\r?\n  \}\r?\n/.exec(formBase);
    ck(!!dialog, "FormBase.configureBreakout est bien lu");
    ck((dialog[1].match(/FormControls\.entityPicker\(typeOpts/g) || []).length === 2, "🚨 les DEUX sélecteurs de types sont À RECHERCHE (principe n°14)");
    ck(!/FormControls\.select\(typeOpts/.test(dialog[1]), "…et plus aucun <select> brut de types");
    ck(/mode === "split"/.test(dialog[1]), "le dialogue connaît le mode `split` (port existant → trunk, nom et type figés)");
    ck(/errSplitName/.test(dialog[1]), "…et exige un nom de trunk aussi en mode `split` (racine du nom des lanes)");

    const css = fs.readFileSync(path.join(__dirname, "..", "..", "src-client", "styles", "dc-manager.css"), "utf8");
    const block = /\.port-breakout \{[\s\S]*?tr\.port-lane[^\n]*\n/.exec(css);
    ck(!!block, "la CSS porte le bloc breakout (groupe du formulaire → lignes de la fiche)");
    ck(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/.test(block[0]), "🚨 aucune couleur en dur dans le bloc : tokens seulement (le thème clair suit de lui-même)");
    ck(/var\(--lift\)/.test(block[0]), "le relief du groupe vient du token d'élévation partagé");
    ck(!/\.port-locked/.test(css), "la classe `.port-locked` de l'ancienne ligne verrouillée n'existe plus");
  });
};

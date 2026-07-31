/* Tests modules — PILE DE MODALES : `core/ModalStack`, la politique d'empilement SANS DOM
   (push/pop, « au plus UNE édition vivante » D9b, cible d'une fermeture totale D9a).
   `ui/Modal` n'est pas testable headless (il construit sa DOM au constructeur) : tout ce qui se
   VÉRIFIE de la pile vit donc ici, et rien d'autre. Harnais et assertions : harness.js. */
"use strict";
const { ck, section, ModalStack } = require("./harness.js");

/** Entrée minimale : la pile n'exige que la NATURE et le LIBELLÉ (le reste est l'affaire de Modal). */
const entry = (kind, title) => ({ kind, title });
/** Entrée MUNIE d'une clé d'identité (D5) — ce que fournit une FICHE (jamais un formulaire). */
const keyed = (kind, title, stackKey) => ({ kind, title, stackKey });

module.exports = async () => {
  await section("ModalStack : pile vide, push/pop, sommet et profondeur", async () => {
    const pile = new ModalStack();
    ck.eq(pile.depth(), 0, "pile NEUVE : profondeur 0");
    ck.eq(pile.top(), null, "pile vide : aucun sommet");
    ck.eq(pile.pop(), null, "dépiler une pile vide rend null (et ne lève pas)");
    ck.eq(pile.editionAlive(), null, "pile vide : aucune édition vivante");
    ck.eq(pile.at(0), null, "pile vide : `at` hors bornes rend null");

    pile.push(entry("info", "Équipement — sw-01"));
    ck.eq(pile.depth(), 1, "un push → profondeur 1");
    ck.eq(pile.top().title, "Équipement — sw-01", "le SOMMET est le dernier poussé (c'est lui qui est affiché)");
    pile.push(entry("info", "Baie — R12"));
    ck.eq(pile.depth(), 2, "deux niveaux");
    ck.eq(pile.top().title, "Baie — R12", "le nouveau push devient le sommet");
    ck.eq(pile.at(0).title, "Équipement — sw-01", "`at(0)` = le BAS de la pile (le 1er ouvert)");
    ck.eq(pile.at(1).title, "Baie — R12", "`at(depth-1)` = le sommet");
    ck.eq(pile.at(2), null, "`at` au-delà du sommet rend null");

    ck.eq(pile.pop().title, "Baie — R12", "pop rend le SOMMET");
    ck.eq(pile.depth(), 1, "…et la profondeur décroît");
    ck.eq(pile.top().title, "Équipement — sw-01", "le niveau du dessous redevient le sommet");
    ck.eq(pile.pop().title, "Équipement — sw-01", "pop du dernier niveau");
    ck.eq(pile.depth(), 0, "pile de nouveau vide → la modale se ferme pour de bon");
  });

  await section("ModalStack : `clear` vide la pile DU SOMMET VERS LE BAS", async () => {
    const pile = new ModalStack();
    pile.push(entry("info", "A")); pile.push(entry("info", "B")); pile.push(entry("info", "C"));
    const retires = pile.clear();
    ck.eq(retires.map((e) => e.title).join(","), "C,B,A", "l'ordre rendu est celui de la DESTRUCTION : on démonte ce qu'on voit avant ce qui est dessous");
    ck.eq(pile.depth(), 0, "après clear, la pile est vide");
    ck.eq(pile.clear().length, 0, "clear sur une pile vide ne rend rien (et ne lève pas)");
  });

  await section("ModalStack : `editionAlive` repère l'édition à N'IMPORTE QUEL niveau", async () => {
    const pile = new ModalStack();
    pile.push(entry("info", "Fiche"));
    ck.eq(pile.editionAlive(), null, "que des fiches → aucune édition vivante");
    pile.push(entry("edit", "Modifier l'équipement"));
    ck.eq(pile.editionAlive().title, "Modifier l'équipement", "édition AU SOMMET : repérée");
    pile.push(entry("info", "Fiche liée"));
    ck.eq(pile.editionAlive().title, "Modifier l'équipement", "édition ENFOUIE sous une fiche : repérée quand même — c'est tout l'intérêt");
    pile.pop(); pile.pop();
    ck.eq(pile.editionAlive(), null, "l'édition dépilée n'est plus vivante");
  });

  await section("ModalStack : D9b — au plus UNE édition vivante par pile", async () => {
    const pile = new ModalStack();
    ck.eq(pile.pushAllowed("edit").ok, true, "pile VIDE : une édition est toujours permise (le refus ne vaut que pour un PUSH)");
    ck.eq(pile.pushAllowed("info").ok, true, "pile vide : une fiche aussi, évidemment");

    pile.push(entry("info", "Intervention #42"));
    ck.eq(pile.pushAllowed("edit").ok, true, "édition AU-DESSUS DE FICHES : autorisée (flux courant fiche → « Modifier »)");
    ck.eq(pile.pushAllowed("info").ok, true, "fiche au-dessus de fiches : autorisée");

    pile.push(entry("edit", "Équipement — sw-01"));
    const refus = pile.pushAllowed("edit");
    ck.eq(refus.ok, false, "édition SUR édition : REFUSÉE (le sommet est une édition)");
    ck.eq(refus.editingTitle, "Équipement — sw-01", "le refus NOMME l'édition qui bloque — sans ce libellé le toast serait creux");
    ck.eq(pile.pushAllowed("info").ok, true, "une FICHE reste poussable au-dessus d'une édition (consultation en cours de saisie)");

    pile.push(entry("info", "Fiche cible"));
    const refusEnfoui = pile.pushAllowed("edit");
    ck.eq(refusEnfoui.ok, false, "édition sur une édition ENFOUIE : refusée aussi (la règle regarde toute la pile, pas le sommet)");
    ck.eq(refusEnfoui.editingTitle, "Équipement — sw-01", "…et nomme toujours la bonne édition");

    ck.eq(pile.depth(), 3, "`pushAllowed` est un PRÉDICAT : il ne modifie jamais la pile");
  });

  await section("ModalStack : D9a — cible d'une fermeture totale (✕ / Échap / clic hors modale)", async () => {
    // --- que des fiches : rien à protéger, on ferme tout
    const fiches = new ModalStack();
    fiches.push(entry("info", "A")); fiches.push(entry("info", "B"));
    ck.eq(fiches.closeAllTarget().action, "closeAll", "que des fiches → fermeture TOTALE (rien à perdre)");

    // --- pile vide : la fermeture n'a rien à faire, mais elle doit répondre « closeAll » (pas planter)
    ck.eq(new ModalStack().closeAllTarget().action, "closeAll", "pile vide → closeAll (chemin dégénéré, sans effet)");

    // --- édition AU SOMMET : l'utilisateur la VOIT, la garde ne s'applique pas
    const auSommet = new ModalStack();
    auSommet.push(entry("info", "Fiche")); auSommet.push(entry("edit", "Modifier"));
    ck.eq(auSommet.closeAllTarget().action, "closeAll", "édition AU SOMMET → closeAll : l'utilisateur voit ce qu'il ferme (le garde-fou « modifié » du niveau suffit)");

    // --- édition ENFOUIE : c'est LE cas que la garde protège
    const enfouie = new ModalStack();
    enfouie.push(entry("info", "Intervention #42"));
    enfouie.push(entry("edit", "Équipement — sw-01"));
    enfouie.push(entry("info", "Fiche cible"));
    enfouie.push(entry("info", "Fiche liée"));
    const cible = enfouie.closeAllTarget();
    ck.eq(cible.action, "popTo", "édition SOUS le sommet → on DÉPILE jusqu'à elle au lieu de tout détruire");
    ck.eq(cible.index, 1, "l'index visé est celui de l'ÉDITION dans la pile (les 2 fiches au-dessus tombent)");
    ck.eq(cible.editingTitle, "Équipement — sw-01", "le toast « Vous éditez … » nomme l'édition rendue à l'écran");
    ck.eq(enfouie.depth(), 4, "`closeAllTarget` est un PRÉDICAT : il ne dépile rien lui-même");

    // --- une seule fiche AU-DESSUS suffit à déclencher la garde (le cas le plus fréquent)
    const uneFiche = new ModalStack();
    uneFiche.push(entry("edit", "Nouveau câble"));
    uneFiche.push(entry("info", "Fiche port"));
    const cible2 = uneFiche.closeAllTarget();
    ck.eq(cible2.action, "popTo", "édition en BAS + une fiche au-dessus → garde");
    ck.eq(cible2.index, 0, "l'édition est le niveau 0 → on dépile jusqu'à lui");

    // --- édition SEULE (profondeur 1) : elle est au sommet, donc closeAll
    const seule = new ModalStack();
    seule.push(entry("edit", "Nouveau site"));
    ck.eq(seule.closeAllTarget().action, "closeAll", "édition SEULE (profondeur 1) → closeAll : « revenir » et « fermer » coïncident");
  });

  await section("ModalStack : D5 — `indexOfKey` (dédup des boucles de navigation)", async () => {
    const pile = new ModalStack();
    // Une entrée SANS clé (un formulaire) ne doit JAMAIS être reconnue — sinon on dédupliquerait
    // une saisie, en l'écrasant.
    pile.push(entry("edit", "Nouvel équipement"));
    ck.eq(pile.indexOfKey("detail:equipments/42"), -1, "entrée sans clé : jamais matchée");
    ck.eq(pile.indexOfKey(""), -1, "une clé vide ne matche pas une entrée sans clé");

    pile.push(keyed("info", "Équipement — sw-01", "detail:equipments/42"));
    pile.push(keyed("info", "Baie — R12", "detail:racks/7"));
    ck.eq(pile.indexOfKey("detail:equipments/42"), 1, "clé PRÉSENTE : rend son index (0 = bas)");
    ck.eq(pile.indexOfKey("detail:racks/7"), 2, "clé du sommet : son index");
    ck.eq(pile.indexOfKey("detail:cables/9"), -1, "clé ABSENTE : -1");
    ck.eq(pile.depth(), 3, "`indexOfKey` est un PRÉDICAT : il ne modifie jamais la pile");

    // Doublon (ne devrait pas arriver, mais la règle est définie) : on rend la PLUS HAUTE, car c'est
    // jusqu'à la visite la plus RÉCENTE qu'une redescente doit s'arrêter.
    const doublon = new ModalStack();
    doublon.push(keyed("info", "A (ancien)", "detail:equipments/42"));
    doublon.push(keyed("info", "Baie", "detail:racks/7"));
    doublon.push(keyed("info", "A (récent)", "detail:equipments/42"));
    ck.eq(doublon.indexOfKey("detail:equipments/42"), 2, "doublon de clé : on rend la PLUS HAUTE (la plus récente)");
  });

  await section("ModalStack : la garde D9a et le refus D9b protègent la MÊME chose", async () => {
    /* Les deux règles sont le recto et le verso d'un seul invariant : une saisie en cours ne doit
       jamais disparaître sans que l'utilisateur l'ait vue. Le vérifier ENSEMBLE évite qu'un futur
       lot n'en assouplisse une en croyant l'autre indépendante. */
    const pile = new ModalStack();
    pile.push(entry("edit", "Modifier la baie"));
    ck.eq(pile.pushAllowed("edit").ok, false, "D9b : pas de 2e édition…");
    pile.push(entry("info", "Fiche équipement"));
    const t = pile.closeAllTarget();
    ck.eq(t.action, "popTo", "D9a : …et la fermeture totale ne peut pas la détruire en silence");
    ck.eq(t.editingTitle, pile.pushAllowed("edit").editingTitle, "les deux règles NOMMENT la même édition — un seul message pour l'utilisateur");
  });
};

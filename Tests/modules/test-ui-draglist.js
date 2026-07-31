/* Tests modules — GLISSER-DÉPOSER DE LISTE (`ui/DragList`, lot L4 de l'éditeur de route).

   La primitive est du DOM (Pointer Events capturés, placeholder) et ne se teste pas ici — SAUF sa
   seule décision GÉOMÉTRIQUE, `slotFor`, statique et pure : l'emplacement de dépôt est le nombre de
   MILIEUX de ligne situés au-dessus du pointeur (milieux des lignes SANS la ligne saisie, donc
   l'emplacement est aussi l'index final de la dépose). C'est elle qui décide où tombe une étape ;
   le reste n'est que de la peinture autour.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");
const { DragList } = D("ui/DragList.js");

module.exports = async () => {

  await section("DragList : emplacement de dépôt (slotFor, pur)", async () => {
    // Trois lignes RESTANTES (la ligne saisie est déjà exclue par l'appelant), milieux à 50/150/250.
    const milieux = [50, 150, 250];
    ck.eq(DragList.slotFor(milieux, 10), 0, "pointeur au-dessus de tout : dépose en tête");
    ck.eq(DragList.slotFor(milieux, 50), 0, "PILE sur un milieu : pas encore franchi (comparaison stricte)");
    ck.eq(DragList.slotFor(milieux, 51), 1, "juste sous le 1er milieu : entre la 1re et la 2e ligne");
    ck.eq(DragList.slotFor(milieux, 200), 2, "entre les 2e et 3e milieux : avant-dernière place");
    ck.eq(DragList.slotFor(milieux, 999), 3, "pointeur sous tout : dépose en fin");
    ck.eq(DragList.slotFor([], 123), 0, "aucune autre ligne : la seule place est 0");
  });
};

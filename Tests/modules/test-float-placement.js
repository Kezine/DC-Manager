/* Tests modules — PLACEMENT DES SURFACES FLOTTANTES ancrées (`core/FloatPlacement`, cadrage C §2.2).

   La règle était recodée QUATRE fois (SearchPop.portalPlace, Autocomplete, RowMenu, RichTooltip.place)
   avec des divergences ; elle vit désormais dans un module PUR (rects/tailles/viewport injectés) et les
   composants ne sont plus que des adaptateurs. On teste ici la règle générique `anchored` sous les
   PARAMÉTRAGES EXACTS des consommateurs (défauts = SearchPop ; seuil+fill+maxHeight = Autocomplete ;
   end+marginV+always = RowMenu) puis la politique `tooltip` (RichTooltip) — dont les cas historiques
   restent AUSSI joués via `RichTooltip.place` dans test-views-tools.js (non-régression de la délégation).

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");
const { FloatPlacement } = D("core/FloatPlacement.js");

module.exports = async () => {

  const rect = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const VP = { width: 1000, height: 800 };

  await section("FloatPlacement.anchored : défauts = paramétrage SearchPop (gap 4, start, marge 8, bascule fits)", async () => {
  {
    // Cas NOMINAL : la place suffit dessous → sous l'ancre, aligné à son bord gauche.
    const p = FloatPlacement.anchored(rect(100, 100, 200, 30), { width: 300, height: 200 }, VP);
    ck.eq(p.top, 134, "dessous : anchor.bottom (130) + gap (4)");
    ck.eq(p.left, 100, "alignement start : bord gauche de l'ancre");
    ck.eq(p.flipped, false, "pas de bascule quand la place suffit dessous");
    ck.eq(p.width, null, "aucune largeur imposée hors alignement fill");
    ck.eq(p.maxHeight, null, "aucun maxHeight sans politique demandée");

    // BASCULE : plus de place dessous, la surface tient ENTIÈRE dessus.
    const flip = FloatPlacement.anchored(rect(100, 650, 200, 30), { width: 300, height: 200 }, VP);
    ck.eq(flip.flipped, true, "bascule : déborde dessous (684+200 > 800) et tient dessus");
    ck.eq(flip.top, 446, "basculée : anchor.top (650) - gap (4) - hauteur (200)");
    // Cohérence des DEUX ancrages d'une surface basculée : poser `bottom` ou poser `top` doit
    // produire le même rectangle (bottom = vp.height - (top + hauteur)).
    ck.eq(flip.bottom, 800 - (flip.top + 200), "ancrage bas ⇄ ancrage haut : même rectangle");

    // PAS de bascule si la surface ne tient pas entière dessus (politique fits) : on reste
    // dessous — comportement SearchPop, où le CSS borne la hauteur du popover.
    const stay = FloatPlacement.anchored(rect(100, 100, 200, 30), { width: 300, height: 750 }, VP);
    ck.eq(stay.flipped, false, "fits : ne tient pas dessus (100-4-750 < 0) → reste dessous");
    ck.eq(stay.top, 134, "reste dessous même en débordant (le CSS du consommateur borne)");

    // RECADRAGE horizontal : ancre collée à gauche → marge 8 ; collée à droite → repoussée dedans.
    ck.eq(FloatPlacement.anchored(rect(2, 100, 50, 20), { width: 200, height: 100 }, VP).left, 8,
      "recadrage gauche : jamais sous la marge (8)");
    ck.eq(FloatPlacement.anchored(rect(950, 100, 40, 20), { width: 200, height: 100 }, VP).left, 792,
      "recadrage droite : vp.width (1000) - largeur (200) - marge (8)");

    // ANCRE PARTIELLEMENT HORS ÉCRAN (haut-gauche), surface qui déborde dessous : on reste
    // dessous quand même (rien ne tient dessus), recadré à la marge.
    const off = FloatPlacement.anchored(rect(-40, -10, 100, 30), { width: 200, height: 790 }, VP);
    ck.eq(off.flipped, false, "ancre débordant en haut : jamais de bascule (aucune place dessus)");
    ck.eq(off.top, 24, "sous l'ancre hors écran : bottom (20) + gap (4)");
    ck.eq(off.left, 8, "ancre débordant à gauche : recadrée à la marge");

    // VIEWPORT MINUSCULE : surface plus large que l'écran moins les marges → la borne GAUCHE
    // gagne (choix unique du module — le contenu commence au bord visible).
    const tiny = FloatPlacement.anchored(rect(20, 60, 100, 20), { width: 250, height: 100 }, { width: 200, height: 150 });
    ck.eq(tiny.left, 8, "surface plus large que le viewport : borne gauche gagnante (marge 8)");
    ck.eq(tiny.top, 84, "déborde dessous ET ne tient pas dessus : reste dessous");
  }
  });

  await section("FloatPlacement.anchored : paramétrage Autocomplete (gap 0, fill, seuil 220/more, maxHeight 120/12)", async () => {
  {
    const AC = { gap: 0, align: "fill", flip: { minBelow: 220, above: "more" }, maxHeight: { floor: 120, inset: 12 } };
    // La hauteur mesurée est OMISE (0) : bascule à seuil + ancrage par le bas ne la consomment pas
    // (c'est ce qui épargne un reflow forcé à chaque frappe chez le consommateur).
    const size = (w) => ({ width: w, height: 0 });

    // SEUIL : moins de 220 px dessous ET davantage dessus → bascule, ancrée PAR LE BAS.
    const flip = FloatPlacement.anchored(rect(50, 600, 300, 24), size(300), VP, AC);
    ck.eq(flip.flipped, true, "seuil : 176 px dessous (< 220) et 600 dessus (> 176) → bascule");
    ck.eq(flip.bottom, 200, "ancrage bas : vp.height (800) - anchor.top (600), gap 0");
    ck.eq(flip.maxHeight, 588, "maxHeight côté élu (dessus) : max(120, 600 - 12)");
    ck.eq(flip.width, 300, "fill : largeur imposée = celle de l'ancre");
    ck.eq(flip.left, 50, "fill : bord gauche de l'ancre");

    // Place suffisante dessous : pas de bascule, collée sous l'input (gap 0).
    const below = FloatPlacement.anchored(rect(50, 100, 300, 24), size(300), VP, AC);
    ck.eq(below.flipped, false, "676 px dessous (>= 220) : reste dessous");
    ck.eq(below.top, 124, "collée sous l'input : anchor.bottom, gap 0");
    ck.eq(below.maxHeight, 664, "maxHeight côté élu (dessous) : max(120, 676 - 12)");

    // Seuil non atteint dessous mais PAS plus de place dessus → on reste dessous (politique more).
    const cramped = FloatPlacement.anchored(rect(50, 100, 300, 24), size(300), { width: 1000, height: 300 }, AC);
    ck.eq(cramped.flipped, false, "more : 176 dessous < 220 mais 100 dessus (pas davantage) → reste dessous");
    ck.eq(cramped.maxHeight, 164, "comprimée dans l'espace élu : max(120, 176 - 12)");

    // PLANCHER : espace élu trop petit → maxHeight tombe au plancher (la liste déborde un peu, assumé).
    const floor = FloatPlacement.anchored(rect(50, 60, 300, 24), size(300), { width: 1000, height: 150 }, AC);
    ck.eq(floor.flipped, false, "66 dessous < 220 mais 60 dessus (pas davantage) → reste dessous");
    ck.eq(floor.maxHeight, 120, "plancher : max(120, 66 - 12) = 120");

    // fill N'EST PAS recadré : une liste calée sur un input près du bord reste calée dessus
    // (la décoller « esthétiquement » la désolidariserait visuellement de son champ).
    ck.eq(FloatPlacement.anchored(rect(2, 100, 300, 24), size(300), VP, AC).left, 2,
      "fill : aucun recadrage horizontal (left = celui de l'ancre, même < marge)");
  }
  });

  await section("FloatPlacement.anchored : paramétrage RowMenu (end, marginV 8, bascule always)", async () => {
  {
    const RM = { align: "end", marginV: 8, flip: { above: "always" } };

    // Alignement END : bord droit du menu sur le bord droit du déclencheur.
    const p = FloatPlacement.anchored(rect(800, 100, 30, 16), { width: 168, height: 120 }, VP, RM);
    ck.eq(p.left, 662, "end : anchor.right (830) - largeur (168)");
    ck.eq(p.top, 120, "dessous : anchor.bottom (116) + gap (4)");

    // END qui DÉBORDE À GAUCHE (déclencheur près du bord gauche) → recadré à la marge.
    ck.eq(FloatPlacement.anchored(rect(10, 100, 30, 16), { width: 168, height: 120 }, VP, RM).left, 8,
      "end débordant à gauche : recadré à la marge (8)");

    // BASCULE au simple débordement bas (la marge 8 entre dans le test), sans exigence dessus.
    const flip = FloatPlacement.anchored(rect(800, 700, 30, 16), { width: 168, height: 120 }, VP, RM);
    ck.eq(flip.flipped, true, "déborde dessous (720+120 > 800-8) → bascule, même sans mesurer dessus");
    ck.eq(flip.top, 576, "basculé : anchor.top (700) - gap (4) - hauteur (120)");

    // Menu plus haut que la place dessus : le haut basculé est BORNÉ à marginV (jamais hors écran
    // par le haut — comportement historique du menu ⋮).
    const clamp = FloatPlacement.anchored(rect(300, 40, 30, 16), { width: 168, height: 300 }, { width: 1000, height: 340 }, RM);
    ck.eq(clamp.flipped, true, "always : bascule au débordement même si ça ne tient pas dessus");
    ck.eq(clamp.top, 8, "haut basculé borné à marginV : max(8, 40 - 4 - 300)");
  }
  });

  await section("FloatPlacement.tooltip : politique RichTooltip (centré, clamp DUR au viewport)", async () => {
  {
    // Mêmes cas que la section historique `RichTooltip.place` de test-views-tools.js — qui reste
    // jouée là-bas sur la façade (non-régression de la délégation) ; ici on fixe la politique.
    const TIP = { width: 200, height: 100 };

    const p = FloatPlacement.tooltip(rect(400, 300, 40, 30), TIP, VP, 8);
    ck.eq(p.y, 338, "sous l'ancre : bottom (330) + gap (8)");
    ck.eq(p.x, 320, "centré sur l'ancre : 400 + 40/2 - 200/2");

    ck.eq(FloatPlacement.tooltip(rect(400, 700, 40, 30), TIP, VP, 8).y, 592,
      "flip au-dessus : top (700) - gap (8) - hauteur (100)");

    // Déborde en bas SANS place au-dessus : pas de flip, clamp bas — le tooltip RECOUVRE l'ancre,
    // assumé pour une surface non interactive (c'est CE clamp qui distingue la politique tooltip
    // des popovers interactifs, qui ne recouvrent jamais leur champ).
    ck.eq(FloatPlacement.tooltip(rect(400, 20, 40, 770), TIP, VP, 8).y, 700,
      "sans place au-dessus : clamp à vp.height - hauteur (recouvre l'ancre, assumé)");

    ck.eq(FloatPlacement.tooltip(rect(0, 300, 20, 20), TIP, VP, 8).x, 0, "clamp gauche : jamais de x négatif");
    ck.eq(FloatPlacement.tooltip(rect(980, 300, 20, 20), TIP, VP, 8).x, 800, "clamp droite : vp.width - largeur");

    const huge = FloatPlacement.tooltip(rect(10, 10, 20, 20), { width: 1200, height: 900 }, VP, 8);
    ck.eq(huge.x, 0, "tooltip plus large que le viewport : collé au bord 0");
    ck.eq(huge.y, 0, "tooltip plus haut que le viewport : collé au bord 0");
  }
  });
};

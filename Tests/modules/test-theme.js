/* Tests modules — PRÉFÉRENCE DE THÈME (core/ThemeResolution). Le panneau des réglages
   offre trois positions (clair · auto · sombre) : la décision « quelle préférence donne
   quel thème appliqué » est un module PUR, testé ici sans navigateur — l'appelant lui
   passe ce que répond `prefers-color-scheme`, il ne le lit jamais lui-même.
   Ce qu'on verrouille : le DÉFAUT (sombre, = absence d'attribut `data-theme`), l'ORDRE
   des positions du toggle, la lecture tolérante des préférences persistées (y compris
   celles écrites AVANT l'ajout du mode auto), le fait qu'un choix explicite ne se laisse
   jamais écraser par le système, et la bascule de la palette qui doit produire un
   changement VISIBLE même depuis « auto ». Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  const { ThemeResolution } = D("core/ThemeResolution.js");

  await section("ThemeResolution — défaut et catalogue des positions", async () => {
    ck.eq(ThemeResolution.DEFAULT, "dark", "défaut = SOMBRE (l'absence de `data-theme` EST le thème sombre du CSS)");
    ck.eq(ThemeResolution.OPTIONS.join(","), "light,auto,dark", "ORDRE du toggle : clair ← auto → sombre (auto au MILIEU)");
    ck.eq(ThemeResolution.OPTIONS.length, 3, "trois positions, ni plus ni moins");
    ck(ThemeResolution.OPTIONS.indexOf("auto") === 1, "« auto » est bien la position CENTRALE (le repère « A » du contrôle en dépend)");
  });

  await section("ThemeResolution.normalize — lecture d'une préférence persistée", async () => {
    ck.eq(ThemeResolution.normalize("light"), "light", "« light » accepté");
    ck.eq(ThemeResolution.normalize("dark"), "dark", "« dark » accepté");
    ck.eq(ThemeResolution.normalize("auto"), "auto", "« auto » accepté (valeur ajoutée avec le suivi système)");
    // Rétrocompat : les préférences écrites AVANT le mode auto ne contiennent que light/dark — elles
    // passent telles quelles, aucune migration à écrire.
    ck.eq(ThemeResolution.normalize("dark"), "dark", "préférence d'une version ANTÉRIEURE relue sans migration");
    ck.eq(ThemeResolution.normalize("sombre"), null, "valeur inconnue → null (l'appelant garde sa valeur courante)");
    ck.eq(ThemeResolution.normalize(""), null, "chaîne vide → null");
    ck.eq(ThemeResolution.normalize(undefined), null, "absente → null");
    ck.eq(ThemeResolution.normalize(null), null, "null → null");
    ck.eq(ThemeResolution.normalize(1), null, "type non-chaîne → null");
    ck.eq(ThemeResolution.normalize("Dark"), null, "casse différente → null (la valeur persistée est canonique)");
  });

  await section("ThemeResolution.effective — un choix EXPLICITE prime toujours sur le système", async () => {
    ck.eq(ThemeResolution.effective("light", true), "light", "« clair » reste clair même si le système préfère le sombre");
    ck.eq(ThemeResolution.effective("light", false), "light", "« clair » reste clair (système clair)");
    ck.eq(ThemeResolution.effective("dark", false), "dark", "« sombre » reste sombre même si le système préfère le clair");
    ck.eq(ThemeResolution.effective("dark", true), "dark", "« sombre » reste sombre (système sombre)");
    ck.eq(ThemeResolution.effective("auto", true), "dark", "« auto » + système sombre → sombre");
    ck.eq(ThemeResolution.effective("auto", false), "light", "« auto » + système clair → CLAIR");
    // `matchMedia` absent (contexte exotique, très vieux moteur) : l'appelant passe `false`… ce qui
    // donnerait « clair ». On vérifie donc surtout que le DÉFAUT, lui, ne dépend pas du système.
    ck.eq(ThemeResolution.effective(ThemeResolution.DEFAULT, false), "dark", "le défaut rend « dark » quoi que dise le système");
    ck.eq(ThemeResolution.effective(ThemeResolution.DEFAULT, true), "dark", "…et le rend aussi quand le système préfère le sombre");
  });

  await section("ThemeResolution.toggled — la bascule de la palette produit un changement VISIBLE", async () => {
    ck.eq(ThemeResolution.toggled("light", false), "dark", "clair → sombre");
    ck.eq(ThemeResolution.toggled("dark", false), "light", "sombre → clair");
    // 🚨 Le cas qui justifie la fonction : depuis « auto », basculer ne doit PAS rendre la valeur que le
    // système impose déjà (rien ne changerait à l'écran) mais son INVERSE — et épingler ce choix.
    ck.eq(ThemeResolution.toggled("auto", true), "light", "auto affiché SOMBRE → épingle CLAIR (et non « dark », qui ne changerait rien)");
    ck.eq(ThemeResolution.toggled("auto", false), "dark", "auto affiché CLAIR → épingle SOMBRE");
    ck(ThemeResolution.toggled("auto", true) !== "auto", "basculer QUITTE toujours « auto » : c'est un choix explicite");
    // Involution : deux bascules d'affilée reviennent au point de départ (le second appel part d'une
    // préférence désormais explicite, le système n'a plus voix au chapitre).
    const once = ThemeResolution.toggled("light", true);
    ck.eq(ThemeResolution.toggled(once, true), "light", "deux bascules → retour au thème initial");
  });
};

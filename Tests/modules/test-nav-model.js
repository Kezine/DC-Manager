/* Tests modules — MODÈLE PUR de la navigation à deux niveaux (`app/NavModel`, re-design du menu 2026-08-20).

   Le menu passe de « 11 onglets primaires + sous-vues cachées dans des liens d'en-tête + 1 groupe
   déroulant » à « 5 DOMAINES ▸ leurs VUES ». Le modèle est pur (ni DOM ni Shell) : il reçoit des
   déclarations + un prédicat de visibilité et rend la structure à peindre. On teste ici :

     1. 🚨 la RÈGLE (A) — un compteur n'appartient QU'À une entrée TERMINALE (décision utilisateur
        qui TRANCHE CONTRE la maquette, dont la note « badges qui remontent » agrégeait sur le
        domaine et sur le burger) ; elle est appliquée à la CONSTRUCTION, pas laissée au câblage ;
     2. les règles de DÉGRADÉ sous droits partiels (domaine vide → disparaît · domaine à une vue →
        onglet direct · un seul domaine → niveau 1 effacé) ;
     3. le VERROU D'EXHAUSTIVITÉ — toute vue enregistrée dans `app/main.ts` est rattachée à un
        domaine, et le catalogue ne garde aucune entrée périmée. Sans lui, une vue ajoutée demain
        disparaîtrait SILENCIEUSEMENT du menu (elle n'aurait simplement plus de chemin d'accès).

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, TsViews } = require("./harness.js");
const { D } = require("./harness.js");
const { NavModel, NAV_DOMAINS } = D("app/NavModel.js");

module.exports = async () => {

  /* Jeu d'essai RÉDUIT et stable — indépendant du catalogue réel (testé séparément par le verrou). */
  const DOMS = [
    { name: "d1", label: "l.d1", icon: "I1", views: ["a", "b", "c"], separatorsBefore: ["b"] },
    { name: "d2", label: "l.d2", icon: "I2", views: ["d", "e"] },
    { name: "d3", label: "l.d3", icon: "I3", views: ["f"] },
  ];
  const VUES = [
    { name: "a", label: "L.a" }, { name: "b", label: "L.b", hasCount: true },
    { name: "c", label: "L.c" }, { name: "d", label: "L.d", hasCount: true },
    { name: "e", label: "L.e" }, { name: "f", label: "L.f", hasCount: true },
  ];
  const TOUT = () => true;

  /* ==========================================================================
     1. 🚨 RÈGLE (A) — compteurs sur les entrées TERMINALES uniquement
     ========================================================================== */
  await section("NavModel : 🚨 RÈGLE (A) — un badge n'appartient QU'À une entrée terminale", async () => {
    // -- forme atomique : on passe les ENFANTS eux-mêmes (l'appelant ne décide pas qu'il est terminal) --
    ck.eq(NavModel.allowsBadge(), true, "aucun enfant (appel nu) = terminale → badge autorisé");
    ck.eq(NavModel.allowsBadge([]), true, "liste d'enfants VIDE = terminale → badge autorisé");
    ck.eq(NavModel.allowsBadge(["x"]), false, "UN enfant → badge REFUSÉ");
    ck.eq(NavModel.allowsBadge(["x", "y"]), false, "plusieurs enfants → badge REFUSÉ");

    // -- appliquée à la CONSTRUCTION : c'est le point de la règle, pas une convention d'appelant --
    const nav = NavModel.resolve(DOMS, VUES, TOUT);
    ck.eq(nav.domains.every((d) => d.badge === false), true,
      "AUCUN domaine ne porte de badge — même si ses vues en portent (pas d'agrégation, contre la maquette)");
    const d1 = nav.domains.find((d) => d.name === "d1");
    ck.eq(d1.views.map((v) => v.name + ":" + v.badge).join(" "), "a:false b:true c:false",
      "les VUES portent le badge si et seulement si elles déclarent un count()");

    // -- une vue à `count()` dans un domaine ne « remonte » nulle part : le domaine reste à false --
    const parDomaine = nav.domains.map((d) => d.name + "=" + d.badge).join(" ");
    ck.eq(parDomaine, "d1=false d2=false d3=false", "règle (A) tenue sur les TROIS domaines du jeu d'essai");

    // -- le `badge` d'un domaine est DÉRIVÉ (pas codé en dur) : il vaut ce que la règle rend pour ses
    //    enfants réels. Un domaine sans enfant serait terminal… mais il a déjà disparu de la structure,
    //    d'où l'invariant « aucun domaine résolu ne porte de badge », prouvé ici et non affirmé par le type.
    ck.eq(nav.domains.every((d) => d.badge === NavModel.allowsBadge(d.views)), true,
      "badge d'un domaine = allowsBadge(ses vues) — valeur DÉRIVÉE de la règle, pas une constante");
    ck.eq(nav.domains.every((d) => d.views.length > 0), true,
      "…et tout domaine résolu a au moins une vue (un domaine vide disparaît), donc badge toujours false");

    // -- cas du domaine réduit à UNE vue : le bouton direct est TERMINAL, son badge reste licite --
    const seul = NavModel.resolve(DOMS, VUES, (n) => n === "b");
    ck.eq(seul.domains.length, 1, "seule `b` visible → un seul domaine survit");
    ck.eq(seul.domains[0].direct, true, "…rendu en onglet DIRECT");
    ck.eq(seul.domains[0].views[0].badge, true,
      "un onglet direct pointe vers UNE vue : il est terminal, son badge reste autorisé (la règle porte sur les enfants, pas sur le niveau visuel)");
    ck.eq(seul.domains[0].badge, false, "…et le domaine lui-même reste SANS badge");
  });

  /* ==========================================================================
     2. Structure résolue + règles de dégradé (droits partiels)
     ========================================================================== */
  await section("NavModel.resolve : structure, séparateurs, et dégradé sous droits partiels", async () => {
    const nav = NavModel.resolve(DOMS, VUES, TOUT);
    ck.eq(nav.domains.map((d) => d.name).join(","), "d1,d2,d3", "domaines dans l'ordre déclaré");
    ck.eq(nav.domains[0].views.map((v) => v.name).join(","), "a,b,c", "vues dans l'ordre déclaré");
    ck.eq(nav.flattened, false, "3 domaines visibles → pas d'aplatissement");
    ck.eq(nav.domains[0].direct, false, "domaine à 3 vues → barre de vues (pas direct)");
    ck.eq(nav.domains[2].direct, true, "domaine à 1 vue → onglet DIRECT");

    // -- séparateurs : jamais en tête de barre --
    ck.eq(nav.domains[0].views.map((v) => (v.separatorBefore ? "|" : "") + v.name).join(" "), "a |b c",
      "séparateur rendu AVANT la vue déclarée");
    const sansA = NavModel.resolve(DOMS, VUES, (n) => n !== "a");
    ck.eq(sansA.domains[0].views.map((v) => (v.separatorBefore ? "|" : "") + v.name).join(" "), "b c",
      "🚨 la vue qui portait le séparateur passe en TÊTE (droits) → séparateur SUPPRIMÉ (pas de trait orphelin au bord)");

    // -- domaine vide → disparaît --
    const sansD2 = NavModel.resolve(DOMS, VUES, (n) => n !== "d" && n !== "e");
    ck.eq(sansD2.domains.map((d) => d.name).join(","), "d1,d3", "domaine dont TOUTES les vues sont masquées → il disparaît");

    // -- un seul domaine → niveau 1 effacé --
    const solo = NavModel.resolve(DOMS, VUES, (n) => ["a", "b", "c"].includes(n));
    ck.eq(solo.flattened, true, "un SEUL domaine visible → flattened (ses vues deviennent le niveau 1)");
    ck.eq(solo.domains[0].views.length, 3, "…avec ses 3 vues");

    // -- plus rien de visible --
    const rien = NavModel.resolve(DOMS, VUES, () => false);
    ck.eq(rien.domains.length, 0, "aucune vue visible → aucun domaine");
    ck.eq(rien.flattened, false, "…et pas d'aplatissement (rien à aplatir)");
    ck.eq(NavModel.firstVisibleView(rien), null, "firstVisibleView → null quand plus aucune vue n'est accessible");

    // -- vue déclarée dans un domaine mais NON enregistrée (module absent selon le mode) --
    const partiel = NavModel.resolve([{ name: "dx", label: "l", views: ["a", "fantome"] }], VUES, TOUT);
    ck.eq(partiel.domains[0].views.map((v) => v.name).join(","), "a",
      "vue déclarée au catalogue mais non enregistrée (ex. module serveur absent) → simplement omise, sans planter");
  });

  await section("NavModel : helpers de rattachement (domaine actif, premier repli, isDomain)", async () => {
    const nav = NavModel.resolve(DOMS, VUES, TOUT);
    ck.eq(NavModel.activeDomain("e", nav), "d2", "domaine à surligner/déplier pour la vue active");
    ck.eq(NavModel.activeDomain("inconnue", nav), null, "vue hors structure → null (le Shell retombe sur le 1er domaine)");
    ck.eq(NavModel.firstVisibleView(nav), "a", "premier repli = 1re vue du 1er domaine visible");
    ck.eq(NavModel.domainOf("d", DOMS), "d2", "domainOf : rattachement déclaré");
    ck.eq(NavModel.domainOf("zzz", DOMS), null, "domainOf : vue non rattachée → null");
    ck.eq(NavModel.isDomain("d2", DOMS), true, "isDomain : un domaine est reconnu (il ne navigue jamais — piège ①)");
    ck.eq(NavModel.isDomain("d", DOMS), false, "isDomain : une VUE n'est pas un domaine");
  });

  /* ==========================================================================
     3. VERROU D'EXHAUSTIVITÉ — aucune vue orpheline du menu
     ========================================================================== */
  await section("NavModel : VERROU — toute vue de main.ts est rattachée à un domaine (analyse des SOURCES)", async () => {
    /* POURQUOI CE VERROU. Le catalogue `NAV_DOMAINS` est la SEULE carte vue → domaine. Une vue
       enregistrée mais rattachée à aucun domaine n'apparaîtrait NULLE PART dans le nouveau menu :
       pas d'onglet, pas de pastille, pas d'entrée de tiroir — atteignable seulement par son
       deep-link. C'est exactement le « rien ne doit disparaître silencieusement » du carton.
       Symétriquement, une entrée PÉRIMÉE (vue supprimée/renommée) masquerait un vrai trou.

       On collecte DEUX formes d'enregistrement :
         · `addListTab("nom", …)`            — onglets de LISTE (1er argument littéral) ;
         · `shell.addView({ name: "nom" })`  — vues CUSTOM (littéral ; l'appel interne d'addListTab
                                               passe `name` en propriété raccourcie, il est donc
                                               naturellement exclu — même distinction structurelle
                                               que le verrou de gating de test-client-access.js). */
    const fs = require("fs");
    // Le détecteur vit dans le HARNAIS (`TsViews`) depuis qu'un SECOND verrou pose la même question à
    // main.ts — la carte collection → onglet des liens directs (test-app-link-routing.js). Le contrôle
    // de discrimination ci-dessous le couvre donc pour les deux.
    const declaredViews = (text, fileName) => TsViews.declaredIn(text, fileName);

    // -- CONTRÔLE DE DISCRIMINATION : sans lui, un détecteur aveugle rendrait le verrou vert à tort --
    {
      const sonde = [
        'addListTab("liste", I18n.t("x"), ListConfigs.y, { icon: Icons.Z });',
        'const c = shell.addView({ name: "custom", kind: "primary", visible: () => true });',
        'const x = shell.addView({ name, label, kind: opts.kind || "primary" });',   // ← interne à addListTab
        '// addListTab("en-commentaire", …);',
        'autreObjet.addView({ name: "ailleurs" });',
      ].join("\n");
      const vues = declaredViews(sonde, "sonde.ts").map((v) => v.name);
      ck.eq(vues.join(","), "liste,custom,ailleurs",
        "détecteur : listes + vues custom littérales vues ; propriété raccourcie et commentaire exclus");
    }

    // -- Le VERROU, sur la source RÉELLE --
    const mainTs = path.join(__dirname, "..", "..", "src-client", "app", "main.ts");
    const vues = declaredViews(fs.readFileSync(mainTs, "utf8"), "app/main.ts");
    ck(vues.length >= 25, "verrou : la source est bien lue — " + vues.length + " vues enregistrées");

    const rattachees = new Set(NavModel.declaredViews(NAV_DOMAINS));
    const orphelines = vues.filter((v) => !rattachees.has(v.name)).map((v) => v.name + " (ligne " + v.line + ")");
    ck.eq(orphelines.join("  |  "), "",
      "🚨 verrou : toute vue enregistrée est rattachée à un domaine de NAV_DOMAINS (sinon elle n'a AUCUN chemin dans le menu)");

    const declarees = new Set(vues.map((v) => v.name));
    const perimees = NavModel.declaredViews(NAV_DOMAINS).filter((n) => !declarees.has(n));
    ck.eq(perimees.join(", "), "", "verrou : aucune entrée PÉRIMÉE au catalogue (vue disparue de main.ts)");

    // -- Une vue ne peut appartenir qu'à UN domaine (sinon deux chemins, deux surlignages) --
    const tous = NavModel.declaredViews(NAV_DOMAINS);
    const doublons = tous.filter((n, i) => tous.indexOf(n) !== i);
    ck.eq(doublons.join(", "), "", "verrou : aucune vue rattachée à DEUX domaines");

    // -- Les séparateurs déclarés doivent désigner des vues du domaine (sinon coquille silencieuse) --
    const sepsFautifs = NAV_DOMAINS.flatMap((d) => (d.separatorsBefore || [])
      .filter((n) => !d.views.includes(n)).map((n) => d.name + "→" + n));
    ck.eq(sepsFautifs.join(", "), "", "verrou : tout `separatorsBefore` désigne une vue DU domaine");
  });
};

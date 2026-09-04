/* Tests modules — PANIER d'actions groupées (cf. docs/panier.md, cadrage du 2026-08-24) :
   les DEUX modules purs du socle —
     - core/CartFamilies : la carte « collection → famille », source unique de l'invariant
                           mono-famille (câble ≡ faisceau, chacun des autres pour soi, une
                           collection absente n'entre pas au panier) ;
     - core/CartModel    : l'état pur — ordre d'ajout, idempotence, verdicts (`conflict` sans
                           jamais vider de sa propre initiative, `full`, `unsupported`),
                           remplacement explicite, relecture TOLÉRANTE d'un stockage.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  const { CartFamilies } = D("core/CartFamilies.js");
  const { CartModel } = D("core/CartModel.js");
  const { CartLabelPlans } = D("core/CartLabelPlan.js");

  const item = (collection, id, label) => ({ collection, id, label: label || id });

  await section("panier : CartFamilies — la carte des familles", async () => {
    // LA décision structurante (P1) : câble et faisceau partagent l'anatomie d'étiquette
    // (LabelPrintPolicy.isFlagKind), donc la MÊME famille — c'est tout l'exemple du besoin.
    ck.eq(CartFamilies.of("cables"), "links", "un câble est de la famille `links`");
    ck.eq(CartFamilies.of("cableBundles"), "links", "un faisceau AUSSI — même anatomie");
    ck(CartFamilies.compatible("cables", "cableBundles"), "câbles et faisceaux cohabitent");
    // Les autres diffèrent réellement (formats, champs, gabarit par défaut) : chacun sa famille.
    ck.eq(CartFamilies.of("equipments"), "equipments", "un équipement a sa propre famille");
    ck(!CartFamilies.compatible("cables", "equipments"), "câble et équipement ne cohabitent PAS");
    ck(!CartFamilies.compatible("racks", "spares"), "baie et spare non plus");
    // MÊME raisonnement que links, appliqué à `isSpareLike` : spare et sous-équipement ont la
    // même anatomie d'étiquette (emplacement/type/série, pas d'owner, gabarit S) — même famille.
    ck.eq(CartFamilies.of("spares"), "components", "un spare est de la famille `components`");
    ck.eq(CartFamilies.of("subEquipments"), "components", "un sous-équipement AUSSI");
    ck(CartFamilies.compatible("spares", "subEquipments"), "spares et sous-équipements cohabitent");
    ck(!CartFamilies.compatible("cables", "spares"), "…mais pas avec un lien");
    ck.eq(CartFamilies.collectionsOf("components").join(","), "subEquipments,spares", "les collections de `components`");
    // Absente de la carte = n'entre pas au panier (décision P1 bis : pas d'action, pas de geste).
    ck.eq(CartFamilies.of("vms"), null, "une collection sans action n'a pas de famille");
    ck(!CartFamilies.compatible("vms", "vms"), "…et n'est donc compatible avec RIEN, pas même elle");
    ck.eq(CartFamilies.collectionsOf("links").join(","), "cables,cableBundles", "les collections de `links`");
  });

  await section("panier : CartLabelPlan — le plan d'impression par famille", async () => {
    // Le plan porte DEUX règles : le sujet de politique de la planche, et COMMENT le lot se
    // développe en étiquettes. 🚨 T11 : la seconde n'est plus un NOMBRE que le panier applique
    // lui-même (`labelsPerItem`, qui poussait deux fois le même sujet dans la modale) mais le
    // DÉFAUT de la bascule A / B / A+B — c'est `LabelPrintPolicy.expand` qui multiplie, et la
    // volumétrie reste donc réglable devant l'aperçu. La décision P9 (« un lien s'étiquette par
    // paire ») survit intacte : elle est désormais un défaut, pas une imposition.
    ck.eq(CartLabelPlans.of("links").kind, "cable", "famille `links` → sujet `cable` (isFlagKind les égalise)");
    ck.eq(CartLabelPlans.of("links").defaultEndsMode, "ab", "un lien part sur A + B (décision P9, devenue le défaut de la bascule)");
    ck(!("labelsPerItem" in CartLabelPlans.of("links")), "🚨 plus de `labelsPerItem` : le panier ne duplique plus les sujets (T11)");
    ck.eq(CartLabelPlans.of("components").kind, "spare", "famille `components` → sujet `spare` (isSpareLike les égalise)");
    ck.eq(CartLabelPlans.of("components").defaultEndsMode, undefined, "du petit matériel n'a pas d'extrémités : aucune bascule à défauter");
    // Une famille sans action d'impression n'a pas de plan — et n'est donc pas offerte au panier.
    ck.eq(CartLabelPlans.of("equipments").kind, "equipment", "famille `equipments` → son propre sujet");
    ck.eq(CartLabelPlans.of("equipments").defaultEndsMode, undefined, "un équipement non plus");
    // Une famille sans action d'impression n'a pas de plan — et n'est donc pas offerte au panier.
    ck.eq(CartLabelPlans.of("racks"), null, "pas encore de plan pour les baies");
    // 🚨 L'argument `families` de CartPanel.setup est DÉRIVÉ de cette table : le verrou vérifie
    // qu'aucune famille annoncée imprimable n'est en réalité sans plan.
    const families = CartLabelPlans.families();
    ck.eq(families.join(","), "links,components,equipments", "familles imprimables dérivées de la table");
    ck(families.every((f) => !!CartLabelPlans.of(f)), "toute famille annoncée a bien un plan");
  });

  await section("panier : CartModel — ajout, ordre, idempotence", async () => {
    const cart = new CartModel();
    ck(cart.isEmpty(), "un panier neuf est vide");
    ck.eq(cart.family(), null, "…et sans famille (il les accepte donc toutes)");
    ck.eq(cart.add(item("cables", "c1", "Lien A")), "added", "premier ajout");
    ck.eq(cart.add(item("cableBundles", "b1", "Trunk 1")), "added", "un faisceau rejoint un câble");
    ck.eq(cart.family(), "links", "la famille du panier est celle de son contenu");
    ck.eq(cart.size(), 2, "deux éléments");
    // L'ordre du panier EST l'ordre de la planche : il ne doit pas dépendre d'un tri interne.
    ck.eq(cart.all().map((i) => i.id).join(","), "c1,b1", "ordre D'AJOUT préservé");
    ck.eq(cart.add(item("cables", "c1")), "already", "ajouter deux fois est idempotent");
    ck.eq(cart.size(), 2, "…et n'ajoute rien");
    ck(cart.has("cables", "c1"), "has() voit l'élément");
    // La collection fait partie de l'identité : deux collections peuvent porter le même id.
    ck(!cart.has("cableBundles", "c1"), "l'identité est `collection:id`, pas `id` seul");
  });

  await section("panier : CartModel — invariant de famille et remplacement EXPLICITE", async () => {
    const cart = new CartModel();
    cart.add(item("cables", "c1"));
    ck(!cart.accepts("equipments"), "le panier n'accepte plus une autre famille");
    ck.eq(cart.add(item("equipments", "e1")), "conflict", "l'ajout rend `conflict`");
    // 🚨 LE point : `add` ne vide JAMAIS le panier de sa propre initiative — l'utilisateur
    // perdrait son travail sans l'avoir demandé. Le remplacement est un geste séparé (P6).
    ck.eq(cart.size(), 1, "le conflit n'a RIEN détruit");
    ck.eq(cart.replaceWith(item("equipments", "e1")), "added", "replaceWith remplace explicitement");
    ck.eq(cart.family(), "equipments", "la famille a basculé");
    ck.eq(cart.size(), 1, "…et le contenu précédent est parti");
    ck.eq(cart.add(item("vms", "v1")), "unsupported", "une collection hors carte est refusée");
  });

  await section("panier : CartModel — plafond, retrait, vidage", async () => {
    const cart = new CartModel();
    let allAdded = true;
    for (let i = 0; i < CartModel.MAX; i++) if (cart.add(item("cables", "c" + i)) !== "added") allAdded = false;
    ck(allAdded, "remplissage jusqu'au plafond : tous les ajouts passent");
    ck.eq(cart.size(), CartModel.MAX, "le panier atteint son plafond");
    ck.eq(cart.add(item("cables", "trop")), "full", "au-delà du plafond : `full`");
    ck(cart.remove("cables", "c0"), "retrait d'un élément présent");
    ck(!cart.remove("cables", "c0"), "…un second retrait ne rend plus vrai");
    ck.eq(cart.size(), CartModel.MAX - 1, "la place est libérée");
    ck.eq(cart.add(item("cables", "trop")), "added", "…et un ajout repasse");
    cart.clear();
    ck(cart.isEmpty(), "clear() vide");
    ck.eq(cart.family(), null, "…et rend le panier ouvert à toutes les familles");
  });

  await section("panier : CartModel — relecture TOLÉRANTE du stockage", async () => {
    // Un stockage peut être vide, corrompu, ou bricolé à la main : rien de tout cela ne doit
    // installer un panier que l'UI ne saurait plus représenter.
    ck.eq(CartModel.fromJSON(null).size(), 0, "null → panier vide");
    ck.eq(CartModel.fromJSON({}).size(), 0, "sans `items` → panier vide");
    ck.eq(CartModel.fromJSON({ items: "nope" }).size(), 0, "`items` non-tableau → panier vide");
    const mixed = CartModel.fromJSON({ items: [
      item("cables", "c1", "Lien A"),
      { collection: "cables" },                 // sans id
      { id: "x" },                              // sans collection
      null,
      item("equipments", "e1"),                 // AUTRE famille : l'invariant la rejette
      item("cableBundles", "b1"),
    ] });
    ck.eq(mixed.size(), 2, "seuls les éléments valides ET de la famille du premier survivent");
    ck.eq(mixed.all().map((i) => i.id).join(","), "c1,b1", "…dans l'ordre");
    ck.eq(mixed.family(), "links", "famille cohérente");
    // Aller-retour : ce qu'on persiste est ce qu'on relit.
    const round = CartModel.fromJSON(mixed.toJSON());
    ck.eq(JSON.stringify(round.all()), JSON.stringify(mixed.all()), "toJSON → fromJSON conserve tout");
    ck.eq(round.all()[0].label, "Lien A", "le libellé de secours survit au stockage");
    // Un libellé absent ne doit pas devenir `undefined` dans le DOM.
    ck.eq(CartModel.fromJSON({ items: [{ collection: "cables", id: "c9" }] }).all()[0].label, "", "libellé manquant → chaîne vide");
  });
};

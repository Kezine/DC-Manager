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
    // Absente de la carte = n'entre pas au panier (décision P1 bis : pas d'action, pas de geste).
    ck.eq(CartFamilies.of("vms"), null, "une collection sans action n'a pas de famille");
    ck(!CartFamilies.compatible("vms", "vms"), "…et n'est donc compatible avec RIEN, pas même elle");
    ck.eq(CartFamilies.collectionsOf("links").join(","), "cables,cableBundles", "les collections de `links`");
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

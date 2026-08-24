/* Domaine `cart` — ANGLAIS. Calque EXACT de `../fr/cart.ts` (test de complétude
   `Tests/modules/test-i18n.js`). Voir docs/panier.md. */
export const cart = {
  topbar: "Cart",
  title: "Cart",
  subtitle: "{{n}} item(s) · {{family}}",
  family: {
    links: "Cables and trunks",
    equipments: "Equipment",
    racks: "Racks",
    components: "Components and spares",
  },
  empty: "The cart is empty. Tick rows in a listing to fill it.",
  remove: "Remove from cart",
  clear: "Empty the cart",
  select: "Add to cart",
  selectAll: "Tick the whole page",
  printLabels: "Print labels ({{n}})",
  printSource: "Cart ({{n}})",
  full: "Cart full — {{max}} items maximum.",
  conflict: "The cart already holds another family ({{family}}). Empty it first.",
  missing: "{{n}} item(s) not found — skipped.",
  nothing: "Nothing printable in the cart.",
} as const;

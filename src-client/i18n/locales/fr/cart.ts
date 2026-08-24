/* ============================================================================
   Domaine `cart` — FRANÇAIS. PANIER d'actions groupées (cf. docs/panier.md) :
   entrée de topbar, modale du panier, cases à cocher des listings, dialogue de
   conflit de famille et bilan de l'impression groupée. Agrégé par `../fr.ts`.

   ⚠ La variable d'interpolation est `n`, jamais `count` : i18next réserve `count`
   à la PLURALISATION (il chercherait alors des clés `_one`/`_other`).
   Voir docs/i18n.md. */
export const cart = {
  /** Entrée de topbar (titre + aria-label du bouton à pastille). */
  topbar: "Panier",
  title: "Panier",
  /** Sous-titre de la modale : « 12 éléments · Câbles et faisceaux ». */
  subtitle: "{{n}} élément(s) · {{family}}",
  family: {
    links: "Câbles et faisceaux",
    equipments: "Équipements",
    racks: "Baies",
    spares: "Pièces détachées",
  },
  empty: "Le panier est vide. Cochez des lignes dans un listing pour le remplir.",
  remove: "Retirer du panier",
  clear: "Vider le panier",
  /** Case à cocher d'une ligne de listing, et case d'en-tête (toute la page). */
  select: "Ajouter au panier",
  selectAll: "Cocher toute la page",
  /** Action groupée (V1-Beta : la seule). */
  printLabels: "Imprimer les étiquettes ({{n}})",
  /** Sous-titre de la modale d'impression + en-tête de planche. */
  printSource: "Panier ({{n}})",
  full: "Panier plein — {{max}} éléments au maximum.",
  /** V1-Beta : simple refus. Le dialogue de REMPLACEMENT viendra avec la 2e famille
      porteuse d'une action — aujourd'hui les cases n'apparaissent que sur une seule. */
  conflict: "Le panier contient déjà une autre famille ({{family}}). Videz-le d'abord.",
  /** Bilan d'impression : ce qui a disparu du document depuis l'ajout. */
  missing: "{{n}} élément(s) introuvable(s) — ignoré(s).",
  nothing: "Aucun élément imprimable dans le panier.",
} as const;

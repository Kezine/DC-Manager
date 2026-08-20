/* ============================================================================
   Domaine `nav` — FRANÇAIS. Libellés des DOMAINES du menu à deux niveaux
   (`app/NavModel` → `NAV_DOMAINS`). Agrégé par `../fr.ts`. Voir docs/navigation.md
   et docs/i18n.md.

   Ces cinq clés sont référencées par un module PUR (`NavModel`), qui ne traduit
   pas lui-même : il porte la CLÉ, le Shell appelle `I18n.t`. Ajouter un domaine =
   ajouter sa clé ICI **et** dans `../en/nav.ts` (le test de complétude fr ⇄ en
   échoue sinon). Les libellés nomment un DOMAINE MÉTIER, pas une action : ils
   restent des substantifs courts, lisibles dans une tuile de barre d'onglets. */
export const nav = {
  domain: {
    inventaire: "Inventaire",
    implantation: "Implantation",
    reseau: "Réseau",
    exploitation: "Exploitation",
    parametres: "Paramètres",
  },
} as const;

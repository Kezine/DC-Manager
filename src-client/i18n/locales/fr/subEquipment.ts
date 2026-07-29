/* ============================================================================
   Domaine `subEquipment` — FRANÇAIS. SOUS-ÉQUIPEMENTS : contenu LOGIQUE d'un
   équipement maître (drive d'une librairie à bandes, carte d'un châssis).
   Fiche + formulaire dans `views/forms/SubEquipmentForms.ts`, section réutilisée
   par la fiche d'équipement et la fiche de groupe. Agrégé par `../fr.ts`.
   Voir docs/i18n.md.

   ⚠ Le vocabulaire porte une INTENTION : on ne parle jamais d'« emplacement » ni
   de « position » (un sous-équipement n'en a pas) — `slot` est un REPÈRE en texte
   libre, et `natureHint` dit explicitement pourquoi la fiche n'a ni lieu ni ports,
   pour qu'elle ne se lise pas comme incomplète. */
export const subEquipment = {
  fallback: "(sous-équipement)",
  notFound: "Sous-équipement introuvable",
  detailTitle: "Détail du sous-équipement",
  titleNew: "Nouveau sous-équipement",
  titleEdit: "Modifier le sous-équipement",
  created: "Sous-équipement créé",
  updated: "Sous-équipement mis à jour",

  master: "Équipement maître",
  masterMissing: "Équipement maître introuvable",
  masterFixed: "Sous-équipement de « {{name}} » — il n'existe que par lui.",
  openMaster: "Ouvrir la fiche de l'équipement maître",

  slot: "Repère",
  slotPlaceholder: "Étagère A / baie 3…",
  slotHint: "Texte libre, pour s'y retrouver dans le maître. Ce n'est pas une position : un sous-équipement n'est ni placé ni dessiné.",
  hardware: "Matériel",
  namePlaceholder: "Drive LTO-8 n°2…",
  nameHint: "Le nom porte la sémantique : il n'y a pas de champ « type ».",
  brandPlaceholder: "Quantum, IBM…",
  modelPlaceholder: "Référence constructeur…",
  serialPlaceholder: "Numéro de série…",
  natureHint: "Un sous-équipement n'a ni emplacement, ni dimensions, ni ports propres : son existence physique est celle de son équipement maître.",

  section: "Sous-équipements ({{count}})",
  sectionEmpty: "Aucun sous-équipement.",
  add: "+ Sous-équipement",
} as const;

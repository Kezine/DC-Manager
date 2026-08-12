/* ============================================================================
   Domaine `attachment` — FRANÇAIS. PIÈCES JOINTES (collection `attachments`,
   lot B) : formulaire de création/édition (`Forms.attachment`), section
   « Pièces jointes » des fiches porteuses et briques partagées (`AttachmentUi`).
   La FICHE détail vit dans `detail.attachment.*`, les colonnes/filtres dans
   `lists.*`, l'onglet dans `tabs.attachments.*`. Agrégé par `../fr.ts`.
   Voir docs/i18n.md et docs/attachments.md. */
export const attachment = {
  form: {
    namePlaceholder: "Convention de prêt 2026, Bon de commande…",
    file: "Fichier",
    fileHint: "PDF, image, document bureautique ou texte — 50 Mo maximum. Le binaire vit hors du document.",
    editLocked: "Le fichier n'est pas remplaçable : pour changer le binaire, supprimez la pièce et recréez-la.",
    target: "Cible",
    targetHint: "Équipement OU sous-équipement auquel rattacher la pièce (facultatif).",
    familyEquipment: "Équipement",
    familySubEquipment: "Sous-équipement",
    titleNew: "Nouvelle pièce jointe",
    titleEdit: "Modifier la pièce jointe",
    created: "Pièce jointe créée",
    updated: "Pièce jointe mise à jour",
    fileRequired: "Choisissez un fichier à joindre.",
    uploadFailed: "Échec de l'envoi du fichier.",
    blobFailed: "Échec du dépôt du binaire — la pièce n'a pas été créée.",
    noStore: "Stockage des pièces jointes indisponible.",
  },
  // Section « Pièces jointes » des fiches porteuses (équipement / sous-équipement).
  section: "Pièces jointes ({{count}})",
  openDetail: "Ouvrir la fiche de la pièce jointe",
  binaryMissing: "Le binaire de cette pièce jointe est introuvable.",
  // VIEWER intégré (cadrage B) : rendu image/texte/markdown/PDF dans la pile de modales.
  view: {
    title: "Pièce jointe",
    truncated: "Affichage tronqué — télécharger pour le fichier complet.",
    readError: "Impossible de lire le contenu de cette pièce jointe.",
    notViewable: "Ce type de fichier ne peut pas être affiché — téléchargez-le pour l'ouvrir.",
    // Politique d'images D-B3 : les images externes d'un markdown sont neutralisées par défaut.
    showExternalImages_one: "Afficher l'image externe",
    showExternalImages_other: "Afficher les {{count}} images externes",
    externalImageTitle: "Image externe neutralisée — cliquez pour ouvrir sa source dans un nouvel onglet.",
  },
  // Pastille de la fiche détail signalant que la cible est un SOUS-ÉQUIPEMENT (vs équipement).
  targetSubEquipmentPill: "Sous-équipement",
} as const;

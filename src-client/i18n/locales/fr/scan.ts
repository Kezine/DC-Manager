/* ============================================================================
   Domaine `scan` — FRANÇAIS. UI du SCAN CAMÉRA (chantier étiquettes QR, lot D) :
   greffon de champ (`ui/ScanControl`), viseur (`ui/ScanViewfinder`) — bouton,
   panneau résultat, avertissements des parseurs (`core/ScanParsing`, codes →
   libellés ICI), états d'échec caméra (échecs TYPÉS de `core/BarcodeDetection`).
   Les préférences du panneau Réglages vivent dans `shell.settings.scan*`.
   Agrégé par `../fr.ts`. Voir docs/i18n.md et docs/qr-scan.md § « L'UI de scan ». */
export const scan = {
  button: {
    // aria-label du greffon (le bouton n'a pas de texte) — nomme le CHAMP qu'il remplit.
    label: "Scanner — {{field}}",
    tip: "Scanner (QR / code-barres)",
  },
  viewfinder: {
    title: "Scanner",
    freeTitle: "Scanner une étiquette",
    // Libellé de repli d'un champ sans <label> de formulaire (greffon générique, raccourci).
    genericField: "Champ de saisie",
    hint: "Placez le code dans la zone — déplacez-la ou redimensionnez-la par les coins.",
    locked: "Code verrouillé",
    engineLabel: "Moteur",
    engineAuto: "Auto (natif)",
    engineWasm: "WASM",
    badgeNative: "moteur natif",
    badgeWasm: "moteur wasm",
    torch: "Torche",
    torchUnavailable: "Torche non disponible sur cette caméra.",
    cameraNext: "Changer de caméra",
    recenter: "Recentrer la zone de décodage",
  },
  result: {
    decodedQr: "QR-code décodé",
    decoded: "Code décodé",
    // Annonce vocale (aria-live) de la valeur lue — accessibilité de la maquette.
    announce: "Code décodé : {{value}}",
    again: "Continuer",
    validate: "Valider",
    copy: "Copier",
    copied: "Valeur copiée",
    inject: "Insérer dans le dernier champ actif",
    openLink: "Ouvrir le lien (nouvel onglet)",
  },
  // Codes des parseurs (`core/ScanParsing`) — « jamais d'injection silencieuse » : la valeur
  // refusée reste affichée avec sa raison, « Valider » est désactivé.
  warning: {
    empty: "Code vide — rien à insérer.",
    multiline: "Valeur multi-lignes — elle ne convient pas à un champ simple.",
    linklike: "Cette valeur ressemble à un lien — probablement le mauvais code de la planche d'étiquettes.",
  },
  // Échecs TYPÉS du démarrage caméra (cf. CameraStartFailure, docs/qr-scan.md § Sécurité).
  error: {
    insecure: "La caméra exige un contexte sécurisé : HTTPS ou localhost.",
    noCamera: "Aucune caméra détectée sur cet appareil.",
    permissionBlocked: "L'accès à la caméra est BLOQUÉ pour ce site : l'invite ne reviendra pas. Débloquez-le via l'icône caméra de la barre d'adresse (ou les réglages du site) — le scan reprendra tout seul.",
    permissionDismissed: "Autorisation caméra refusée ou ignorée — réessayez pour relancer la demande.",
    retry: "Réessayer",
    generic: "Échec caméra : {{name}} {{message}}",
    engineFailed: "Le moteur de décodage n'a pas pu démarrer.",
  },
} as const;

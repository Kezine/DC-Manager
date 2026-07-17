/* ============================================================================
   Domaine `forms` — FRANÇAIS. SOCLE des formulaires (`views/forms/FormBase.ts`) :
   préréglages de perspective, assistant de breakout, éditeurs de capot / de
   montage latéral / d'élévation de baie. Agrégé par `../fr.ts`. Voir docs/i18n.md.

   `{{spans}}` = liste des facteurs de breakout entre accolades, fournie déjà
   formatée par l'appelant ; `{{trunk}}`/`{{lane}}` = débits déjà échappés. */
export const forms = {
  faceRatio: {
    frontEars: "Façade {{u}}U · avec oreilles",
    frontNoEars: "Façade {{u}}U · sans oreilles",
    rear: "Façade {{u}}U · arrière",
  },
  breakout: {
    needPortTypes: "Créez d'abord des types de port (QSFP+ et SFP+).",
    lanes: "Nombre de lanes : <b>×{{n}}</b>  ({{trunk}} ÷ {{lane}} = {{n}} — breakout standard).",
    nonStandard: "Combinaison non standard : {{trunk}} ÷ {{lane}} = {{ratio}}. Un breakout valide impose débit(trunk) = N × débit(lane) avec N ∈ {{spans}}.",
    laneOpt: "×{{n}} lanes",
    lanesField: "Nombre de lanes",
    lanesManualHint: "Débit non renseigné sur ces types → choix manuel parmi les breakouts standard.",
    title: "Nouveau breakout",
    create: "Créer",
    namePlaceholder: "ex. QSFP1",
    nameField: "Nom du trunk",
    nameHint: "Les lanes seront nommées « nom/1 », « nom/2 », …",
    trunkField: "Type du trunk (connecteur physique)",
    trunkHint: "Ex. 400G QSFP-DD — le trunk ne porte pas de câble lui-même.",
    laneField: "Type des lanes",
    laneHint: "Identique pour TOUTES les lanes — chacune porte un câble 1:1.",
    errName: "Donnez un nom au trunk.",
    errTrunk: "Choisissez le type du trunk.",
    errLane: "Choisissez le type des lanes.",
    errCombo: "Combinaison trunk/lane non standard : ajustez les types (débit trunk = N × débit lane, N ∈ {{spans}}).",
  },
  cap: {
    kept_one: "{{count}} cellule conservée : un pin y est posé.",
    kept_other: "{{count}} cellules conservées : un pin y est posé.",
    clearAll: "Supprimer tout",
    clearAllTitle: "Retirer tous les trous de ce capot (les cellules portant un pin sont conservées)",
  },
  image: {
    badFormat: "Format non supporté (PNG / JPEG / WebP).",
  },
  side: {
    left: "G",
    right: "D",
    bay: "baie",
    marginLeft: "marge gauche",
    marginRight: "marge droite",
    here: "ici",
    tooWide: "L'équipement (largeur {{w}} mm) dépasse la largeur de colonne ({{col}} mm).",
  },
  rack: {
    rearSuffix: " (dos)",
    remove: "Retirer",
    mount: "Monter un élément ici",
  },
  ph: {
    equipment: "(équipement)",
  },
} as const;

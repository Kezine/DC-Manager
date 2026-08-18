# Carton — Étiquettes QR IMPRIMABLES (gabarits + flux d'impression)

**Chantier « étiquettes QR / scan caméra » — volet IMPRESSION (lot E, dernier volet).**
Poussé le 2026-08-19 pour exploration Claude Design. Au retour : maquette PULL dans `briefs/`
(même cycle que « Saisie QR-code (caméra) », déjà explorée ET implémentée — merci !).

## Contexte — ce qui EXISTE déjà (ne pas re-concevoir)

- Le **scan** est traité : maquette `explorations/Saisie QR-code (camera) - maquette.html`,
  implémentée (greffon par champ + viseur ROI). Ce carton ne concerne QUE l'impression.
- Le **serveur génère les QR** : `GET …/qr/:collection/:id?format=png|svg&size=<px>` → image d'un
  QR (correction M, quiet zone standard) encodant l'URL absolue de la fiche de l'objet.
  SVG dispo (net à toute échelle d'impression) — c'est le format à privilégier pour l'imprimé.
- Scanné par un téléphone hors app → le navigateur ouvre la fiche ; scanné dans l'app → saut à la
  fiche même si l'URL de déploiement a changé depuis l'impression.
- Objets étiquetables : tout objet à fiche — en pratique **équipements** et **baies (racks)**
  d'abord ; spares/sous-équipements possibles ensuite.

## À explorer (l'arbitrage « gabarits » est ROUTÉ sur cette maquette)

1. **Gabarits d'étiquette** — les 3 registres pressentis, à confronter :
   - étiquette UNITAIRE d'équipement (collée en façade : petite, QR + identité minimale) ;
   - étiquette de BAIE (plus grande, en tête de baie : QR + nom + salle/rangée) ;
   - **PLANCHE A4** (grille d'étiquettes à découper ou papier autocollant pré-découpé type
     Avery — plusieurs objets d'un coup, p. ex. « toute la baie B12 »).
2. **Anatomie d'une étiquette** : QR + quoi en LISIBLE HUMAIN ? (nom, emplacement baie/U,
   type/famille, n° de série ?). Hiérarchie typographique à très petite taille ; le QR doit rester
   scannable (≳ 18-20 mm de côté imprimé, quiet zone respectée, noir sur blanc — l'imprimé
   IGNORE le thème sombre de l'app).
3. **Flux de déclenchement dans l'app** (primitives existantes : boutons-icône `Icons`,
   modale standard, listings avec actions de ligne) :
   - depuis une FICHE (bouton « Imprimer l'étiquette ») ;
   - depuis un LISTING (action de ligne ; sélection multiple → planche ?) ;
   - depuis une BAIE (« étiquettes de tout son contenu » → planche) ?
   - aperçu avant impression (fenêtre/onglet print-CSS `@media print`) — quelle mise en scène ?
4. **Paramétrage utile sans usine à gaz** : taille d'étiquette (S/M/L ?), champs affichés
   (cases à cocher ?), nombre de colonnes de la planche — qu'est-ce qui mérite un réglage,
   qu'est-ce qui doit être un bon défaut ?

## Contraintes

- Interface en FRANÇAIS ; l'app fournit modale/boutons/tokens (galerie synchronisée dans ce
  projet) ; la SORTIE imprimée est du print-CSS noir sur blanc, pensée pour A4 (et idéalement
  compatible imprimantes d'étiquettes dédiées en unitaire).
- Aucun logo/branding externe ; identité = données de l'objet.
- L'étiquette imprimée est PÉRENNE : ne pas y mettre d'info volatile (statut, IP…) — le QR mène à
  la fiche qui, elle, est à jour.

## Livrable attendu

Une maquette HTML dans `explorations/` (« Étiquettes imprimables - maquette ») montrant : les
gabarits retenus (unitaire équipement / baie / planche A4), l'anatomie d'une étiquette aux tailles
réelles, et le flux d'impression (point d'entrée + aperçu). Les recommandations tranchées
(tailles mm, champs par défaut) en notes dans la maquette.

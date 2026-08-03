# Carton — Refonte du filtre « à recherche » (Porteur) : l'unifier avec les filtres fermés

> **Statut : PROSPECTIF — à explorer par Claude Design** (dossier `explorations/` du projet).
> Demande utilisateur du 2026-08-03. La carte `listing/filtre-cible.html` documente l'ÉTAT ACTUEL
> (à ne pas modifier) ; ce carton porte la DIRECTION voulue et les décisions déjà prises.
> Au retour : maquette → PULL dans `briefs/` → implémentation dans le repo → resync.

## Le problème

La dimension « à recherche » du menu « + Filtre » (filtre CIBLE unifié, lots 3-4 du chantier
recherche partagée — ex. « Porteur » sur les adresses IP, « Équipement » sur les câbles, « Cible »
sur les interventions) est aujourd'hui un **champ de recherche nu** (`SearchPop` compact) posé dans
le menu, à côté des dimensions à options fixes qui, elles, sont des **déclencheurs fermés**
(`.multi-trigger` + `.count-badge`). Deux langages visuels dans le même menu — et le popover de
résultats (~380 px) **déborde** du menu (200 px).

## La direction voulue (décisions utilisateur, 2026-08-03)

1. **Même design que les filtres de liste FERMÉS.** La dimension à recherche se présente comme un
   déclencheur `.multi-trigger` : `[ Porteur (badge) ▾ ]`. À l'ouverture, au lieu de la liste
   cochable (`.multi-panel`), c'est un **champ de recherche** qui s'ouvre (le `SearchPop` — on
   RÉUTILISE le composant, principe n°14 ; jamais un contrôle réinventé).
2. **Badge du déclencheur** : `(Tous)` quand aucune cible ; le **NOM de l'entité** quand une cible
   est choisie (`Porteur (SW-Coeur)`) — même logique que le count-badge qui reflète la sélection.
   La chip retirable reste en dessous, comme pour toute dimension.
3. **Popover ouvert avec une cible DÉJÀ choisie** : la **valeur courante s'affiche avec un ✕
   d'effacement** au-dessus du champ (même esprit que `FormControls.entityPicker` des formulaires) —
   on voit ce qu'on remplace. Taper remplace (mono).
4. **Anticiper le MULTI-cibles (OR)** dans la maquette : badge compteur à 2+ cibles
   (`Porteur (2)`), chips cumulées, le popover liste les cibles choisies (retirables) au-dessus du
   champ « Ajouter… ». Le serveur des interventions sait déjà le OR (param `targets`) ; l'état des
   listings est un `Set` — la forme du code est prête, seule l'UI est mono v1.

## Contraintes et matériaux

- **Composants existants à réutiliser** : `.multi-trigger`/`.count-badge` (déclencheur),
  `SearchPop` (champ + popover + `StaleGate` + anti-rebond + badges de famille `.dc-search-tag`),
  `FilterChips` (chips à valeur libre, libellé résolu à chaque rendu — entité renommée suivie,
  supprimée → repli identifiant). Les candidats viennent de `core/EntityCandidates` (double mode
  local/serveur, plafond 12, familles badgées Équipement/VM…).
- **Résoudre le débordement** : le popover du champ doit vivre correctement dans (ou hors de) la
  colonne du menu « + Filtre » — c'est LA tension visuelle actuelle (380 px vs 200 px). Portail
  (`.dc-pop-portal`), élargissement du menu, panneau secondaire… : à explorer.
- **Accessibilité** : le déclencheur reste un vrai bouton (`aria-haspopup`/`aria-expanded`) ; le
  champ garde son ARIA combobox (posé par `SearchPop`).
- **Thèmes** : sombre ET clair (tokens CSS de l'app — aucune couleur en dur).
- **Portée** : le design vaut pour TOUTES les dimensions « à recherche » (Porteur, Équipement des
  câbles, Cible des interventions) — « Porteur » n'est que l'exemple de travail.

## Pointeurs (repo)

- `src-client/ui/FilterBar.ts` (`buildSearch` — l'état actuel), `src-client/ui/MultiSelect.ts`
  (le déclencheur fermé à égaler), `src-client/ui/SearchPop.ts`, `src-client/ui/EntityPicker.ts`
  (l'esprit « valeur courante + effacer »), `src-client/core/FilterChips.ts`,
  `src-client/core/EntityCandidates.ts`, `src-client/views/ListTargets.ts`.
- Doc d'architecture : `docs/recherche.md` (§ filtre cible unifié).
- Carte galerie de l'état actuel : `listing/filtre-cible.html`.

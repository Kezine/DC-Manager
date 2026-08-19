# Carton — MENU DE L'APP : re-design complet (wide screen + responsive)

**Demande utilisateur du 2026-08-19.** Poussé le 2026-08-20 pour exploration Claude Design.
Objectif : un travail de RE-DESIGN de toute la navigation de l'app, dans ses DEUX régimes
(wide screen et responsive), à partir de l'inventaire COMPLET ci-dessous. Au retour :
maquette PULL dans `briefs/` (cycle habituel).

## 1 · Inventaire EXACT du menu actuel (source : enregistrements du Shell)

**Onglets PRIMAIRES** (barre d'onglets, dans l'ordre) :
Équipements · VMs · Wifi · Racks · Câbles · IPAM · Netmap · Datacenters · Interventions ·
Certificats · **Paramètres ▾** (groupe déroulant — seul élément de ce type).

**Sous-vues** (`kind: secondary`, rattachées à un parent — atteintes par les LIENS D'EN-TÊTE
de la vue parente, PAS par la barre) :
- Équipements → Groupes · Spares · Sous-équipements · Applications · Pièces jointes ·
  Images de façade
- VMs → Clusters *(mode API seulement)*
- Câbles → Réseaux · Faisceaux · Types de port · Types de câble
- IPAM (= Adresses IP) → Réseaux IP · Plages DHCP
- Datacenters → Salles · Sites · Étages
- Paramètres (groupe) → Contacts · Notifications

**Topbar (hors onglets)** : loupe (recherche globale, Ctrl+K) · **scanner une étiquette**
(nouveau — caméra, masqué sans caméra/mode fichier) · undo/redo · état de sauvegarde ·
utilisateur connecté (nom complet aujourd'hui) · réglages (thème, échelle, préférences).

**Badges de comptage live** sur certains onglets : Interventions (ouvertes, criticité),
Certificats (échéances), Images de façade (nombre) — mécanisme générique `count()`.

## 2 · Comportements ACTUELS à connaître

- **Wide screen** : la barre montre l'ICÔNE SEULE par onglet (libellé au survol) ; le groupe
  « Paramètres » se déroule ; les sous-vues ne sont PAS dans la barre (liens d'en-tête).
- **Responsive** : menu déroulant APLATI (`ShellNav.responsiveMenu`) — primaires à plat,
  groupe = en-tête + enfants indentés ; ⚠ les sous-vues de primaires (Groupes, Spares…) sont
  OMISES de ce menu (atteignables seulement en passant par leur parent).
- **Gating par droits** : chaque entrée a un prédicat `visible()` (permission de lecture) —
  TOUT onglet peut disparaître ; un utilisateur peut n'avoir que 2 entrées. Certaines vues
  sont API-seulement (Clusters, Interventions, Certificats, Notifications…).
- **Deep-links** : `#nom-de-vue` (les noms sont STABLES — un re-design ne doit pas les
  changer, ou le signaler explicitement) ; les fragments `#doc/…/fiche/…` sont réservés aux
  étiquettes QR.
- i18n fr/en intégrale.

## 3 · Douleurs identifiées (matière à re-design, pas une liste de solutions)

1. **11 entrées primaires** — la barre est chargée, l'icône seule exige la mémorisation.
2. **Deux mécanismes de sous-navigation différents** : groupe déroulant (Paramètres) vs
   liens d'en-tête (toutes les autres sous-vues) — incohérent et peu découvrable.
3. **Responsive** : long menu à plat, sous-vues invisibles, et le NOM COMPLET de
   l'utilisateur mange la topbar (un correctif est déjà décidé : icône seule + modale
   d'infos au clic — l'intégrer à la réflexion).
4. Les badges (Interventions/Certificats) doivent rester visibles dans TOUT régime — c'est
   de l'alerte opérationnelle, pas de la décoration.

## 4 · Contraintes

- Primitives/tokens du design system (galerie synchronisée dans ce projet) ; fr d'abord.
- La nav doit rester COHÉRENTE quand des entrées disparaissent (droits partiels).
- Ne pas casser : deep-links `#nom`, badge de comptage générique, groupe extensible
  (d'autres groupes pourront naître), topbar (loupe/scan/undo/état de sauvegarde).
- Tactile : cibles ≥ 44 px, tout doit être atteignable ET refermable au doigt.

## 5 · Livrable attendu

Une maquette HTML dans `explorations/` (« Menu de l'app - maquette ») montrant : la
navigation wide screen ET responsive (les deux à parité de soin), le pattern UNIFIÉ de
sous-navigation, l'emplacement des badges, la zone utilisateur (avec le correctif icône +
modale d'infos), et les recommandations tranchées en notes. Si le re-design propose de
regrouper des primaires, montrer le AVANT/APRÈS de la barre.

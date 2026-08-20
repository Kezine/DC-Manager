# Navigation — menu à DEUX NIVEAUX (domaines ▸ vues)

Architecture du menu de l'application, dans ses deux régimes (grand écran et responsive).
Re-design du 2026-08-20, à partir de la maquette `design-system/briefs/menu-app-redesign-maquette.html`
(réalisée par Claude Design sur le carton `menu-app-redesign.md`).

La règle de partage habituelle s'applique : ce document est pour le **développeur**. Il n'y a rien
ici pour le déployeur (le menu ne se configure pas), et le mode d'emploi destiné à l'utilisateur
final relève de la future aide **in-app**, pas de `docs/`.

## 1 · Le problème que ce re-design résout

L'ancien menu accumulait trois défauts, tous constatés dans le carton :

1. **Onze onglets primaires** dans une barre unique, rendus en **icône seule** — le libellé
   n'apparaissait qu'au survol, donc la barre exigeait de mémoriser onze pictogrammes.
2. **Deux mécanismes de sous-navigation concurrents** : un groupe déroulant (« Paramètres », seul
   de son espèce) et des **liens d'en-tête** pour toutes les autres sous-vues. Deux gestes à
   apprendre pour une même intention, et aucun des deux n'était découvrable.
3. **En responsive**, un menu déroulant **aplati** qui **omettait purement et simplement** les
   sous-vues des primaires : Groupes, Spares, Sous-équipements, Applications, Pièces jointes,
   Images de façade n'apparaissaient nulle part et n'étaient atteignables qu'en passant par leur
   vue parente.

## 2 · Le modèle : `app/NavModel` (PUR, testé)

Toute la logique vit dans un module **sans DOM ni Shell**, donc testable en isolation — même raison
d'être que `ShellNav`, qui conserve les helpers de hash. Le Shell ne fait que **peindre** ce que le
modèle a **résolu**.

```
niveau 1 — DOMAINE  : Inventaire · Implantation · Réseau · Exploitation · Paramètres
niveau 2 — VUE      : toutes les vues du domaine, dans une barre de pastilles
```

Un **domaine est un regroupement, pas une vue** : il n'a ni `<section>`, ni corps, ni hash. C'est
exactement le **piège ①** de l'ancien `kind:"group"` — lequel disparaît, « Paramètres » devenant un
domaine comme les autres. Cliquer un domaine active sa **première vue visible**.

### `NAV_DOMAINS` — la carte vue → domaine

Le catalogue vit **dans le module**, et non dans `main.ts`, pour la même raison que
`core/ViewAccess` : un **test d'exhaustivité** peut alors relire les sources de `main.ts`, y trouver
toute vue enregistrée, et **échouer en la nommant** si elle n'est rattachée à aucun domaine. Une vue
ajoutée demain ne peut donc pas disparaître silencieusement du menu — elle n'aurait sinon plus aucun
chemin d'accès, hors deep-link. Le même verrou refuse les entrées **périmées** (vue supprimée ou
renommée) et les **doublons** (une vue dans deux domaines = deux chemins, deux surlignages).

Les libellés sont des **clés i18n** et les icônes des **noms de constantes** du registre `ui/Icons` :
le module reste pur, c'est l'appelant qui résout les unes et les autres.

### `resolve()` — la structure à peindre

`resolve(domains, views, isVisible)` rend `{ domains, flattened }` pour un jeu de droits donné, en
appliquant les **règles de dégradé** de la maquette (§ 04) :

| Situation | Rendu |
|---|---|
| Domaine sans aucune vue visible | il **disparaît** |
| Domaine réduit à **une** vue visible | onglet **direct** (`direct:true`), sans barre de vues |
| **Un seul** domaine visible | le niveau 1 **s'efface** (`flattened:true`), ses vues deviennent le niveau 1 |
| Plus aucune vue visible | aucun domaine — l'écran « aucun accès » couvre l'app |

Un **séparateur** (regroupement visuel interne à un domaine, ex. `… | VMs · Clusters | Wifi`) qui se
retrouverait **en tête de barre** parce que les droits ont masqué la vue qui le précédait est
**supprimé** : pas de trait orphelin au bord.

Ces règles sont importantes parce que le gating par droits peut réduire l'app à très peu de chose —
un utilisateur peut n'avoir accès qu'à deux entrées (cf. `docs/auth.md` § « Gating côté client »).
La navigation doit rester **cohérente** dans tous ces états, pas seulement dans le cas nominal.

## 3 · 🚨 Règle (A) — les compteurs ne vivent que sur les entrées TERMINALES

**Décision utilisateur du 2026-08-20, qui tranche CONTRE la maquette.** La note « 4 · Badges qui
remontent » de celle-ci proposait d'agréger les badges sur le domaine (couleur = sévérité max,
nombre = somme) et sur le bouton burger en mobile. Ce n'est **pas** ce qui est implémenté.

Un badge de comptage n'appartient qu'à une entrée **sans enfant** :

| Entrée | Badge |
|---|---|
| Vue (niveau 2) | **autorisé** |
| Domaine (niveau 1) | **jamais** — il a des enfants |
| En-tête d'accordéon du tiroir mobile | **jamais** — c'est un domaine |
| Bouton burger | **jamais** — il ne représente rien de terminal |
| Onglet direct (domaine réduit à une vue) | **autorisé** — il pointe vers une seule vue, il est terminal |

Cette dernière ligne mérite d'être lue deux fois : la règle porte sur les **enfants**, pas sur le
**niveau visuel**. Un bouton de niveau 1 qui ne mène qu'à une vue est terminal, son badge est licite.

**Comment la règle est tenue.** Elle est appliquée à la **construction**, pas au câblage : chaque
entrée résolue sort avec un booléen `badge` que le rendu se contente de **lire**. Le Shell n'écrit
jamais lui-même « si c'est un domaine alors pas de badge » — cette condition n'existe nulle part
dans le rendu. Une vue qui déclarerait un `count()` sans y avoir droit sortirait à `badge:false`
sans que personne ait à y penser.

`NavModel.allowsBadge(children?)` prend les **enfants eux-mêmes** plutôt qu'un drapeau « terminal » :
l'appelant ne peut donc pas décider à la place de la règle. Et le `badge` d'un domaine est **dérivé**
de cet appel sur ses vues réelles, pas codé en dur — l'invariant « jamais de badge sur un domaine »
est ainsi **prouvé par le test** plutôt qu'affirmé par le type.

La règle se lit sur la structure **déclarée**, jamais sur la visibilité courante. Sinon un domaine
dont les droits masquent tous les enfants sauf un verrait un badge **apparaître**, et le même compte
clignoterait d'un utilisateur à l'autre.

### ⚠ Conséquence assumée : l'alerte n'est pas visible partout

La douleur n°4 du carton demandait que les badges d'alerte (interventions critiques, certificats
expirants) restent visibles **dans tout régime** — « c'est de l'alerte opérationnelle, pas de la
décoration ». La règle (A) l'en empêche partiellement : une alerte n'est visible que lorsque la
**barre de vues de son domaine** est affichée, donc pas depuis un autre domaine, ni tiroir fermé en
mobile.

Cette tension est **connue et assumée** : la règle (A) prime. Si la remontée d'alerte est voulue, elle
devra passer par un **porteur hors menu** (une cloche de notification dans la topbar, par exemple),
jamais par un badge sur une entrée parente.

## 4 · Le rendu : qui peint quoi

Le modèle résout, le Shell peint. Trois surfaces, trois responsabilités :

| Surface | Où | Ce qu'elle peint |
|---|---|---|
| Barre de **niveau 1** (`.tabs`) | `Shell.buildDomainBar()` | les **domaines** (icône + libellé), ou les **vues** de l'unique domaine si `flattened` |
| Barre de **niveau 2** (`.views-bar`) | `Shell.buildViewsBar()` | les **vues** du domaine actif, en pastilles, séparateurs compris |
| **Tiroir** responsive (`.nav-drawer`) | `app/ShellDrawer` | un **accordéon par domaine**, contenant toutes ses vues |

Le tiroir a **son propre fichier** (principe n°2 : `Shell.ts` est déjà un monolithe) et n'est couplé
au Shell que par l'interface injectée `ShellDrawerHost` — même patron que `PositioningTool`/
`PositioningHost`. Il ne lit ni le Store, ni les droits, ni le registre des vues : il reçoit la
structure **déjà résolue** et demande le reste (badge d'une vue, identité, état de sauvegarde) à son
hôte.

**Reconstruction conditionnelle.** `refreshCounts()` est appelée à chaque bascule d'onglet, chaque
rafraîchissement de vue et chaque comptage résolu. Reconstruire le DOM du menu à chaque fois volerait
le focus clavier au milieu d'une navigation : le Shell compare donc une **signature** de la structure
(domaines × vues × aplatissement) et ne rebâtit que si elle a changé. Les valeurs de badge, elles,
sont réécrites à chaque passage — elles ne changent pas la structure.

**Le masquage par droits n'est plus un `display:none` posé après coup.** Une vue invisible est
**absente** de la structure résolue, donc absente de tous les chemins à la fois. L'ancien registre
`viewNavEls` (qui devait énumérer chaque nœud de navigation menant à une vue, sous peine de laisser
une porte ouverte) disparaît avec sa classe de bugs.

### Responsive : ce qui quitte la topbar sous 760 px

Le burger et le tiroir prennent le relais des deux barres. Sortent aussi de la topbar les contrôles
que le tiroir reprend **de première classe** : la **pastille utilisateur** (en-tête du tiroir, qui
ouvre la même modale d'infos) et **annuler/rétablir** (pied du tiroir).

Restent en topbar, à dessein : les actions **fichier** (nouveau / ouvrir / enregistrer / copie) et le
déclencheur des **réglages**. Le tiroir n'en offre pas de copie, et le mode fichier doit rester
entièrement utilisable sur petit écran (principe n°15). C'est un écart assumé à la maquette, dont la
topbar mobile ne portait que marque, loupe, scanner et burger.

**Les contrôles restent collés au bord DROIT.** Au-dessus du breakpoint, c'est `.tabs` (`flex:1`) qui
pousse la rangée d'actions à droite ; sous 760 px la barre d'onglets est `display:none` et cet appui
disparaît — d'où le `margin-left:auto` posé sur `.topbar-actions` dans le bloc responsive. Sans lui
les contrôles se tassaient contre la marque, et le burger quittait le bord de l'écran, là où le pouce
l'atteint.

> ⚠ **Piège de spécificité (corrigé).** La règle qui masque le burger hors responsive doit porter
> `.icon-btn.topbar-burger`, pas `.topbar-burger` seul : à spécificité égale (0,1,0), c'est la règle
> la plus **tardive** qui gagne, et `.icon-btn { display:inline-flex }` est déclarée plus bas dans la
> feuille. Le burger s'affichait donc sur grand écran, à côté des deux barres qu'il est censé
> remplacer.

### Les réglages : une modale dédiée, deux déclencheurs

Le panneau des **réglages** vit dans `app/SettingsPanel` — sa **propre classe, son propre fichier**
(principe n°2, même raison que le tiroir), couplé par l'interface injectée `SettingsPanelHost`, que
`ShellHost` **étend** : le bootstrap ne fabrique qu'un seul objet d'hôte et le Shell le passe tel quel.

Ce panneau est le **corps d'une modale de la pile standard** (niveau `info`, `stackKey: "settings"`),
plus un popover ancré à la topbar. Le popover était `position:absolute` dans la topbar, plafonné en
hauteur et refermé par tout clic au document ; surtout, il n'avait qu'**un** point d'ouverture
possible — son ancre. Le pied du tiroir devait donc **simuler un clic** sur le bouton de la topbar
(`settingsBtn.click()`) faute de pouvoir le peindre ailleurs. Les deux déclencheurs — bouton de la
topbar et bouton « Réglages » du pied du tiroir — ouvrent désormais **la même instance** par un appel
direct, sans dépendance invisible à un bouton tiers.

> 🚨 **Le corps du panneau est construit UNE fois et gardé vivant** (détaché entre deux ouvertures).
> C'est ce qui permet aux reflets (`setTheme`, `setUiScale`, `setAutosave`, `setExportAllowed`…)
> d'être posés **à tout moment** par le bootstrap, modale fermée comprise — exactement comme du temps
> du popover, qui vivait en permanence dans le DOM. `Modal` ne détruit jamais le corps d'un niveau,
> l'invariant tient. Le reconstruire à chaque ouverture obligerait à rejouer tout l'état au bon
> moment, et une seule omission ferait mentir un contrôle.

En **mode visualiseur**, la barre d'actions ne garde que ce déclencheur (`.topbar-settings`) **et le
burger** (`.topbar-burger`) : sous 760 px le tiroir est le seul chemin de navigation, le masquer
laisserait une application sans menu du tout.

### Écran d'accueil : la navigation doit rester inerte

Tant qu'aucun document n'est ouvert (`body.welcome-active`), tout chemin de navigation est neutralisé.
Les deux barres, le burger et le tiroir portent la classe `topbar-needs-doc` prévue pour ça : la liste
de sélecteurs du CSS n'a donc pas à s'allonger à chaque nouvel élément de menu. Sans cette
neutralisation, on pourrait cliquer une pastille de vue et naviguer dans une application **sans
document chargé** — une régression fonctionnelle, invisible sur un poste de développement où un
document est toujours ouvert.

## 5 · Ce qui a disparu

- **Le mécanisme de groupe** (`Shell.addGroup`, `kind:"group"`, `GroupEntry`, boutons déroulants
  d'onglet, CSS `.tab-group`). « Paramètres » est un domaine ordinaire.
- **Les liens d'en-tête** (`ShellView.links`) : la barre de vues les rend intégralement redondants. Le
  champ est **retiré**, pas seulement ignoré — un champ qui ne fait plus rien finit par être renseigné
  de bonne foi par le contributeur suivant.
- **Le bouton « ← retour »** de l'en-tête, remplacé par le **fil d'Ariane** `domaine › vue` (et ses
  deux clés i18n `shell.header.back*`).
- **Le menu déroulant aplati** du responsive (`.tabs-dd*`, `ShellNav.responsiveMenu`), remplacé par le
  tiroir à accordéons — avec lui part `ShellNav.ancestorGroup`, qui n'avait de sens que pour surligner
  un groupe.
- **Le registre `viewNavEls`** du Shell : le masquage par droits est désormais structurel (§ 4).

## 6 · Ce qui n'a PAS bougé (contraintes dures)

- **Les deep-links `#nom`** de toutes les vues. Seule leur **place dans le menu** change. Un
  bookmark, un lien partagé ou une navigation programmatique existants continuent de fonctionner.
  Un **nom de domaine n'est pas un hash valide** : `ShellNav.resolveHash` le refuse, au même titre
  qu'il refusait un nom de groupe.

  > ⚠ **Piège en lisant la maquette.** Son tableau « Où va chaque entrée actuelle » affiche des
  > deep-links **fictifs** — elle a inventé des identifiants lisibles (`#pieces-jointes`,
  > `#images-facade`, `#types-cable`, `#reseaux-ip`, `#plages-dhcp`, `#netmap`, `#datacenters`,
  > `#sous-equipements`) là où l'application utilise `#attachments`, `#faceimages`, `#cabletypes`,
  > `#ipnetworks`, `#dhcpranges`, `#graph`, `#datacenter`, `#sousequipements`. La promesse de la
  > maquette (« aucun `#nom` ne change ») est **tenue**, mais ce sont les noms **réels** qui sont
  > conservés, pas ceux de son tableau. `NAV_DOMAINS` ne référence que des noms réels — et le verrou
  > d'exhaustivité échouerait aussitôt sur un identifiant inventé, puisqu'aucune vue de `main.ts` ne
  > porterait ce nom.
- **Le gating par droits** : chaque vue garde son prédicat `visible()`, et le verrou de test qui
  relit les sources de `main.ts` (`test-client-access.js`) reste vert.
- **Le mécanisme de comptage** `count()` / `countClass()` lui-même : seule la question « qui a le
  droit d'afficher un badge » change.
- **Le logo et la marque.** La maquette contenait un logo de **substitution** (Claude Design ne
  disposait pas du vrai) : il a été ignoré. Le glyphe officiel — trois cercles reliés — est
  conservé verbatim, dans la topbar comme sur l'écran d'accueil.
- **La topbar** : loupe (Ctrl+K), scanner d'étiquette, undo/redo, état de sauvegarde, pastille
  utilisateur, réglages. Le correctif « icône utilisateur + modale d'infos » livré au lot R1
  (`0682241`) est réutilisé tel quel, pas réécrit.

## 7 · Mode local

Aucun écart. Le menu ne dépend d'aucun service : en mode fichier, l'état d'autorisation vaut « tout
permis » **par construction** (injection nulle, cf. `docs/hydratation.md` et `docs/auth.md`), donc
`isVisible` rend vrai partout et les cinq domaines s'affichent. Les vues API-seulement (Clusters,
Interventions, Certificats, Notifications) restent absentes en mode fichier comme avant — leur
domaine se réduit alors mécaniquement par les règles de dégradé du § 2, sans code spécifique.

## 8 · Étendre

- **Nouvelle vue** → l'enregistrer comme d'habitude *et* l'ajouter au domaine voulu dans
  `NAV_DOMAINS`. Si on l'oublie, le verrou d'exhaustivité échoue en nommant la vue : c'est le
  comportement voulu, pas une gêne.
- **Nouveau domaine** → une entrée de plus dans `NAV_DOMAINS`, plus ses deux libellés i18n (fr *et*
  en — le test de complétude échoue sinon). La maquette note qu'au-delà de six domaines la barre
  devrait passer en défilement plutôt qu'en icônes ; ce seuil n'est pas atteint.
- **Nouveau badge** → déclarer `count()` sur la vue. Rien d'autre : si l'entrée est terminale, le
  badge apparaît ; sinon la règle (A) le refuse silencieusement, ce qui est le bon comportement.

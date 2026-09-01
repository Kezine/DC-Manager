# Liens directs — une URL pour chaque élément, et pour une recherche

Chantier du 2026-09-01. Toute chose consultable de l'application a une **URL directe** ; toute
modale d'info porte un bouton qui la **copie** ; une URL peut aussi **ouvrir la recherche**
pré-remplie.

Ce document est pour le **développeur**. Rien ici ne concerne le déployeur (aucune variable
d'environnement n'a été ajoutée), et le mode d'emploi destiné à l'utilisateur final relève de la
future aide **in-app**.

## 1 · La grammaire, en entier

Tout vit **dans le fragment** (après le `#`), qui n'est transmis à aucun serveur.

```
doc/<docId>/fiche/<collection>/<id>[?vue=1]   fiche d'un objet du document
doc/<docId>/intervention/<id>                 intervention (base serveur séparée)
doc/<docId>/cert/<id>                         certificat   (base serveur séparée)
doc/<docId>/recherche/<texte>                 palette de recherche pré-remplie
```

**Toutes les formes portent le document**, y compris les deux familles dites « hors document » :
leurs tables serveur sont bien indexées par `doc_id` (`InterventionsDb`, `CertsDb`), donc la bascule
de document leur vaut aussi. **Toutes contiennent des `/`**, et aucun nom de vue n'en contient : les
deep-links de vue historiques (`#equipements`) restent hors d'atteinte du routeur — c'est ce qui
permet aux deux langages de cohabiter dans le même fragment sans jamais se disputer.

La **source unique** de cette grammaire est [`src-shared/AppLink`](../src-shared/AppLink.ts) —
partagée front ⇄ back, pure, testée (`Tests/modules/test-app-link.js`).

> 🚨 **`EntityLink` reste la source de vérité de la forme « fiche ».** Ce format est **gravé dans des
> étiquettes QR déjà imprimées** : il est **intangible**, et toute évolution lui est **additive**.
> `AppLink` lui **délègue** `parse`/`fragment` ; il ne recopie jamais sa logique. Le test vérifie
> qu'un fragment sans `?vue=1` est **bit pour bit** celui d'`EntityLink`.

## 2 · 🚨 Le paramètre `?vue=1`, et pourquoi il sauve le chantier

La demande d'origine était « le lien ouvre le bon onglet **et** la modale ». Appliquée sans nuance,
elle aurait changé le comportement de **toutes les étiquettes déjà imprimées** : scanner un
équipement depuis l'onglet « Câbles » aurait fait perdre le contexte de travail en cours.

La synchronisation d'onglet est donc **conditionnée à un paramètre**, et le **bouton « copier le
lien » l'inclut par défaut**. Conséquence, qui est tout l'intérêt du choix :

| Provenance du lien | `?vue=1` | Comportement |
|---|---|---|
| **QR déjà imprimé** (et tout lien d'avant le chantier) | absent | la fiche s'ouvre **par-dessus l'onglet courant** — exactement comme avant |
| **Bouton « copier le lien »** | présent | l'onglet de l'objet est **activé**, puis la fiche s'ouvre par-dessus |

Le paramètre vit **dans le fragment** (`…/r9?vue=1`) et non dans une query string : rien ne part au
serveur, rien ne traverse le reverse-proxy, et il ne se mêle pas aux paramètres d'auth/OIDC des
retours de login.

> 🚨 **Le piège qu'il tend.** `EntityLink.parse` découpe sur `/` et exige **exactement 5 segments**,
> l'`id` étant le 5ᵉ. Un `?vue=1` laissé collé à l'id serait **avalé dans l'id** — « objet
> introuvable » sur un objet qui existe. `AppLink.splitFragment` sépare donc le suffixe **avant**
> toute délégation, **jamais l'inverse**. C'est testé sur l'`id` lui-même, pas seulement sur le
> drapeau : un test qui ne regarderait que `syncView` passerait au vert avec l'id cassé.

Les familles **hors document** ne portent jamais le paramètre : leur fiche est peinte **par leur
vue**, il n'y a pas d'autre chemin — l'activation fait partie de l'ouverture. Le lien de
**recherche** non plus : la palette est une surcouche, elle n'appartient à aucun onglet.

## 3 · Du lien à l'écran : qui fait quoi

```
   texte brut (hash au boot · hashchange · code scanné)
            │
            ▼
   AppLink.parse ────────────────► null  → ce n'est pas un lien direct : ShellNav reprend la main
            │ cible typée
            ▼
   AppLinkRouting.decide  (PUR)   « agir ici, ou changer de document d'abord ? »
            │
            ▼
   AppLinkOpener          (impératif)
            ├─ switch-doc → ouvre le document visé, puis continue
            ├─ fiche      → [si ?vue=1 : active la vue] puis cache → fetchOne → Forms.detail
            ├─ intervention/cert → active la vue (obligatoire), puis ouvre par le module
            └─ recherche  → ouvre la palette pré-remplie
```

| Module | Rôle |
|---|---|
| [`src-shared/AppLink`](../src-shared/AppLink.ts) | la **grammaire** : lire, écrire, et le **registre** `stackKey → adresse`. |
| [`core/AppLinkRouting`](../src-client/core/AppLinkRouting.ts) | la **règle du document** (pure, testée). Mode fichier ⇒ `docId` ignoré ; mode API ⇒ `open` ⇄ `switch-doc`. |
| [`core/CollectionViews`](../src-client/core/CollectionViews.ts) | la carte **collection → onglet**, verrouillée par test. |
| [`app/AppLinkOpener`](../src-client/app/AppLinkOpener.ts) | l'**exécution** : dépendances injectées, ne lève jamais, ne double aucun message. |

**L'ordre du boot fait tout**, et il n'a pas changé : la cible est capturée **tôt** (avant que
`Shell.switchView` ne réécrive le hash), puis consommée quand un document est **prêt**
(`documentOpened`), **après** la restauration de vue. Un lien porteur de `?vue=1` **remplace** alors
la vue restaurée — ce qui est exactement ce qu'il demande.

**Aucune boucle possible** quand le lien active une vue : `switchView` réécrit le hash en `#nom`, qui
n'est justement **pas** un lien direct — le `hashchange` suivant rend `null` et s'arrête.

### La carte collection → onglet, et pourquoi elle est explicite

La correspondance est **1:1 et complète** (21 collections à fiche ⇄ 21 onglets de liste), mais elle
n'est **pas devinable** : `datacenters` s'affiche dans l'onglet **salles**, et `ipAddresses` dans
l'onglet **ipam**. Une convention « nom en minuscules sans séparateur » aurait donc marché **19 fois
sur 21** — la pire des situations, puisque le défaut ne se voit que chez qui utilise ces deux
liens-là. D'où une carte écrite, et **deux verrous** (`Tests/modules/test-app-link-routing.js`) :

1. toute collection à fiche (`DetailForms.DETAIL_COLLECTIONS`) a un onglet déclaré, et aucune entrée
   n'est périmée ;
2. tout onglet nommé par la carte **existe réellement** dans `app/main.ts` (sources relues) — une
   carte cohérente avec elle-même mais nommant un onglet fantôme n'activerait rien, tout pareil.

Les **4** collections sans fiche (`ports`, `aggregates`, `rackItems`, `waypoints`) sont des
sous-objets : les inscrire promettrait une navigation qui n'existe pas.

### L'activation vérifie la visibilité AVANT d'agir

`Shell.switchView` se **replie sur la première vue accessible** quand sa cible est masquée par les
droits. Activer sans vérifier **déménagerait** donc l'utilisateur sur une vue arbitraire alors qu'il
ne demandait qu'une fiche. L'opener teste `isVisible` d'abord ; vue interdite ⇒ il n'active rien et
ouvre la fiche par-dessus ce qui est là (la fiche a sa propre garde, côté serveur).

## 4 · Le bouton « copier le lien »

Un **bouton-icône** (maillon de chaîne) dans `.modal-header-actions`, à gauche du plein écran — donc
**un seul point** pour toute l'application, et non 21 fiches à modifier.

Il apparaît **si et seulement si** le niveau affiché désigne un objet adressable, ce que décide le
**registre** `AppLink.fromStackKey` à partir de la `stackKey` que la modale passait **déjà** pour la
déduplication de pile.

> **Pourquoi dériver de la `stackKey`.** Les 21 fiches portent déjà `detail:<collection>/<id>`, qui
> **est** l'adresse de l'objet. Un champ explicite aurait été 21+ points d'écriture, donc 21
> occasions d'oublier — et un oubli est **silencieux** : pas de bouton, personne ne le voit. Ici,
> l'exhaustivité est **prouvée par un test** qui échoue en nommant la fiche sans lien.
>
> `ModalOptions.shareKey` permet de **surcharger** la dérivation, pour le cas — pas encore rencontré —
> où l'identité de **pile** et l'adresse **publique** devraient diverger. Une chaîne vide force
> l'absence de bouton (d'où `?? ""` et non `|| ""` à la construction du niveau).

Le lien est **recalculé au clic**, pas à la peinture : entre l'ouverture et le geste, le document
courant a pu changer, et c'est l'adresse de **maintenant** qu'on veut.

**La base est l'URL courante**, hash **et** query retirés (`AppLink.baseOf`). C'est l'adresse par
laquelle l'utilisateur accède réellement, donc celle qui marchera pour son collègue du même réseau ;
la query part avec le reste, car elle peut porter un retour d'authentification qui n'a rien à faire
dans un lien envoyé à quelqu'un. `PUBLIC_BASE_URL` reste réservée au **QR imprimé**, qui doit, lui,
survivre **hors** de l'application (cf. [`qr-scan.md`](qr-scan.md)).

### Ce qui n'a PAS de bouton, et pourquoi c'est voulu

Réglages, panier, viseur de scan, infos utilisateur, **contenu de baie**, images de façade,
notifications, et **tous les formulaires d'édition** : ce ne sont pas des objets consultables, ou ils
n'ont pas de fiche. Le registre rend `null`, donc aucun bouton — **aucune promesse non tenue**. Le
**visualiseur de pièce jointe** (`view:attachments/<id>`), lui, **replie sur la fiche** de la pièce
jointe, d'où l'aperçu s'ouvre.

## 5 · Le lien de recherche

Le bouton de la palette vit à côté du champ, au même endroit que le ✕ d'effacement — les deux
agissent sur ce qui est **saisi**, pas sur la palette.

Le point subtil est la **portée**, qui vient de deux gestes : tapée en préfixe (« eq: switch ») elle
vit **dans** le texte et se relit toute seule ; choisie d'un clic sur une pastille elle vit **hors**
du texte. Un lien qui ne porterait que la saisie perdrait donc la moitié des recherches.
`GlobalSearch.canonicalQuery` remet le préfixe devant : le lien reste **une** donnée, lisible et
tapable à la main, plutôt qu'un second paramètre à encoder, parser et tester.

Cette règle est **pure** et vit dans `core/GlobalSearch` : elle est la **réciproque exacte** de
`parsePrefix`, et c'est cette réciprocité qui rend le lien fidèle — elle est verrouillée comme telle.
Sans elle, un lien copié rouvrirait une **autre** recherche que celle affichée, sans que rien ne le
signale.

Une recherche **vide** n'est pas un lien : `AppLink.parse` la refuse, et le bouton ne se rend pas.
Une palette vierge est déjà à un Ctrl+K.

## 6 · Sécurité et droits

- `parse` est nourri de **texte non sûr** (QR scanné, lien collé) : la collection reste validée
  contre la **liste blanche** du schéma, les identifiants ne sont que des **clés de recherche**, et
  aucune navigation n'est décidée dans le module partagé — il rend une cible, l'appelant décide.
- Un lien est **partageable sans risque** : il ne divulgue qu'un identifiant, et l'autorisation est
  vérifiée **à l'ouverture**, côté serveur.
- Un **403** en vol est déjà dit une fois par `core/AccessDenial` (un **401** par `SessionExpiry`) :
  l'opener ne double jamais ces messages, sans quoi il mentirait sur la cause.
- Une **vue** interdite est absorbée sans déménagement (§ 3) ; pour les familles hors document, dont
  l'ouverture *exige* la vue, l'opener le dit une fois, dans les termes du lien.

## 7 · Mode local

Le bouton est **présent partout**, mode fichier compris : le principe n°15 demande que la
fonctionnalité soit **pensée** pour le local, pas qu'elle y soit identique, et masquer priverait
l'utilisateur autonome d'un geste qui marche.

**Écart assumé, et il est double :**

1. La base est alors une adresse **locale** (`file:///…/dc-manager.html`) : le lien vaut pour **ce
   poste**, comme signet personnel. C'est utile, et ce n'est pas partageable.
2. Le mode fichier n'a **pas d'identifiant de document** (« le document *est* le fichier ») alors que
   la grammaire exige un segment `doc/<docId>/`. On y pose la sentinelle partagée
   `AppLink.LOCAL_DOC` (`"local"`), sans risque de collision — un document serveur est toujours
   `doc-<uuid>` — et sans conséquence à la relecture, ce mode **ignorant** le `docId` (arbitrage n°1
   du chantier QR). ⚠ Un lien produit en mode fichier puis collé dans une instance **serveur**
   échouera donc, sur un message honnête (« document visé inaccessible »), jamais en silence.

Les **interventions** et les **certificats** n'existent qu'en mode API : leurs liens y sont refusés
par **injection nulle** (`externals: null`), qui produit un message explicite au lieu d'un silence —
aucun test de mode n'est écrit ni dans l'opener ni dans le routage.

La **recherche**, elle, fonctionne dans les deux modes : la palette est locale en mode fichier.

## 8 · 🚨 Étendre — brancher un nouvel élément

**Une ligne**, dans le registre `AppLink.STACK_KEY_FORMS` :

```ts
{ prefix: "ma-modale:", target: (rest, docId) => (rest ? { kind: "…", docId, id: rest } : null) },
```

…plus la `stackKey` que la modale passe **déjà** à `Modal.open` pour la déduplication de pile. Rien à
écrire dans la modale elle-même : le bouton apparaît, le lien se lit, le round-trip est testé.

Si la nouvelle forme mérite une **entrée de grammaire** (et non un repli sur une forme existante),
ajouter sa branche dans `AppLink.parse`/`fragment` et son ouverture dans `AppLinkOpener` — puis
étendre `Tests/modules/test-app-link.js`, qui vérifie le round-trip forme par forme.

**Nouvelle collection à fiche** → l'ajouter à `CollectionViews.VIEW_OF_COLLECTION`. Si on l'oublie,
le verrou échoue **en nommant** la collection : c'est le comportement voulu, pas une gêne.

## 9 · Ce que ce chantier ne fait PAS

- **Pas d'URL « vivante »** : ouvrir une fiche ne réécrit pas le hash, le fermer ne le nettoie pas.
  Le hash continue de refléter l'**onglet**, et le lien s'obtient par le bouton. L'URL vivante
  demanderait d'arbitrer `pushState` vs `replaceState`, d'empêcher le `hashchange` qu'on vient de
  provoquer de rouvrir la fiche, et de décider ce que « précédent » fait d'une **pile** de modales —
  une évolution à instruire seule.
- **Pas de lien vers un listing filtré** (`#equipements` + filtre cible) : c'est un second format à
  cadrer, avec sa propre question — quels filtres sont sérialisables ? (cf. les limites résiduelles
  du chantier lazy-load : filtres sur-page en régime pagé, tris sans colonne SQL).
- **Pas de lien vers la vue 3D cadrée** sur un objet.

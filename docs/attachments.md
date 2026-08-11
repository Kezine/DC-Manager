# Pièces jointes — collection `attachments` & binaires hors document

> Attacher des FICHIERS arbitraires aux éléments d'inventaire (convention de prêt d'un équipement,
> bon de commande, garantie, scan administratif) : les décrire, les retrouver par la recherche, les
> télécharger. Architecture en DEUX étages, et c'est la décision structurante du chantier (cadrage
> 2026-08-10, D1/D4) : les **MÉTADONNÉES** sont une collection ORDINAIRE du document (`attachments`),
> le **BINAIRE** vit HORS document — disque serveur en mode API, IndexedDB + fichier compagnon
> `.nmfa` en mode fichier. L'UI (formulaire, sections de fiches, sous-onglet) est un lot séparé.

## Le modèle : une collection ordinaire + un binaire à part

**`attachments`** (spec partagée `DataValidation.SPEC_FIELDS.attachments`) : `name` (libellé, requis),
`description`, `file_name` (nom d'ORIGINE, requis — download uniquement), `mime` (requis, ∈ liste
blanche), `size` (octets, posés par le SERVEUR à l'upload), et la CIBLE — `equipment_id` OU
`sub_equipment_id`, deux FK nullables à **exclusivité souple** (invariant, patron `applications`).

Parce que c'est une collection ordinaire, tout ce qui manquait au pipeline d'images est acquis
GRATUITEMENT : recherche Ctrl+K (search-v6, la cible résolue par lien — taper « SRV37 » remonte ses
pièces), **cascade**, **undo modèle**, verrou optimiste, changeset/SSE, listing générique, audit.

- **Cascade (D3) : supprimer la cible SUPPRIME ses pièces** — un `delete`, PAS un `detach` (une
  convention de prêt orpheline n'a pas de sens ; à comparer aux `applications`, qui SURVIVENT
  détachées, et aux images, bibliothèque PARTAGÉE jamais supprimée en cascade). Récursif par le
  moteur : équipement → ses sous-équipements → leurs pièces. Rien ne pointe vers une pièce jointe :
  sa propre règle de cascade est vide.
- **Le binaire ne suit PAS la cascade (D5)** : AUCUN unlink en ligne, nulle part. La purge des
  binaires orphelins est le travail EXCLUSIF de la **maintenance** (bouton existant). Conséquences
  voulues : l'**undo** d'une suppression (fichier ET API) recrée l'enregistrement et retrouve un
  binaire INTACT ; aucune hook post-transaction ; un crash entre « fichier écrit » et
  « enregistrement inséré » laisse au pire un orphelin rattrapé par la maintenance.
- `Store.attachmentsOfEquipment` / `attachmentsOfSubEquipment` (index FK, cf. `INDEX_SPEC.attachments`)
  sont la source unique des futures sections « Pièces jointes » des fiches.

## Mode API : binaires sur DISQUE, streamés

`DOCS_DIR/attachments/<docId>/<attachmentId>` — un dossier par document, l'**id opaque EST le nom de
fichier**. Motivation mesurée (D4) : better-sqlite3 est SYNCHRONE — un blob de dizaines de Mo dans la
base gèlerait le thread Node pour tous les clients ; sur disque, upload (multer **diskStorage**) et
download (`fs.createReadStream`) sont STREAMÉS, et le `.db` reste petit (VACUUM/backup/WAL inchangés).
Module : `src-server/src/AttachmentFiles.ts` (instance unique portée par `DocumentStore`).

Routes (sous `/documents/:docId`) — SEUL le binaire a des routes dédiées :

- **`POST /attachments`** — multipart `{ meta: JSON, blob: file }`, plafond **50 Mo** (limite multer ;
  un dépassement est rejeté par multer avant le handler). Discipline d'écriture : multer streame un
  `.tmp-…` dans le dossier CIBLE → validation (meta JSON, liste blanche MIME, spec partagée, id sûr,
  création stricte 409) → `promote` (**rename atomique** vers l'id) → **insertion de l'enregistrement
  via le dépôt standard** : la création passe par `resolveRepo` comme toute écriture (rev++, verrou,
  SSE) avec un changeset ciblant la collection `attachments` (règle `/attachments` d'`ApiRules.buildChangeset`).
  Échec d'insertion → unlink du fichier (le seul unlink « en ligne » légitime : l'enregistrement n'a
  jamais existé). Le serveur fait AUTORITÉ sur `size` (taille réelle reçue, jamais crue du client).
- **`GET /attachments/:id/blob`** — download STREAMÉ, `Content-Type` stocké,
  **`Content-Disposition: attachment` TOUJOURS** (D6, cf. Sécurité), 404 si l'enregistrement OU le
  fichier manque.
- **Tout le reste passe par les routes GÉNÉRIQUES de collection** : listing, lecture, édition de
  métadonnées (renommer/décrire/recibler), suppression (sans unlink — D5), `/transact` (undo client).

**Maintenance** (`POST /maintenance`, étendue) : purge les fichiers de `attachments/<docId>/` dont
l'id n'existe PLUS dans la collection (`purgedAttachments` + octets dans le rapport) — les ids
référencés sont les ids de la **table `attachments`** (requête sur la collection, pas un scan des FK)
— plus les temporaires d'upload abandonnés. **Suppression d'un document** : le dossier
`attachments/<docId>/` est emporté avec le `.db`.

**Sauvegarde/restauration d'un document serveur = le `.db` ET son dossier `attachments/<docId>/`**
(cf. `src-server/RUN.md` § Données) — un `.db` restauré seul laisse des enregistrements dont le
download répond 404.

## Mode local (principe n°15) : AUCUN écart

La fonctionnalité est native en mode fichier : la collection vit dans le `.json` comme les autres
(validation partagée = même garde-fou), les binaires en **IndexedDB** (`dc-manager-attachments`,
backend `IdbAttachmentBackend`) et dans le fichier **compagnon `.nmfa`** à côté du `.json` (décision
D7 : un compagnon SÉPARÉ du `.nmfb` d'images — les cycles de vie diffèrent, une bibliothèque d'images
partagée à import-écrasement mélangée aux pièces par entité rendrait l'import de bibliothèque
destructeur pour les pièces).

- **Appariement** par clé `meta.attachmentsKey` (gravée dans le `.json` ET le manifeste du `.nmfa`) —
  patron exact de `meta.facesKey`.
- **Ouverture** (`FileDocuments.loadCompanionAttachmentsOnOpen`) : nom mémorisé (`meta.attachmentsFile`)
  → convention `<json>.nmfa` → SCAN du dossier par signature (mode dossier) ; handle mémorisé +
  permission (mode fichier simple). ⚠ Résolution AUTOMATIQUE seulement à ce lot : pas de dialogue de
  ré-association dédié (celui des images arrive avec l'UI du lot B) — un compagnon introuvable est
  tracé (logs `fs`) et silencieux.
- **Sauvegarde** : `saveCompanionAttachments`, jumeau de `saveCompanionFaces` (mode dossier sans
  picker ; garde ANTI-ÉCRASEMENT : si des enregistrements existent mais qu'AUCUN binaire n'est
  disponible localement — compagnon jamais chargé — on n'écrit PAS, pour ne pas écraser un `.nmfa`
  potentiellement complet par un bundle vide).
- **Maintenance** (bouton « Nettoyer les images non utilisées ») : purge AUSSI les binaires de pièces
  dont l'enregistrement a disparu (`AttachmentStore.keepOnly(ids de la collection)`) — même doctrine
  D5 que le serveur.

## Format `.nmfa` (et la généralisation `.nmfb`)

Les DEUX compagnons partagent la même ENVELOPPE, extraite dans **`src-client/data/BinaryBundle.ts`**
(l'ancien code de bundle d'`ImageStore`, généralisé — émission BIT-IDENTIQUE à l'historique, prouvée
par golden dans `test-attachments.js`) :

```
[0..3]  signature ASCII (« NMFB » images · « NMFA » pièces jointes)
[4]     version du conteneur (1)
[5..8]  longueur du manifeste JSON (uint32 LE)
[9..]   manifeste JSON (UTF-8), puis les blobs concaténés dans l'ordre du manifeste
```

Manifeste `.nmfa` v1 : `{ v: 1, key, attachments: [{ id, type, bytes }] }` — le STRICT nécessaire au
binaire ; les métadonnées riches (nom, cible, description) vivent dans le `.json`, source unique.
Les deux signatures sont ÉTANCHES (un `.nmfa` n'est pas lisible comme `.nmfb`, et réciproquement).

## Sécurité

- **Liste blanche MIME PARTAGÉE** (`Schema.ATTACHMENT_MIME_TYPES` + `isAttachmentMime`) : PDF,
  PNG/JPEG/WebP, ODT/ODS/DOCX/XLSX, TXT/CSV. **JAMAIS `text/html` ni `image/svg+xml`** (un document
  exécutable resservi par l'origine = XSS stocké — même doctrine que `IMAGE_MIME_TYPES`). Appliquée
  TROIS fois : filtre front à la sélection (lot B), REJET 400 serveur à l'upload, et INVARIANT de la
  collection (toute écriture — édition de métadonnées comprise : on ne peut pas requalifier un
  binaire en type interdit après coup).
- **`Content-Disposition: attachment` TOUJOURS** (D6, RÉVISÉ 2026-08-11) : le DOWNLOAD serveur reste la
  règle — le binaire n'est JAMAIS servi INLINE par l'origine (le `nosniff` global reste en défense en
  profondeur). L'affichage inline n'existe QUE via le **viewer CLIENT** (cf. § Viewer), sur un `blob:`
  LOCAL au navigateur — jamais un flux servi par le serveur : le motif originel de D6 (XSS stocké resservi
  par l'ORIGINE) ne s'applique donc pas au viewer. Pour le PDF, la visionneuse NATIVE du navigateur est
  assumée (moteur sandboxé par le navigateur ; historique de CVE = risque résiduel documenté, repli =
  téléchargement). Le nom proposé au download = `file_name` ASSAINI par la classe pure `ContentDisposition`
  (contrôles/CRLF retirés — anti-injection d'en-tête —, repli ASCII pour le paramètre `filename`, nom
  fidèle RFC 5987 dans `filename*`).
- **Path traversal impossible PAR CONSTRUCTION** (D4) : aucune entrée utilisateur n'entre dans un
  chemin — les segments sont le docId (du registre) et l'id de pièce, VALIDÉ (`AttachmentFiles.isSafeId` :
  alphanumériques + `._-`, jamais de point en tête, jamais de séparateur) à chaque composition de
  chemin. Le nom d'origine ne vit QUE dans les métadonnées et l'en-tête de download.
- **Plafond 50 Mo par pièce** (multer `limits`, en STREAM disque — jamais le binaire en RAM).

## Viewer intégré (cadrage B, 2026-08-11)

Afficher une pièce jointe SANS quitter l'app, **100 % client** (aucune route serveur) et dans les DEUX modes :
`AttachmentStore.getBlob(id)` est mode-agnostique (REST = `fetch → Blob`, `Content-Disposition: attachment`
n'affecte pas `fetch` ; fichier = lecture IndexedDB). Point d'entrée `AttachmentUi.view(host, att)`, à côté de
`download`. Surface : **modale de la pile**, niveau `info` (`hideFooter`, SANS `onSave` → s'empile partout, y
compris au-dessus d'un formulaire, garde D9b), `wide`, `stackKey: "view:attachments/<id>"`, pied = bouton
« Télécharger ». Binaire absent (`getBlob` → null) → toast `attachment.binaryMissing` (cas D8 du visualiseur
autonome).

**Cycle de vie de l'objectURL** : les rendus binaires (image, PDF) créent un `URL.createObjectURL` RÉVOQUÉ à
la fermeture du niveau via le callback `onClose` de `ModalOptions` (rappelé à toute disparition — ← Retour, ✕,
Échap, clic hors-modale, dédup de pile). Point de révocation UNIQUE : aucune fuite par ouvertures répétées
(même patron que `PerspectiveEditor.open`). Le viewer NE cache PAS l'objectURL dans `AttachmentStore` (chaque
ouverture porte son create/revoke).

**Choix du rendu** — module PUR testé `core/AttachmentViewKind.kindOf(mime, file_name)` → `image` | `text` |
`markdown` | `pdf` | `null`. Décision par **MIME d'abord, extension du `file_name` en repli** : un `.md`
historique stocké en `text/plain` rend en **markdown**, un `.csv` reste **texte**. `null` (ODT/ODS/DOCX/XLSX
et tout inconnu) = non visualisable → **pas de bouton « Afficher »**, téléchargement seul.

**Rendus** :
- **image** (PNG/JPEG/WebP) : `<img>` centrée, `max-width:100%; max-height:70vh; object-fit:contain`.
- **texte** (`text/plain`, `text/csv`) : `<pre>` rempli en **`textContent`** (jamais `innerHTML`), monospace,
  retour à la ligne. **TRONCATURE à 1 Mo affiché** (bandeau « Affichage tronqué — télécharger pour le fichier
  complet ») — la lecture elle-même est bornée à 1 Mo (un fichier de dizaines de Mo figerait l'onglet).
- **markdown** (`text/markdown`) : `Markdown.render` (défauts micromark SÛRS) dans la variante plein-cadre
  `.md-body-full` (largeur de lecture bornée, titres/blocs espacés, tables scrollables). Même troncature 1 Mo.
- **PDF** (**D-B1** : iframe native) : `<iframe>` sur l'objectURL, ~75vh, `title` accessible. **PAS d'attribut
  `sandbox`** (il bloque le plugin PDF de certains navigateurs) — le blob est local, jamais servi inline par
  l'origine (D6 révisé) ; le moteur PDF est sandboxé par le navigateur (risque résiduel assumé). Dégradation
  gracieuse : un navigateur qui ne rend pas l'iframe laisse le pied « Télécharger ». Validation
  multi-navigateurs (Chrome/Edge/Firefox) à faire À L'ŒIL.

**Politique d'images du markdown (D-B3)** — module PUR testé `core/MarkdownImagePolicy.classify(src, baseUri)`
→ `local` (`blob:`/`data:`) : rendue ; `same-origin` (résolue contre `document.baseURI` — respecte le `<base>`
du mode reverse-proxy sous-dossier) : rendue d'office ; `external` : REMPLACÉE par un lien cliquable sûr
(l'URL visible, jamais suivie automatiquement). S'il existe au moins une image externe, le viewer affiche un
bouton « Afficher les images externes » qui RE-REND en les autorisant, pour CETTE ouverture uniquement (aucune
persistance). La classification est pure (testable) ; la manipulation DOM vit dans `AttachmentUi`.

**Admission de `text/markdown` (D-B2)** : ajouté à `Schema.ATTACHMENT_MIME_TYPES` (les 3 gardes suivent). Le
sélecteur `ui/FilePicker` a un **repli extension → MIME** (table `{ .md/.markdown → text/markdown, .txt →
text/plain, .csv → text/csv }`) : `File.type` est souvent VIDE pour un `.md` (Windows/Firefox), donc quand le
type du navigateur est vide OU inconnu de la validation, le MIME est résolu par l'extension AVANT de valider,
et EXPOSÉ via `picker.mime` (consommé par `Forms.attachment` à la place de `file.type`). Les extensions sont
aussi ajoutées à l'attribut `accept`.

**Gestes d'ouverture (D-B4)** : bouton « Afficher » dans le pied de la fiche `attachmentDetail` (AVANT
« Télécharger », présent seulement si visualisable, le viewer s'empile dessus) ; action « Afficher » dans le
MENU de ligne du listing Pièces jointes (AVANT « Télécharger », présente seulement si visualisable). Les
sections « Pièces jointes » des fiches porteuses (équipement/sous-équipement) sont INCHANGÉES.

## Exports (D8)

L'export **JSON autonome** et le **visualiseur HTML** embarquent les MÉTADONNÉES (la collection fait
partie du document) mais **JAMAIS les binaires** — des PDF en base64 rendraient le fichier
impraticable. Le canal complet des binaires est le compagnon `.nmfa` (mode fichier) ou le dossier
serveur (mode API). L'avertissement UI au point d'export arrive avec le lot B
(cf. `FileDocuments.snapshotWithImages`).

## Limites assumées

- **Undo d'une suppression en mode API** : l'undo client recrée l'ENREGISTREMENT (via `/transact`) ;
  le binaire est toujours là (D5) TANT QUE la maintenance n'est pas passée entre-temps. Une
  maintenance intercalée laisse un enregistrement dont le download répond 404 — le re-upload est la
  seule réparation.
- **L'espace disque n'est récupéré qu'à la maintenance** (trade-off D5, identique aux images).
- **Compagnon `.nmfa` introuvable à l'ouverture** : silencieux à ce lot (résolution automatique
  seulement) — l'UI de ré-association est du lot B.

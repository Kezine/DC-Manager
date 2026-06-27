# NetMap — Migration vers un backend REST (Node.js + SQLite)

> Document de design vivant. On l'affine au fur et à mesure. Sections marquées
> `[décidé]` = arbitrage pris ; `[à préciser]` = ouvert.

## 1. Objectif

Permettre à NetMap de fonctionner soit en **mode fichier** (actuel : un `.json`
sur disque + compagnon `.nmfb` d'images, via File System Access API), soit en
**mode API/REST** (données servies par un backend Node.js + SQLite). Les deux
modes coexistent ; le mode fichier reste le comportement par défaut en usage
autonome (hébergement statique / ouverture locale).

## 2. Décisions de design

### 2.1 Modes & détection `[décidé]`
- Deux modes : `local` (fichier) et `api` (REST).
- **L'app sera probablement servie par le backend** et doit alors fonctionner
  **sans configuration utilisateur**.
- Détection au boot via une **config injectée** par le backend dans le HTML
  servi : `window.__NETMAP_CONFIG__ = { mode: "api", apiBaseUrl: "/api" }`.
  - Config absente → **mode `local`** (build statique autonome, double-clic).
  - Config `mode: "api"` → mode REST, `apiBaseUrl` **même origine** par défaut
    (`/api`), aucune saisie utilisateur.
- Le pref `dataSource` ("local"|"api") reste un repli/dev ; la config injectée
  **prime** quand elle est présente.

### 2.2 Authentification `[décidé]`
- **L'app ne gère PAS l'auth.** Un **SSO personnalisé externe** s'en charge.
- L'app **n'a pas de flux de login**. Elle transmet simplement les
  identifiants de session (cookies) au backend : `fetch(..., { credentials: "include" })`.
- La **validation est faite par le SSO**. Le backend NetMap peut soit valider
  lui-même via un endpoint SSO, soit **proxy le token** au SSO qui répond avec
  les infos utilisateur si la session est valide.
- Côté app : un appel type `GET /api/me` (proxifié au SSO par le backend)
  renvoie l'utilisateur courant (ou 401). En 401, l'app **ne tente pas de
  login** — elle laisse le SSO/redirection gérer. `[à préciser]` : comportement
  exact sur 401 (bannière « non connecté » vs redirection SSO).

### 2.3 Backend `[décidé]`
- **Node.js + SQLite.** Pleine liberté sur le contrat HTTP → on le définit ici
  pour coller exactement à `RestAdapter`.

### 2.4 Images / fichier compagnon `[décidé — à implémenter en P2]`
- La logique du **compagnon `.nmfb`** (et plus largement le stockage des blobs
  d'images de façade) doit passer **derrière l'abstraction d'accès aux données**.
- `ImageStore` ne parlera plus directement à IndexedDB / aux fichiers : il
  délèguera à un **backend d'images** fourni par l'implémentation du mode courant.
  - mode `local` → backend images = compagnon `.nmfb` (+ cache IndexedDB).
  - mode `api` → backend images = **endpoints blob** (`/images`).
- Conséquence : le protocole `.nmfb` / `facesKey` devient **interne au backend
  fichier** ; il n'existe pas en mode API.

### 2.5 Conditionnement de l'UI `[décidé — partiellement P0]`
- L'app **conditionne ses contrôles selon le mode** :
  - mode `local` : écran d'accueil (Rouvrir/Ouvrir/Nouveau), Ouvrir/Enregistrer/
    Enregistrer-sous, auto-save, compagnon, TabChannel (verrou inter-onglets).
  - mode `api` : **pas d'écran d'accueil fichier**, données chargées du serveur
    au boot ; pas d'Ouvrir/Enregistrer (sauvegarde continue via `transact`) ;
    pas d'auto-save ni de compagnon ; indicateur d'utilisateur connecté.

## 3. Arbitrages structurels (à trancher)

| Sujet | Option A | Option B | Statut |
|---|---|---|---|
| **`transact` atomique** | Endpoint serveur `POST /transact` appliquant le lot dans UNE transaction SQLite | Boucle d'appels par entité (actuel `RestAdapter`) — non atomique | **A** retenu (SQLite = transaction triviale). `[décidé]` |
| **Cascade de SUPPRESSION** | Calculée client (lot pré-étendu) ; le serveur applique tel quel | Logique **PARTAGÉE** (`shared/Cascade.ts`) appliquée des DEUX côtés : le `Store` en mode fichier, le serveur sur `DELETE` | **B** retenu `[décidé]` — un `DELETE /{coll}/{id}` naïf laissait des FK pendantes (le serveur n'était pas autorité). La cascade vit désormais une seule fois (principe n°3) et le serveur recompose deletes+détachements en UNE transaction. **⚠️ Limite : cascade NON récursive** (cf. §6). |
| **Logique clone/pose** | Reste **calculée client** ; le lot pré-étendu est le contrat ; le serveur applique tel quel | Déplacée **côté serveur** | `[à préciser]` — clone/pose restent client (pas de risque d'incohérence référentielle, contrairement au DELETE) |
| **Undo/redo en mode API** | Désactivé (boutons grisés) ; le serveur fait autorité | Endpoints serveur `POST /undo` `/redo` | `[à préciser]` — démarrer en **désactivé** |
| **Mono/multi-document** | **Un seul workspace** par backend (origine) | Ressource `/documents` + collections scopées | `[à préciser]` — démarrer **mono-workspace** |
| **Dirty / révision** | Jeton de révision **serveur** (remplace `histIndex`) | — | `[à préciser]` |

## 4. Contrat HTTP (cible, à figer avec le backend)

Base : `apiBaseUrl` (défaut même origine `/api`). Tous les appels en
`credentials: "include"`. JSON sauf blobs.

- `GET /me` → `{ user }` (proxifié SSO) ou `401`.
- `GET /{collection}?page=&pageSize=&q=&ids=&{champ}={valeur}` → `{ rows, total, page, pages, pageSize }`.
  - `q` : recherche plein-texte (le serveur doit répliquer la normalisation
    `Text.normSearch` : minuscule + sans accents) `[à préciser]`.
  - `where` : `{champ}={valeur}` ; **`null` sérialisé `"null"`** = « non rattaché ».
  - **champs-tableaux** (ex. `network_ids`, `waypoint_ids`) : sémantique
    d'appartenance (cf. `INDEX_SPEC`).
  - tri par défaut : `created_date` (parité `BrowserStorageAdapter`).
- `GET /{collection}/{id}` · `POST /{collection}` · `PUT /{collection}/{id}` · `DELETE /{collection}/{id}`.
- `GET/PUT /meta`.
- `POST /transact` `[nouveau]` : `{ creates[], updates[], deletes[], meta? }`
  appliqué **atomiquement**. Remplace la boucle actuelle de `RestAdapter.transact`.
- Images `[P2 — figé côté client]` :
  - `GET /images` → `[{ id, name, u_height, face, description, type, bytes }]` (métadonnées).
  - `GET /images/{id}` → métadonnées d'une image.
  - `GET /images/{id}/blob` → binaire (le miroir UI pointe cette URL ; même
    origine → cookies envoyés ; pas de pré-téléchargement au boot).
  - `PUT /images/{id}` → `multipart/form-data` `{ meta: JSON, blob: file }` (crée/remplace ; id client).
  - `DELETE /images/{id}`.
- **Pas de `PUT /snapshot` à l'ouverture** : en mode API, ouvrir = **fetch**,
  jamais push (sinon on écrase le serveur). `/snapshot` réservé à un import
  explicite dans un workspace vide.

## 5. Plan par phases

- **P0 — Rendre REST sélectionnable & instancié** ✅ *(fait)*
  - Config injectée (`window.__NETMAP_CONFIG__`) + détection au boot.
  - Branche d'instanciation `RestAdapter` (même origine, `credentials:"include"`)
    vs `BrowserStorageAdapter`.
  - Mode API **conditionne** la machinerie fichier (accueil, ouvrir/enregistrer,
    auto-save, compagnon, TabChannel masqués/désactivés).
  - En mode API : pas d'ensemencement (`newDocument`) → pas de `/snapshot` à l'ouverture.
- **P1 — Cœur du contrat** ✅ *(client + backend faits)*
  - ✅ `RestAdapter.transact` = **un seul `POST /transact`** (lot atomique côté serveur).
  - ✅ `RestAdapter.me()` → `GET /me` (user SSO) + pastille « connecté en tant que »
    dans la topbar (mode API).
  - ✅ Backend : `POST /transact` (1 transaction SQLite, `db.ts transact`) et `GET /me`
    (proxy SSO, `auth.validate`) ; `q`/`where`/pagination/tri implémentés (`db.ts list`).
- **P2 — Images** ✅ *(client + backend faits)*
  - ✅ `ImageBackend` (interface) : `ImageStore` délègue toute la persistance
    (miroir + undo + bundle `.nmfb` restent dans `ImageStore`, agnostiques).
  - ✅ `IdbImageBackend` (mode fichier, comportement inchangé) + `RestImageBackend`
    (endpoints blob ; le miroir UI pointe l'URL serveur, pas de pré-téléchargement).
  - ✅ Sélection du backend au boot selon le mode ; bouton « Ouvrir un fichier de
    faces » (compagnon) masqué en mode API.
  - ✅ Backend : endpoints `/images` implémentés (`api.ts` : list/get/blob/put/delete).
    Caveat connu : l'undo image en REST rejoue des PUT/DELETE (OK mono-utilisateur ;
    à revoir en multi-client).
- **P3 — Concurrence** *(fait, base)*
  - ✅ Révision de document (`rev`) ; entête `X-Doc-Rev` (rev en lecture, rev+1 en
    écriture) suivie côté client (`RestAdapter.docRev`).
  - ✅ Canal **SSE** `/documents/:docId/events` : à chaque écriture, les AUTRES
    clients reçoivent `{ rev }` et **rechargent** (le client ignore sa propre rev).
    Dernière-écriture-gagne + convergence par reload.
  - ✅ Undo/redo **désactivés en mode API** (boutons + raccourcis).
  - ✅ **Verrou optimiste par entité (409)** : chaque ligne porte `updated_rev` (rev
    du document à son dernier écrit) ; le client envoie `X-Base-Rev` (= son `docRev`)
    sur chaque écriture ; le serveur rejette en **409** si une entité visée a
    `updated_rev > base` (rejet AVANT incrément de rev / SSE). Grain ENTITÉ → deux
    éditions disjointes ne se gênent pas. UX : reload + toast conflit, **sans rejeu**.
  - ⏳ Reste : conflit *update-after-delete* (résurrection — non détecté faute de
    tombstone) ; undo serveur.
- **P4 — Multi-documents** : ✅ fait (registre `/documents` + un SQLite par document).

## 6. État au démarrage du chantier (constat d'analyse)

- `DataAdapter` : contrat complet et **réellement exercé** (tout passe par
  `Store`). Côté lecture, mappe proprement sur REST.
- `RestAdapter` existe mais : `transact` **non atomique** (boucle HTTP) ;
  undo/`histIndex` non gérés (no-op) → casse le « dirty » en l'état.
- Logique métier : la **cascade de suppression** est désormais PARTAGÉE
  (`shared/Cascade.ts`) — appliquée par le `Store` (fichier) ET par le serveur sur
  `DELETE` (autorité référentielle, plus de FK pendantes par appel API direct).
  Le reste (`cloneEquipment`, `removeSite`, ruptures de câbles) reste **calculé côté
  client** dans `Store` → cf. arbitrage §3.
- État hors-adapter aujourd'hui : images (IndexedDB + `.nmfb`), document fichier
  (`.json`), handles FS, prefs, view-state 3D, TabChannel.

### 6.1 Limites connues / dette

- **⚠️ Cascade NON récursive — À CORRIGER.** `Cascade.plan` ne fait qu'**un seul
  niveau** : les cas transitifs sont traités à la main dans les hooks `custom` (ex.
  supprimer un équipement supprime ses ports ET les câbles de ces ports). Mais une
  branche transitive NON couverte explicitement laisse des orphelins — p. ex. les
  **lanes de breakout** (`ports.parent_port_id`) d'un port appartenant à un
  équipement supprimé : l'équipement supprime ses ports, mais la règle des lanes
  (portée par `ports`, pas par `equipments`) n'est pas rejouée. Conséquence : des
  enregistrements pendants apparaissent en **usage NORMAL** (sans appel API brut).
  Le logiciel doit rester cohérent **sans intervention IT** → la cascade doit
  devenir **réellement récursive** (rejouer `Cascade.plan` sur chaque entité
  supprimée jusqu'au point fixe, avec garde anti-cycle), au lieu de dépendre de
  hooks `custom` exhaustifs. Vaut pour les deux modes (fichier + API), puisque la
  logique est désormais partagée. **Priorité : à planifier.**
- Conflit *update-after-delete* (résurrection) non détecté faute de tombstone ; undo
  serveur absent (cf. P3).
</content>

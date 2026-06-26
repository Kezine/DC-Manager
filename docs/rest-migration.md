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
| **Logique cascade/clone/pose** | Reste **calculée client** ; le lot pré-étendu est le contrat ; le serveur applique tel quel | Déplacée **côté serveur** (le serveur connaît l'intégrité référentielle) | `[à préciser]` — A plus rapide à livrer ; B plus robuste aux appels directs |
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
- **P1 — Cœur du contrat** *(client fait ; reste = backend)*
  - ✅ `RestAdapter.transact` = **un seul `POST /transact`** (lot atomique côté serveur).
  - ✅ `RestAdapter.me()` → `GET /me` (user SSO) + pastille « connecté en tant que »
    dans la topbar (mode API).
  - ⏳ Backend : implémenter `POST /transact` (1 transaction SQLite) et `GET /me`
    (proxy SSO). Figer `q`/`where`/pagination/tri (cf. §4).
- **P2 — Images** *(client fait ; reste = backend)*
  - ✅ `ImageBackend` (interface) : `ImageStore` délègue toute la persistance
    (miroir + undo + bundle `.nmfb` restent dans `ImageStore`, agnostiques).
  - ✅ `IdbImageBackend` (mode fichier, comportement inchangé) + `RestImageBackend`
    (endpoints blob ; le miroir UI pointe l'URL serveur, pas de pré-téléchargement).
  - ✅ Sélection du backend au boot selon le mode ; bouton « Ouvrir un fichier de
    faces » (compagnon) masqué en mode API.
  - ⏳ Backend : implémenter les endpoints `/images` (cf. §4). Caveat : l'undo
    image en REST rejoue des PUT/DELETE (OK mono-utilisateur ; à revoir en P3
    multi-client).
- **P3 — Concurrence** : ETag/version + conflits UX ; canal live (SSE/WS) ;
  politique undo (désactivé en API au départ).
- **P4 — Multi-documents** : décision produit ; éventuelle ressource `/documents`.

## 6. État au démarrage du chantier (constat d'analyse)

- `DataAdapter` : contrat complet et **réellement exercé** (tout passe par
  `Store`). Côté lecture, mappe proprement sur REST.
- `RestAdapter` existe mais : `transact` **non atomique** (boucle HTTP) ;
  undo/`histIndex` non gérés (no-op) → casse le « dirty » en l'état.
- Logique métier (cascade delete, `cloneEquipment`, `removeSite`, ruptures de
  câbles) **calculée côté client** dans `Store` → cf. arbitrage §3.
- État hors-adapter aujourd'hui : images (IndexedDB + `.nmfb`), document fichier
  (`.json`), handles FS, prefs, view-state 3D, TabChannel.
</content>

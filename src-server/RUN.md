# DC Manager — Lancer l'image & consulter les logs

Guide d'exploitation du conteneur (client + backend REST). Aucun Node requis en
local : tout est construit dans l'image. Voir aussi [README.md](README.md).

> Prérequis : **Docker Desktop** démarré (icône baleine active).
> Toutes les commandes se lancent depuis le dossier `src-server/`.

---

## 1. Lancer

```bash
cd src-server
docker compose up -d --build      # construit (client+serveur) et démarre en arrière-plan
```

- `--build` : reconstruit l'image (à refaire après chaque modif du code).
- `-d` : détaché (rend la main). Sans `-d`, les logs défilent dans le terminal.

Puis ouvrir **http://localhost:3000** (mode API, utilisateur `dev` factice).

> 1ʳᵉ build ≈ 3-6 min (build du client + deps natives). Les suivants sont en cache.

### Sans docker compose
```bash
# depuis la racine NetMap/ :
docker build -f src-server/Dockerfile -t dc-manager .
docker run -d --name dc-manager -p 3000:3000 -v dc-manager-data:/data dc-manager
```

---

## 2. Vérifier que ça tourne

```bash
docker compose ps                 # statut + ports (doit être "Up", health "healthy")
curl http://localhost:3000/healthz       # → {"ok":true}
curl http://localhost:3000/api/me        # → {"name":"dev","dev":true}
```

---

## 3. Consulter les logs

```bash
docker compose logs -f            # logs EN DIRECT (Ctrl+C pour quitter le suivi)
docker compose logs --tail 100    # les 100 dernières lignes
docker compose logs --since 10m   # depuis 10 minutes
```

Sans compose (par nom de conteneur) :
```bash
docker logs -f dc-manager
docker logs --tail 200 dc-manager
```

Au démarrage, le serveur logue une ligne du type :
```
DC Manager server → http://localhost:3000  (api /api)
```

### Niveau de logs (serveur)
Le serveur logue **chaque requête** (méthode, URL, code, durée) + les opérations
sur les documents. Verbosité réglable par **`LOG_LEVEL`** (dans `docker-compose.yml`) :

| `LOG_LEVEL` | Ce qui apparaît |
|---|---|
| `error` | uniquement les exceptions / 5xx |
| `warn`  | + les réponses 4xx |
| `info` *(défaut)* | + chaque requête réussie + création/suppression de documents |
| `debug` | + ouverture des dépôts (documents) |
| `trace` | + le healthcheck `/healthz` |

```bash
# changer le niveau à chaud :
#   éditer LOG_LEVEL dans docker-compose.yml puis
docker compose up -d
docker compose logs -f            # observer
```

Format : `2026-… INFO  [http] GET /api/documents → 200 (3ms)`.

Côté **client**, logs console séparés : **Réglages → Débogage → « Logs de
débogage »** (ou `DcManagerLog.enable()` en console) ; l'onglet **Réseau** (F12)
montre les URL exactes appelées.

---

## 4. Arrêter / redémarrer / reconstruire

```bash
docker compose restart            # redémarre (garde les données)
docker compose stop               # arrête (garde conteneur + données)
docker compose up -d              # relance
docker compose down               # arrête ET supprime le conteneur (données conservées : volume)
docker compose up -d --build      # reconstruit après une modif de code
```

---

## 5. Données & persistance

Les documents vivent dans le volume **`dc-manager-data`** (monté sur `/data`,
un fichier `.db` par document + `registry.db`).

```bash
docker volume ls                  # liste les volumes (cherche *dc-manager-data)
docker compose down -v            # ⚠️ SUPPRIME le volume → repart de zéro (perte des documents)
```

Inspecter le contenu du volume dans le conteneur :
```bash
docker compose exec dc-manager ls -la /data/documents
```

---

## 6. Configuration (variables d'environnement)

À régler dans `docker-compose.yml` (section `environment`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | port d'écoute |
| `API_BASE` | `/api` | préfixe des endpoints REST |
| `DOCS_DIR` | `/data/documents` | dossier des documents (registre + 1 `.db`/doc) |
| `SSO_URL` | *(vide)* | endpoint SSO externe qui valide la session (cf. ci-dessous). **vide → mode dev** |
| `COOKIE_NAME` | *(vide)* | nom du cookie contenant le jeton à proxifier au SSO (`""` = en-tête `Cookie` complet) |
| `DEV_USER` | `dev` | nom de l'utilisateur factice en mode dev |

### Authentification (SSO)
L'app **ne gère pas l'auth** : le serveur **proxifie le jeton** (cookie `COOKIE_NAME`)
au SSO externe (`SSO_URL`) qui renvoie l'utilisateur
(`logged`, `adminRight`, `expireDate`). Le résultat est **mis en cache** (clé =
hash du cookie) tant que le cookie ne change pas et que `expireDate` n'est pas
dépassée. **Accès autorisé uniquement si `logged` et `adminRight = "SUPER_ADMIN"`**
(sinon `403` ; le client affiche « accès refusé »).

- **Mode dev** (offline, défaut du `docker-compose.yml`) : `SSO_URL=""` →
  utilisateur factice `dev` en SUPER_ADMIN, tout est autorisé.
- **Mode dev + mot de passe** : `BASIC_AUTH=user:pass` (prioritaire sur le SSO) →
  le navigateur demande un user/mot de passe (HTTP Basic) ; identifiants OK →
  SUPER_ADMIN. Pratique pour protéger un serveur de dev sans le SSO.
- **Tester l'écran « accès refusé »** du client (en dev) : `DEV_RIGHT=NONE`
  (connecté mais sans droits) ou `DEV_RIGHT=ANON` (non connecté). Le client
  affiche alors le message sur l'écran d'accueil au lieu d'ouvrir un document.
- **SSO réel** : dans `docker-compose.yml`, renseigner `SSO_URL` (endpoint de validation
  de votre SSO) et, si besoin, `COOKIE_NAME` (nom du cookie portant le jeton ; vide =
  en-tête `Cookie` complet). Ex. `SSO_URL: https://sso.example.com/validate`.

Après modif du compose : `docker compose up -d` (recrée le conteneur).

---

## 7. Importer un document `.json` dans la base

Script `scripts/import-json.mjs` : crée un document serveur depuis un export
`.json` (format mode-fichier), pousse les données, et importe les images de
façade (inline `faceImages` **ou** compagnon `.nmfb`).

```bash
# serveur lancé (dev) :
node scripts/import-json.mjs ../Samples/mondoc.json --name "Mon doc"
# avec compagnon d'images :
node scripts/import-json.mjs ../Samples/mondoc.json ../Samples/mondoc.nmfb --name "Mon doc"
# serveur distant + auth :
node scripts/import-json.mjs doc.json --url https://dc-manager.example.com --cookie "SsoJWT=…"
node scripts/import-json.mjs doc.json --url http://host:3000 --basic dev:secret
```

(`node` requis sur la machine qui lance le script ; le serveur, lui, tourne dans Docker.)

## 8. Dépannage

| Symptôme | Cause probable / solution |
|---|---|
| **404 sur les endpoints dans le navigateur** | Ancien bundle en cache → **Ctrl+Shift+R** (hard refresh). |
| **Page blanche / vieille version** | Idem : hard refresh, ou vider le cache du site. |
| **`port is already allocated`** | Le port 3000 est pris : changer `ports: "3001:3000"` dans le compose. |
| **`Cannot connect to the Docker daemon`** | Docker Desktop n'est pas démarré. |
| **Conteneur en `Restarting`/`Exited`** | `docker compose logs --tail 50` pour voir l'erreur de démarrage. |
| **`Client introuvable`** (503 sur `/`) | Le build du client a échoué : `docker compose up --build` et regarder les logs de build. |
| **Repartir totalement de zéro** | `docker compose down -v && docker compose up -d --build`. |

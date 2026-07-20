# Servir l'app sous un sous-dossier (reverse-proxy)

> DC Manager peut être servi **à la racine** (`https://host/`) **ou sous n'importe quel
> sous-dossier** (`https://host/dc-manager/`) derrière un reverse-proxy, **sans
> reconfiguration ni rebuild**. Ce document explique le mécanisme et les réglages proxy.

## 1. Principe : tout est relatif

L'app **ne code en dur aucun chemin absolu** (`/api`, `/sw.js`, `/icons/…`). Toutes ses
URLs sont **relatives** et ancrées sur un **`<base href>`** présent dans le HTML
([`src-client/index.html`](../src-client/index.html)). Le navigateur résout donc chaque URL contre
l'emplacement réel où la page a été chargée :

| Ressource | Écrit en | Servie à la racine | Servie sous `/dc-manager/` |
|---|---|---|---|
| API REST | `api` | `/api` | `/dc-manager/api` |
| Manifest | `manifest.webmanifest` | `/manifest.webmanifest` | `/dc-manager/manifest.webmanifest` |
| Icônes | `icons/…` | `/icons/…` | `/dc-manager/icons/…` |
| Service worker | `sw.js` (scope `./`) | `/sw.js` (scope `/`) | `/dc-manager/sw.js` (scope `/dc-manager/`) |



L'app **ne fait aucun routing par l'URL** (les documents se choisissent dans l'app,
`location.pathname` ne change jamais) → l'ancre `<base>` reste stable et la résolution
relative est fiable. Le code n'utilise **aucune** référence SVG `url(#…)`, donc le piège
classique `<base>` ↔ fragments SVG **ne s'applique pas**.

## 2. Côté serveur : `apiBaseUrl` relatif + `<base>` optionnel

Le backend qui sert le client ([`src-server/src/server.ts`](../src-server/src/server.ts),
`serveClient`) :

1. injecte `window.__DCMANAGER_CONFIG__ = { mode: "api", apiBaseUrl: "api", … }` — base
   d'API **relative** (sans slash initial) ;
2. si le proxy annonce le préfixe via l'en-tête **`X-Forwarded-Prefix`** (ex.
   `/dc-manager`), il remplace `<base href="./">` par `<base href="/dc-manager/">` — une
   **ancre absolue** qui couvre deux cas que le `./` ne couvre pas (cf. §4).

L'en-tête est **filtré** (chemin absolu, charset sûr uniquement) avant injection : un
`X-Forwarded-Prefix` malveillant ne peut pas s'évader de l'attribut `href` (anti-XSS).

## 3. Configuration proxy

Le backend ne voit jamais le préfixe : il reçoit `/`, `/api`, `/sw.js` à la racine. La
seule condition est que le **navigateur** émette ses requêtes sous `/dc-manager/…`, ce
qui est automatique grâce aux URLs relatives.

**Nginx**
```nginx
location /dc-manager/ {
    proxy_pass http://backend:3000/;          # le slash final RETIRE /dc-manager
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Conseillé (robustesse, cf. §4) — annonce le préfixe à l'app :
    proxy_set_header X-Forwarded-Prefix /dc-manager;
    # --- Canal LIVE (SSE) : indispensable au temps réel (synchro VM, multi-client) — cf. §5 ---
    proxy_http_version 1.1;                    # connexion longue vers le backend (défaut 1.0 = fermeture)
    proxy_set_header   Connection "";          # ne PAS transmettre « close » : garde le flux SSE ouvert
    proxy_read_timeout 3600s;                  # ne pas couper le SSE inactif (heartbeat serveur toutes les 30 s)
    # proxy_buffering off;                     # NON requis : l'app envoie déjà « X-Accel-Buffering: no » (cf. §5)
}
# Redirige l'URL sans slash final vers la version avec slash (cf. §4) :
location = /dc-manager { return 308 /dc-manager/; }
```



## 4. Le piège du slash final

Avec une `<base href="./">` (cas sans `X-Forwarded-Prefix`), l'ancre est le **dossier**
du document courant :

- `…/dc-manager/` → base `…/dc-manager/` ✓
- `…/dc-manager` (**sans** slash) → base `…/` ❌ → `api` retombe sur `/api` (hors préfixe)

Deux parades, idéalement les deux :

1. **Rediriger** `/dc-manager` → `/dc-manager/` au niveau du proxy (`308`, cf. §3) ;
2. poser **`X-Forwarded-Prefix`** : le serveur injecte alors une `<base>` **absolue**
   (`/dc-manager/`), insensible au slash final.

## 5. Canal live (SSE) — mise à jour temps réel

L'app ouvre un flux **Server-Sent Events** (`<base>api/documents/:id/events`) : le serveur y
POUSSE un événement à chaque écriture pour que les clients rechargent la donnée concernée
(**synchro VM**, édition d'un **autre** client…). Tes **propres** modifications ne dépendent PAS
du SSE (le client les applique directement) — d'où un symptôme trompeur si le flux est cassé :
« mes éditions s'affichent, mais une synchro VM / un autre onglet non, il faut recharger ».

**Le piège proxy : le buffering.** nginx bufferise les réponses PAR DÉFAUT ; un flux SSE mis en
tampon n'atteint jamais (ou par à-coups) le navigateur. Deux protections, la 1ʳᵉ suffit :

1. **L'app envoie `X-Accel-Buffering: no`** sur la réponse SSE → nginx ne bufferise pas ce flux,
   **sans réglage proxy** (solution recommandée : elle voyage avec l'app) ;
2. à défaut / par prudence, poser `proxy_buffering off;` sur le `location`.

Il faut AUSSI une **connexion longue** (le SSE reste ouvert) : `proxy_http_version 1.1;` +
`proxy_set_header Connection "";` + un `proxy_read_timeout` large (le serveur émet un heartbeat
toutes les 30 s, ce qui garde le flux vivant). Ces directives figurent dans l'exemple du §3.

**Autres proxies** : Traefik et Caddy **ne bufferisent pas** par défaut (Caddy active même un
flush immédiat pour `text/event-stream`) → SSE OK sans réglage. Apache (`mod_proxy`) : désactiver
le buffering du flux ; HAProxy : streaming par défaut, OK.

## 6. Service worker & PWA

Le SW se recale **dynamiquement** sur son scope ([`src-client/pwa/sw.js`](../src-client/pwa/sw.js)) :
`const BASE = new URL(self.registration.scope).pathname;` — toutes ses clés de cache, le
repli hors-ligne et la détection des appels API (`BASE + "api"`, jamais mis en cache)
sont dérivées de `BASE`. Le manifeste ([`manifest.webmanifest`](../src-client/pwa/manifest.webmanifest))
a `start_url`/`scope`/`id` relatifs (`./`), résolus contre son propre emplacement →
l'app reste **installable** sous un sous-dossier.

Le scope demandé (`./`, dossier du script) est ⊆ au dossier du SW → **pas besoin** de
l'en-tête `Service-Worker-Allowed`.

## 7. Checklist de déploiement sous sous-dossier

- [ ] Proxy en **Mode A** (retire le préfixe), `proxy_pass` avec **slash final**.
- [ ] Redirection `/<prefixe>` → `/<prefixe>/` (slash final).
- [ ] En-tête `X-Forwarded-Prefix: /<prefixe>` posé par le proxy (robustesse).
- [ ] Vérifier dans l'onglet **Réseau** (F12) que les appels partent bien sous
      `/<prefixe>/api/…` et renvoient `200`.
- [ ] PWA : `Application → Manifest`/`Service Workers` (DevTools) montre un scope
      `/<prefixe>/`.
- [ ] **Live (SSE)** : une synchro VM (ou une édition depuis un 2ᵉ onglet) met à jour l'UI
      **sans recharger** la page ; sinon, vérifier le buffering / la connexion longue du proxy (cf. §5).

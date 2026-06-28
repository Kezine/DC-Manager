/* Service Worker DC Manager — émis tel quel dans dist/ par webpack (cf. webpack.config.js, EmitStaticAssetsPlugin),
   servi à /sw.js par le backend (express.static). Volontairement MINIMAL et CONSERVATEUR :
     · l'API (/api/*) n'est JAMAIS interceptée ni mise en cache → données toujours fraîches, SSE (live) intacte ;
     · les requêtes non-GET et cross-origin passent au réseau sans toucher au cache ;
     · NAVIGATIONS (document HTML) : network-first → repli cache hors-ligne (la config __DCMANAGER_CONFIG__ étant
       injectée côté serveur, on privilégie toujours le réseau pour ne pas figer un mode local/api périmé) ;
     · ASSETS statiques same-origin (icônes, manifest) : stale-while-revalidate (rapide + rafraîchi en fond).
   Versionner CACHE à chaque changement de stratégie pour purger l'ancien au activate. */
const CACHE = "dc-manager-shell-v1";
// BASE = chemin de montage de l'app = PATHNAME du scope du SW (toujours terminé par "/"). Calculé depuis
// `self.registration.scope` → tout est résolu RELATIVEMENT au sous-dossier où l'app est servie : le même SW
// fonctionne à la racine ("/") OU derrière un reverse-proxy sous un sous-dossier ("/dc-manager/"), sans config.
const BASE = new URL(self.registration.scope).pathname;   // ex. "/" ou "/dc-manager/"
const SHELL = BASE;                                        // page racine (coquille) — cache du repli hors-ligne
const SELF_PATH = BASE + "sw.js";                          // ne jamais se mettre soi-même en cache
const API_PREFIX = BASE + "api";                           // endpoints REST (jamais interceptés / mis en cache)

self.addEventListener("install", (event) => {
  // Pré-cache le strict minimum (coquille = page racine + manifeste) ; les icônes seront mises en cache à l'usage.
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([SHELL, BASE + "manifest.webmanifest"]).catch(() => undefined))
  );
  self.skipWaiting();   // active immédiatement la nouvelle version (couplé à clients.claim ci-dessous)
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))   // purge des caches obsolètes
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                                  // mutations → réseau direct (jamais de cache)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                   // cross-origin → laissé au navigateur
  if (url.pathname === SELF_PATH) return;                            // ne jamais se mettre soi-même en cache
  if (url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX + "/")) return;   // API + SSE → réseau direct

  // NAVIGATIONS (chargement de la page) : network-first, repli cache si hors-ligne.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(SHELL, copy)); return res; })
        .catch(() => caches.match(SHELL).then((c) => c || caches.match(req)))
    );
    return;
  }

  // ASSETS same-origin (icônes, manifest, éventuels fichiers de build) : stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});

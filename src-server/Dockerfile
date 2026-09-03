# DC Manager — image Docker (client buildé + backend Node/SQLite).
# Contexte de build = racine DcManager/ :  docker build -f src-server/Dockerfile -t dc-manager .
#
# TROIS étages : `client` (webpack), `server-build` (compilation TypeScript + module natif
# better-sqlite3) et `runtime` (image livrée). Le POURQUOI de la séparation build/runtime : la
# chaîne de compilation `python3 make g++` que réclame `better-sqlite3` pèse à elle seule environ
# la moitié du poids total de l'image — elle ne sert qu'à COMPILER le module natif, jamais à
# l'EXÉCUTER (le `.node` compilé suffit au runtime). En la confinant à `server-build`, `runtime`
# ne recopie que le résultat (`node_modules` déjà buildé + `dist/`) et reste vierge de tout
# compilateur — image finale nettement plus légère, sans rien changer au binaire exécuté.

# --- 1) build du client (HTML autonome dist/dc-manager.html) ---
FROM node:20-bookworm-slim AS client
WORKDIR /client
COPY package*.json ./
RUN npm ci || npm install
COPY tsconfig*.json webpack.config.js ./
COPY src-client ./src-client
# Le code PARTAGÉ est importé par le front via `../../src-shared/...` → il doit exister à /client/src-shared.
# (Sans cette copie, le build webpack échoue en TS2307 « Cannot find module '../../src-shared/...' ».)
COPY src-shared ./src-shared
RUN npm run build

# --- 2) backend Node + SQLite (TypeScript → compilé) — étage de BUILD, pas livré tel quel ---
# On PRÉSERVE l'arborescence du dépôt (src-server/ + src-shared/) sous /app : le serveur compile le code
# PARTAGÉ `src-shared/` avec lui (rootDir = parent commun) → sortie `src-server/dist/src-server/src/index.js`,
# identique au build local. Cf. CLAUDE.md « Code partagé ».
FROM node:20-bookworm-slim AS server-build
WORKDIR /app
# better-sqlite3 = module natif → chaîne de compilation. Elle vit UNIQUEMENT dans cet étage
# intermédiaire : l'étage `runtime` ci-dessous ne la recopie pas (cf. en-tête du fichier).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY src-server/package*.json ./src-server/
RUN cd src-server && (npm ci || npm install)
COPY src-server/tsconfig.json ./src-server/
COPY src-server/src ./src-server/src
COPY src-shared ./src-shared
RUN cd src-server && npm run build && npm prune --omit=dev

# --- 3) image livrée : runtime SEUL, aucune chaîne de compilation ---
# Ne récupère de `server-build` que le RÉSULTAT (dépendances déjà installées + module natif déjà
# compilé, sortie `tsc`) — jamais python3/make/g++ ni les sources TypeScript.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
COPY --from=server-build /app/src-server/node_modules ./src-server/node_modules
COPY --from=server-build /app/src-server/dist ./src-server/dist
# package.json indispensable au RUNTIME : il porte `"type": "module"`, sans quoi Node lirait les
# `.js` de dist/ en CommonJS et le serveur ne démarrerait pas. `dist/src-shared/` vit SOUS
# src-server/ (cf. étage précédent), donc ce même package.json couvre aussi le code partagé compilé.
COPY --from=server-build /app/src-server/package.json ./src-server/package.json
COPY --from=client /client/dist /client-dist
# --- Variables d'environnement au RUNTIME ---
# POSÉES par l'image (surchargables au `docker run`/compose) — voir la ligne ENV ci-dessous :
#   PORT=3000 · API_BASE=/api · DOCS_DIR=/data/documents (sous le VOLUME) · CLIENT_DIR=/client-dist · NODE_ENV=production
# À FOURNIR À L'EXÉCUTION selon les besoins (JAMAIS de valeur en dur ici — surtout pas un secret) :
#   DCMANAGER_SECRETS_KEY : passphrase de chiffrement des secrets serveur (jetons des providers VM + webhooks notify).
#                           ABSENTE → ces features se désactivent (503 explicite) MAIS le serveur DÉMARRE quand même.
#                           AUCUN repli (l'ancien VM_PROVIDERS_KEY n'est plus lu). La PKI/certs n'en dépend pas.
#   Auth  : SSO_URL | SSO_LOGIN_URL | COOKIE_NAME | DEV_USER | BASIC_AUTH   (cf. RUN.md § Authentification)
#   Autres : LOG_LEVEL (error|warn|info|debug|trace) · JIRA_BASE_URL (lien Jira des interventions)
# Référence EXHAUSTIVE des variables : README.md — tableau « Variables d'environnement ».
ENV NODE_ENV=production CLIENT_DIR=/client-dist DOCS_DIR=/data/documents PORT=3000 API_BASE=/api
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src-server/dist/src-server/src/index.js"]

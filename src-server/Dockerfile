# DC Manager — image Docker (client buildé + backend Node/SQLite).
# Contexte de build = racine DcManager/ :  docker build -f src-server/Dockerfile -t dc-manager .
# (point de départ — à aligner ensuite sur la convention du projet SmsControl)

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

# --- 2) backend Node + SQLite (TypeScript → compilé) ---
# On PRÉSERVE l'arborescence du dépôt (src-server/ + src-shared/) sous /app : le serveur compile le code
# PARTAGÉ `src-shared/` avec lui (rootDir = parent commun) → sortie `src-server/dist/src-server/src/index.js`,
# identique au build local. Cf. CLAUDE.md « Code partagé ».
FROM node:20-bookworm-slim AS server
WORKDIR /app
# better-sqlite3 = module natif → chaîne de compilation
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY src-server/package*.json ./src-server/
RUN cd src-server && (npm ci || npm install)
COPY src-server/tsconfig.json ./src-server/
COPY src-server/src ./src-server/src
COPY src-shared ./src-shared
RUN cd src-server && npm run build && npm prune --omit=dev
COPY --from=client /client/dist /client-dist
ENV NODE_ENV=production CLIENT_DIR=/client-dist DOCS_DIR=/data/documents PORT=3000 API_BASE=/api
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src-server/dist/src-server/src/index.js"]

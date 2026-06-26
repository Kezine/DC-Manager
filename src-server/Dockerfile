# NetMap — image Docker (client buildé + backend Node/SQLite).
# Contexte de build = racine NetMap/ :  docker build -f src-server/Dockerfile -t netmap .
# (point de départ — à aligner ensuite sur la convention du projet SmsControl)

# --- 1) build du client (HTML autonome dist/netmap.html) ---
FROM node:20-bookworm-slim AS client
WORKDIR /client
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json webpack.config.js ./
COPY src ./src
RUN npm run build

# --- 2) backend Node + SQLite (TypeScript → compilé) ---
FROM node:20-bookworm-slim AS server
WORKDIR /app
# better-sqlite3 = module natif → chaîne de compilation
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY src-server/package*.json ./
RUN npm ci || npm install
COPY src-server/tsconfig.json ./
COPY src-server/src ./src
RUN npm run build && npm prune --omit=dev
COPY --from=client /client/dist /client-dist
ENV NODE_ENV=production CLIENT_DIR=/client-dist DB_FILE=/data/netmap.db PORT=3000 API_BASE=/api
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]

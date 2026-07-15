#!/usr/bin/env bash
# Build & push de l'image Docker DC Manager (client buildé + backend Node/SQLite) vers un registre.
# Le contexte de build est la RACINE du dépôt (le Dockerfile, dans src-server/, y copie src-client/ src-server/ src-shared/).
#
# Usage (variables d'env OU arguments positionnels) :
#   REGISTRY=ghcr.io IMAGE=kezine/dc-manager TAG=1.0.0 scripts/docker-publish.sh
#   scripts/docker-publish.sh <image> <tag> [registry]
#   ex. : scripts/docker-publish.sh kezine/dc-manager 1.0.0 ghcr.io
#
# Options :
#   SKIP_PUSH=1    → build seulement (pas de login/push)
#   SKIP_LATEST=1  → ne pas (re)taguer/pousser :latest
#   REBUILD_APP=1  → force le rebuild de la layer CLIENT (webpack) SANS toucher au reste
#                    (deps serveur + module natif better-sqlite3 restent en cache). Pratique
#                    quand le cache n'a pas vu un changement de sources. Implémenté via le
#                    `--no-cache-filter` de BuildKit (étage `client` du Dockerfile).
#   Pour tout reconstruire de zéro : NO_CACHE=1 (équivaut à `docker build --no-cache`).
#
# Registres : laisser REGISTRY vide pour le Docker Hub officiel ; sinon ghcr.io,
# registry.exemple.com, etc. Le login se fait de manière interactive (ou via un
# `docker login` préalable / `DOCKER_PASSWORD` côté CI).
set -euo pipefail

# Se placer à la racine du dépôt quel que soit le dossier d'appel (ce script vit dans scripts/).
cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-${3:-}}"
IMAGE="${IMAGE:-${1:-kezine/dc-manager}}"
TAG="${TAG:-${2:-latest}}"
REF="${REGISTRY:+$REGISTRY/}$IMAGE"     # ex. ghcr.io/kezine/dc-manager (REGISTRY vide → kezine/dc-manager)

command -v docker >/dev/null || { echo "✗ docker introuvable (Docker Desktop démarré ?)" >&2; exit 1; }

TAGS=(-t "$REF:$TAG")
[ "${SKIP_LATEST:-}" = "1" ] || TAGS+=(-t "$REF:latest")

# BuildKit requis pour --no-cache-filter (défaut sur Docker récent ; on le force pour être sûr).
export DOCKER_BUILDKIT=1
BUILD_OPTS=()
if [ "${NO_CACHE:-}" = "1" ]; then
  BUILD_OPTS+=(--no-cache); echo "  ↳ NO_CACHE=1 : reconstruction COMPLÈTE (aucun cache)"
elif [ "${REBUILD_APP:-}" = "1" ]; then
  BUILD_OPTS+=(--no-cache-filter client); echo "  ↳ REBUILD_APP=1 : rebuild forcé de la layer client (webpack) — serveur/natif gardés en cache"
fi

echo "→ build  $REF:$TAG$([ "${SKIP_LATEST:-}" = "1" ] || echo "  (+ :latest)")   [contexte: $PWD]"
docker build -f src-server/Dockerfile "${BUILD_OPTS[@]}" "${TAGS[@]}" .

if [ "${SKIP_PUSH:-}" = "1" ]; then
  echo "✓ build OK (push ignoré : SKIP_PUSH=1) — $REF:$TAG"
  exit 0
fi

echo "→ login  ${REGISTRY:-(Docker Hub)}"
docker login ${REGISTRY:+"$REGISTRY"}

echo "→ push   $REF:$TAG"
docker push "$REF:$TAG"
if [ "${SKIP_LATEST:-}" != "1" ]; then echo "→ push   $REF:latest"; docker push "$REF:latest"; fi

echo "✓ publié : $REF:$TAG"

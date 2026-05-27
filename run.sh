#!/usr/bin/env bash
set -e

if [ -f /data/params ]; then
    set -a
    # shellcheck disable=SC1091
    source /data/params
    set +a
fi

export REDIS_HOST="${REDIS_HOST:-redis}"
export CATALOGUE_URL="${CATALOGUE_URL:-http://${CATALOGUE_HOST:-roboshop-catalogue}:${CATALOGUE_PORT:-8080}}"
export PORT="${CART_SERVER_PORT:-8080}"

exec node server.js

#!/usr/bin/env bash
set -e

if [ -f /data/params ]; then
    set -a
    # shellcheck disable=SC1091
    source /data/params
    set +a
fi

: "${REDIS_HOST:?REDIS_HOST is required}"
: "${CATALOGUE_HOST:?CATALOGUE_HOST is required}"
: "${CATALOGUE_PORT:?CATALOGUE_PORT is required}"
: "${CART_SERVER_PORT:?CART_SERVER_PORT is required}"

export REDIS_HOST
export CATALOGUE_URL="http://${CATALOGUE_HOST}:${CATALOGUE_PORT}"
export PORT="${CART_SERVER_PORT}"

exec node server.js

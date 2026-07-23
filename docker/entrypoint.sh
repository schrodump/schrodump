#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

# PID 1 is dumb-init, which forwards signals here. This script owns two children — the API and
# the UI — and is responsible for passing the signal on to both. Without that, a `docker stop`
# would kill the shell and orphan the Node processes.
set -eu

SERVER_ENTRY=/app/server/apps/server/dist/index.js
WEB_ENTRY=/app/web/apps/web/server.js
PRISMA_BIN=/app/prisma-cli/node_modules/.bin/prisma
SCHEMA=/app/server/apps/server/prisma/schema.prisma

log() {
  printf '%s entrypoint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2
}

# Migrations run before anything listens: a server answering requests against a schema it does not
# match is worse than a server that is not up yet.
log "applying database migrations"
"$PRISMA_BIN" migrate deploy --schema "$SCHEMA"

log "starting api on port ${PORT}"
node "$SERVER_ENTRY" &
api_pid=$!

log "starting web on port ${WEB_PORT}"
PORT="$WEB_PORT" node "$WEB_ENTRY" &
web_pid=$!

# NOTE: the signal is delivered correctly, but neither the API nor the runner installs a SIGTERM
# handler today, so Node exits immediately and scratch directories from an in-flight job are left
# behind. They are reclaimed by the ScratchManager sweep on the next boot, not at shutdown.
stop() {
  log "signal received, stopping children"
  kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  wait "$web_pid" 2>/dev/null || true
  log "stopped"
  exit 0
}
trap stop TERM INT

# Poll rather than `wait`: if either child dies on its own the container must die too, so the
# restart policy can act. A bare `wait` would keep the container alive with half the app down.
while kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 1
done

log "a child process exited unexpectedly; shutting down"
kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true
exit 1

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

# Drives the product through the deployment we ship: `docker compose up`, the setup link, keys, a
# destination, a target, a policy, a backup, and a FULL_RESTORE verify — asserting the artifact
# reaches VERIFIED.
#
# This exists because three defects shipped that no unit or integration test could have caught, all
# of them in the seam between the code and compose.yaml:
#
#   - the socket proxy denied `exec`, so FULL_RESTORE verify could never run
#   - scratch was a path only Schrodump's own container could see, so every mounted-file operation
#     (verify, restore, STAGED, mongo) failed "mounts denied"
#   - nothing pulled executor images, so the first backup of every engine failed on a fresh host
#
# The suite talks to Docker and PostgreSQL directly. The deployment inserts a proxy, a volume layout
# and a network topology between them, and none of that was ever exercised. Each defect alone was
# enough to make a new installation take backups it could never verify or restore.
#
# Usable locally exactly as CI runs it: scripts/smoke-compose.sh

set -euo pipefail

PROJECT="schrodump-smoke-$$"
PORT="${SMOKE_PORT:-18999}"
WORK="$(mktemp -d)"
SCRATCH="${WORK}/scratch"
BASE="http://127.0.0.1:${PORT}"
# Better-Auth checks the Origin against SCHRODUMP_URL; curl sends none unless told to.
ORIGIN="http://localhost:8080"
JSON="content-type: application/json"
PASSWORD="smoke-password-not-a-secret"

log() { printf '\n== %s\n' "$1"; }
fail() {
  printf '\nsmoke: %s\n' "$1" >&2
  printf '\n--- schrodump logs (tail) ---\n' >&2
  docker compose -p "$PROJECT" --env-file "${WORK}/.env" logs schrodump 2>&1 | tail -40 >&2 || true
  exit 1
}

cleanup() {
  docker compose -p "$PROJECT" --env-file "${WORK}/.env" down -v >/dev/null 2>&1 || true
  docker rm -f "${PROJECT}-target" "${PROJECT}-minio" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The container runs unprivileged (uid 100) and this is a bind mount, so the directory has to be
# writable by it. Docker chowns a named volume; it does not chown a bind mount. Getting this wrong
# is what the boot-time preflight now refuses, and what CI hit the first time this job ran.
mkdir -p "$SCRATCH"
chmod 0777 "$SCRATCH"
cat > "${WORK}/.env" <<EOF
DB_PASSWORD=smoke-$(openssl rand -hex 6)
SCHRODUMP_KEK=$(openssl rand -base64 32)
PORT=${PORT}
EXECUTOR_NETWORK=${PROJECT}_targets
SCRATCH_HOST_PATH=${SCRATCH}
SCHRODUMP_SCHEDULER_TICK_MS=5000
EOF

compose() { docker compose -p "$PROJECT" --env-file "${WORK}/.env" "$@"; }
api() { curl -sS -b "${WORK}/cookies" -c "${WORK}/cookies" -H "Origin: ${ORIGIN}" "$@"; }

log "1/7  docker compose up"
compose up -d >/dev/null
for _ in $(seq 1 60); do
  status="$(compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null || true)"
  case "$status" in *"health: starting"*) sleep 5 ;; *) break ;; esac
done
compose ps --format '{{.Service}}	{{.Status}}'
echo "$(compose ps --format '{{.Status}}')" | grep -q unhealthy && fail "a service came up unhealthy"

log "2/7  a target database and an S3 destination on the deployment's own networks"
docker run -d --name "${PROJECT}-target" --network "${PROJECT}_targets" \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=apppw -e POSTGRES_DB=shop postgres:18-alpine >/dev/null
docker run -d --name "${PROJECT}-minio" --network "${PROJECT}_internal" \
  -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 \
  minio/minio:RELEASE.2025-09-07T16-13-09Z server /data >/dev/null
for _ in $(seq 1 60); do
  docker exec "${PROJECT}-target" pg_isready -h 127.0.0.1 -U app -d shop >/dev/null 2>&1 && break
  sleep 2
done
docker exec "${PROJECT}-target" psql -U app -d shop -q \
  -c "CREATE TABLE orders(id int primary key, v text); INSERT INTO orders VALUES (1,'smoke');"
docker run --rm --network "${PROJECT}_internal" \
  -e AWS_ACCESS_KEY_ID=minio -e AWS_SECRET_ACCESS_KEY=minio123 -e AWS_DEFAULT_REGION=us-east-1 \
  amazon/aws-cli:latest --endpoint-url "http://${PROJECT}-minio:9000" s3 mb s3://backups >/dev/null

log "3/7  the one-time setup link"
token="$(compose logs schrodump 2>&1 | grep -oE 'token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)"
[ -n "$token" ] || fail "no setup token was printed at boot"
api -o /dev/null -w '   setup %{http_code}\n' -X POST -H "$JSON" \
  -d "{\"token\":\"${token}\",\"email\":\"a@example.com\",\"password\":\"${PASSWORD}\"}" \
  "${BASE}/backend/setup"
api -o /dev/null -w '   sign-in %{http_code}\n' -X POST -H "$JSON" \
  -d "{\"email\":\"a@example.com\",\"password\":\"${PASSWORD}\"}" \
  "${BASE}/api/auth/sign-in/email"
# An admin created through the setup link chose this password; it owes no rotation.
api "${BASE}/backend/me" | grep -q '"mustChangePassword":false' ||
  fail "a setup-link admin was flagged for password rotation"

log "4/7  encryption keys"
api -o /dev/null -w '   provision %{http_code}\n' -X POST -H "$JSON" \
  -d '{"escrow":{"mode":"generate"}}' "${BASE}/backend/encryption-keys"

log "5/7  destination, target, policy"
dest="$(api -X POST -H "$JSON" -d "{\"name\":\"minio\",\"endpoint\":\"http://${PROJECT}-minio:9000\",\"region\":\"us-east-1\",\"bucket\":\"backups\",\"prefix\":\"s\",\"accessKeyId\":\"minio\",\"secretAccessKey\":\"minio123\",\"forcePathStyle\":true,\"sealMode\":\"operational\"}" "${BASE}/backend/destinations" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[ -n "$dest" ] || fail "the destination was not created"
# PUT/GET/DELETE against the real bucket: a credential that can write but not manage is a backup
# you cannot retain.
api -o /dev/null -w '   canary %{http_code}\n' -X POST "${BASE}/backend/destinations/${dest}/canary"

target="$(api -X POST -H "$JSON" -d "{\"name\":\"shop\",\"engine\":\"postgres\",\"host\":\"${PROJECT}-target\",\"port\":5432,\"username\":\"app\",\"password\":\"apppw\",\"tls\":false,\"scope\":{\"databases\":[\"shop\"],\"schemas\":[],\"collections\":[]}}" "${BASE}/backend/targets" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[ -n "$target" ] || fail "the target was not created"
# Reaches the target over the executor network, through the socket proxy.
api "${BASE}/backend/targets/${target}/test-connection" -X POST | grep -q '"ok":true' ||
  fail "the connection test did not reach the target database"

policy="$(api -X POST -H "$JSON" -d "{\"name\":\"smoke\",\"targetId\":\"${target}\",\"destinationId\":\"${dest}\",\"cron\":\"0 3 * * *\",\"verifyLevel\":\"FULL_RESTORE\",\"executionMode\":\"STREAM\",\"parallelism\":1,\"keepLast\":3,\"keepDaily\":0,\"keepWeekly\":0,\"keepMonthly\":0,\"keepYearly\":0,\"enabled\":true}" "${BASE}/backend/policies" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[ -n "$policy" ] || fail "the policy was not created"

log "6/7  a real backup"
api -o /dev/null -w '   enqueue %{http_code}\n' -X POST "${BASE}/backend/policies/${policy}/backup"

log "7/7  waiting for the artifact to reach VERIFIED"
for attempt in $(seq 1 60); do
  sleep 5
  body="$(api "${BASE}/backend/artifacts")"
  case "$body" in
    *'"VERIFIED":1'*|*'"VERIFIED": 1'*)
      printf '   VERIFIED after %ss\n' "$((attempt * 5))"
      printf '\nsmoke: the deployment we ship took a backup and proved it restores.\n'
      exit 0
      ;;
  esac
  jobs="$(api "${BASE}/backend/jobs")"
  case "$jobs" in
    *'"state":"FAILED"'*)
      printf '\n--- jobs ---\n%s\n' "$jobs" >&2
      fail "a job failed"
      ;;
  esac
done
printf '\n--- artifacts ---\n%s\n' "$(api "${BASE}/backend/artifacts")" >&2
fail "no artifact reached VERIFIED within 5 minutes"

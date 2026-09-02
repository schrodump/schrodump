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
  docker rm -f "${PROJECT}-target" "${PROJECT}-minio" "${PROJECT}-mysql" "${PROJECT}-mongo" >/dev/null 2>&1 || true
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
SCHRODUMP_IMAGE=${SCHRODUMP_IMAGE:-schrodump/schrodump:latest}
PORT=${PORT}
EXECUTOR_NETWORK=${PROJECT}_targets
SCRATCH_HOST_PATH=${SCRATCH}
SCHRODUMP_SCHEDULER_TICK_MS=5000
EOF

compose() { docker compose -p "$PROJECT" --env-file "${WORK}/.env" "$@"; }
api() { curl -sS -b "${WORK}/cookies" -c "${WORK}/cookies" -H "Origin: ${ORIGIN}" "$@"; }

log "1/12  docker compose up"
compose up -d >/dev/null
for _ in $(seq 1 60); do
  status="$(compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null || true)"
  case "$status" in *"health: starting"*) sleep 5 ;; *) break ;; esac
done
compose ps --format '{{.Service}}	{{.Status}}'
echo "$(compose ps --format '{{.Status}}')" | grep -q unhealthy && fail "a service came up unhealthy"

log "2/12  a target database and an S3 destination on the deployment's own networks"
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

log "3/12  the one-time setup link"
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

log "4/12  encryption keys"
api -o /dev/null -w '   provision %{http_code}\n' -X POST -H "$JSON" \
  -d '{"escrow":{"mode":"generate"}}' "${BASE}/backend/encryption-keys"

log "5/12  destination, target, policy"
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

log "6/12  a real backup"
api -o /dev/null -w '   enqueue %{http_code}\n' -X POST "${BASE}/backend/policies/${policy}/backup"

log "7/12  waiting for the artifact to reach VERIFIED"
verified=""
for attempt in $(seq 1 60); do
  sleep 5
  body="$(api "${BASE}/backend/artifacts")"
  case "$body" in
    *'"VERIFIED":1'*|*'"VERIFIED": 1'*)
      printf '   VERIFIED after %ss\n' "$((attempt * 5))"
      verified=yes
      break
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
[ -n "$verified" ] || {
  printf '\n--- artifacts ---\n%s\n' "$(api "${BASE}/backend/artifacts")" >&2
  fail "no artifact reached VERIFIED within 5 minutes"
}

# Verify restores into a throwaway sandbox; a real restore runs a different code path
# (runRestoreJob) against a real database with --clean semantics. It was equally broken by the
# scratch defect and equally invisible to every other test.
log "8/12  restoring it over the live database"
artifact="$(api "${BASE}/backend/artifacts" | sed -n 's/.*"items":\[{"id":"\([^"]*\)".*/\1/p')"
[ -n "$artifact" ] || fail "could not read the artifact id"
# Changed AFTER the backup, so "the data came back" is an observation rather than a coincidence.
docker exec "${PROJECT}-target" psql -U app -d shop -q \
  -c "DELETE FROM orders; INSERT INTO orders VALUES (99,'written-after-the-backup');"
api -o /dev/null -w '   enqueue %{http_code}\n' -X POST -H "$JSON" \
  -d '{"target":"DATABASE","confirmExistingDatabase":true}' \
  "${BASE}/backend/artifacts/${artifact}/restore"
for attempt in $(seq 1 60); do
  sleep 5
  jobs="$(api "${BASE}/backend/jobs")"
  case "$jobs" in
    *'"kind":"RESTORE","state":"SUCCEEDED"'*) break ;;
    *'"kind":"RESTORE","state":"FAILED"'*)
      printf '\n--- jobs ---\n%s\n' "$jobs" >&2
      fail "the restore failed"
      ;;
  esac
  [ "$attempt" -eq 60 ] && fail "the restore did not finish within 5 minutes"
done
rows="$(docker exec "${PROJECT}-target" psql -U app -d shop -tAc "SELECT string_agg(id||':'||v,',') FROM orders" | tr -d ' ')"
[ "$rows" = "1:smoke" ] || fail "the restore did not put the backed-up data back (found: ${rows})"
printf '   the backed-up row is back and the post-backup row is gone\n'

# The documented floor when the metadata database is lost. It aborted on a partly-missing catalog
# until the import was made idempotent, and a rebuilt artifact must come back UNOBSERVED — the
# verification record lived in the database that was lost.
log "9/12  rebuilding the catalog from the bucket alone"
compose exec -T db psql -U schrodump -d schrodump -tAc 'DELETE FROM "Artifact"' >/dev/null
api "${BASE}/backend/artifacts" | grep -q '"items":\[\]' || fail "the catalog was not emptied"
api -o /dev/null -w '   rebuild %{http_code}\n' -X POST -H "$JSON" \
  -d "{\"destinationId\":\"${dest}\"}" "${BASE}/backend/catalog/rebuild"
rebuilt="$(api "${BASE}/backend/artifacts")"
# Not a fixed count: a newly created policy makes the scheduler dispatch the most recent past cron
# window as well, so the number of artifacts depends on timing. The claim that matters does not —
# they came back, and NONE of them inherited a VERIFIED state, because the verification record
# lived in the database that was lost.
case "$rebuilt" in
  *'"VERIFIED":0'*) : ;;
  *) printf '\n--- artifacts ---\n%s\n' "$rebuilt" >&2
     fail "a rebuilt artifact came back VERIFIED — a rebuild cannot inherit a state it cannot substantiate" ;;
esac
case "$rebuilt" in
  *'"UNOBSERVED":0'*|*'"items":[]'*)
     printf '\n--- artifacts ---\n%s\n' "$rebuilt" >&2
     fail "the catalog did not come back from the bucket" ;;
  *) printf '   recovered, and every one UNOBSERVED rather than VERIFIED\n' ;;
esac

# Rotation must leave every existing artifact readable. The retired key keeps its identity, and if
# it ever stopped keeping it the loss would be silent — pre-rotation artifacts unopenable by the
# server, discovered at a restore, months later. That is the worst failure this product has.
log "10/12  rotating the operational key, and re-verifying an artifact sealed to the old one"
old_artifact="$(api "${BASE}/backend/artifacts" | sed -n 's/.*"items":\[{"id":"\([^"]*\)".*/\1/p')"
[ -n "$old_artifact" ] || fail "could not read the rebuilt artifact id"
api -o /dev/null -w '   rotate %{http_code}\n' -X POST -H "$JSON" \
  -d '{"type":"operational"}' "${BASE}/backend/encryption-keys/rotate"
# The retired row must still hold its identity; serverCanDecrypt is that column, derived.
api "${BASE}/backend/encryption-keys" |
  grep -q '"type":"operational","state":"retired","publicRecipient":"[^"]*","serverCanDecrypt":true' ||
  fail "the retired operational key lost its identity — every artifact sealed to it is now unopenable"
api -o /dev/null -w '   re-verify the pre-rotation artifact %{http_code}\n' -X POST \
  "${BASE}/backend/artifacts/${old_artifact}/verify"
for attempt in $(seq 1 60); do
  sleep 5
  case "$(api "${BASE}/backend/artifacts")" in
    *'"VERIFIED":1'*|*'"VERIFIED": 1'*) printf '   still VERIFIED, decrypted with the retired key\n'; break ;;
  esac
  [ "$attempt" -eq 60 ] && fail "an artifact sealed to the retired key could not be verified after rotation"
done

# Everything above is postgres over STREAM: the dump goes to stdout and nothing is mounted. The
# STAGED path is a different product — a second executor image, a directory dump, a staging
# directory bind-mounted from the host, a tar step, and an untar on the way back — and it is the
# path this seam has broken twice (scratch as a container-only path, and nothing pulling executor
# images). None of it was covered here.
#
# mysql carries it: `parallelism > 1` is the explicit way into STAGED (resolveExecutionMode), and
# mydumper is an image the operator never names — the server resolves schrodump/mydumper:1 by
# itself, at backup time.
log "11/12  a STAGED mysql backup, through the executor image nobody types"

# Unpublished until the first release cuts a tag, so a fresh checkout builds it. ensureImage
# inspects before pulling, so a local tag is used as-is and no registry is consulted.
if ! docker image inspect schrodump/mydumper:1 >/dev/null 2>&1; then
  printf '   building schrodump/mydumper:1 (no release has published it yet)\n'
  docker build -q -f docker/executors/mydumper.Dockerfile -t schrodump/mydumper:1 . >/dev/null
fi

# 8.0 rather than the newest tag: the adapter derives the executor image from the PROBED server
# version, so any supported version exercises the same resolution and the same STAGED pipeline —
# and this is the one that can be run through end to end before it is asked of CI.
docker run -d --name "${PROJECT}-mysql" --network "${PROJECT}_targets" \
  -e MYSQL_ROOT_PASSWORD=rootpw -e MYSQL_DATABASE=shop mysql:8.0 >/dev/null
# `mysqladmin ping` answers as soon as the server accepts connections, which is BEFORE the
# entrypoint has finished creating MYSQL_DATABASE. Waiting on the database itself is the condition
# the next command actually needs; pinging would race it.
for _ in $(seq 1 90); do
  docker exec "${PROJECT}-mysql" mysql -uroot -prootpw shop -e 'select 1' >/dev/null 2>&1 && break
  sleep 2
done
docker exec "${PROJECT}-mysql" mysql -uroot -prootpw shop \
  -e "CREATE TABLE orders(id int primary key, v text); INSERT INTO orders VALUES (1,'smoke');" \
  >/dev/null 2>&1 || fail "could not seed the mysql target"

my_target="$(api -X POST -H "$JSON" -d "{\"name\":\"shop-mysql\",\"engine\":\"mysql\",\"host\":\"${PROJECT}-mysql\",\"port\":3306,\"username\":\"root\",\"password\":\"rootpw\",\"tls\":false,\"scope\":{\"databases\":[\"shop\"],\"schemas\":[],\"collections\":[]}}" "${BASE}/backend/targets" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[ -n "$my_target" ] || fail "the mysql target was not created"
api "${BASE}/backend/targets/${my_target}/test-connection" -X POST | grep -q '"ok":true' ||
  fail "the connection test did not reach the mysql target"

# parallelism 2, not executionMode: the field on the policy is a request, and resolveExecutionMode
# decides. Asking for more than one worker is the only explicit way into STAGED.
my_policy="$(api -X POST -H "$JSON" -d "{\"name\":\"smoke-mysql\",\"targetId\":\"${my_target}\",\"destinationId\":\"${dest}\",\"cron\":\"0 3 * * *\",\"verifyLevel\":\"FULL_RESTORE\",\"executionMode\":\"STAGED\",\"parallelism\":2,\"keepLast\":3,\"keepDaily\":0,\"keepWeekly\":0,\"keepMonthly\":0,\"keepYearly\":0,\"enabled\":true}" "${BASE}/backend/policies" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[ -n "$my_policy" ] || fail "the mysql policy was not created"
api -o /dev/null -w '   enqueue %{http_code}\n' -X POST "${BASE}/backend/policies/${my_policy}/backup"

# Counts cannot answer this: a VERIFIED artifact already exists and the scheduler may add more of
# either engine. The claim is that ONE artifact holds all three properties at once — mysql, STAGED
# and VERIFIED — so it is asserted on the artifact. Splitting on `}` puts each object on its own
# line; none of these fields nest.
staged_verified() {
  api "${BASE}/backend/artifacts" | tr '}' '\n' |
    grep '"engine":"mysql"' | grep '"executionMode":"STAGED"' | grep -c '"state":"VERIFIED"' || true
}
for attempt in $(seq 1 72); do
  sleep 5
  if [ "$(staged_verified)" -ge 1 ]; then
    printf '   VERIFIED after %ss — mydumper ran, the staging directory mounted, the tar\n' "$((attempt * 5))"
    printf '   round-tripped, and myloader restored it into a throwaway server\n'
    break
  fi
  jobs="$(api "${BASE}/backend/jobs")"
  case "$jobs" in
    *'"state":"FAILED"'*)
      printf '\n--- jobs ---\n%s\n' "$jobs" >&2
      fail "a job failed during the STAGED mysql backup"
      ;;
  esac
  if [ "$attempt" -eq 72 ]; then
    printf '\n--- artifacts ---\n%s\n' "$(api "${BASE}/backend/artifacts")" >&2
    fail "no STAGED mysql artifact reached VERIFIED within 6 minutes"
  fi
done

# A STAGED artifact restores through a DIFFERENT path than the one that just verified it:
# runRestoreJob against a real database with --clean semantics, versus a throwaway sandbox. Both
# call buildExtractStaging, and only this one does it over data somebody would miss.
docker exec "${PROJECT}-mysql" mysql -uroot -prootpw shop \
  -e "DELETE FROM orders; INSERT INTO orders VALUES (99,'written-after-the-backup');" >/dev/null 2>&1
staged_artifact="$(api "${BASE}/backend/artifacts" | tr '}' '\n' |
  grep '"engine":"mysql"' | grep '"executionMode":"STAGED"' | grep '"state":"VERIFIED"' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$staged_artifact" ] || fail "could not read the STAGED artifact id"
api -o /dev/null -w '   restore enqueue %{http_code}\n' -X POST -H "$JSON" \
  -d '{"target":"DATABASE","confirmExistingDatabase":true}' \
  "${BASE}/backend/artifacts/${staged_artifact}/restore"
for attempt in $(seq 1 72); do
  sleep 5
  rows="$(docker exec "${PROJECT}-mysql" mysql -uroot -prootpw shop -N -B \
    -e "SELECT group_concat(concat(id,':',v)) FROM orders" 2>/dev/null | tr -d ' \n')"
  [ "$rows" = "1:smoke" ] && { printf '   the tar was unpacked and myloader put the backed-up row back\n'; break; }
  case "$(api "${BASE}/backend/jobs")" in
    *'"kind":"RESTORE","state":"FAILED"'*) fail "the STAGED restore failed" ;;
  esac
  [ "$attempt" -eq 72 ] && fail "the STAGED restore did not put the data back (found: ${rows})"
done

# Mongo is the one engine whose BACKUP cannot run without scratch: the mongodump password travels
# only in a --config file, and that file has to sit at a path the Docker daemon can resolve as a
# bind source. That is precisely what the scratch defect broke — and the engine it broke most
# completely, since STREAM postgres kept working throughout. Nothing here covered it.
log "12/12  a mongo backup, whose password only travels in a mounted config file"
docker run -d --name "${PROJECT}-mongo" --network "${PROJECT}_targets" \
  -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=rootpw mongo:8 >/dev/null
for _ in $(seq 1 90); do
  docker exec "${PROJECT}-mongo" mongosh -u root -p rootpw --quiet --eval 'db.adminCommand("ping")' \
    >/dev/null 2>&1 && break
  sleep 2
done
# A scoped credential, NOT root — and this is the product being right rather than a workaround.
# mongodump copies one database at a time, so a credential that can see several leaves the scope
# ambiguous, and the backup refuses with MONGODB_SCOPE_TOO_BROAD rather than guessing. Pointing
# this at root is exactly the mistake an operator makes first; using the remedy the error message
# names is what proves that advice actually works.
docker exec "${PROJECT}-mongo" mongosh -u root -p rootpw --quiet --eval '
  db.getSiblingDB("shop").orders.insertOne({_id:1,v:"smoke"});
  db.getSiblingDB("admin").createUser({user:"backup",pwd:"backuppw",roles:[{role:"readWrite",db:"shop"}]});
' >/dev/null 2>&1 || fail "could not seed the mongo target"

mo_target="$(api -X POST -H "$JSON" -d "{\"name\":\"shop-mongo\",\"engine\":\"mongodb\",\"host\":\"${PROJECT}-mongo\",\"port\":27017,\"username\":\"backup\",\"password\":\"backuppw\",\"tls\":false,\"scope\":{\"databases\":[\"shop\"],\"schemas\":[],\"collections\":[]}}" "${BASE}/backend/targets" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[ -n "$mo_target" ] || fail "the mongo target was not created"
api "${BASE}/backend/targets/${mo_target}/test-connection" -X POST | grep -q '"ok":true' ||
  fail "the connection test did not reach the mongo target"

# parallelism 1: mongo is not staged-capable, and asking for more would be answered with a warning
# and STREAM rather than an error.
mo_policy="$(api -X POST -H "$JSON" -d "{\"name\":\"smoke-mongo\",\"targetId\":\"${mo_target}\",\"destinationId\":\"${dest}\",\"cron\":\"0 3 * * *\",\"verifyLevel\":\"FULL_RESTORE\",\"executionMode\":\"STREAM\",\"parallelism\":1,\"keepLast\":3,\"keepDaily\":0,\"keepWeekly\":0,\"keepMonthly\":0,\"keepYearly\":0,\"enabled\":true}" "${BASE}/backend/policies" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[ -n "$mo_policy" ] || fail "the mongo policy was not created"
api -o /dev/null -w '   enqueue %{http_code}\n' -X POST "${BASE}/backend/policies/${mo_policy}/backup"

mongo_verified() {
  api "${BASE}/backend/artifacts" | tr '}' '\n' | grep '"engine":"mongodb"' |
    grep -c '"state":"VERIFIED"' || true
}
for attempt in $(seq 1 72); do
  sleep 5
  if [ "$(mongo_verified)" -ge 1 ]; then
    printf '   VERIFIED after %ss — the --config file reached the executor from scratch\n' "$((attempt * 5))"
    break
  fi
  case "$(api "${BASE}/backend/jobs")" in
    *'"state":"FAILED"'*)
      printf '\n--- jobs ---\n%s\n' "$(api "${BASE}/backend/jobs")" >&2
      fail "a job failed during the mongo backup"
      ;;
  esac
  [ "$attempt" -eq 72 ] && fail "no mongo artifact reached VERIFIED within 6 minutes"
done

printf '\nsmoke: the deployment we ship backed up postgres, mysql and mongo, verified every one by restoring it, restored two of them over live data, rebuilt its catalog from the bucket, and kept an artifact readable across a key rotation.\n'

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

# Rehearse recovering this deployment from its own self-backup.
#
# The drills in CI prove the pipeline. They cannot prove YOUR topology — that your bucket
# credentials, your escrow identity and your network are what you believe they are. This script is
# that rehearsal, and it deliberately uses NOTHING from Schrodump: standard `aws`, `age`, `gunzip`
# and `pg_restore`. That is the point. On the day you need this, Schrodump is the thing that is
# gone, and a recovery procedure that depends on it is not a recovery procedure.
#
# It is READ-ONLY against your bucket and it refuses to write into a database that is not empty.
#
# Usage:
#   scripts/rehearse-recovery.sh \
#     --bucket my-backups --key schrodump/self-backup/<id>/metadata.bin \
#     --identity ./escrow.key \
#     --into 'postgresql://postgres:postgres@127.0.0.1:5433/rehearsal'
#
#   --endpoint https://... and --region are passed through to the aws CLI when set.
#   --key may be omitted if --sidecar points at the self-backup.json to read it from.

set -euo pipefail

BUCKET="" KEY="" SIDECAR_KEY="" IDENTITY="" INTO="" ENDPOINT="" REGION=""

die() { printf 'rehearsal: %s\n' "$1" >&2; exit 1; }
note() { printf '\n== %s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --bucket)   BUCKET="${2:-}"; shift 2 ;;
    --key)      KEY="${2:-}"; shift 2 ;;
    --sidecar)  SIDECAR_KEY="${2:-}"; shift 2 ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --into)     INTO="${2:-}"; shift 2 ;;
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --region)   REGION="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '5,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$BUCKET" ]   || die "--bucket is required"
[ -n "$IDENTITY" ] || die "--identity is required (the OFFLINE escrow identity, not the operational one)"
[ -n "$INTO" ]     || die "--into is required (a scratch PostgreSQL you do not mind losing)"
[ -f "$IDENTITY" ] || die "--identity file not found: $IDENTITY"
[ -n "$KEY" ] || [ -n "$SIDECAR_KEY" ] || die "pass --key, or --sidecar to read the key from it"

for tool in aws age gunzip pg_restore psql jq; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

AWS=(aws)
[ -n "$ENDPOINT" ] && AWS+=(--endpoint-url "$ENDPOINT")
[ -n "$REGION" ] && AWS+=(--region "$REGION")

WORK="$(mktemp -d)"
# The decrypted dump is your data in clear. It never outlives this script, on any exit path.
trap 'rm -rf "$WORK"' EXIT INT TERM
chmod 700 "$WORK"

note "1/6  Refusing to overwrite anything"
existing="$(psql "$INTO" -tAc \
  "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')" \
  2>/dev/null)" || die "cannot reach --into database"
[ "$existing" = "0" ] || die "--into database already holds $existing tables; point this at an EMPTY database"

if [ -n "$SIDECAR_KEY" ]; then
  note "2/6  Reading the sidecar"
  "${AWS[@]}" s3 cp "s3://${BUCKET}/${SIDECAR_KEY}" "$WORK/self-backup.json" >/dev/null
  [ -n "$KEY" ] || KEY="$(jq -r '.bucketKey' "$WORK/self-backup.json")"
  jq -r '.recovery' "$WORK/self-backup.json"
else
  note "2/6  No sidecar given; skipping checksum verification"
fi

note "3/6  Fetching s3://${BUCKET}/${KEY}"
"${AWS[@]}" s3 cp "s3://${BUCKET}/${KEY}" "$WORK/metadata.bin" >/dev/null

if [ -f "$WORK/self-backup.json" ]; then
  note "4/6  Verifying the checksum recorded in the sidecar"
  expected="$(jq -r '.checksum' "$WORK/self-backup.json")"
  actual="$( (command -v sha256sum >/dev/null && sha256sum "$WORK/metadata.bin" | cut -d' ' -f1) \
            || shasum -a 256 "$WORK/metadata.bin" | cut -d' ' -f1 )"
  [ "$expected" = "$actual" ] || die "checksum mismatch: sidecar says $expected, the object is $actual"
  printf '   checksum matches (%s)\n' "$actual"
else
  note "4/6  Skipped"
fi

# The artifact is standard age, not a Schrodump format. That is why the `age` CLI can open it, and
# why this rehearsal is worth more than one driven by the product itself.
note "5/6  Decrypting with the escrow identity, then gunzip"
age -d -i "$IDENTITY" -o "$WORK/metadata.sql.gz" "$WORK/metadata.bin" \
  || die "decryption failed — is this the ESCROW identity? The operational one cannot open this."
gunzip -f "$WORK/metadata.sql.gz"

note "6/6  Restoring into the scratch database"
pg_restore --no-owner --no-privileges -d "$INTO" "$WORK/metadata.sql" >/dev/null

orgs="$(psql "$INTO" -tAc 'select count(*) from "Organization"' | tr -d ' ')"
targets="$(psql "$INTO" -tAc 'select count(*) from "DatabaseTarget"' | tr -d ' ')"
artifacts="$(psql "$INTO" -tAc 'select count(*) from "Artifact"' | tr -d ' ')"

cat <<SUMMARY

Recovered: ${orgs} organization(s), ${targets} target(s), ${artifacts} artifact(s).

The catalog is readable again. Point DATABASE_URL at this database and Schrodump would come up
knowing about every artifact in the bucket.

This is the step no CI run can do for you. Having done it, your self-backup is no longer merely
written — you have watched it restore.
SUMMARY

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Test a candidate SCHRODUMP_KEK against the fingerprint an instance recorded, WITHOUT booting it.
//
// The boot already refuses a KEK whose fingerprint diverges, which is the control that matters. But
// it is a terrible instrument: it needs the whole stack up, it answers one candidate per restart,
// and on the day you are actually reaching for this you have several candidates and a deployment
// that will not start. So this asks the same question with nothing but Node.
//
// It reads the candidate from STDIN, never argv: this repository's rule for every other secret is
// that argv is visible to any process on the host, and a key that opens every backup does not get
// an exception for being typed by a human in a hurry.
//
// A match here means the key is the one this instance was initialized with. It does NOT
// independently prove a credential will unwrap — the fingerprint is derived from the KEK alone, so
// it cannot detect a fingerprint row that was itself rewritten. For that proof, boot the server
// against the database: unwrapping a real credential is the check with something at stake.
//
// Usage:
//   docker compose exec -T db psql -qtAX -U schrodump -d schrodump \
//     -c "select value from \"AppConfig\" where key = 'kek_fingerprint'"
//
//   printf %s "$CANDIDATE" | node scripts/check-kek.mjs --fingerprint <hex-from-above>
//   printf %s "$CANDIDATE" | node scripts/check-kek.mjs --print     # just show its fingerprint

import { createHash, hkdfSync, timingSafeEqual } from "node:crypto";

// Must stay identical to kekFingerprint() in apps/server/src/crypto/kek.ts. The two live in
// different files on purpose — this one has to run with no build, no workspace and no database —
// so a test in that package asserts they agree. Change one without the other and it goes red.
const FINGERPRINT_INFO = "schrodump-kek-fingerprint-v1";

export function fingerprintOf(kek) {
  const derived = Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), FINGERPRINT_INFO, 32));
  return createHash("sha256").update(derived).digest("hex");
}

export function kekBufferOf(base64) {
  const buf = Buffer.from(base64, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `the candidate decodes to ${String(buf.length)} bytes, not 32 — this is not a Schrodump KEK. ` +
        "A real one is `openssl rand -base64 32`, 44 characters ending in '='.",
    );
  }
  return buf;
}

function die(message) {
  process.stderr.write(`check-kek: ${message}\n`);
  process.exit(2);
}

async function readStdin() {
  if (process.stdin.isTTY) {
    die(
      "the candidate key is read from stdin, not from an argument.\n" +
        "  printf %s \"$CANDIDATE\" | node scripts/check-kek.mjs --fingerprint <hex>",
    );
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function parseArgs(argv) {
  let expected = null;
  let printOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--print") printOnly = true;
    else if (argv[i] === "--fingerprint") {
      expected = (argv[i + 1] ?? "").trim().toLowerCase();
      i += 1;
    } else die(`unknown argument: ${String(argv[i])}`);
  }
  return { expected, printOnly };
}

async function main() {
  const { expected, printOnly } = parseArgs(process.argv.slice(2));
  if (!printOnly && expected === null) die("pass --fingerprint <hex>, or --print to show one");
  if (expected !== null && !/^[0-9a-f]{64}$/.test(expected)) {
    die("--fingerprint takes the 64-character hex value stored in AppConfig.kek_fingerprint");
  }

  const candidate = await readStdin();
  if (candidate === "") die("stdin was empty — nothing to check");

  let actual;
  try {
    actual = fingerprintOf(kekBufferOf(candidate));
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
    return;
  }

  if (printOnly) {
    process.stdout.write(`${actual}\n`);
    return;
  }

  // timingSafeEqual over two public hex digests is not defending anything real; it costs nothing
  // and keeps the habit intact for the next person who copies this comparison somewhere it matters.
  const ok = timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  if (ok) {
    process.stdout.write(
      "MATCH — this is the key this instance was initialized with.\n" +
        "It unwraps the stored credentials and opens artifacts sealed to keys it wrapped.\n",
    );
    return;
  }
  process.stdout.write(
    "NO MATCH — this is not the key this instance was initialized with.\n" +
      "Booting with it would be refused, which is the correct outcome: a wrong KEK cannot decrypt\n" +
      "anything, and starting anyway would write new data nobody could later reconcile.\n",
  );
  process.exit(1);
}

// Only run when executed directly, so the test can import fingerprintOf and compare it with the
// server's own implementation.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// scripts/check-kek.mjs answers "is this the key this instance was initialized with?" without a
// build, a workspace or a database — which means it carries its OWN copy of the derivation. Two
// copies of a definition drift, and this one drifts silently: the script would keep answering, just
// wrongly, and it answers during a recovery, when nobody is in a position to doubt it.
//
// So this runs the real script as a subprocess and compares it against the server's own function.
// Black box on purpose: it also pins the interface the operator types — the key on stdin, the
// fingerprint on stdout, the exit code that says match.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { kekFingerprint } from "./kek.js";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../../../scripts/check-kek.mjs", import.meta.url));

async function runScript(args: string[], stdin: string) {
  const child = execFileAsync(process.execPath, [SCRIPT, ...args]);
  child.child.stdin?.end(stdin);
  try {
    const { stdout } = await child;
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("scripts/check-kek.mjs agrees with the server", () => {
  it("derives the same fingerprint the boot check compares against", async () => {
    const kek = randomBytes(32);

    const { code, stdout } = await runScript(["--print"], kek.toString("base64"));

    expect(code).toBe(0);
    // The whole point of the script: this equality is what an operator is trusting.
    expect(stdout.trim()).toBe(kekFingerprint(kek));
  });

  it("exits 0 and says MATCH for the right key", async () => {
    const kek = randomBytes(32);

    const { code, stdout } = await runScript(
      ["--fingerprint", kekFingerprint(kek)],
      kek.toString("base64"),
    );

    expect(code).toBe(0);
    expect(stdout).toContain("MATCH");
  });

  it("exits NON-ZERO for a wrong key, so a script cannot read failure as success", async () => {
    const { code, stdout } = await runScript(
      ["--fingerprint", kekFingerprint(randomBytes(32))],
      randomBytes(32).toString("base64"),
    );

    expect(code).toBe(1);
    expect(stdout).toContain("NO MATCH");
  });

  it("refuses a value that is not 32 bytes rather than reporting a confident mismatch", async () => {
    // A truncated paste is the likeliest bad input here, and "NO MATCH" would send the operator
    // looking for a different key instead of at their clipboard.
    const { code, stdout } = await runScript(
      ["--fingerprint", kekFingerprint(randomBytes(32))],
      Buffer.from("too-short").toString("base64"),
    );

    expect(code).toBe(2);
    expect(stdout).toContain("not 32");
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The claim the whole recovery story rests on: an artifact this server writes can be opened by the
// STANDARD age binary, with no Schrodump involved.
//
// docs/install.md tells an operator to "decrypt with the offline escrow age identity", and
// scripts/rehearse-recovery.sh does exactly that with the `age` CLI. Every existing test decrypts
// with the same JavaScript library that encrypted — which proves the library is self-consistent and
// proves nothing about the day the metadata database is gone and the only thing left is a bucket, a
// key on paper, and whatever tools are on the machine.
//
// If this ever fails, the recovery procedure in the documentation is fiction.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptStream, generateAgeKeyPair } from "./artifact.js";

function hasAgeCli(): boolean {
  try {
    execFileSync("age", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Gated on the binary rather than on SCHRODUMP_TEST_INTEGRATION alone: this needs no database and
// no Docker, only the tool an operator would actually reach for.
const enabled = hasAgeCli();

// A plausible dump body. Content is irrelevant to the claim; size is not — the CIPHERTEXT has to
// cross age's 64 KiB STREAM chunk boundary, because a single-chunk payload would not exercise the
// framing a real multi-hundred-megabyte artifact depends on.
//
// Hence the random tail. Repeated DDL gzips to almost nothing, so a payload that looks big in the
// source is a few hundred bytes by the time age sees it — the first version of this test asserted
// the size and caught exactly that.
const PLAINTEXT = `-- schrodump metadata dump\n${randomBytes(120_000).toString("hex")}\n`;

describe.skipIf(!enabled)("a Schrodump artifact opens with the standard age CLI", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "schrodump-age-interop-"));
  });

  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips dump -> gzip -> age through `age -d -i`", async () => {
    const pair = await generateAgeKeyPair();
    const identityPath = join(dir, "escrow.key");
    // The format an operator keeps offline: the identity string on its own line.
    writeFileSync(identityPath, `${pair.identity}\n`, { mode: 0o600 });

    // The production order, and the production helper. Reimplementing the pipeline here would test
    // a copy of it rather than the thing that writes real artifacts.
    const gzipped = Readable.from([Buffer.from(PLAINTEXT, "utf8")]).pipe(createGzip());
    const encrypted = await encryptStream(gzipped, [pair.recipient]);
    const chunks: Buffer[] = [];
    for await (const chunk of encrypted) chunks.push(Buffer.from(chunk as Buffer));
    const artifactPath = join(dir, "metadata.bin");
    writeFileSync(artifactPath, Buffer.concat(chunks));
    expect(Buffer.concat(chunks).byteLength).toBeGreaterThan(65536);

    // No library, no server, no Prisma. The binary an operator has.
    execFileSync("age", ["-d", "-i", identityPath, "-o", join(dir, "out.gz"), artifactPath]);
    execFileSync("gunzip", ["-f", join(dir, "out.gz")]);

    expect(readFileSync(join(dir, "out"), "utf8")).toBe(PLAINTEXT);
  }, 60_000);

  it("refuses the wrong identity rather than returning garbage", async () => {
    const sealed = await generateAgeKeyPair();
    const other = await generateAgeKeyPair();
    const wrongPath = join(dir, "wrong.key");
    writeFileSync(wrongPath, `${other.identity}\n`, { mode: 0o600 });

    const gzipped = Readable.from([Buffer.from("secret", "utf8")]).pipe(createGzip());
    const encrypted = await encryptStream(gzipped, [sealed.recipient]);
    const chunks: Buffer[] = [];
    for await (const chunk of encrypted) chunks.push(Buffer.from(chunk as Buffer));
    const path = join(dir, "sealed.bin");
    writeFileSync(path, Buffer.concat(chunks));

    // This is what "the operational identity cannot open a self-backup" looks like from the CLI —
    // the property the escrow design depends on, checked against the tool that will be used.
    expect(() =>
      execFileSync("age", ["-d", "-i", wrongPath, "-o", join(dir, "nope"), path], {
        stdio: "ignore",
      }),
    ).toThrow();
  }, 60_000);
});

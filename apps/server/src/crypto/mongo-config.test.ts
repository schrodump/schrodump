// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Unit test for the mongo `--config` credential-file helper. The bind-mount wiring is smoke-verified
// (Task 8); here we pin the file's CONTENT, mode, and the returned RunMount — the parts that must be
// exactly right for mongodump/mongorestore to read the password off the file instead of argv.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MONGO_CONFIG_PATH } from "@schrodump/engines/adapters/mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeMongoConfig } from "./mongo-config.js";

describe("writeMongoConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schrodump-mongo-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes `password: <json-quoted>` into the reserved dir at mode 0600", async () => {
    const { mount } = await writeMongoConfig(dir, "hunter2");
    expect(await readFile(mount.source, "utf8")).toBe('password: "hunter2"\n');
    expect(dirname(mount.source)).toBe(dir);
    expect((await stat(mount.source)).mode & 0o777).toBe(0o600);
  });

  it("returns a read-only RunMount targeting the engines-exported MONGO_CONFIG_PATH (never hardcoded)", async () => {
    const { mount } = await writeMongoConfig(dir, "pw");
    expect(mount.target).toBe(MONGO_CONFIG_PATH);
    expect(mount.readOnly).toBe(true);
  });

  // The whole reason to JSON-quote: a naive `password: <pw>` turns a leading '#' into a YAML comment
  // (empty password), and ':' / quotes / backslashes misparse — verified against mongo:8's tools,
  // which then fall back to a stdin prompt that hangs. JSON-quoting (YAML superset of JSON) is safe.
  it("YAML-safely quotes passwords with #, ':', quotes and backslashes", async () => {
    const nasty = 'p@:s#"w\\ord';
    const { mount } = await writeMongoConfig(dir, nasty);
    expect(await readFile(mount.source, "utf8")).toBe(`password: ${JSON.stringify(nasty)}\n`);
    // Sanity: the parsed value round-trips back to the original password.
    const line = (await readFile(mount.source, "utf8")).trim();
    expect(JSON.parse(line.slice("password: ".length))).toBe(nasty);
  });

  it("cleanup removes the credential file", async () => {
    const { mount, cleanup } = await writeMongoConfig(dir, "pw");
    await cleanup();
    await expect(stat(mount.source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The CA-file helpers and the worker's use of them. The bind mount itself is proved by the compose
// smoke (a postgres target behind a throwaway CA reaching VERIFIED); what is pinned here is what the
// runner is HANDED — read-only, at the path every descriptor names — and that nothing is mounted
// where nothing should be.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MONGO_CONFIG_PATH } from "@schrodump/engines/adapters/mongodb";
import { TLS_CA_PATH, type TargetConnection } from "@schrodump/engines/descriptor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  stageTlsCaForBackup,
  TLS_CA_SCRATCH_REQUIRED_REASON,
  tlsCaDirFor,
  writeTlsCaFile,
} from "./tls-ca-file.js";
import { tlsCaScratchProblem, tlsOf, withConnectionMounts } from "./worker-wiring.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

const CONN: TargetConnection = {
  host: "db.internal",
  port: 5432,
  database: "app",
  username: "backup",
  password: "s3cret",
  tls: true,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "schrodump-tls-ca-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeTlsCaFile", () => {
  it("writes the PEM, world-readable for an executor that runs as another uid", async () => {
    const { mount } = await writeTlsCaFile(dir, PEM);
    expect(await readFile(mount.source, "utf8")).toBe(PEM);
    expect(dirname(mount.source)).toBe(dir);
    expect((await stat(mount.source)).mode & 0o777).toBe(0o644);
  });

  it("mounts READ-ONLY at the engines-exported TLS_CA_PATH (never hardcoded)", async () => {
    const { mount } = await writeTlsCaFile(dir, PEM);
    expect(mount).toMatchObject({ target: TLS_CA_PATH, readOnly: true });
  });

  it("cleanup removes the file", async () => {
    const { mount, cleanup } = await writeTlsCaFile(dir, PEM);
    await cleanup();
    await expect(stat(mount.source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// Not in the job's reservation: pg_dump -Fd refuses a non-empty staging directory and the archive
// step would tar the CA into the artifact.
describe("stageTlsCaForBackup", () => {
  it("uses a directory of its own beside the job's, never the staging directory", async () => {
    const { mount } = await stageTlsCaForBackup(dir, "job-1", PEM);
    expect(dirname(mount.source)).toBe(tlsCaDirFor(dir, "job-1"));
    expect(dirname(mount.source)).not.toBe(join(dir, "job-1"));
    expect(mount).toMatchObject({ target: TLS_CA_PATH, readOnly: true });
  });

  it("cleanup removes the whole directory", async () => {
    const { cleanup } = await stageTlsCaForBackup(dir, "job-1", PEM);
    await cleanup();
    await expect(stat(tlsCaDirFor(dir, "job-1"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("tlsOf", () => {
  it("carries the CA only when the row has one", () => {
    expect(tlsOf({ tls: true, tlsCaCert: PEM })).toEqual({ tls: true, tlsCaCert: PEM });
    expect(tlsOf({ tls: true, tlsCaCert: null })).toEqual({ tls: true });
    expect(tlsOf({ tls: true, tlsCaCert: null })).not.toHaveProperty("tlsCaCert");
  });
});

describe("tlsCaScratchProblem — a verified target needs somewhere to mount its CA from", () => {
  it("refuses a CA without scratch, by name", () => {
    expect(tlsCaScratchProblem({ ...CONN, tlsCaCert: PEM }, undefined)).toBe(
      TLS_CA_SCRATCH_REQUIRED_REASON,
    );
  });

  it("lets everything else through", () => {
    expect(tlsCaScratchProblem({ ...CONN, tlsCaCert: PEM }, "/scratch")).toBeNull();
    expect(tlsCaScratchProblem(CONN, undefined)).toBeNull();
    // A CA with TLS off is inert, so there is nothing to mount and nothing to refuse.
    expect(tlsCaScratchProblem({ ...CONN, tls: false, tlsCaCert: PEM }, undefined)).toBeNull();
  });
});

describe("withConnectionMounts — what a restore executor is handed", () => {
  const mountsFor = async (engine: Parameters<typeof withConnectionMounts>[0], conn: TargetConnection) => {
    const provide = withConnectionMounts(engine, conn).provideExtraMounts;
    if (provide === undefined) return null;
    return provide(dir);
  };

  it("a verified postgres target gets its CA, read-only, and nothing else", async () => {
    const extra = await mountsFor("postgres", { ...CONN, tlsCaCert: PEM });
    expect(extra?.mounts).toEqual([
      expect.objectContaining({ target: TLS_CA_PATH, readOnly: true }),
    ]);
    const source = extra?.mounts[0]?.source ?? "";
    expect(await readFile(source, "utf8")).toBe(PEM);
    await extra?.cleanup();
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a verified mongo target gets both its --config and its CA", async () => {
    const extra = await mountsFor("mongodb", { ...CONN, tlsCaCert: PEM });
    expect(extra?.mounts.map((mount) => mount.target)).toEqual([MONGO_CONFIG_PATH, TLS_CA_PATH]);
    expect(extra?.mounts.every((mount) => mount.readOnly)).toBe(true);
  });

  it("an unverified or TLS-off postgres/mysql target mounts nothing at all", async () => {
    for (const engine of ["postgres", "mysql", "mariadb"] as const) {
      expect(withConnectionMounts(engine, CONN)).toEqual({});
      expect(withConnectionMounts(engine, { ...CONN, tls: false, tlsCaCert: PEM })).toEqual({});
    }
  });

  it("an unverified mongo target still gets its --config, and no CA", async () => {
    const extra = await mountsFor("mongodb", CONN);
    expect(extra?.mounts.map((mount) => mount.target)).toEqual([MONGO_CONFIG_PATH]);
  });
});

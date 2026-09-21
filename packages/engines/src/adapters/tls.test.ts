// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Every tool that connects to a target, in each of the three TLS modes. The defect this covers was
// the probe and the tools disagreeing about what `tls: true` meant; these assert what each tool is
// actually TOLD, mode by mode, so the tool side of that agreement cannot drift on its own. The flag
// spellings were verified against the real images first — a descriptor test can only confirm that
// the string was chosen, and one of the strings this replaced (`--tls` for the mongo tools) named
// an option the tools do not have.

import { describe, expect, it } from "vitest";
import {
  EngineDescriptorError,
  TLS_CA_PATH,
  targetTlsOf,
  tlsModeOf,
  type DumpInput,
  type RestoreInput,
  type TargetConnection,
} from "../descriptor.js";
import { mongodbAdapter } from "./mongodb.js";
import { mariadbAdapter, mysqlAdapter } from "./mysql.js";
import { postgresAdapter } from "./postgres.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

const BASE: TargetConnection = {
  host: "db.internal",
  port: 5432,
  database: "app",
  username: "backup",
  password: "s3cret",
  tls: true,
};
const OFF: TargetConnection = { ...BASE, tls: false };
const REQUIRE: TargetConnection = { ...BASE, tls: true };
const VERIFY: TargetConnection = { ...BASE, tls: true, tlsCaCert: PEM };

function dump(connection: TargetConnection, over: Partial<DumpInput> = {}): DumpInput {
  return {
    connection,
    serverVersionNum: 160002,
    executionMode: "STREAM",
    parallelism: 1,
    scope: { databases: ["app"], schemas: [], collections: [] },
    facts: { isReplicaSet: false, hasMyisam: false, canReadRolePasswords: true },
    ...over,
  };
}

function restore(connection: TargetConnection, over: Partial<RestoreInput> = {}): RestoreInput {
  return {
    connection,
    serverVersionNum: 160002,
    target: "DATABASE",
    scope: { databases: ["app"], schemas: [], collections: [] },
    executionMode: "STREAM",
    sourcePath: "/var/lib/schrodump/restore-source",
    ...over,
  };
}

describe("targetTlsOf — the one reading of a target's TLS settings", () => {
  it("reads the three modes", () => {
    expect(targetTlsOf(OFF)).toEqual({ mode: "disable" });
    expect(targetTlsOf(REQUIRE)).toEqual({ mode: "require" });
    expect(targetTlsOf(VERIFY)).toEqual({ mode: "verify-full", caCert: PEM });
  });

  it("keeps a CA inert while TLS is off — off is the explicit choice", () => {
    expect(tlsModeOf({ tls: false, tlsCaCert: PEM })).toBe("disable");
  });
});

describe("postgres — every tool gets the same PGSSLMODE", () => {
  const descriptors = (connection: TargetConnection) => [
    postgresAdapter.buildDump(dump(connection)),
    postgresAdapter.buildDump(
      dump(connection, { executionMode: "STAGED", parallelism: 2, stagingPath: "/scratch/j" }),
    ),
    postgresAdapter.buildGlobalsDump?.(dump(connection)),
    postgresAdapter.buildRestore(restore(connection)),
    postgresAdapter.buildGlobalsRestore?.(restore(connection)),
  ];

  it("disable: TLS off, no root certificate", () => {
    for (const descriptor of descriptors(OFF)) {
      expect(descriptor?.env.PGSSLMODE).toBe("disable");
      expect(descriptor?.env).not.toHaveProperty("PGSSLROOTCERT");
    }
  });

  it("require: encrypted and unverified, exactly as libpq's own sslmode=require", () => {
    for (const descriptor of descriptors(REQUIRE)) {
      expect(descriptor?.env.PGSSLMODE).toBe("require");
      expect(descriptor?.env).not.toHaveProperty("PGSSLROOTCERT");
    }
  });

  it("verify-full: the chain against the mounted CA, and the host name checked", () => {
    for (const descriptor of descriptors(VERIFY)) {
      expect(descriptor?.env.PGSSLMODE).toBe("verify-full");
      expect(descriptor?.env.PGSSLROOTCERT).toBe(TLS_CA_PATH);
    }
  });

  it("names the mounted path, never the certificate itself", () => {
    for (const descriptor of descriptors(VERIFY)) {
      expect(JSON.stringify(descriptor)).not.toContain("BEGIN CERTIFICATE");
    }
  });
});

describe("mysql — the stock client and mysqldump", () => {
  const MYSQL: Partial<DumpInput> = { serverVersionNum: 80036 };

  it("require: --ssl-mode=REQUIRED, which refuses a server without TLS and verifies nothing", () => {
    const command = mysqlAdapter.buildDump(dump(REQUIRE, MYSQL)).command;
    expect(command).toContain("--ssl-mode=REQUIRED");
    expect(command.join(" ")).not.toContain("--ssl-ca");
  });

  it("verify-full: VERIFY_IDENTITY against the mounted CA, on the dump and the restore", () => {
    const dumpCommand = mysqlAdapter.buildDump(dump(VERIFY, MYSQL)).command;
    expect(dumpCommand).toContain("--ssl-mode=VERIFY_IDENTITY");
    expect(dumpCommand).toContain(`--ssl-ca=${TLS_CA_PATH}`);
    expect(dumpCommand).not.toContain("--ssl-mode=REQUIRED");

    const restoreScript = mysqlAdapter.buildRestore(restore(VERIFY, { serverVersionNum: 80036 }))
      .command[2];
    expect(restoreScript).toContain("'--ssl-mode=VERIFY_IDENTITY'");
    expect(restoreScript).toContain(`'--ssl-ca=${TLS_CA_PATH}'`);
  });

  it("disable: unchanged — DISABLED plus the RSA key fetch caching_sha2_password needs", () => {
    const command = mysqlAdapter.buildDump(dump(OFF, MYSQL)).command;
    expect(command).toContain("--ssl-mode=DISABLED");
    expect(command).toContain("--get-server-public-key");
  });
});

describe("mariadb — its client has no ssl-mode", () => {
  const MARIA: Partial<DumpInput> = { serverVersionNum: 110402 };

  it("verify-full: --ssl, the mounted CA, and --ssl-verify-server-cert, on the dump and the restore", () => {
    const dumpCommand = mariadbAdapter.buildDump(dump(VERIFY, MARIA)).command;
    expect(dumpCommand).toEqual(
      expect.arrayContaining(["--ssl", `--ssl-ca=${TLS_CA_PATH}`, "--ssl-verify-server-cert"]),
    );
    expect(dumpCommand.join(" ")).not.toContain("--ssl-mode");

    const restoreScript = mariadbAdapter.buildRestore(restore(VERIFY, { serverVersionNum: 110402 }))
      .command[2];
    expect(restoreScript).toContain("'--ssl-verify-server-cert'");
    expect(restoreScript).toContain(`'--ssl-ca=${TLS_CA_PATH}'`);
  });

  it("require: --ssl alone", () => {
    const command = mariadbAdapter.buildDump(dump(REQUIRE, MARIA)).command;
    expect(command).toContain("--ssl");
    expect(command).not.toContain("--ssl-verify-server-cert");
  });

  it("disable: no TLS flag at all", () => {
    expect(mariadbAdapter.buildDump(dump(OFF, MARIA)).command.join(" ")).not.toContain("--ssl");
  });
});

// mydumper and myloader fall back to plaintext under --ssl-mode=REQUIRED (measured), so the one mode
// they cannot honour is refused rather than emitted, and the server routes it to STREAM first.
describe("mydumper / myloader — STAGED honours verify-full and refuses require", () => {
  const staged = (connection: TargetConnection) =>
    dump(connection, {
      serverVersionNum: 80036,
      executionMode: "STAGED",
      parallelism: 2,
      stagingPath: "/scratch/j",
    });
  const stagedRestore = (connection: TargetConnection) =>
    restore(connection, { serverVersionNum: 80036, executionMode: "STAGED" });

  for (const adapter of [mysqlAdapter, mariadbAdapter]) {
    it(`${adapter.kind}: verify-full reaches mydumper and myloader as VERIFY_IDENTITY + --ca`, () => {
      for (const command of [
        adapter.buildDump(staged(VERIFY)).command,
        adapter.buildRestore(stagedRestore(VERIFY)).command,
      ]) {
        expect(command).toEqual(
          expect.arrayContaining(["--ssl-mode=VERIFY_IDENTITY", `--ca=${TLS_CA_PATH}`]),
        );
      }
    });

    it(`${adapter.kind}: require is refused by both, never emitted as a flag that falls back`, () => {
      expect(() => adapter.buildDump(staged(REQUIRE))).toThrow(EngineDescriptorError);
      expect(() => adapter.buildRestore(stagedRestore(REQUIRE))).toThrow(
        /never dumped or restored through them/,
      );
    });

    it(`${adapter.kind}: says why before a mode is chosen, and only for require`, () => {
      expect(adapter.stagedTlsRefusal?.(REQUIRE)).toMatch(/fall back to plaintext/);
      expect(adapter.stagedTlsRefusal?.(VERIFY)).toBeNull();
      expect(adapter.stagedTlsRefusal?.(OFF)).toBeNull();
    });

    it(`${adapter.kind}: disable keeps mydumper's argv free of TLS flags`, () => {
      expect(adapter.buildDump(staged(OFF)).command.join(" ")).not.toContain("ssl");
    });
  }

  it("postgres and mongodb have no staged TLS limitation to declare", () => {
    expect(postgresAdapter.stagedTlsRefusal).toBeUndefined();
    expect(mongodbAdapter.stagedTlsRefusal).toBeUndefined();
  });
});

describe("mongodb — --ssl, never --tls", () => {
  const scope = { databases: ["shop"], schemas: [], collections: [] };
  const commands = (connection: TargetConnection) => [
    mongodbAdapter.buildDump(dump(connection, { serverVersionNum: 80000, scope })).command,
    mongodbAdapter.buildRestore(restore(connection, { serverVersionNum: 80000, scope })).command,
  ];

  it("require: --ssl, which verifies against the image's system store — the tools' own default", () => {
    for (const command of commands(REQUIRE)) {
      expect(command).toContain("--ssl");
      expect(command.join(" ")).not.toContain("--sslCAFile");
      expect(command).not.toContain("--tls");
    }
  });

  it("verify-full: --ssl --sslCAFile at the mounted path", () => {
    for (const command of commands(VERIFY)) {
      expect(command).toEqual(expect.arrayContaining(["--ssl", `--sslCAFile=${TLS_CA_PATH}`]));
      expect(command).not.toContain("--tls");
    }
  });

  it("disable: no TLS flag", () => {
    for (const command of commands(OFF)) {
      expect(command.join(" ")).not.toContain("--ssl");
    }
  });
});

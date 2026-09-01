// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  EngineDescriptorError,
  type DumpInput,
  type RestoreInput,
  type TargetConnection,
} from "../descriptor.js";
import { mongodbAdapter } from "./mongodb.js";

const CONN: TargetConnection = {
  host: "db.internal",
  port: 27017,
  database: "app",
  username: "backup",
  password: "s3cret",
  tls: true,
};

function dumpInput(over: Partial<DumpInput> = {}): DumpInput {
  return {
    connection: CONN,
    serverVersionNum: 80004,
    executionMode: "STREAM",
    parallelism: 1,
    scope: { databases: [], schemas: [], collections: [] },
    facts: { isReplicaSet: false, hasMyisam: false },
    ...over,
  };
}

function restoreInput(over: Partial<RestoreInput> = {}): RestoreInput {
  return {
    connection: CONN,
    serverVersionNum: 80004,
    target: "DATABASE",
    // A sub-scope restore now REQUIRES something to scope by — a DATABASE target with an empty
    // scope is refused, because the only other reading is "everything", which is what made this
    // capability unsafe. Tests about flags unrelated to scope get a valid one by default.
    scope: { databases: ["app"], schemas: [], collections: [] },
    executionMode: "STREAM",
    ...over,
  };
}

describe("mongodbAdapter.imageFor", () => {
  it("uses the official mongo:<major> image (which ships the tools)", () => {
    expect(mongodbAdapter.imageFor(80004)).toBe("mongo:8");
    expect(mongodbAdapter.imageFor(70005)).toBe("mongo:7");
  });
});

describe("mongodbAdapter.buildDump", () => {
  it("STREAM emits mongodump --archive to stdout, no oplog on a standalone", () => {
    const descriptor = mongodbAdapter.buildDump(dumpInput());
    expect(descriptor.command).toContain("mongodump");
    expect(descriptor.command).toContain("--archive");
    expect(descriptor.command).not.toContain("--oplog");
    expect(descriptor.outputKind).toBe("stdout");
  });

  it("adds --oplog for a full dump of a replica set", () => {
    const descriptor = mongodbAdapter.buildDump(
      dumpInput({ facts: { isReplicaSet: true, hasMyisam: false } }),
    );
    expect(descriptor.command).toContain("--oplog");
  });

  it("refuses a scoped dump on a replica set instead of only warning", () => {
    expect(() =>
      mongodbAdapter.buildDump(
        dumpInput({
          facts: { isReplicaSet: true, hasMyisam: false },
          scope: { databases: ["app"], schemas: [], collections: [] },
        }),
      ),
    ).toThrow(EngineDescriptorError);
  });

  it("keeps the password in env, never in the command", () => {
    const descriptor = mongodbAdapter.buildDump(dumpInput());
    for (const arg of descriptor.command) {
      expect(arg).not.toContain("s3cret");
    }
    expect(descriptor.command).toContain("--config");
    expect(descriptor.env.MONGODB_PASSWORD).toBe("s3cret");
  });
});

describe("mongodbAdapter.buildRestore", () => {
  it("STREAM reads from a mounted archive file with --drop, no --oplogReplay", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        target: "DATABASE",
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    expect(descriptor.command).toContain("mongorestore");
    expect(descriptor.command).toContain("--archive=/var/lib/schrodump/restore-source");
    expect(descriptor.command).toContain("--drop");
    expect(descriptor.command).toContain("--config");
    expect(descriptor.command).not.toContain("--oplogReplay");
    expect(descriptor.outputKind).toBe("directory");
  });

  it("includes --tls when connection.tls is true", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        connection: { ...CONN, tls: true },
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    expect(descriptor.command).toContain("--tls");
  });

  it("omits --tls when connection.tls is false", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        connection: { ...CONN, tls: false },
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    expect(descriptor.command).not.toContain("--tls");
  });

  it("keeps the password in env, never in the command", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    for (const arg of descriptor.command) {
      expect(arg).not.toContain("s3cret");
    }
    expect(descriptor.command).toContain("--config");
    expect(descriptor.env.MONGODB_PASSWORD).toBe("s3cret");
  });
});

describe("mongodbAdapter.buildRestore — oplog replay", () => {
  it("replays the oplog for a FULL_CLUSTER restore of an oplog-bearing archive", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        target: "FULL_CLUSTER",
        sourceHasOplog: true,
        sourcePath: "/var/lib/schrodump/restore-source",
      }),
    );
    expect(descriptor.command).toContain("--oplogReplay");
  });

  it("never replays for an archive dumped without --oplog, whatever the target", () => {
    // mongorestore hard-refuses --oplogReplay when the archive carries no oplog ("no oplog file to
    // replay"), so emitting it here would crash the whole restore rather than degrade it.
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({ target: "FULL_CLUSTER", sourceHasOplog: false }),
    );
    expect(descriptor.command).not.toContain("--oplogReplay");
  });

  it("never replays when the archive's provenance is unknown", () => {
    // Artifacts written before the fact was recorded. Guessing "yes" crashes a real restore during
    // an incident; the caller records the consistency caveat on the job instead.
    const descriptor = mongodbAdapter.buildRestore(restoreInput({ target: "FULL_CLUSTER" }));
    expect(descriptor.command).not.toContain("--oplogReplay");
  });

  it("never replays into a sub-scope target, even from an oplog-bearing archive", () => {
    // --oplogReplay applies the oplog across the WHOLE archive; against a DATABASE/COLLECTION
    // target that would write outside the scope the operator asked for.
    for (const target of ["DATABASE", "COLLECTION"] as const) {
      const descriptor = mongodbAdapter.buildRestore(
        restoreInput({
          target,
          sourceHasOplog: true,
          scope: { databases: ["app"], schemas: [], collections: ["events"] },
        }),
      );
      expect(descriptor.command).not.toContain("--oplogReplay");
    }
  });
});

describe("mongodbAdapter.buildVerifySandbox", () => {
  it("describes a mongo sandbox bootstrapped with a root user, forcing TCP readiness", () => {
    const s = mongodbAdapter.buildVerifySandbox!(80000, "pw", "shop");
    expect(s.image).toBe("mongo:8");
    expect(s.env.MONGO_INITDB_ROOT_USERNAME).toBe("verify");
    expect(s.env.MONGO_INITDB_ROOT_PASSWORD).toBe("pw");
    // --host 127.0.0.1 forces mongosh to probe TCP rather than whatever mongosh would otherwise
    // default to, the same defensive lesson as postgres's pg_isready -h 127.0.0.1 and mysql's
    // mysqladmin ping -h 127.0.0.1 (see postgres.ts / mysql.ts buildVerifySandbox). Unlike
    // postgres/mysql, the readiness check must also be AUTHENTICATED: mongo's temp bootstrap
    // server binds TCP with --auth stripped, so an unauthenticated ping false-positives against
    // it before the real (root-user) server is up. Requiring auth as "verify" against admin means
    // only the real server can pass.
    expect(s.readinessCommand).toEqual([
      "sh",
      "-c",
      'exec mongosh -u verify -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin ' +
        "--host 127.0.0.1 --quiet --eval 'db.runCommand({ping:1}).ok'",
    ]);
    expect(s.port).toBe(27017);
    expect(s.username).toBe("verify");
    expect(s.password).toBe("pw");
    expect(s.database).toBe("shop");
  });

  it("never puts the actual password on argv — only the env-var reference", () => {
    const s = mongodbAdapter.buildVerifySandbox!(80000, "s3cret-pw", "shop");
    for (const arg of s.readinessCommand) {
      expect(arg).not.toContain("s3cret-pw");
    }
    const joined = s.readinessCommand.join(" ");
    expect(joined).toContain("$MONGO_INITDB_ROOT_PASSWORD");
    expect(s.env.MONGO_INITDB_ROOT_PASSWORD).toBe("s3cret-pw");
  });
});

describe("mongodbAdapter.buildVerifyAssertions", () => {
  it("never interpolates target-controlled values into the mongosh eval script", () => {
    const evil = 'evil"+process.exit(1)+"';
    const descriptor = mongodbAdapter.buildVerifyAssertions({
      connection: { ...CONN, host: evil, database: evil, username: evil },
      serverVersionNum: 80004,
      scope: { databases: [evil], schemas: [], collections: [] },
    });
    const script = descriptor.command.at(-1) ?? "";
    // The eval string is static; the malicious values live only in env.
    expect(script).not.toContain(evil);
    expect(script).not.toContain("process.exit");
    expect(descriptor.env.SCHRODUMP_MONGO_HOSTPORT).toContain(evil);
    for (const arg of descriptor.command) {
      expect(arg).not.toContain("s3cret");
    }
  });

  // --nodb is mandatory: without it mongosh opens an implicit default connection to
  // mongodb://127.0.0.1:27017 at startup and aborts (ECONNREFUSED) before the --eval script — which
  // makes the ONLY intended connection — ever runs, silently turning every mongo verify FAILED.
  it("runs mongosh with --nodb so the script makes the only connection", () => {
    const descriptor = mongodbAdapter.buildVerifyAssertions({
      connection: CONN,
      serverVersionNum: 80004,
      scope: { databases: ["shop"], schemas: [], collections: [] },
    });
    expect(descriptor.command).toEqual([
      "mongosh",
      "--nodb",
      "--quiet",
      "--eval",
      descriptor.command.at(-1),
    ]);
  });
});

// Sub-scope restore was withdrawn because buildRestore never read input.scope and drove
// mongorestore with a bare --drop: a DATABASE request would drop and overwrite EVERY namespace in
// the archive. These pin the scoping that lets it come back. The proof that neighbours actually
// survive is an integration test against a real mongo — a descriptor test can only show the flags.
describe("mongodbAdapter.buildRestore — namespace scoping", () => {
  it("scopes a DATABASE restore to that database, so --drop cannot reach its neighbours", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({ target: "DATABASE", scope: { databases: ["app"], schemas: [], collections: [] } }),
    );

    expect(descriptor.command).toContain("--nsInclude=app.*");
    // --drop is namespace-scoped ONLY through --nsInclude. Keeping one without the other is the
    // defect this replaces, so both are asserted together.
    expect(descriptor.command).toContain("--drop");
  });

  it("scopes a COLLECTION restore to that collection alone", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        target: "COLLECTION",
        scope: { databases: ["app"], schemas: [], collections: ["events"] },
      }),
    );

    expect(descriptor.command).toContain("--nsInclude=app.events");
    expect(descriptor.command).not.toContain("--nsInclude=app.*");
  });

  it("emits one --nsInclude per requested database", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({
        target: "DATABASE",
        scope: { databases: ["app", "audit"], schemas: [], collections: [] },
      }),
    );

    expect(descriptor.command).toContain("--nsInclude=app.*");
    expect(descriptor.command).toContain("--nsInclude=audit.*");
  });

  it("leaves FULL_CLUSTER unscoped — the whole archive is the scope", () => {
    const descriptor = mongodbAdapter.buildRestore(
      restoreInput({ target: "FULL_CLUSTER", scope: { databases: ["app"], schemas: [], collections: [] } }),
    );

    expect(descriptor.command.some((a) => a.startsWith("--nsInclude"))).toBe(false);
  });

  // The failure mode that made this unsafe: a sub-scope request with nothing to scope BY would
  // emit no --nsInclude, leaving a bare --drop across the whole archive. Refusing is the only
  // answer that cannot lose data.
  it("refuses a sub-scope restore that names no database", () => {
    expect(() =>
      mongodbAdapter.buildRestore(
        restoreInput({ target: "DATABASE", scope: { databases: [], schemas: [], collections: [] } }),
      ),
    ).toThrow(EngineDescriptorError);
  });

  it("refuses a COLLECTION restore that names no collection", () => {
    expect(() =>
      mongodbAdapter.buildRestore(
        restoreInput({
          target: "COLLECTION",
          scope: { databases: ["app"], schemas: [], collections: [] },
        }),
      ),
    ).toThrow(EngineDescriptorError);
  });
});

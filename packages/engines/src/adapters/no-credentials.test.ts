// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { ENGINE_KINDS, type EngineKind } from "@schrodump/core/types";
import {
  type DumpInput,
  type RestoreInput,
  type TargetConnection,
  type VerifyInput,
} from "../descriptor.js";
import { resolveAdapter } from "../registry.js";

const PASSWORD = "sup3r-s3cret-p@ssw0rd";

const CONN: TargetConnection = {
  host: "db.internal",
  port: 5432,
  database: "app",
  username: "backup",
  password: PASSWORD,
  tls: true,
};

// A supported version per engine, so imageFor never rejects it.
const VERSION: Record<EngineKind, number> = {
  postgres: 160002,
  mysql: 80036,
  mariadb: 110402,
  mongodb: 80004,
};

const EMPTY_SCOPE = { databases: [], schemas: [], collections: [] };

function commandsFor(kind: EngineKind): string[][] {
  const adapter = resolveAdapter(kind);
  const dump: DumpInput = {
    connection: CONN,
    serverVersionNum: VERSION[kind],
    executionMode: "STREAM",
    parallelism: 1,
    scope: EMPTY_SCOPE,
    facts: { isReplicaSet: false, hasMyisam: false },
  };
  const restore: RestoreInput = {
    connection: CONN,
    serverVersionNum: VERSION[kind],
    target: "DATABASE",
    scope: EMPTY_SCOPE,
  };
  const verify: VerifyInput = {
    connection: CONN,
    serverVersionNum: VERSION[kind],
    scope: EMPTY_SCOPE,
  };

  const commands = [
    adapter.buildDump(dump).command,
    adapter.buildRestore(restore).command,
    adapter.buildVerifyAssertions(verify).command,
  ];
  if (adapter.buildGlobalsDump) commands.push(adapter.buildGlobalsDump(dump).command);
  return commands;
}

describe("no credential ever appears in a command", () => {
  for (const kind of ENGINE_KINDS) {
    it(`routes the password to env, never argv, for ${kind}`, () => {
      for (const command of commandsFor(kind)) {
        for (const arg of command) {
          expect(arg).not.toContain(PASSWORD);
        }
      }
      // and it must actually be carried somewhere in env
      const env = resolveAdapter(kind).buildDump({
        connection: CONN,
        serverVersionNum: VERSION[kind],
        executionMode: "STREAM",
        parallelism: 1,
        scope: EMPTY_SCOPE,
        facts: { isReplicaSet: false, hasMyisam: false },
      }).env;
      expect(Object.values(env)).toContain(PASSWORD);
    });
  }
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { MongoClient, type MongoClientOptions } from "mongodb";
import { targetTlsOf } from "../descriptor.js";
import { versionToNum, type DatabaseSize, type ProbeConnection, type ProbeResult } from "./types.js";

// The driver's half of each TLS mode, matched to the tool flags (adapters/mongodb mongoTlsArgs).
// Unlike postgres and mysql, `require` still verifies — against Node's bundled CAs here and the
// image's system store in mongodump — because that is the tools' own default and there is no
// unverified mode to match. A CA replaces the bundled list rather than adding to it, exactly as
// `--sslCAFile` does, so "verified against that CA" means that CA and nothing else.
export function mongoTls(conn: ProbeConnection): Pick<MongoClientOptions, "tls" | "ca"> {
  const tls = targetTlsOf(conn);
  switch (tls.mode) {
    case "disable":
      return { tls: false };
    case "require":
      return { tls: true };
    case "verify-full":
      return { tls: true, ca: tls.caCert };
  }
}

export async function probeMongodb(conn: ProbeConnection): Promise<ProbeResult> {
  const client = new MongoClient(`mongodb://${conn.host}:${conn.port}`, {
    auth: { username: conn.username, password: conn.password },
    authSource: conn.database,
    ...mongoTls(conn),
    serverSelectionTimeoutMS: conn.connectTimeoutMs,
    connectTimeoutMS: conn.connectTimeoutMs,
  });

  try {
    await client.connect();
    const admin = client.db(conn.database).admin();

    const info = await admin.serverInfo();
    const serverVersionNum = versionToNum(String(info.version));

    const listed = await admin.listDatabases();
    const databases: DatabaseSize[] = listed.databases.map((database) => ({
      name: database.name,
      sizeBytes: Number(database.sizeOnDisk ?? 0),
    }));

    // A replica set reports a `setName` in the hello() response; a standalone does not.
    const hello = await admin.command({ hello: 1 });
    const setName: unknown = hello["setName"];
    const isReplicaSet = typeof setName === "string" && setName.length > 0;

    // Collections are deliberately NOT enumerated here. `conn.database` is the authSource ("admin"
    // for mongo — see probe/types + worker-wiring's probeDatabaseFor), NOT a data db: a
    // least-privilege backup credential (readWrite on its ONE scoped db, created in admin) is not
    // authorized to `listCollections` on admin and the driver throws Unauthorized (code 13). It is
    // also the wrong db to list — the backup dumps whole databases (scope.databases). Note that
    // for mongodb this scope is discovery only: dumpScopeFor (worker-wiring) hands buildDump the
    // TARGET's scope instead, so what is reported here does not decide what gets dumped. Report no
    // collection-level scope, exactly as the mysql/postgres probes do, so a whole-db dump stays a
    // whole-db dump. Collection-level discovery, if it is ever needed, must run against a data db
    // the credential can actually read, never the authSource.
    return {
      serverVersionNum,
      databases,
      scope: {
        databases: databases.map((database) => database.name),
        schemas: [],
        collections: [],
      },
      facts: { isReplicaSet, hasMyisam: false, canReadRolePasswords: false },
    };
  } finally {
    await client.close();
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { MongoClient } from "mongodb";
import { versionToNum, type DatabaseSize, type ProbeConnection, type ProbeResult } from "./types.js";

export async function probeMongodb(conn: ProbeConnection): Promise<ProbeResult> {
  const client = new MongoClient(`mongodb://${conn.host}:${conn.port}`, {
    auth: { username: conn.username, password: conn.password },
    authSource: conn.database,
    tls: conn.tls,
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
    // also the wrong db to list — the backup dumps whole databases (scope.databases), and
    // worker-wiring feeds probe.scope straight into buildDump, where a non-empty scope.collections
    // becomes a `--collection` filter (and >1 is refused as MONGODB_SCOPE_TOO_BROAD). Report no
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
      facts: { isReplicaSet, hasMyisam: false },
    };
  } finally {
    await client.close();
  }
}

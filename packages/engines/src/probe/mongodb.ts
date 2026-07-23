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

    const collections = await client.db(conn.database).listCollections().toArray();

    return {
      serverVersionNum,
      databases,
      scope: {
        databases: databases.map((database) => database.name),
        schemas: [],
        collections: collections.map((collection) => collection.name),
      },
      facts: { isReplicaSet, hasMyisam: false },
    };
  } finally {
    await client.close();
  }
}

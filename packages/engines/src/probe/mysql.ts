// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createConnection, type RowDataPacket } from "mysql2/promise";
import { versionToNum, type DatabaseSize, type ProbeConnection, type ProbeResult } from "./types.js";

export async function probeMysql(conn: ProbeConnection): Promise<ProbeResult> {
  const connection = await createConnection({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    connectTimeout: conn.connectTimeoutMs,
    ...(conn.tls ? { ssl: {} } : {}),
  });

  try {
    const [versionRows] = await connection.query<RowDataPacket[]>("SELECT VERSION() AS version");
    const serverVersionNum = versionToNum(String(versionRows[0]?.version ?? ""));

    // information_schema and performance_schema are catalog/introspection views, not backupable
    // data — and they are visible in information_schema.tables/.schemata to EVERY authenticated
    // user regardless of grants (verified against both root and a database-scoped user), unlike
    // `mysql`/`sys` which only appear for a user actually granted on them. Left in, they flow
    // straight into buildDump's `--databases` list (worker-wiring passes probe.scope through
    // unfiltered). `information_schema` is the unconditional failure: mysqldump hard-refuses it
    // ("Dumping 'information_schema' DB content is not supported") on every real instance, and a
    // single unrefusable database anywhere in `--databases` aborts the whole dump. `performance_schema`
    // is a runtime catalog with no user data (mysqldump does not hard-refuse it, but it is never a
    // backup candidate); excluding both mirrors probePostgres's own `datistemplate = false` filter:
    // the probe reports backup CANDIDATES, and a catalog schema is never one.
    const SYSTEM_SCHEMAS = "('information_schema', 'performance_schema')";
    const [sizeRows] = await connection.query<RowDataPacket[]>(
      "SELECT table_schema AS name, SUM(data_length + index_length) AS bytes " +
        `FROM information_schema.tables WHERE table_schema NOT IN ${SYSTEM_SCHEMAS} GROUP BY table_schema`,
    );
    const databases: DatabaseSize[] = sizeRows.map((row) => ({
      name: String(row.name),
      sizeBytes: Number(row.bytes ?? 0),
    }));

    const [myisamRows] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE engine = 'MyISAM'",
    );
    const hasMyisam = Number(myisamRows[0]?.count ?? 0) > 0;

    const [schemaRows] = await connection.query<RowDataPacket[]>(
      `SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ${SYSTEM_SCHEMAS}`,
    );

    return {
      serverVersionNum,
      databases,
      scope: {
        databases: databases.map((database) => database.name),
        schemas: schemaRows.map((row) => String(row.name)),
        collections: [],
      },
      facts: { isReplicaSet: false, hasMyisam },
    };
  } finally {
    await connection.end();
  }
}

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

    const [sizeRows] = await connection.query<RowDataPacket[]>(
      "SELECT table_schema AS name, SUM(data_length + index_length) AS bytes " +
        "FROM information_schema.tables GROUP BY table_schema",
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
      "SELECT schema_name AS name FROM information_schema.schemata",
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

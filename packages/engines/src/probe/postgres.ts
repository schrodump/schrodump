// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Client } from "pg";
import type { DatabaseSize, ProbeConnection, ProbeResult } from "./types.js";

export async function probePostgres(conn: ProbeConnection): Promise<ProbeResult> {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    ssl: conn.tls ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: conn.connectTimeoutMs,
    statement_timeout: conn.connectTimeoutMs,
  });

  await client.connect();
  try {
    const version = await client.query<{ server_version_num: string }>("SHOW server_version_num");
    const serverVersionNum = Number(version.rows[0]?.server_version_num ?? "0");

    const sizes = await client.query<{ datname: string; size: string }>(
      "SELECT datname, pg_database_size(datname)::text AS size " +
        "FROM pg_database WHERE datistemplate = false",
    );
    const databases: DatabaseSize[] = sizes.rows.map((row) => ({
      name: row.datname,
      sizeBytes: Number(row.size),
    }));

    const schemas = await client.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata " +
        "WHERE schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg\\_%'",
    );

    // The exact predicate pg_dumpall depends on, not `rolsuper`: it reads pg_authid unless given
    // --no-role-passwords, and that read is refused to everyone but a superuser or a role granted
    // SELECT on it. A managed service's "master" user (rds_superuser, cloudsqlsuperuser,
    // azure_pg_admin, ...) is not a superuser and gets false here, which is what it is.
    const authid = await client.query<{ can_read: boolean }>(
      "SELECT has_table_privilege('pg_catalog.pg_authid', 'SELECT') AS can_read",
    );
    const canReadRolePasswords = authid.rows[0]?.can_read === true;

    return {
      serverVersionNum,
      databases,
      scope: {
        databases: databases.map((database) => database.name),
        schemas: schemas.rows.map((row) => row.schema_name),
        collections: [],
      },
      facts: { isReplicaSet: false, hasMyisam: false, canReadRolePasswords },
    };
  } finally {
    await client.end();
  }
}

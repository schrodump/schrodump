// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { Client } from "pg";
import { targetTlsOf } from "../descriptor.js";
import type { DatabaseSize, ProbeConnection, ProbeResult } from "./types.js";

// The driver's half of each TLS mode, matched to what pg_dump is told (PGSSLMODE, adapters/postgres).
//
// `require` does not verify, because `sslmode=require` does not. This used to be
// `{ rejectUnauthorized: true }` — verification against Node's bundled CAs, with no way to add one —
// so every managed postgres (RDS, Cloud SQL, Supabase, anything self-signed) failed here, and with it
// every backup, while pg_dump itself would have connected and verified nothing.
//
// `verify-full` checks the name against `conn.host` explicitly. pg layers TLS on a socket it already
// connected and passes no host to tls.connect — only a servername, and none for an IP — so Node
// falls back to checking the certificate against "localhost" for an IP-literal host (measured).
// Pinning the check to the configured host is what libpq's verify-full does too.
export function postgresSsl(conn: ProbeConnection): false | ConnectionOptions {
  const tls = targetTlsOf(conn);
  switch (tls.mode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return {
        ca: tls.caCert,
        rejectUnauthorized: true,
        checkServerIdentity: (_servername, cert) => checkServerIdentity(conn.host, cert),
      };
  }
}

export async function probePostgres(conn: ProbeConnection): Promise<ProbeResult> {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    ssl: postgresSsl(conn),
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { isIP } from "node:net";
import { checkServerIdentity, TLSSocket } from "node:tls";
import { createConnection, type Connection, type RowDataPacket, type SslOptions } from "mysql2/promise";
import { targetTlsOf } from "../descriptor.js";
import { versionToNum, type DatabaseSize, type ProbeConnection, type ProbeResult } from "./types.js";

// The driver's half of each TLS mode, matched to the client flags (adapters/mysql tlsArgs).
//
// `require` does not verify, because `--ssl-mode=REQUIRED` does not. This used to be `ssl: {}`, which
// mysql2 reads as "verify against Node's bundled CAs" — so a provider or self-signed CA failed here
// and every backup with it, while the client would have connected and verified nothing.
//
// `verify-full` needs `verifyIdentity`: without it mysql2 checks the chain and never the host name,
// which is VERIFY_CA, not VERIFY_IDENTITY.
export function mysqlSsl(conn: ProbeConnection): SslOptions | undefined {
  const tls = targetTlsOf(conn);
  switch (tls.mode) {
    case "disable":
      return undefined;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return { ca: tls.caCert, rejectUnauthorized: true, verifyIdentity: true };
  }
}

// mysql2 hands tls.connect no host and, for an IP-literal host, no servername either — so Node checks
// the certificate against "localhost" instead of the address (measured: a certificate naming
// localhost was accepted for ::1, which it does not name). Against a certificate that does not name
// localhost that is merely stricter; against one that does, the address was never looked at.
// Checking the address itself as soon as the connection is up closes that before a single query
// runs — though the login has already happened by then, which is why the docs say to give a verified
// mysql/mariadb target the host NAME on its certificate. For a name, mysql2's own check already used
// the right one and this returns at once.
//
// The promise wrapper keeps the callback connection, and that its TLS socket, on untyped fields; the
// shape is read defensively and a connection without a TLS socket is refused rather than passed.
function assertPeerNamesHost(connection: Connection, host: string): void {
  if (isIP(host) === 0) return;
  const inner = (connection as unknown as { connection?: { stream?: unknown } }).connection;
  const stream = inner?.stream;
  if (!(stream instanceof TLSSocket)) {
    throw new Error("a verified connection has no TLS socket to check the host against");
  }
  const mismatch = checkServerIdentity(host, stream.getPeerCertificate());
  if (mismatch !== undefined) throw mismatch;
}

export async function probeMysql(conn: ProbeConnection): Promise<ProbeResult> {
  const ssl = mysqlSsl(conn);
  const connection = await createConnection({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    connectTimeout: conn.connectTimeoutMs,
    ...(ssl !== undefined ? { ssl } : {}),
  });

  try {
    if (targetTlsOf(conn).mode === "verify-full") assertPeerNamesHost(connection, conn.host);

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
      facts: { isReplicaSet: false, hasMyisam, canReadRolePasswords: false },
    };
  } finally {
    await connection.end();
  }
}

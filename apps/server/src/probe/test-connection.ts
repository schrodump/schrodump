// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { ProbeConnection, ProbeResult } from "@schrodump/engines/probe/types";
import { probeMongodb } from "@schrodump/engines/probe/mongodb";
import { probeMysql } from "@schrodump/engines/probe/mysql";
import { probePostgres } from "@schrodump/engines/probe/postgres";

export type EngineName = "postgres" | "mysql" | "mariadb" | "mongodb";

// A code, never a driver message. Driver errors routinely embed the credential they failed with —
// the MongoDB driver puts the whole URI, password included, in its error text — so classifying
// here and discarding the original is what keeps the secret out of both the response and the log.
//
// Note the distinction: this READS the message when nothing better is available, because that is
// where some drivers put the only discriminating detail. It never EMITS it. What leaves this
// module is one of these six constants.
export type ProbeFailureCode =
  | "UNREACHABLE"
  | "TIMEOUT"
  | "AUTH_FAILED"
  | "INSUFFICIENT_PRIVILEGES"
  | "TLS_FAILED"
  | "UNKNOWN";

export interface TestConnectionResult {
  readonly ok: boolean;
  readonly serverVersionNum: number | null;
  readonly failure: ProbeFailureCode | null;
  // The driver's own error class and code — "MongoServerError/13" — and never anything else.
  // Without it an UNKNOWN is a dead end for the operator: they can see that it failed and have no
  // way to say why to anyone. A class name and a numeric code cannot carry a credential, which is
  // exactly why this is the one piece of driver output allowed out of here.
  readonly driverCode: string | null;
}

export interface ProbeTarget {
  readonly engine: EngineName;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly tls: boolean;
  // From the target's scope. Used only by the SQL engines, where it names the database to connect
  // to; for MongoDB the probe treats it as the auth source, which is a different thing entirely.
  readonly databases: readonly string[];
}

export type ProbeFn = (conn: ProbeConnection) => Promise<ProbeResult>;
export type ProbeTable = Readonly<Record<EngineName, ProbeFn>>;

const DEFAULT_PROBES: ProbeTable = {
  postgres: probePostgres,
  mysql: probeMysql,
  mariadb: probeMysql,
  mongodb: probeMongodb,
};

// A connectivity test must fail fast: an operator clicking a button is waiting on it.
const CONNECT_TIMEOUT_MS = 8_000;

// The database the probe connects through. For PostgreSQL and MySQL this is a real database, so
// the first scoped one is used when the target names any. For MongoDB `database` is the auth
// source, which is `admin` regardless of what is being backed up.
function databaseFor(target: ProbeTarget): string {
  if (target.engine === "mongodb") return "admin";
  const scoped = target.databases[0];
  if (scoped !== undefined && scoped.length > 0) return scoped;
  return target.engine === "postgres" ? "postgres" : "mysql";
}

interface ErrorShape {
  readonly code: string;
  readonly name: string;
  readonly message: string;
}

function shapeOf(error: unknown): ErrorShape {
  if (typeof error !== "object" || error === null) return { code: "", name: "", message: "" };
  const record = error as { code?: unknown; codeName?: unknown; name?: unknown; message?: unknown; cause?: unknown };

  let code = "";
  if (typeof record.code === "string") code = record.code;
  else if (typeof record.code === "number") code = String(record.code);
  else if (typeof record.codeName === "string") code = record.codeName;
  // The MongoDB driver wraps the socket failure; the useful code can sit on the cause.
  else if (typeof record.cause === "object" && record.cause !== null) {
    const cause = record.cause as { code?: unknown };
    if (typeof cause.code === "string") code = cause.code;
  }

  return {
    code: code.toUpperCase(),
    name: typeof record.name === "string" ? record.name.toUpperCase() : "",
    message: typeof record.message === "string" ? record.message.toLowerCase() : "",
  };
}

// Reads code first because codes are stable identifiers the drivers document, then the error's
// class name, and only then a handful of fixed phrases. The last step exists because the MongoDB
// driver reports every connection-level failure as MongoServerSelectionError with no code at all,
// and the only thing separating "no TLS on the other end" from "host is down" is the wording.
//
// Reading the message is not the same as emitting it: what this returns is one of six constants,
// and the driver's text is dropped on the floor.
export function classify(error: unknown): ProbeFailureCode {
  const { code, name, message } = shapeOf(error);

  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(code)) {
    return "UNREACHABLE";
  }
  // 28P01 invalid_password and 28000 invalid_authorization_specification (PostgreSQL);
  // 1045 ER_ACCESS_DENIED_ERROR (MySQL/MariaDB); 18 AuthenticationFailed (MongoDB).
  if (["28P01", "28000", "ER_ACCESS_DENIED_ERROR", "1045", "18", "AUTHENTICATIONFAILED"].includes(code)) {
    return "AUTH_FAILED";
  }
  // 13 Unauthorized (MongoDB), 42501 insufficient_privilege (PostgreSQL). A different problem
  // from AUTH_FAILED and a different fix: the credential is right, the grant is missing.
  if (["13", "UNAUTHORIZED", "42501", "ER_SPECIFIC_ACCESS_DENIED_ERROR", "1227"].includes(code)) {
    return "INSUFFICIENT_PRIVILEGES";
  }
  if (["EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_TLS_CERT_ALTNAME_INVALID", "08P01"].includes(code)) {
    return "TLS_FAILED";
  }
  if (["ETIMEDOUT", "ETIMEOUT", "PROTOCOL_SEQUENCE_TIMEOUT"].includes(code)) return "TIMEOUT";

  // Speaking TLS to a server that does not offer it looks like a socket that closed mid-handshake.
  if (message.includes("tls") || message.includes("ssl")) return "TLS_FAILED";

  if (message.includes("not authorized") || message.includes("requires authentication")) {
    return "INSUFFICIENT_PRIVILEGES";
  }
  if (name === "MONGONETWORKERROR" || message.includes("econnrefused")) return "UNREACHABLE";
  if (name === "MONGOSERVERSELECTIONERROR" || message.includes("timed out")) return "TIMEOUT";

  return "UNKNOWN";
}

// The driver's identity for the failure: class name and code, nothing else. Used to make an
// UNKNOWN reportable instead of a dead end.
export function driverCodeOf(error: unknown): string | null {
  const { code, name } = shapeOf(error);
  const parts = [name, code].filter((part) => part.length > 0);
  return parts.length === 0 ? null : parts.join("/");
}

// Probes a target and reports whether it answered, plus the server version — the number that
// decides which executor image can dump and restore it. It returns codes, never credentials and
// never driver prose.
export async function testTargetConnection(
  target: ProbeTarget,
  probes: ProbeTable = DEFAULT_PROBES,
): Promise<TestConnectionResult> {
  const connection: ProbeConnection = {
    host: target.host,
    port: target.port,
    database: databaseFor(target),
    username: target.username,
    password: target.password,
    tls: target.tls,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  };

  try {
    const result = await probes[target.engine](connection);
    return { ok: true, serverVersionNum: result.serverVersionNum, failure: null, driverCode: null };
  } catch (error) {
    return {
      ok: false,
      serverVersionNum: null,
      failure: classify(error),
      driverCode: driverCodeOf(error),
    };
  }
}

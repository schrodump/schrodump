// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { DatabaseSize, ProbeConnection, ProbeResult } from "@schrodump/engines/probe/types";
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
  // What the server holds, by name and size. Empty on failure. This used to be dropped here — the
  // probe measured it and the worker used it for STAGED routing, but the operator never saw it. It
  // is what lets a target be scoped from what actually exists instead of from a typed name: on a
  // real deployment an unscoped postgres target dumped the maintenance database while the 9.4 GB
  // one sat beside it in this very list, discarded on this line. Names and sizes are not
  // credentials, and the caller has already supplied the credentials that produced them.
  readonly databases: readonly DatabaseSize[];
  // null on failure. For mongodb this decides the scope outright: a replica set is dumped whole,
  // with its oplog, and cannot be narrowed. Reported for every engine rather than only mongo so a
  // caller never has to guess whether null means "not a replica set" or "not asked".
  readonly isReplicaSet: boolean | null;
}

export interface ProbeTarget {
  readonly engine: EngineName;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly tls: boolean;
  // The target's CA certificate (PEM), or null. With `tls` it decides the mode the probe connects in
  // (targetTlsOf, engines descriptor.ts) — the same reading every dump and restore tool gets, so a
  // probe that passes is a backup that can connect.
  readonly tlsCaCert: string | null;
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

// How far down a `cause` chain a code is looked for. The MongoDB driver wraps the socket failure
// twice: a certificate the store did not trust arrives as MongoServerSelectionError, whose cause is a
// MongoNetworkError with no code, whose cause is Node's TLS error carrying SELF_SIGNED_CERT_IN_CHAIN
// (measured against a requireTLS mongod). Reading one level found nothing, and the name fallback
// below then called a certificate problem a TIMEOUT.
const CAUSE_DEPTH = 3;

function codeOf(record: { code?: unknown; codeName?: unknown }): string {
  if (typeof record.code === "string") return record.code;
  if (typeof record.code === "number") return String(record.code);
  if (typeof record.codeName === "string") return record.codeName;
  return "";
}

function shapeOf(error: unknown): ErrorShape {
  if (typeof error !== "object" || error === null) return { code: "", name: "", message: "" };
  const record = error as { code?: unknown; codeName?: unknown; name?: unknown; message?: unknown; cause?: unknown };

  let code = codeOf(record);
  // The drivers wrap the socket failure; the useful code can sit on a cause.
  let cause = record.cause;
  for (let depth = 0; code === "" && depth < CAUSE_DEPTH; depth++) {
    if (typeof cause !== "object" || cause === null) break;
    const next = cause as { code?: unknown; codeName?: unknown; cause?: unknown };
    code = codeOf(next);
    cause = next.cause;
  }

  return {
    code: code.toUpperCase(),
    name: typeof record.name === "string" ? record.name.toUpperCase() : "",
    message: typeof record.message === "string" ? record.message.toLowerCase() : "",
  };
}

// The certificate could not be verified, by the code Node's TLS layer gives each reason. These are
// what a server behind a provider or private CA answers when no CA — or the wrong one — was supplied,
// and they came back UNKNOWN: an operator told "the driver gave no code this recognises" instead of
// "paste the provider's CA". Listed by code, never matched by message.
const CERTIFICATE_CODES = [
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "CERT_CHAIN_TOO_LONG",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];

// Everything else that means TLS did not come up, by code:
//   EPROTO, ERR_SSL_*   a handshake the other end would not complete (ERR_SSL_WRONG_VERSION_NUMBER
//                       is TLS spoken to a plaintext port); OpenSSL names each alert this way.
//   ERR_OSSL_*          the CA material itself could not be read.
//   HANDSHAKE_SSL_ERROR mysql2's wrapper for any failed TLS upgrade — it replaces Node's code with
//                       this one, so a certificate refusal arrives here and nowhere else (measured).
//   HANDSHAKE_NO_SSL_SUPPORT  mysql2: TLS required, the server offers none.
//   ER_SECURE_TRANSPORT_REQUIRED, 3159  mysql: TLS off, the server requires it.
//   08P01               postgres protocol violation, what a TLS mismatch looks like there.
const TLS_CODES = [
  "EPROTO",
  "08P01",
  "HANDSHAKE_SSL_ERROR",
  "HANDSHAKE_NO_SSL_SUPPORT",
  "ER_SECURE_TRANSPORT_REQUIRED",
  "3159",
];
const TLS_CODE_PREFIXES = ["ERR_SSL_", "ERR_OSSL_"];

function isTlsCode(code: string): boolean {
  return (
    CERTIFICATE_CODES.includes(code) ||
    TLS_CODES.includes(code) ||
    TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))
  );
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
  if (isTlsCode(code)) return "TLS_FAILED";
  // 28000 is also how postgres refuses a connection that pg_hba.conf only accepts over TLS
  // (`hostssl`): TLS off against a server that requires it. The code alone cannot tell that from a
  // rejected role; the refusal says "no encryption", and the tie-break reads that, never emits it.
  if (code === "28000" && message.includes("no encryption")) return "TLS_FAILED";
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
    ...(target.tlsCaCert !== null ? { tlsCaCert: target.tlsCaCert } : {}),
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  };

  try {
    const result = await probes[target.engine](connection);
    return {
      ok: true,
      serverVersionNum: result.serverVersionNum,
      failure: null,
      driverCode: null,
      databases: result.databases,
      isReplicaSet: result.facts.isReplicaSet,
    };
  } catch (error) {
    return {
      ok: false,
      serverVersionNum: null,
      failure: classify(error),
      driverCode: driverCodeOf(error),
      databases: [],
      isReplicaSet: null,
    };
  }
}

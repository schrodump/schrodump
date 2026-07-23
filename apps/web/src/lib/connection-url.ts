// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { EngineKind } from "@/lib/domain";

// Parses a connection URL into the fields the target form already has. This is a filler for the
// form, not a wire format: the URL carries the password, and the project keeps exactly one path
// for a credential. Sending the URL to the server would create a second one — through validation,
// logs and error messages — in exchange for convenience.

export interface ParsedConnection {
  readonly engine: EngineKind;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  // null means the URL said nothing about TLS, so the form's default must stand. Turning TLS off
  // is an explicit, recorded choice — never a silent fallback.
  readonly tls: boolean | null;
  readonly databases: string[];
}

export type ParseFailureReason =
  | "malformed"
  | "unsupportedScheme"
  | "srvUnsupported"
  | "multipleHosts";

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedConnection }
  | { readonly ok: false; readonly reason: ParseFailureReason; readonly scheme?: string };

const BY_SCHEME: Record<string, { engine: EngineKind; port: number }> = {
  "postgres:": { engine: "postgres", port: 5432 },
  "postgresql:": { engine: "postgres", port: 5432 },
  "mysql:": { engine: "mysql", port: 3306 },
  "mariadb:": { engine: "mariadb", port: 3306 },
  "mongodb:": { engine: "mongodb", port: 27017 },
};

// Values that mean "TLS is required". Anything else that is stated explicitly — disable, prefer,
// allow — does not require TLS, so it maps to false rather than being rounded up to true.
const TLS_REQUIRED = new Set(["require", "verify-ca", "verify-full", "required", "verify_ca", "verify_identity"]);

function readTls(params: URLSearchParams): boolean | null {
  const mode = params.get("sslmode") ?? params.get("ssl-mode") ?? params.get("sslMode");
  if (mode !== null) return TLS_REQUIRED.has(mode.toLowerCase());

  const flag = params.get("tls") ?? params.get("ssl") ?? params.get("useSSL");
  if (flag !== null) return flag.toLowerCase() === "true" || flag === "1";

  return null;
}

// The host portion, with any userinfo stripped. Read from the raw string because the shapes we
// most want to name — mongodb+srv, a replica-set URI — are ones the URL parser rejects or accepts
// for the wrong reasons, and "malformed" is a useless thing to tell someone who pasted a URI their
// database tooling prints.
function authorityOf(raw: string): string {
  const marker = raw.indexOf("://");
  if (marker === -1) return "";
  const rest = raw.slice(marker + 3);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  return at === -1 ? authority : authority.slice(at + 1);
}

export function parseConnectionUrl(input: string): ParseResult {
  const raw = input.trim();
  if (raw.length === 0) return { ok: false, reason: "malformed" };

  // Checked before parsing: the failure to report is about the target model, not about syntax.
  if (/^mongodb\+srv:/i.test(raw)) return { ok: false, reason: "srvUnsupported" };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === undefined) return { ok: false, reason: "malformed" };

  const known = BY_SCHEME[`${scheme}:`];
  if (known === undefined) return { ok: false, reason: "unsupportedScheme", scheme };

  // A replica-set URI lists several hosts. A target holds one, and silently taking the first would
  // produce a target that looks right and backs up the wrong node.
  if (authorityOf(raw).includes(",")) return { ok: false, reason: "multipleHosts" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (url.hostname.length === 0) return { ok: false, reason: "malformed" };

  return {
    ok: true,
    value: {
      engine: known.engine,
      // IPv6 arrives bracketed from the URL parser; database clients want the bare address.
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port === "" ? known.port : Number(url.port),
      // Credentials are percent-encoded in a URL: a password containing @ or / round-trips only
      // if it is decoded here.
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      tls: readTls(url.searchParams),
      databases: databasesOf(url.pathname),
    },
  };
}

function databasesOf(pathname: string): string[] {
  const name = decodeURIComponent(pathname.replace(/^\//, "")).trim();
  return name.length === 0 ? [] : [name];
}

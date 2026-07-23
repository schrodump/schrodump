// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "./connection-url";

function parsed(url: string) {
  const result = parseConnectionUrl(url);
  if (!result.ok) throw new Error(`expected a parse, got ${result.reason}`);
  return result.value;
}

describe("parseConnectionUrl", () => {
  it("maps each supported scheme to its engine", () => {
    expect(parsed("postgres://u:p@db.internal/shop").engine).toBe("postgres");
    expect(parsed("postgresql://u:p@db.internal/shop").engine).toBe("postgres");
    expect(parsed("mysql://u:p@db.internal/shop").engine).toBe("mysql");
    expect(parsed("mariadb://u:p@db.internal/shop").engine).toBe("mariadb");
    expect(parsed("mongodb://u:p@db.internal/shop").engine).toBe("mongodb");
  });

  it("falls back to the engine's default port when the URL omits one", () => {
    expect(parsed("postgres://u:p@db.internal/shop").port).toBe(5432);
    expect(parsed("mysql://u:p@db.internal/shop").port).toBe(3306);
    expect(parsed("mongodb://u:p@db.internal/shop").port).toBe(27017);
  });

  it("keeps an explicit port", () => {
    expect(parsed("postgres://u:p@db.internal:6543/shop").port).toBe(6543);
  });

  it("puts the database into the scope", () => {
    expect(parsed("postgres://u:p@db.internal/shop").databases).toEqual(["shop"]);
    expect(parsed("postgres://u:p@db.internal").databases).toEqual([]);
  });

  it("decodes percent-encoded credentials", () => {
    // A password of p@ss/word only survives the round trip if it is decoded.
    const value = parsed("postgres://ana%40corp:p%40ss%2Fword@db.internal/shop");
    expect(value.username).toBe("ana@corp");
    expect(value.password).toBe("p@ss/word");
  });

  it("leaves TLS untouched when the URL says nothing about it", () => {
    // null means "keep the form's default", which is on. Absence must never downgrade TLS.
    expect(parsed("postgres://u:p@db.internal/shop").tls).toBeNull();
  });

  it("reads TLS only from an explicit statement", () => {
    expect(parsed("postgres://u:p@h/db?sslmode=require").tls).toBe(true);
    expect(parsed("postgres://u:p@h/db?sslmode=verify-full").tls).toBe(true);
    expect(parsed("postgres://u:p@h/db?sslmode=disable").tls).toBe(false);
    // prefer and allow may end up unencrypted, so they do not mean "TLS required".
    expect(parsed("postgres://u:p@h/db?sslmode=prefer").tls).toBe(false);
    expect(parsed("mongodb://u:p@h/db?tls=true").tls).toBe(true);
    expect(parsed("mysql://u:p@h/db?ssl-mode=REQUIRED").tls).toBe(true);
  });

  it("unbrackets an IPv6 host", () => {
    expect(parsed("postgres://u:p@[2001:db8::1]:5432/shop").host).toBe("2001:db8::1");
  });

  it("refuses mongodb+srv, which has no port to record", () => {
    const result = parseConnectionUrl("mongodb+srv://u:p@cluster.example.net/shop");
    expect(result).toEqual({ ok: false, reason: "srvUnsupported" });
  });

  it("refuses a multi-host URI instead of silently taking the first host", () => {
    const result = parseConnectionUrl("mongodb://u:p@a.internal:27017,b.internal:27017/shop");
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe("multipleHosts");
  });

  it("refuses an unsupported scheme and names it", () => {
    const result = parseConnectionUrl("redis://u:p@h:6379/0");
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe("unsupportedScheme");
    expect(result.ok ? null : result.scheme).toBe("redis");
  });

  it("refuses malformed input", () => {
    for (const input of ["", "   ", "not a url", "postgres://"]) {
      expect(parseConnectionUrl(input).ok).toBe(false);
    }
  });
});

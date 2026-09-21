// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { en } from "@/i18n/messages/en";
import type { Translate } from "@/i18n/provider";
import { loginErrorMessage } from "./login-error";

// The real English catalog, interpolated the way the provider does it, so the assertions read the
// sentence an operator sees rather than a key.
const t: Translate = (key, vars) =>
  Object.entries(vars ?? {}).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key]);

describe("loginErrorMessage", () => {
  // The first-install trap: the stack is configured for http://localhost:8080 and the operator
  // opened http://10.0.0.5:8080. Better-Auth answers 403 INVALID_ORIGIN, and the page used to say
  // the password was wrong.
  it("names the address the page was opened at when the origin is refused", () => {
    const message = loginErrorMessage({ code: "INVALID_ORIGIN", status: 403 }, "http://10.0.0.5:8080", t);
    expect(message).toContain("http://10.0.0.5:8080");
    expect(message).toContain("SCHRODUMP_URL");
    expect(message).not.toBe(en["auth.login.error"]);
  });

  it("says a rate limit is a rate limit, not a wrong password", () => {
    expect(loginErrorMessage({ status: 429 }, "http://localhost:8080", t)).toBe(
      en["auth.login.error.rateLimited"],
    );
  });

  it("says the server did not answer when it did not", () => {
    expect(loginErrorMessage({ status: 502 }, "http://localhost:8080", t)).toBe(en["auth.login.error.server"]);
    expect(loginErrorMessage({}, "http://localhost:8080", t)).toBe(en["auth.login.error.server"]);
  });

  // The one case that must stay vague: it must not tell a stranger whether the address exists.
  it("keeps a refused credential as the one sentence that discloses nothing", () => {
    expect(loginErrorMessage({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 }, "http://localhost:8080", t)).toBe(
      en["auth.login.error"],
    );
  });
});

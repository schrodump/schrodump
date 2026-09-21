// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Translate } from "@/i18n/provider";

// Only a refused CREDENTIAL is reported as one. Every other refusal used to read "Invalid email or
// password" too — and the likeliest one on a first install is not a credential at all: Better-Auth
// refuses a sign-in whose Origin is not SCHRODUMP_URL, so opening the stack at the host's IP, or
// at a proxy name the variable does not carry, rejected the password the operator had just created
// and sent them looking for a typo that was never there. Naming the address this page was opened
// at is enough for them to see the mismatch; it discloses nothing the browser does not already show.
export function loginErrorMessage(
  error: { code?: string; status?: number },
  origin: string,
  t: Translate,
): string {
  if (error.code === "INVALID_ORIGIN") return t("auth.login.error.origin", { origin });
  if (error.status === 429) return t("auth.login.error.rateLimited");
  if (error.status === undefined || error.status === 0 || error.status >= 500) {
    return t("auth.login.error.server");
  }
  return t("auth.login.error");
}

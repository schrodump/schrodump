// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Test doubles for the egress guard. Nothing in the running server imports this file.
//
// It exists because `EgressGuard` is a REQUIRED dependency of every path that dials an
// operator-supplied address — deliberately, so a new call site cannot be written without one — and
// the suites for those paths are overwhelmingly about something else: what a webhook signs, what a
// probe classifies, which fields a PATCH accepts. Handing each of them a real guard would make
// every one of those tests depend on DNS.
//
// `allowAnyEgress` is what a test that is not about egress uses. `refuseAnyEgress` is its twin, for
// the tests that ARE: each of the four call sites has one case proving it refuses, and each of
// those cases goes red if the guard call is removed from the code under test.

import {
  COMPOSE_SERVICE_NAMES,
  createEgressGuard,
  EgressRefusedError,
  type EgressGuard,
} from "./guard.js";

// The REAL guard a shipped compose deployment builds with neither variable set, over a stub
// resolver so a test never touches DNS. This is what the "a legitimate private address still
// works" cases are asserted against: a stub that allows everything would prove nothing about the
// default, which is the half of this feature most likely to break a real deployment.
export function defaultPolicyGuard(dns: Record<string, string[]> = {}): EgressGuard {
  return createEgressGuard(
    { deny: [], allow: [], selfHosts: [...COMPOSE_SERVICE_NAMES], selfAddresses: [] },
    {
      resolve: (host) => {
        const found = dns[host];
        return found === undefined ? Promise.reject(new Error("ENOTFOUND")) : Promise.resolve(found);
      },
    },
  );
}

export const allowAnyEgress: EgressGuard = {
  check: () => Promise.resolve(null),
  assert: () => Promise.resolve(),
  checkUrl: () => Promise.resolve(null),
  assertUrl: () => Promise.resolve(),
};

// The wording is a stand-in for the guard's own sentences; what the tests assert is that it
// REACHED the caller, and through which field.
export const REFUSAL = "refused by the test egress policy";

export const refuseAnyEgress: EgressGuard = {
  check: () => Promise.resolve(REFUSAL),
  assert: (field) => Promise.reject(new EgressRefusedError(field, REFUSAL)),
  checkUrl: () => Promise.resolve(REFUSAL),
  assertUrl: (field) => Promise.reject(new EgressRefusedError(field, REFUSAL)),
};

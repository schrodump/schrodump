// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The contract between how a notification channel's credential is STORED and how it is READ.
//
// NotificationChannel keeps its two credentials in String columns — unlike every other encrypted
// credential in the schema, which is Json — and routes/wiring.ts writes them with JSON.stringify.
// The delivery path handed that string straight to readCredential, which validates an OBJECT, so
// every attempt failed with "Invalid input: expected object, received string". Permanently, for
// webhook and SMTP alike.
//
// Observed on a running deployment: the channel's lastFailure recorded exactly that, every tick.
// Nothing caught it earlier because evaluate.ts is pure and well tested while the wiring — the
// seam where the column shape meets the crypto — had no test at all.

import { describe, expect, it } from "vitest";
import { encryptCredential } from "../crypto/envelope.js";
import { readCredential } from "../crypto/credential-access.js";

const KEK = Buffer.alloc(32, 5);
// Low entropy and obviously a placeholder, on purpose: the secret scanner flags a high-entropy
// literal next to the word SECRET, and it is right to — a fixture that looks like a real signing
// key is indistinguishable from one until somebody checks. It only has to clear the schema's
// 16-character floor.
const SIGNING_KEY = "example-example-example";
const ACCESS = {
  organizationId: "org-1",
  resource: "notificationChannel" as const,
  resourceId: "chan-1",
  purpose: "notification: sign the outgoing webhook",
  correlationId: "notify:chan-1",
};

// Exactly what routes/wiring.ts puts in the String column.
function asStored(secret: string): string {
  return JSON.stringify(encryptCredential(KEK, secret));
}

describe("a notification channel's stored credential", () => {
  it("is a JSON STRING in the column, not an object", () => {
    // If this ever becomes an object, the column type changed and the read path must change with
    // it — which is the drift that produced the bug.
    expect(typeof asStored(SIGNING_KEY)).toBe("string");
  });

  it("cannot be decrypted without parsing it first", () => {
    // The defect, pinned. readCredential validates an envelope OBJECT.
    expect(() => readCredential({ kek: KEK, audit: { record: () => undefined } }, asStored(SIGNING_KEY), ACCESS)).toThrow();
  });

  it("round-trips once parsed", () => {
    const parsed: unknown = JSON.parse(asStored(SIGNING_KEY));

    const out = readCredential({ kek: KEK, audit: { record: () => undefined } }, parsed, ACCESS);

    expect(out).toBe(SIGNING_KEY);
  });
});

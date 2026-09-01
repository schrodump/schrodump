// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import { encryptCredential } from "./envelope.js";
import { readCredential, type CredentialAccess } from "./credential-access.js";

const KEK = Buffer.alloc(32, 9);
const SECRET = "hunter2-but-longer";

function access(over: Partial<CredentialAccess> = {}): CredentialAccess {
  return {
    organizationId: "org-1",
    resource: "target",
    resourceId: "t-1",
    purpose: "backup: connect to the target database to dump it",
    correlationId: "job-1",
    ...over,
  };
}

describe("readCredential", () => {
  it("returns the plaintext and records the access", () => {
    const record = vi.fn();
    const blob = encryptCredential(KEK, SECRET);

    const out = readCredential({ kek: KEK, audit: { record } }, blob, access());

    expect(out).toBe(SECRET);
    expect(record).toHaveBeenCalledWith(access());
  });

  it("never puts the plaintext, or anything derived from it, in the record", () => {
    const record = vi.fn();
    const blob = encryptCredential(KEK, SECRET);

    readCredential({ kek: KEK, audit: { record } }, blob, access());

    // The whole reason this trail is safe to keep: it says WHAT was read and WHO caused it, and
    // an audit log that captured the value would be the largest credential leak in the product.
    const recorded = JSON.stringify(record.mock.calls);
    expect(recorded).not.toContain(SECRET);
    expect(recorded).not.toContain(KEK.toString("base64"));
  });

  it("records the attempt even when decryption fails", () => {
    const record = vi.fn();
    const blob = encryptCredential(KEK, SECRET);
    const wrongKek = Buffer.alloc(32, 1);

    // A run of these is what a wrong KEK or a tampered row looks like, and it is exactly the
    // shape a reviewer wants to see. Recording only successes would hide it.
    expect(() => readCredential({ kek: wrongKek, audit: { record } }, blob, access())).toThrow();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed envelope rather than returning something", () => {
    const record = vi.fn();

    expect(() =>
      readCredential({ kek: KEK, audit: { record } }, { not: "an envelope" }, access()),
    ).toThrow();
  });

  it("carries the purpose through unchanged, because that is what a reviewer reads", () => {
    const record = vi.fn();
    const blob = encryptCredential(KEK, SECRET);
    const ctx = access({
      resource: "encryptionKey",
      resourceId: "key-9",
      purpose: "restore: decrypt the artifact before restoring it",
    });

    readCredential({ kek: KEK, audit: { record } }, blob, ctx);

    expect(record.mock.calls[0]?.[0]).toMatchObject({
      resource: "encryptionKey",
      resourceId: "key-9",
      purpose: "restore: decrypt the artifact before restoring it",
    });
  });
});

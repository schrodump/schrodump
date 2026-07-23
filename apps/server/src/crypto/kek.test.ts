// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertKekFingerprint,
  kekBuffer,
  kekFingerprint,
  KEK_FINGERPRINT_KEY,
  type AppConfigStore,
} from "./kek.js";

const KEK = randomBytes(32);

describe("kekBuffer", () => {
  it("accepts 32-byte base64", () => {
    expect(kekBuffer(KEK.toString("base64")).length).toBe(32);
  });

  it("rejects wrong-length material", () => {
    expect(() => kekBuffer(randomBytes(16).toString("base64"))).toThrow();
  });
});

describe("kekFingerprint", () => {
  it("is deterministic and does not leak the key bytes", () => {
    const fingerprint = kekFingerprint(KEK);
    expect(fingerprint).toBe(kekFingerprint(KEK));
    expect(fingerprint).not.toContain(KEK.toString("hex"));
    expect(kekFingerprint(randomBytes(32))).not.toBe(fingerprint);
  });
});

function makeStore(existing: { value: string } | null): AppConfigStore & { created: unknown[] } {
  const created: unknown[] = [];
  return {
    created,
    appConfig: {
      findUnique: () => Promise.resolve(existing),
      create: (args) => {
        created.push(args);
        return Promise.resolve(args);
      },
    },
  };
}

describe("assertKekFingerprint", () => {
  it("persists the fingerprint on first boot", async () => {
    const store = makeStore(null);
    await assertKekFingerprint(store, KEK);
    expect(store.created).toEqual([
      { data: { key: KEK_FINGERPRINT_KEY, value: kekFingerprint(KEK) } },
    ]);
  });

  it("passes when the fingerprint matches", async () => {
    const store = makeStore({ value: kekFingerprint(KEK) });
    await expect(assertKekFingerprint(store, KEK)).resolves.toBeUndefined();
    expect(store.created).toHaveLength(0);
  });

  it("fails the boot when the fingerprint diverges", async () => {
    const store = makeStore({ value: "some-other-fingerprint" });
    await expect(assertKekFingerprint(store, KEK)).rejects.toThrow(/fingerprint mismatch/i);
  });
});

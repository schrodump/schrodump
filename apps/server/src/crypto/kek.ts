// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createHash, hkdfSync } from "node:crypto";

export const KEK_FINGERPRINT_KEY = "kek_fingerprint";
const FINGERPRINT_INFO = "schrodump-kek-fingerprint-v1";

export function kekBuffer(base64: string): Buffer {
  const buf = Buffer.from(base64, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "SCHRODUMP_KEK must decode to 32 bytes — generate with: openssl rand -base64 32",
    );
  }
  return buf;
}

// Fingerprint = SHA-256 over material DERIVED from the KEK (HKDF), never the KEK itself, so the
// stored fingerprint gives an attacker nothing usable against the key.
export function kekFingerprint(kek: Buffer): string {
  const derived = Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), FINGERPRINT_INFO, 32));
  return createHash("sha256").update(derived).digest("hex");
}

// Minimal store shape (PrismaClient satisfies it structurally) so the boot check is unit
// testable without a database.
export interface AppConfigStore {
  appConfig: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>;
    create(args: { data: { key: string; value: string } }): Promise<unknown>;
  };
}

// First boot persists the fingerprint; every later boot compares. On mismatch the boot FAILS —
// without this, someone swaps the variable by mistake, the app starts normally, and the failure
// only surfaces days later when a credential won't decrypt, or worse, at restore time.
export async function assertKekFingerprint(store: AppConfigStore, kek: Buffer): Promise<void> {
  const fingerprint = kekFingerprint(kek);
  const existing = await store.appConfig.findUnique({ where: { key: KEK_FINGERPRINT_KEY } });

  if (existing === null) {
    await store.appConfig.create({ data: { key: KEK_FINGERPRINT_KEY, value: fingerprint } });
    return;
  }

  if (existing.value !== fingerprint) {
    throw new Error(
      "SCHRODUMP_KEK fingerprint mismatch: the configured key differs from the one this instance " +
        "was initialized with. Refusing to boot — a wrong KEK cannot decrypt existing credentials " +
        "or artifacts. Restore the original SCHRODUMP_KEK.",
    );
  }
}

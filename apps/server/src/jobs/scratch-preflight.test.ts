// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import { assertScratchWritable, ScratchNotWritableError } from "./scratch-preflight.js";

describe("scratch preflight", () => {
  it("passes when the directory is writable", async () => {
    await expect(
      assertScratchWritable("/scratch", { access: () => Promise.resolve(), uid: () => 100 }),
    ).resolves.toBeUndefined();
  });

  it("refuses the boot when it is not", async () => {
    const access = vi.fn().mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(
      assertScratchWritable("/var/lib/schrodump/scratch", { access, uid: () => 100 }),
    ).rejects.toBeInstanceOf(ScratchNotWritableError);
  });

  it("names the uid and the command, not just the diagnosis", async () => {
    // The operator creates this directory as root, naturally, and the container is unprivileged.
    // "cannot write to scratch" leaves them to work out which user and what to run; the failure
    // this replaces was silent, so the message has to do the whole job.
    const err = await assertScratchWritable("/var/lib/schrodump/scratch", {
      access: () => Promise.reject(new Error("EACCES")),
      uid: () => 100,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    if (err === null) throw new Error("expected the preflight to refuse");

    expect(err.message).toContain("uid 100");
    expect(err.message).toContain("chown -R 100 /var/lib/schrodump/scratch");
    // And why it matters, because a refusal without a reason invites `chmod 777`.
    expect(err.message).toMatch(/verified or restored/);
  });

  it("keeps the underlying error as the cause", async () => {
    const underlying = new Error("EACCES: permission denied");
    const err = await assertScratchWritable("/scratch", {
      access: () => Promise.reject(underlying),
      uid: () => 100,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    if (err === null) throw new Error("expected the preflight to refuse");

    expect(err.cause).toBe(underlying);
  });
});

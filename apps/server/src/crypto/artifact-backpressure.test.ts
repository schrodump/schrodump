// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// encryptStream is the one place in the upload chain that leaves Node's stream world: it converts
// to a WHATWG stream for the age library and back. That made it the obvious suspect when a
// production dump was found queued in memory — and it was the wrong one. This is the measurement
// that ruled it out, kept so the next person does not have to repeat it, and so a future version
// of `age-encryption` cannot start buffering without a test saying so.

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { encryptStream, generateAgeKeyPair } from "./artifact.js";

// How far the producer was ALLOWED to get. RSS is too noisy to assert on; this asks the same
// question without the noise.
function offeredSource(chunks: number, size: number) {
  const state = { produced: 0 };
  const chunk = Buffer.alloc(size, 7);
  let left = chunks;
  const stream = new Readable({
    read() {
      if (left === 0) {
        this.push(null);
        return;
      }
      left -= 1;
      state.produced += size;
      this.push(chunk);
    },
  });
  return { stream, state };
}

describe("encryptStream and backpressure", () => {
  it("stops pulling from the source while the destination is not reading", async () => {
    const { recipient } = await generateAgeKeyPair();
    const CHUNK = 1024 * 1024;
    const OFFERED = 256;

    const src = offeredSource(OFFERED, CHUNK);
    const encrypted = await encryptStream(src.stream, [recipient]);
    const blocked = new Writable({
      highWaterMark: 64 * 1024,
      write() {
        // Never calls the callback: the whole chain must stall behind it.
      },
    });

    const running = pipeline(encrypted, blocked).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(src.state.produced).toBeLessThan(OFFERED * CHUNK);

    encrypted.destroy();
    src.stream.destroy();
    await running;
  }, 30_000);
});

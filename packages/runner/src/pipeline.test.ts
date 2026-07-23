// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Readable, Transform, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { composeStreamPipeline } from "./pipeline.js";

describe("composeStreamPipeline", () => {
  it("streams source through stages into the destination", async () => {
    const source = Readable.from([Buffer.from("hel"), Buffer.from("lo")]);
    const received: Buffer[] = [];
    const upper = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        callback(null, Buffer.from(chunk.toString("utf8").toUpperCase()));
      },
    });
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received.push(Buffer.from(chunk));
        callback();
      },
    });

    await composeStreamPipeline(source, [upper], sink);
    expect(Buffer.concat(received).toString("utf8")).toBe("HELLO");
  });

  it("aborts and rejects when a middle stage errors, reaching nothing downstream", async () => {
    const source = Readable.from([Buffer.from("a"), Buffer.from("b")]);
    let wroteToSink = false;
    const failing = new Transform({
      transform(_chunk, _encoding, callback) {
        callback(new Error("stage boom"));
      },
    });
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        wroteToSink = true;
        callback();
      },
    });

    await expect(composeStreamPipeline(source, [failing], sink)).rejects.toThrow("stage boom");
    expect(wroteToSink).toBe(false);
  });
});

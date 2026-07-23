// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, newCorrelationId } from "./pino.js";

function capture(): { dest: Writable; text: () => string } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { dest, text: () => chunks.join("") };
}

describe("createLogger redaction", () => {
  it("redacts credentials at every level, including debug", () => {
    const { dest, text } = capture();
    const emitter = createLogger("debug", dest);
    emitter.debug(
      {
        password: "s3cret-pw",
        secretAccessKey: "aws-s3cret",
        nested: { token: "tok-123", secret: "inner" },
        keep: "not-sensitive",
      },
      "boom",
    );
    const out = text();
    expect(out).not.toContain("s3cret-pw");
    expect(out).not.toContain("aws-s3cret");
    expect(out).not.toContain("inner");
    expect(out).toContain("[redacted]");
    expect(out).toContain("not-sensitive");
  });
});

describe("newCorrelationId", () => {
  it("produces unique ids", () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});

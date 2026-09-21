// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { runTickPasses, type TickPass } from "./tick.js";

function recording(ran: string[], name: string, failure: string): TickPass {
  return {
    failure,
    run: () => {
      ran.push(name);
      return Promise.resolve();
    },
  };
}

describe("runTickPasses", () => {
  // SC-02. Dispatch was awaited first in the tick's callback, outside any catch of its own, so the
  // tick that stopped scheduling backups was also a tick with no notification at all.
  it("runs the notification passes when dispatch throws, and logs the dispatch failure under its own line", async () => {
    const ran: string[] = [];
    const logged: string[] = [];
    await runTickPasses(
      [
        {
          failure: "scheduler dispatch failed",
          run: () => Promise.reject(new Error("Invalid explicit day of month definition")),
        },
        recording(ran, "notifications", "notification pass failed"),
        recording(ran, "job events", "job event pass failed"),
      ],
      { error: (_o, m) => logged.push(m) },
    );

    expect(ran).toEqual(["notifications", "job events"]);
    expect(logged).toEqual(["scheduler dispatch failed"]);
  });

  it("keeps going past a pass that throws synchronously", async () => {
    const ran: string[] = [];
    await runTickPasses(
      [
        {
          failure: "notification pass failed",
          run: () => {
            throw new Error("boom");
          },
        },
        recording(ran, "job events", "job event pass failed"),
      ],
      { error: () => undefined },
    );
    expect(ran).toEqual(["job events"]);
  });
});

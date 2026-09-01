// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { deliverEmail, type SmtpTarget } from "./smtp.js";
import type { Notification } from "./evaluate.js";

const TARGET: SmtpTarget = {
  host: "smtp.example",
  port: 587,
  username: "schrodump",
  password: "s3cret",
  from: "schrodump@example",
  to: ["ops@example", "oncall@example"],
};

const FAILED: Notification = {
  trigger: "ARTIFACT_FAILED",
  key: "a1",
  kind: "opened",
  summary: "artifact a1 failed verification: a restore of it did not produce a usable database",
};

function fakeMailer() {
  const sent: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  return {
    sent,
    created,
    deps: {
      createTransport: (opts: Record<string, unknown>) => {
        created.push(opts);
        return {
          sendMail: async (msg: Record<string, unknown>) => {
            sent.push(msg);
            return {};
          },
        };
      },
    },
  };
}

describe("deliverEmail", () => {
  it("sends to every recipient with the summary as the body", async () => {
    const m = fakeMailer();
    await deliverEmail(m.deps, TARGET, FAILED);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]?.to).toBe("ops@example, oncall@example");
    expect(String(m.sent[0]?.text)).toContain("did not produce a usable database");
  });

  it("says in the subject whether a condition opened or resolved", async () => {
    // An operator scanning an inbox reads subjects, not bodies. A resolution that looks identical
    // to an alert is how a mailbox rule ends up deleting both.
    const m = fakeMailer();
    await deliverEmail(m.deps, TARGET, FAILED);
    await deliverEmail(m.deps, TARGET, { ...FAILED, kind: "resolved" });
    expect(String(m.sent[0]?.subject).toLowerCase()).not.toContain("resolved");
    expect(String(m.sent[1]?.subject).toLowerCase()).toContain("resolved");
  });

  it("never puts the SMTP password in the message", async () => {
    const m = fakeMailer();
    await deliverEmail(m.deps, TARGET, FAILED);
    expect(JSON.stringify(m.sent[0])).not.toContain("s3cret");
  });

  it("requires TLS on the transport", async () => {
    // A notification carries the fleet's state. Sending it in the clear over someone's network is
    // not a tradeoff worth a config flag.
    const m = fakeMailer();
    await deliverEmail(m.deps, TARGET, FAILED);
    expect(m.created[0]?.requireTLS).toBe(true);
  });

  it("propagates a send failure so the caller can record the channel as failing", async () => {
    const deps = {
      createTransport: () => ({
        sendMail: async () => {
          throw new Error("connection refused");
        },
      }),
    };
    await expect(deliverEmail(deps, TARGET, FAILED)).rejects.toThrow(/refused/);
  });
});

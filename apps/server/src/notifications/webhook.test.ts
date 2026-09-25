// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deliverWebhook, signBody } from "./webhook.js";
import { allowAnyEgress, refuseAnyEgress, REFUSAL } from "../egress/guard.fixture.js";
import { EgressRefusedError, type EgressGuard } from "../egress/guard.js";
import type { Notification } from "./evaluate.js";

const NOTIFICATION: Notification = {
  trigger: "ARTIFACT_FAILED",
  key: "a1",
  kind: "opened",
  summary: "artifact a1 failed verification",
};

describe("signBody", () => {
  it("is an HMAC-SHA256 of the exact bytes sent", () => {
    // Signing anything other than the transmitted body — a re-serialisation, a subset — means the
    // receiver verifies something the sender never sent.
    const body = '{"a":1}';
    expect(signBody("s3cret", body)).toBe(
      createHmac("sha256", "s3cret").update(body).digest("hex"),
    );
  });
});

describe("deliverWebhook", () => {
  it("posts the notification with its signature over the transmitted body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });

    await deliverWebhook(
      { fetch: fakeFetch as unknown as typeof fetch, egress: allowAnyEgress },
      { url: "https://hooks.example/schrodump", secret: "s3cret" },
      NOTIFICATION,
    );

    const sent = calls[0];
    expect(sent?.url).toBe("https://hooks.example/schrodump");
    const body = sent?.init.body as string;
    const headers = sent?.init.headers as Record<string, string>;
    expect(headers["X-Schrodump-Signature"]).toBe(signBody("s3cret", body));
    expect(JSON.parse(body)).toMatchObject({ trigger: "ARTIFACT_FAILED", key: "a1" });
  });

  it("carries an idempotency key derived from the condition, not from the moment", async () => {
    // A receiver that sees the same condition twice — a retry, a replay — must be able to tell it
    // is the same one. Keying on time would make every delivery unique and defeat that.
    const seen: string[] = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["Idempotency-Key"] ?? "");
      return new Response(null, { status: 204 });
    });
    const target = { url: "https://hooks.example/x", secret: "s" };
    await deliverWebhook({ fetch: fakeFetch as unknown as typeof fetch, egress: allowAnyEgress }, target, NOTIFICATION);
    await deliverWebhook({ fetch: fakeFetch as unknown as typeof fetch, egress: allowAnyEgress }, target, NOTIFICATION);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).not.toBe("");
  });

  it("throws on a non-2xx so the caller can record that delivery itself is failing", async () => {
    const fakeFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      deliverWebhook(
        { fetch: fakeFetch as unknown as typeof fetch, egress: allowAnyEgress },
        { url: "https://hooks.example/x", secret: "s" },
        NOTIFICATION,
      ),
    ).rejects.toThrow(/500/);
  });

  it("never puts the secret in the body or the URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    });
    await deliverWebhook(
      { fetch: fakeFetch as unknown as typeof fetch, egress: allowAnyEgress },
      { url: "https://hooks.example/x", secret: "super-secret-value" },
      NOTIFICATION,
    );
    expect(calls[0]?.url).not.toContain("super-secret-value");
    expect(calls[0]?.init.body as string).not.toContain("super-secret-value");
  });
});

describe("a receiver that never answers", () => {
  it("abandons the request rather than waiting forever", async () => {
    // Same reason as the SMTP timeouts: this now runs inside an operator's HTTP request, not only
    // inside a scheduler tick. Node's fetch has no default timeout at all.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await deliverWebhook({ fetch: fetchMock, egress: allowAnyEgress }, { url: "https://hooks.example/x", secret: "s" }, NOTIFICATION);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("a job event on the wire", () => {
  it("carries the job's kind and state as fields, not only as prose", async () => {
    // A receiver that has to regex the summary to learn the state is a receiver that breaks when
    // somebody improves the wording.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await deliverWebhook(
      { fetch: fetchMock, egress: allowAnyEgress },
      { url: "https://hooks.example/x", secret: "s" },
      {
        trigger: "JOB_STATE",
        key: "job-1",
        kind: "occurred",
        summary: 'BACKUP job for policy "shop-daily" is RUNNING',
        job: { id: "job-1", kind: "BACKUP", state: "RUNNING", policyId: "pol-1" },
      },
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body.job).toEqual({ id: "job-1", kind: "BACKUP", state: "RUNNING", policyId: "pol-1" });
  });

  it("gives each transition of one job its own idempotency key", async () => {
    // The key derives from the CONDITION, not the moment. Without the state in it, PENDING,
    // RUNNING and SUCCEEDED of the same job share a key, and a receiver that deduplicates — which
    // is exactly what the header asks it to do — keeps one delivery out of three.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    for (const state of ["PENDING", "RUNNING", "SUCCEEDED"]) {
      await deliverWebhook(
        { fetch: fetchMock, egress: allowAnyEgress },
        { url: "https://hooks.example/x", secret: "s" },
        {
          trigger: "JOB_STATE",
          key: "job-1",
          kind: "occurred",
          summary: "s",
          job: { id: "job-1", kind: "BACKUP", state, policyId: null },
        },
      );
    }
    const keys = fetchMock.mock.calls.map(
      (call) =>
        ((call[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("still keys a fleet trigger by its condition alone", async () => {
    // The three fleet triggers must keep the property the header was added for: the same condition
    // seen twice is recognisably the same delivery.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    for (let i = 0; i < 2; i += 1) {
      await deliverWebhook(
        { fetch: fetchMock, egress: allowAnyEgress },
        { url: "https://hooks.example/x", secret: "s" },
        NOTIFICATION,
      );
    }
    const keys = fetchMock.mock.calls.map(
      (call) =>
        ((call[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(new Set(keys).size).toBe(1);
  });
});

describe("the egress guard stands between the channel and the wire", () => {
  it("refuses a denied URL without making the request at all", async () => {
    // The point of the guard is that nothing is dialled. A refusal after the socket opened would
    // still have answered the question the operator was asking — does something listen there.
    const fetchMock = vi.fn();
    await expect(
      deliverWebhook(
        { fetch: fetchMock as unknown as typeof fetch, egress: refuseAnyEgress },
        { url: "http://docker-proxy:2375/containers/prune", secret: "s" },
        NOTIFICATION,
      ),
    ).rejects.toThrow(REFUSAL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks after a redirect, because the second hop is an address nobody validated", async () => {
    // The saved URL points at a host the operator owns; its 302 points at the socket proxy. A guard
    // that ran only on the stored value would wave the whole chain through, and `redirect: "follow"`
    // would hide the hop entirely inside undici.
    const seen: string[] = [];
    const egress: EgressGuard = {
      ...allowAnyEgress,
      checkUrl: (raw) => Promise.resolve(raw.includes("docker-proxy") ? REFUSAL : null),
      assertUrl: (field, raw) => {
        seen.push(raw);
        return raw.includes("docker-proxy")
          ? Promise.reject(new EgressRefusedError(field, REFUSAL))
          : Promise.resolve();
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://docker-proxy:2375/containers/prune" },
      }),
    );

    await expect(
      deliverWebhook(
        { fetch: fetchMock as unknown as typeof fetch, egress },
        { url: "https://hooks.example/schrodump", secret: "s" },
        NOTIFICATION,
      ),
    ).rejects.toThrow(REFUSAL);

    // The first hop was allowed and made; the second was checked and never requested.
    expect(seen).toEqual([
      "https://hooks.example/schrodump",
      "http://docker-proxy:2375/containers/prune",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect it is allowed to follow, so an http->https receiver still works", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: "https://hooks.example/moved" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deliverWebhook(
      { fetch: fetchMock as unknown as typeof fetch, egress: allowAnyEgress },
      { url: "http://hooks.example/schrodump", secret: "s" },
      NOTIFICATION,
    );

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://hooks.example/moved");
    // 301 is not a 307: the follow-up is a GET with no body, which is what every other client on
    // the web does with a redirected POST.
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("GET");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBeUndefined();
  });

  it("keeps the method and the signed body across a 308", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { location: "https://hooks.example/moved" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deliverWebhook(
      { fetch: fetchMock as unknown as typeof fetch, egress: allowAnyEgress },
      { url: "https://hooks.example/schrodump", secret: "s" },
      NOTIFICATION,
    );

    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(second.method).toBe("POST");
    const headers = second.headers as Record<string, string>;
    expect(headers["X-Schrodump-Signature"]).toBe(signBody("s", second.body as string));
  });
});

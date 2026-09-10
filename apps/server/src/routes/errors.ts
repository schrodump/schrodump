// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The shape of a refused request.
//
// Every route in this server validates with Zod and, until this file existed, every one of them
// answered a failure the same way: `{ error: "invalid channel" }`, `{ error: "invalid target" }` —
// one string for every possible reason. The schemas were not the problem. They carry sentences
// somebody wrote for a human to read ("a signing secret shorter than 16 characters is not worth
// having", "a channel with no recipients delivers nothing") and the route discarded them one line
// later. An operator who pasted a webhook URL and a 14-character secret got a refusal that named
// nothing and concluded the URL was wrong, because the URL was the only thing on screen to blame.
//
// What leaves here is the field path and the schema's own message. Never the issue object, and
// never the received value — these bodies carry signing secrets, SMTP passwords and database
// credentials, and a validation reply that echoed what it was given would be a credential leak
// wearing the costume of a helpful error. That is the same line `probe/test-connection.ts` draws
// when it emits a driver's error CLASS and never its prose: say which field and why, never what.

import type { FastifyReply } from "fastify";
import type { z } from "zod";

export interface BadRequestBody {
  // Unchanged from before this file: the caller's own summary, still the `error` key, so every
  // existing client and test that reads it keeps working.
  readonly error: string;
  readonly field?: string;
  readonly detail?: string;
}

// Zod reports a rejected key with an EMPTY path and the offending name in `keys` — a plain
// path.join() would answer "" and leave the operator exactly where they started.
function fieldOf(issue: z.core.$ZodIssue): string | undefined {
  if (issue.path.length > 0) return issue.path.join(".");
  if (issue.code === "unrecognized_keys") return issue.keys[0];
  return undefined;
}

// The first issue, not all of them. A form fixes one field at a time, and the alternative — a list
// that grows as earlier fields are corrected — reads like the request got worse.
export function badRequest<T>(
  reply: FastifyReply,
  error: string,
  zodError: z.ZodError<T>,
): FastifyReply {
  const issue = zodError.issues[0];
  if (issue === undefined) return reply.status(400).send({ error } satisfies BadRequestBody);
  const field = fieldOf(issue);
  return reply.status(400).send({
    error,
    ...(field !== undefined ? { field } : {}),
    detail: issue.message,
  } satisfies BadRequestBody);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The art. 37 trail for resource mutations, recorded in ONE hook rather than at each call site.
//
// The call-site approach is what produced the gap this replaces: docs/lgpd.md claimed a trail
// covering targets and destinations, and the entire codebase emitted exactly one action, from the
// restore path. A per-route audit call is a thing a new route forgets to add and nobody notices,
// because a missing audit record looks exactly like an action that never happened.
//
// This hook cannot be forgotten: every mutating request that reaches an authenticated route is
// recorded, including routes that do not exist yet.
//
// It records WHAT and WHO, never the payload. Request bodies here carry database passwords and S3
// secret keys; an audit trail that captured them would turn the compliance feature into the largest
// credential leak in the product.

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { CredentialAuditSink } from "../crypto/credential-access.js";

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// "POST /targets/:id/test" -> "target.test"; "PATCH /destinations/:id" -> "destination.update".
// Derived from the route PATTERN, never the concrete URL, so an id never lands in the action name.
export function actionFor(method: string, routePattern: string): string {
  const segments = routePattern.split("/").filter((s) => s !== "" && !s.startsWith(":"));
  const resource = segments[0] ?? "unknown";
  // Singular reads better as an action name, and the plural is only a URL convention. Two rules,
  // which is enough for every route this server has ("policies" -> "policy" needs the first, and
  // naive -s would yield "policie"). A route named with an irregular plural would come out wrong
  // rather than fail, so keep route names regular — the trail is read by people, not parsed.
  const singular = resource.endsWith("ies")
    ? `${resource.slice(0, -3)}y`
    : resource.endsWith("s")
      ? resource.slice(0, -1)
      : resource;
  const verb =
    segments.length > 1
      ? (segments[segments.length - 1] ?? "")
      : method === "POST"
        ? "create"
        : method === "DELETE"
          ? "delete"
          : "update";
  return `${singular}.${verb}`;
}

export function registerAuditTrail(app: FastifyInstance, prisma: PrismaClient): void {
  app.addHook("onResponse", (request, reply, done) => {
    done();
    const ctx = request.authContext;
    // No context means the request never got past authenticate(); a 4xx means nothing changed.
    if (ctx === undefined || !MUTATING.has(request.method) || reply.statusCode >= 400) return;

    const pattern = request.routeOptions.url ?? request.url;
    const params = request.params as Record<string, string> | undefined;
    void prisma.auditLog
      .create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          action: actionFor(request.method, pattern),
          targetType: pattern.split("/").filter((s) => s !== "")[0] ?? null,
          targetId: params?.["id"] ?? null,
          // The same id the response carried in x-correlation-id and every log line for this
          // request, so an audit row can be joined to what the server was doing at the time.
          correlationId: request.id,
          metadata: { method: request.method, route: pattern, status: reply.statusCode },
        },
      })
      // Audit failure must never fail the request — it has already been answered — but it must not
      // vanish either. A trail that silently stops recording is worse than one that was never
      // claimed, which is the whole lesson of this file.
      .catch((err: unknown) => {
        request.log.error({ err, action: "audit.write_failed" }, "could not record the audit trail");
      });
  });
}

// The `credential.read` half of the art. 37 trail. It cannot ride the onResponse hook: decryption
// happens inside job execution, where there is no request and no user — so these rows carry a null
// userId and are attributed to the job through correlationId instead.
//
// See crypto/credential-access.ts for why the context is a required argument rather than a call
// each site remembers to make.
export function createCredentialAuditSink(
  prisma: PrismaClient,
  log: { error(o: Record<string, unknown>, m: string): void },
): CredentialAuditSink {
  return {
    record(access) {
      void prisma.auditLog
        .create({
          data: {
            organizationId: access.organizationId,
            // No user: the worker is a system process. An access caused by a request still gets
            // its actor, through the correlationId that names the request.
            userId: null,
            action: "credential.read",
            targetType: access.resource,
            targetId: access.resourceId,
            correlationId: access.correlationId,
            // The purpose, never the credential and never anything derived from it.
            metadata: { purpose: access.purpose },
          },
        })
        // Same rule as the request trail: a failed audit write must not fail the operation that
        // triggered it, and must not vanish either.
        .catch((err: unknown) => {
          log.error({ err, action: "audit.credential_write_failed" }, "could not record a credential access");
        });
    },
  };
}

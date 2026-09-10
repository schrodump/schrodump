// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// A throwaway webhook sink, for the compose smoke only. It prints one line per delivery carrying
// the signature header, the idempotency key and the whole body.
//
// Step 17 uses busybox `nc`, which is enough for what it asserts — that a signed request with a
// body arrived — but not for this one. `nc` answers from its own stdin and stops reading once that
// is exhausted, so the JSON body never reaches the log, and it serves one connection at a time,
// which races against a burst of job events. Job events need both: the body, to tell a JOB_STATE
// delivery from a fleet trigger, and concurrency, because one job produces three deliveries in a
// few seconds.

// SINK_PORT, never PORT: this runs inside the schrodump image, whose HEALTHCHECK is
// `wget --spider http://127.0.0.1:${PORT}/health`. Reusing PORT points that probe straight at this
// server, which then logs an unsigned, unkeyed "delivery" every thirty seconds. The smoke also
// runs these containers with --no-healthcheck, because they are not the application.
import { createServer } from "node:http";

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    process.stdout.write(
      `SINK-DELIVERY ${request.headers["x-schrodump-signature"] ?? "unsigned"} ${
        request.headers["idempotency-key"] ?? "unkeyed"
      } ${body.replace(/\s+/g, " ")}\n`,
    );
    response.writeHead(200, { "Content-Length": "0" });
    response.end();
  });
}).listen(Number(process.env.SINK_PORT), () => process.stdout.write("SINK-LISTENING\n"));

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// A throwaway SMTP sink, for the compose smoke only. STARTTLS on a high port, AUTH PLAIN, and it
// prints the message it received so the smoke can assert on it.
//
// It exists because the smoke proved WEBHOOK delivery against a real listener and never once
// delivered an email — and the bug it was written to catch (a JSON.parse in the credential seam,
// see notifications/secret-envelope.test.ts) broke webhook and SMTP alike. Half the feature was
// covered end to end and half was not.
//
// STARTTLS rather than implicit TLS on 465: it needs no root inside the container, and it is the
// path `requireTLS: true` drives for the ports operators actually configure. It accepts ANY
// credentials — it is not a security boundary, it is an assertion target on a private network
// whose certificate is generated for that one run.
// SINK_PORT, never PORT: this runs inside the schrodump image, whose HEALTHCHECK probes
// http://127.0.0.1:${PORT}/health. Reusing PORT aims that probe at this socket every thirty
// seconds. The smoke also passes --no-healthcheck — these containers are not the application.
import { createServer } from "node:net";
import { TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";

const KEY = readFileSync(process.env.KEY_FILE);
const CERT = readFileSync(process.env.CERT_FILE);

function speak(socket) {
  let body = "";
  let inData = false;
  socket.on("data", (chunk) => {
    const text = String(chunk);
    if (inData) {
      body += text;
      if (body.includes("\r\n.\r\n")) {
        inData = false;
        process.stdout.write(`SINK-MESSAGE-START\n${body}\nSINK-MESSAGE-END\n`);
        socket.write("250 2.0.0 queued\r\n");
      }
      return;
    }
    for (const line of text.split("\r\n").filter((l) => l.length > 0)) {
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO" || verb === "HELO") {
        socket.write(socket.encrypted ? "250-smoke-sink\r\n250 AUTH PLAIN\r\n" : "250-smoke-sink\r\n250 STARTTLS\r\n");
      } else if (verb === "STARTTLS") {
        socket.removeAllListeners("data");
        socket.write("220 2.0.0 ready to start TLS\r\n");
        const secure = new TLSSocket(socket, { isServer: true, key: KEY, cert: CERT });
        secure.on("error", () => undefined);
        speak(secure);
      } else if (verb === "AUTH") socket.write("235 2.7.0 accepted\r\n");
      else if (verb === "MAIL" || verb === "RCPT") socket.write("250 2.1.0 ok\r\n");
      else if (verb === "DATA") { inData = true; socket.write("354 end with <CRLF>.<CRLF>\r\n"); }
      else if (verb === "QUIT") { socket.write("221 2.0.0 bye\r\n"); socket.end(); }
      else socket.write("250 2.0.0 ok\r\n");
    }
  });
  socket.on("error", () => undefined);
}

createServer((socket) => {
  socket.write("220 smoke-sink ESMTP\r\n");
  speak(socket);
}).listen(Number(process.env.SINK_PORT), () => process.stdout.write("SINK-LISTENING\n"));

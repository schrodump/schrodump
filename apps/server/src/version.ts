// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Which build this is.
//
// Stamped into the image by docker/Dockerfile (ARG VERSION -> ENV SCHRODUMP_VERSION) rather than
// read from a package.json: the runtime tree is pruned to the production closure and the root
// manifest is not part of it, so a version read from disk would be a version that happened to
// survive pruning.
//
// Deliberately NOT exposed on /health. That endpoint answers without a session, and a version
// banner there tells an unauthenticated caller exactly which advisories apply to this deployment.
// Three places answer "which build" instead, each for a different question:
//   - the boot log line, for "what is running right now";
//   - the image's OCI labels, for "what did I pull" (`docker inspect`, no process needed);
//   - Manifest.toolVersion on every artifact, for "what wrote this backup" — the one that matters
//     during a recovery, months after the container that produced it stopped existing.
const FALLBACK = "0.0.0-dev";

export function serverVersion(): string {
  const stamped = process.env.SCHRODUMP_VERSION;
  // A blank value is an unsubstituted build arg, not a release. Reporting "" would put an empty
  // producer into every manifest written by that image.
  if (stamped === undefined || stamped.trim().length === 0) return FALLBACK;
  return stamped.trim();
}

// Manifest.toolVersion. Read at call time, not frozen into a module constant, so the value comes
// from the environment the process actually booted with.
export function producerVersion(): string {
  return `schrodump-server/${serverVersion()}`;
}

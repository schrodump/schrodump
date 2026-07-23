// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Shared execution contract. `engines` produces an ExecutionDescriptor (WHAT to run) and
// `runner` consumes it (WHERE to run). Those two packages must not import each other, so the
// contract lives here in core.
//
// CREDENTIAL RULE: no credential may ever appear in `command` — process arguments are visible
// to any process on the host. Credentials travel only through `env` or a mounted config file.

export interface BuildWarning {
  readonly code: string;
  readonly message: string;
}

export interface ExecutionDescriptor {
  readonly image: string;
  readonly command: string[];
  readonly env: Record<string, string>;
  readonly outputKind: "stdout" | "directory";
  readonly workdir?: string;
  // Advisory notices produced while building the descriptor (e.g. MyISAM under
  // --single-transaction). Present but never silenced; empty/omitted when there are none.
  readonly warnings?: readonly BuildWarning[];
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Structured base error.
//
// `context` is safe, debug-oriented metadata that IS serialized. Anything that could leak
// client data (connection strings, credentials, data samples) goes in `sensitive`, which
// is held in a private field and NEVER crosses toJSON()/JSON.stringify().

export interface SchrodumpErrorOptions {
  readonly code: string;
  // Injected by the caller (e.g. from the request context) — core stays pure, no randomness.
  readonly correlationId: string;
  readonly context?: Record<string, unknown>;
  readonly sensitive?: Record<string, unknown>;
  readonly cause?: unknown;
}

export interface SchrodumpErrorJSON {
  readonly name: string;
  readonly code: string;
  readonly correlationId: string;
  readonly message: string;
  readonly context: Record<string, unknown>;
}

export class SchrodumpError extends Error {
  readonly code: string;
  readonly correlationId: string;
  readonly context: Record<string, unknown>;
  // Truly private: unreachable from outside, never spread, never serialized.
  #sensitive: Record<string, unknown>;

  constructor(message: string, options: SchrodumpErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.correlationId = options.correlationId;
    this.context = options.context ?? {};
    this.#sensitive = options.sensitive ?? {};
  }

  // Names of the sensitive fields, for in-process debugging — never the values.
  get sensitiveKeys(): string[] {
    return Object.keys(this.#sensitive);
  }

  toJSON(): SchrodumpErrorJSON {
    return {
      name: this.name,
      code: this.code,
      correlationId: this.correlationId,
      message: this.message,
      context: this.context,
    };
  }
}

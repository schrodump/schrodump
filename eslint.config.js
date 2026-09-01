// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Flat config shared by every package/app in the workspace.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // A leading underscore marks a parameter intentionally unused — e.g. an adapter that
      // must conform to a shared interface method but ignores one of its arguments.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // Decrypting a stored credential is an art. 37 access and has to be recorded. readCredential
  // takes the context as a required argument, so a call site cannot decrypt without saying which
  // organization, which resource and why — but only if it goes through readCredential. This is
  // what stops the tenth call site from reaching past it, which is exactly how the trail came to
  // be missing in the first place. crypto/ itself is exempt: that is where the wrapper lives.
  {
    files: ["apps/server/src/**/*.ts"],
    // crypto/ is where the wrapper lives. Tests are exempt because a test that decrypts is
    // asserting what a column contains, which is not an access by the system to a credential —
    // and two of them exist precisely to prove the envelope round-trips.
    ignores: ["apps/server/src/crypto/**", "apps/server/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/crypto/envelope.js", "./envelope.js"],
              importNames: ["decryptCredential"],
              message:
                "Use readCredential from crypto/credential-access.js — decrypting a credential must be recorded (docs/lgpd.md, art. 37).",
            },
          ],
        },
      ],
    },
  },
  prettier,
);

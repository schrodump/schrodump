// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createAuthClient } from "better-auth/react";

// Auth requests run client-side and are proxied same-origin to the server (/api/auth). The
// client needs an absolute base URL; on the server (prerender) it is never actually called, so a
// placeholder keeps createAuthClient from throwing on a relative URL.
const baseURL =
  typeof window === "undefined" ? "http://localhost/api/auth" : `${window.location.origin}/api/auth`;

// Session is a Better-Auth cookie — never localStorage.
export const authClient = createAuthClient({ baseURL });

export const { signIn, signOut, useSession } = authClient;

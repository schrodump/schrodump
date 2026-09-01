# @schrodump/web

Next.js 16 (App Router) + React 19 + Tailwind v4 + shadcn/ui + TanStack Query + Zod. Consumes the
`apps/server` API. Takes precedence over the root `CLAUDE.md` inside this directory.

## Invariants

- **Backup state is ternary and the colour is content, not decoration.** `VERIFIED` green,
  `UNOBSERVED` amber, `FAILED` red. There is no "OK", there is no grey for unverified, and the
  dashboard's primary counter is _"N unobserved backups"_ — never "N ok". See `StatusBadge` and
  `state-counters.tsx`, and the thesis in the root file.
- **Credentials are write-only in the UI.** The server's value never reaches the front end and
  never fills a field. Configured → show "configured" + allow replacing. See `CredentialField`.
- **In edit mode an empty secret field means "keep what is stored"** — never `""`. It is the only
  way to correct a host or a region when the UI cannot read the secret back to resend it; sending
  an empty string would be a 400 at best and an overwritten credential at worst. The forms build
  the `PATCH` body field by field (allow-list), never spread-minus-N: the server schema is
  `.strict()`, so an extra field is a 400, and an allow-list does not leak a new field when someone
  adds one to the create schema. Covered by `edit-forms.test.tsx`, which asserts the request body
  that actually goes out.
- **A field the server refuses appears disabled with the reason, never hidden.** The target's
  `engine`, the destination's `bucket`/`prefix`/`sealMode`, the policy's `target`/`destination`.
  What a resource points at is the first thing an operator needs to read on it — removing the field
  trades an explanation for a mystery.
- **Restore has friction on purpose.** Scopes the engine does not support are disabled with the
  reason (matrix in `lib/domain.ts`); overwriting an existing database requires typing the database
  name. A viewer does not see the button — and the server refuses anyway (the UI is the second
  lock, not the only one). A `STAGED` artifact **does** restore now that the directory pipeline
  landed (the server unpacks the tar before handing the directory to `pg_restore`/`myloader`), so
  `canRestoreArtifact` no longer disables by execution mode. The disable-with-a-reason rule still
  governs what remains refused — a scope the engine does not support, and mongo outside
  `FULL_CLUSTER`.
- **The dashboard counter comes from the server, never from `.length`.** `GET /artifacts` returns
  `{ items, total, counts }`; `items` is capped at 200 and `counts` is computed over the whole
  table. Counting `items` would report fewer unobserved backups than exist, which is exactly the
  number the thesis forbids rounding. When the list is truncated the screen says so
  (`list.truncated`) instead of implying it showed everything.
- **Verify disabled on a policy is a persistent warning**, not a toast.
- **A notification channel shows its last delivery failure.** A notifier that stopped delivering is
  identical to a healthy one unless the interface says otherwise — recording the failure was the
  whole point. Disabling comes before deleting: deleting a channel that is logging failures throws
  away the only evidence that it was failing.
- **No literal UI string in a component.** Everything lives in `src/i18n/messages/en.ts` (the
  source of keys); each translation — `pt-BR.ts` and `es.ts` — is a `Record<MessageKey, string>`,
  so a missing translation breaks the typecheck. Adding a locale: a new dictionary plus an entry in
  `Locale`/`LOCALES`/`dictionaries` in `provider.tsx`. Dynamic keys use a template literal
  (``t(`job.state.${state}`)``), which TS narrows to the valid subset.
- **Password rotation replaces the whole app; it is not a banner.** While `mustChangePassword`
  stands the server refuses every action, so rendering the dashboard behind a notice would be a
  screen full of controls that fail — the operator would read it as a broken product rather than as
  something being asked of them. And the text names `SCHRODUMP_ADMIN_PASSWORD` and `docker
  inspect`: "change your password" without a reason is bureaucracy, and the person picks something
  equally careless.
- **The session is a cookie**, never localStorage. Only the language preference goes to
  localStorage.

## The guided setup starts with keys, and not by taste

`guided-setup.tsx` puts encryption keys first because until an active escrow key exists every
backup fails inside `resolveRecipients` — a checklist starting at "destination" walked the operator
through four steps and then a failed job citing a key nobody had told them to create. The canary
and probe steps are prompts rather than checkmarks: the server records no state for them.

## How it talks to the server

There is no CORS: `next.config.ts` rewrites `/api/auth/*` and `/backend/*` to `SCHRODUMP_API_URL`.
Every fetch is same-origin with `credentials: "include"`. The value is baked at build time
(`output: "standalone"`), not read at runtime — inside the image the API listens on
`127.0.0.1:8081`.

## Domain and formatting

- `src/lib/domain.ts` is a hand-maintained mirror of the `@schrodump/core` vocabulary (small,
  stable enums) — the web depends on **no** workspace package, which keeps the Next build clean.
  Change an enum in core, update it here.
- **Server numbers do not reach the screen raw.** `serverVersionNum` is an encoded integer
  (`70015` = MongoDB 7.0.15); always pass it through `formatServerVersion`. Sizes through
  `formatBytes`.

## Test-connection and RBAC

- The probe returns `{ ok, serverVersionNum, failure, driverCode }`. `failure` is a code
  (`UNREACHABLE`/`TIMEOUT`/`AUTH_FAILED`/`INSUFFICIENT_PRIVILEGES`/`TLS_FAILED`/`UNKNOWN`) with
  text in `targets.probe.reason.*`. `driverCode` is shown only when `failure === "UNKNOWN"` — in
  the other cases it is noise.
- **Role fails closed.** `useCurrentRole` reads the role from `GET /me` (`routes/session.ts`) — it
  lives on the membership, not on the Better-Auth session. While the query is loading, and if it
  fails, the default is `viewer`, which hides restore. The server enforces `operator+`
  independently: this is UX, not the control.

## Connection URL (`lib/connection-url.ts`)

Pasting a URL **fills in** the target form; it is never sent to the server nor stored — the
credential has exactly one path and it does not go through here. Client-side parsing with the
WHATWG `URL`. On success the field is cleared (do not keep the password in two places in state);
on error no field is touched. It refuses `mongodb+srv` and multi-host URIs with a reason instead of
guessing.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```

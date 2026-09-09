# @schrodump/web

Next.js 16 (App Router) + React 19 + Tailwind v4 + shadcn/ui + TanStack Query + Zod. Consumes the
`apps/server` API. Takes precedence over the root `CLAUDE.md` inside this directory.

## Invariants

- **Backup state is ternary and the colour is content, not decoration.** `VERIFIED` green,
  `UNOBSERVED` amber, `FAILED` red. There is no "OK", there is no grey for unverified, and the
  dashboard's primary counter is _"N unobserved backups"_ — never "N ok". See `StatusBadge` and
  `state-counters.tsx`, and the thesis in the root file.
  - **A green also says HOW it was earned.** `VERIFIED` can mean a real `FULL_RESTORE` or only a
    `CHECKSUM` (bytes intact, restore unproven), so the artifact row carries the effective
    `verifiedLevel` beside the badge — and a `CHECKSUM` that was **downgraded** from a requested
    `FULL_RESTORE` (`verifiedDegraded`, e.g. an unscoped replica-set dump v1 cannot restore-verify)
    reads as a caution, never as the restore-proven green beside it. `StatusBadge` stays the ternary
    state; the level tag (`VerifyLevelTag` in `artifacts/page.tsx`) is the qualifier. `null` level
    (never verified, or pre-dating the field) says nothing — it is not a false "checksum".
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
  governs what remains refused — a scope the engine does not support. Mongo now offers
  `DATABASE` and `COLLECTION` too (never `TABLE`; mongo has none), mirroring the server's matrix.
- **The dashboard counter comes from the server, never from `.length`.** `GET /artifacts` returns
  `{ items, total, counts }`; `items` is capped at 200 and `counts` is computed over the whole
  table. Counting `items` would report fewer unobserved backups than exist, which is exactly the
  number the thesis forbids rounding. When the list is truncated the screen says so
  (`list.truncated`) instead of implying it showed everything.
- **Deleting an artifact has friction, and the same two-lock shape as restore.** A viewer never
  sees the control (`canDeleteArtifact`, operator+); the server refuses regardless. The dialog
  makes the operator retype the artifact's short id, and a **`VERIFIED`** artifact — one a restore
  has actually proven good — needs a second, explicit acknowledgement (`acknowledgeVerified`) that
  the API also enforces (409 `VERIFIED_NEEDS_ACK` without it). Deletion reaches the bucket, not just
  the catalog: the object, its manifest and the postgres globals sidecar go too. See
  `DeleteArtifactDialog` and `docs/backup-restore.md`.
- **Verify disabled on a policy is a persistent warning**, not a toast.
- **An `INCONCLUSIVE` job is quiet, never the failed red.** It is a verify whose sandbox or runner
  never got to look; it says nothing about the artifact, which stays `UNOBSERVED`. Painting it like
  `FAILED` is the blur the server refuses to make on the artifact, applied one row over.
  `RecentJobs` and `JobRow` colour only `FAILED`. The server exposes it as its own `JobState`
  precisely so the UI never has to grep the reason string for it.
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

## Key rotation is friction, and a retired key is not clutter

- **The confirmation exists to be read, not clicked.** Rotating is cheap and easy to misread: the
  dangerous belief is that rotating a leaked key closes the leak. It does not — every artifact
  already written stays sealed to the outgoing key. The confirm button is dead until the
  acknowledgement is ticked, and a test proves it by asserting no request went out first.
- **The post-rotation notice is the server's sentence, not a local paraphrase.** What the operator
  must retain (`consequences.operatorMustRetain`) is a property of the rotation the API decided; a
  translated copy here would drift from it the first time the rule changed.
- **A retired key is labelled, kept visible, and has no rotate button.** It is what opens every
  artifact written before the rotation. Listing it without saying so invites an operator to read
  the extra row as clutter to tidy away — and there is no delete, precisely because there must not
  be. Active keys sort first.
- **Escrow rotation offers "bring your own recipient" exactly like provisioning does.** An operator
  who keeps age identities offline must not be pushed onto a server-generated key just because they
  are replacing one.

## The guided setup starts with keys, and not by taste

`guided-setup.tsx` puts encryption keys first because until an active escrow key exists every
backup fails inside `resolveRecipients` — a checklist starting at "destination" walked the operator
through four steps and then a failed job citing a key nobody had told them to create. Six steps,
and the canary and probe ones tick only when the server recorded a pass (`lastCanaryOk` /
`lastProbeOk` `=== true`): `null` (never run) and `false` (ran and was refused) both stay open,
because a bucket nobody proved writable is the same open question the product refuses to paint green
anywhere else. The card stays until all six are done — it cannot be dismissed.

## Design system (the Foundations contract)

`src/app/globals.css` is the token contract, extracted from the redesigned screens. Read it before
touching a colour; the comments carry the measurements.

- **Every colour is authored for both themes on one line, with `light-dark()`.** The browser
  resolves it from `color-scheme`, so the app follows the operating system with no media query, and
  the two themes cannot drift apart because neither is written without the other. `[data-theme]`
  (or `.light`/`.dark`) forces one side. Every text-on-surface pair was measured against WCAG AA in
  both themes; the lowest is 4.51:1. Change a value, re-measure, update the comment.
- **The amber rule.** One hue does three jobs — the accent (`--color-primary`, the focus ring), the
  `UNOBSERVED` state, and caution — and they stay apart by FORM: the state is always a diamond
  marker with a mono uppercase word, the accent is always a filled button or a ring, caution is
  always tinted text or a tinted panel. `accent` is the amber here, not shadcn's grey hover surface;
  hover surfaces use `muted`.
- **The domain tokens keep their names.** `--color-state-*` (the data verdict), `--color-job-*`
  (the process outcome, a quiet palette that never borrows the state colours), `--color-caution*`,
  `--color-destructive*` (a separate red from `state-failed`: a delete button and a condemned
  backup must not read as the same thing). Collapse them into generic success/warning/error and
  the product loses the distinction it exists to make — that goes for a design-system sync too.
- **The aliases in `@theme` are transitional.** `--color-foreground-soft`, `--color-state-*-bg`,
  `--color-border-strong`, `--color-secondary*` exist so the screens that predate the redesign
  restyle without a rename. Each screen drops them as it is ported; delete an alias with its last
  use, and the block with the last alias. New code never uses them.
- **Fonts are vendored (`src/fonts/`), not fetched.** `next/font/google` downloads at build time,
  and a `docker build` on a host without internet must not fail on a typeface. Instrument Sans for
  anything a person wrote; JetBrains Mono for anything a machine produced — ids, sizes, checksums,
  hosts, states, log lines. Both SIL OFL 1.1, licences alongside the files.
- **Radii are four steps** — chip 6, control 9, panel 14, dialog 16 — and the Tailwind
  `rounded-sm/md/lg/xl` map onto them, so `rounded-md` on an input lands on the scale.

The semantic components, each carrying one law and a test that proves it by mutation:

- **`StatusBadge` / `StateMarker`** — colour AND shape: a sealed ring for `VERIFIED` (never a
  checkmark), a rotated square for `UNOBSERVED`, a triangle for `FAILED`, in `data-marker`. There is
  no fourth state.
- **`VerifyLevelChip`** — how deep the check went, never whether it passed. Four appearances: full
  restore and a requested checksum are neutral; a checksum **downgraded** from a requested full
  restore takes the caution tint; a null level on an `UNOBSERVED` artifact says "no verdict yet",
  and a null level on a `VERIFIED`/`FAILED` one (it predates the field) renders nothing — "checksum"
  there would be a false claim, "no verdict" a false one too.
- **`JobStateChip`** — the process outcome: quiet ink and a square, no shape or colour borrowed
  from the state markers, only `FAILED` coloured; `exit N` only when non-zero.
- **`Button`** — six variants (primary, secondary, quiet, ghost, accent, danger; the three legacy
  names map onto them) and **`disabledReason`**, the design system's only way to disable: the
  reason is rendered beside the control as "Blocked — …" and announced through `aria-describedby`.
  There are no bare greyed-out controls in this product. Passing the prop at all (even `null`) keeps
  the button inside its wrapper span: the first version added the wrapper only when a reason
  appeared, React swapped `<button>` for `<span><button/></span>` and REMOUNTED the control, and a
  reference held across the change (a test's, a focus ring's) pointed at a detached node. The reason
  reads before the button, so in a right-aligned footer it sits to the left of the action it
  explains.
- **`Panel`** — seven tones; tone carries the meaning. A `lock` is deliberately not red: a
  constraint is not a failure. A panel that must be announced takes `role="alert"` itself.

The composition pieces came with the artifact catalog port and are meant to be reused by the
screens that follow:

- **`DialogShell`** + **`SubjectRow`** (`ui/dialog.tsx`) — a portal to `document.body` AND a click
  boundary (`stopPropagation` at the root). The portal alone did not protect the dialog: React
  bubbles a portal's events to its React ancestors, so the row's `<span onClick={preventDefault}>`
  still cancelled every native default action inside — the submit button (PR #120's
  "submit-on-click does not fire"; it fired, and was cancelled), the acknowledge checkbox, its
  label text. Escape closes, focus lands inside.
  The subject row names WHAT the dialog acts on — state glyph, target name, engine/mode, size, short
  id — before any wording, so a wrong-row click is caught by reading, not by regret.
- **`RetypeToConfirm`** and **`AcknowledgeCheckbox`** — the two friction gates. Retype for the
  case with a single name (the artifact id, the target database); acknowledge where there is none to
  retype (a full-cluster overwrite reaches every database on the destination) or where the loss
  needs a sentence read out (deleting a `VERIFIED` artifact). The primary action carries the reason
  it is blocked through `disabledReason`; a gate never silently greys a button.
- **The overwrite copy is true to `restore.ts`.** There is no sandbox for a restore. Off means a
  database that already holds data is refused and the job says so; on means live data is replaced.
  The design's first draft claimed an isolated run — a comforting sentence the code does not honour.
- **`FilterChip`**, **`DetailGrid`**, **`ProportionBar`**, **`ruled-list.tsx`** (`ColumnHeaders`,
  `GroupHeader`, `ListFooter`) — the list vocabulary. `DetailGrid` drops a null fact instead of
  printing "—": an absent value is absence. `ListFooter` says how many of the total are shown, and
  always that the counters come from the whole table. Rows are grouped by the viewer's local day
  (`dayGroupOf`), newest group and newest row first regardless of arrival order. Counts have a
  singular key (`artifacts.groupCount.one`) — the catalog has no plural rules beyond one-or-many,
  and "1 artifacts" reads as a bug.
- **`MetricTile`** — a number, its name, its unit line, one sentence on what it means. The tone
  IS the meaning: `caution` for a number asking for attention, `danger` for a broken process,
  `quiet` for a count that is neither — a verify that could not run is not a failure and is not
  painted like one. The jobs ledger's four tiles read `counts`/`stats` the server computed over the
  whole table; a tile that counted the page would say "0 failed" on the day the list got trimmed.
- **The jobs ledger** (`app/jobs/page.tsx`). A job state is a process outcome, so every row also
  shows the verdict on the data it touched — `job.artifact` with the artifact's own glyph and ink,
  never borrowed from the job palette. Timing reads from a clock the page hands down (`now`), which
  ticks only while a RUNNING or PENDING row exists; the row itself owns no timer, which is what
  keeps it testable. Five minutes is the one threshold (`LONG_WAIT_MS`) that turns a queue wait into
  "workers behind" on the row, in the fact, and on the tile. A downgraded verify is recognised from
  the worker's reason sentence (`isDowngrade`, see `apps/server/src/jobs/verify.ts`) — the seam is
  in one place, waiting for a structured flag. A filter narrows the PAGE; the footer then says how
  many of the page's rows match and how many jobs the table holds, rather than letting "showing 3
  of 1,284" imply the three are all there is.
- **The target form and list** (`components/target-form.tsx`, `app/targets/page.tsx`). A
  discovery belongs to the connection it ran against: the form keeps the `engine|host|port|user`
  signature the list came from, and a change to any of them marks the list stale, clears the pick
  and blocks Save until discover runs again — the quiet alternative was saving a database name
  against a server nobody asked. Save is never merely grey: `disabledReason` names the first thing
  to fix, in the order an operator would (name, host, user, password, then the scope). The
  `VerdictPanel` says what a probe came back with in words parameterised by host, port and user,
  never by a secret, and shows the raw driver code only on UNKNOWN. A delete says up front what the
  server will say — which policies still point here — instead of after the 409; a viewer sees no
  action at all, the server refusing the write being the first lock and the missing button the
  second. TLS is still the boolean the API holds; the design's four-mode select is a server change.
- **The configuration trio** (destinations, policies, channels). One family of forms through
  `ui/form-bits.tsx` (`FormHeader`, `FieldLabel`, `SaveBar`): the primary action carries the
  first thing to fix, the locked fields in edit stay on screen with the reason (`Panel` tone
  `lock`), and every refusal is the server's own sentence under "Refused by the server". The
  policy row reads its cron (`lib/cron.ts`: five fields, lists, ranges, steps; `readCron` names
  only the shapes that have an honest sentence, `nextRun` walks the local clock) and says when it
  fires next, or that it will not and why — a disabled policy has no next run, an unreadable
  expression says so in caution and blocks Save. `scratch.configured` comes from `/instance`: with
  it off, the staged mode is withheld with its reason and a full-restore verify is warned as one
  that would only ever end "could not run". A channel that is recording failures offers "Disable
  instead" before "Delete": deleting it throws away the only evidence deliveries were not arriving.
- **The out-of-app screens and settings.** Sign-in, first-run setup and the bootstrap-password
  wall share `AuthFrame`: the mark, a title, one sentence, the form, nothing else — the server
  refuses everything else in those states, and a control that would only produce an error is
  worse than none. The password floor is the server's own (`auth.ts minPasswordLength`, twelve),
  asked for in the form only to save a round trip that ends in the same refusal. The four settings
  panels share `SettingsPanel`; a non-admin is told so in the lock tone, never shown an empty
  list. Anything the server shows once — the escrow identity, a minted temporary password — sits
  in a code block behind an `AcknowledgeCheckbox`, and the button that dismisses it carries the
  reason while the box is unticked, because dismissing is irreversible. A self-backup that
  SUCCEEDED wears the UNOBSERVED ink: nobody restored it, and green is for what a restore opened.
  The guided card counts its steps, and a check the server recorded as refused says so on its row
  instead of looking like one nobody has tried.
- **The top bar** (`app-shell.tsx`): the mark at 36px and the name, the nav as segments in the
  order the product reads (what is proven, what ran, then the configuration), and one
  `AccountMenu` for the three things that are about the person — language, theme, sign out. The
  trigger shows the current language's flag (`country-flag-icons`, SVG: an emoji flag renders as
  two letters on Windows) and its code, nothing more, so the bar keeps its width for the nav. The
  theme has three states — system, light, dark (`useThemeChoice`); an explicit choice stamps
  `data-theme` on `<html>`, which the `light-dark()` tokens read, and is stored under one
  localStorage key that the root layout applies before the first paint. Beside "System" the menu
  says what the browser currently reports ("now dark"), because an OS in dark mode and a browser
  set to light look, from the page, like a toggle that does not work. The transitional aliases
  and the legacy button names are gone: every screen is on the contract now.
- **The catalog is the home screen** (`app/page.tsx`; `/artifacts` redirects there). The product's
  first question is how many backups nobody has checked, and that is the catalog's header — so
  there is no separate dashboard to keep in step with it. The counters keep one shape whether
  the fleet is clean or on fire:
  UNOBSERVED leads at display size with its diamond, VERIFIED and FAILED stay subordinate, and
  FAILED is grey with "nothing to answer for" until there is something to be red about. Under
  them, one line says the numbers were counted server-side over the whole table, and the oldest
  UNOBSERVED artifact is named as the oldest open question. The audit trail is admin-only on the server; the page shows the lock sentence for other roles
  instead of an empty list, groups entries by the viewer's day, filters the PAGE by action or
  actor ("system" is a job's own credential read), and the footer says what a filter narrowed
  and what the table holds.

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
- **Timestamps render in the viewer's zone, never sliced from the ISO string.** They travel as UTC
  ISO; `formatDateTime` / `formatTime` / `formatRelative` (`lib/format.ts`) render them at the
  browser's locale and timezone. The old `at.slice(11, 16)` showed UTC, so a São Paulo operator read
  a 02:00 job as 05:00 — the quiet mismatch that makes a person distrust the whole screen. Freshness
  ("verified 3 days ago") uses `formatRelative`; it answers the question the dashboard is really
  asking better than an absolute stamp.

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

## Target scope is chosen, never typed (`components/target-form.tsx`)

The scope field used to be free text with the hint "empty means all". For postgres that was false —
empty meant `postgres`, the maintenance database — and on a real deployment it produced an 876-byte
backup of nothing under a SUCCEEDED job. The form now runs `POST /targets/discover` with the typed
credentials (nothing is saved by that call) and offers the scope as a selection over what the server
was found to hold, with sizes: one radio for postgres, checkboxes for mysql/mariadb (none selected
means all), and for mongodb a whole-instance lock when `isReplicaSet` comes back true. Save is
disabled by `scopeProblemCode` (`lib/domain.ts`) for exactly the cases the API refuses with
`scopeProblem` — the API is the control, this is so the refusal happens before the request. Nothing
is pre-selected, even with one obvious candidate: a default is what this replaces. In edit mode the
password is write-only and starts empty, so re-discovering means typing it; without it the saved
selection stands. A name carried in from a pasted URL that the server does not hold is dropped on
discovery rather than saved.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```

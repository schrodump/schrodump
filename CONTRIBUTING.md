# Contributing to Schrodump

Thanks for your interest in contributing. This document describes how changes get
into the project.

## Before you start

- Schrodump is licensed under **AGPL-3.0-or-later**. By contributing you agree that
  your contribution is licensed under the same terms.
- Every contribution is accepted **only** under the Schrodump Contributor License
  Agreement (CLA). See [Contributor License Agreement](#contributor-license-agreement)
  below. **No pull request is merged before the CLA is signed.**

## Pull request flow

1. Open (or comment on) an issue describing the change before large work, so we can
   agree on scope and avoid duplicated effort.
2. Fork the repository and create a topic branch from `main`
   (e.g. `feat/verify-restore`, `fix/scratch-cleanup`).
3. Make your change. Keep the diff surgical and focused on a single concern.
4. Run the full local check before pushing:

   ```bash
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

5. Every source file must carry the SPDX header (see `CLAUDE.md`).
6. Push and open a pull request against `main`. Fill in what changed and why.
7. A maintainer reviews. CI (`typecheck`, `lint`, `test`) must be green and the CLA
   must be signed before merge.

## Commit convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>
```

Allowed types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `ci`, `build`,
`perf`. Keep the title in short English; the body may add detail. One logical change
per commit.

## Sign your work: the Developer Certificate of Origin

Schrodump uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO)
rather than a Contributor License Agreement. There is nothing to sign up for and no separate
document to accept: you certify the origin of your contribution by adding a `Signed-off-by` line
to each commit, which git does for you:

```sh
git commit -s -m "fix(runner): ..."
```

That appends a trailer matching your git identity:

```
Signed-off-by: Your Name <you@example.com>
```

By adding it you state that you wrote the patch, or otherwise have the right to submit it under
this project's licence — the full text is at <https://developercertificate.org/>. Use your real
name and a real email address.

The `dco` job in `ci.yml` checks every commit in a pull request. If you forget, the fix is
`git rebase --signoff origin/main` followed by a force-push; nothing needs to be re-submitted.

**Why DCO and not a CLA.** A CLA asks contributors to grant the project rights beyond the licence,
which for an AGPL-3.0-or-later project mainly serves relicensing later. Schrodump has no plan to
relicense, and a CLA is friction that turns a one-line fix into a legal review. The DCO is what the
Linux kernel, GitLab and Docker use, and it is enough for what this project actually needs:
a record that each contributor had the right to contribute what they sent.

## Reporting security issues

Do **not** open a public issue for security problems. Follow the process in
[`SECURITY.md`](SECURITY.md).

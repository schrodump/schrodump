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

## Contributor License Agreement

Signing the CLA is **mandatory** and must happen before any contribution is merged.

<!-- TODO: texto do CLA pendente de revisão jurídica -->

## Reporting security issues

Do **not** open a public issue for security problems. Follow the process in
[`SECURITY.md`](SECURITY.md).

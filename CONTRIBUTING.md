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

## Cutting a release

Releases are tags. `release.yml` triggers on `v*`, re-runs the full gate on the tagged commit, and
only then builds, signs and publishes — a tag on a commit whose CI failed must not become a signed
image.

```sh
git tag -a v0.1.0-rc.3 -m "v0.1.0-rc.3"
git push origin v0.1.0-rc.3
```

`latest` moves only when the tag parses as exactly `X.Y.Z`, so a `-rc.N` publishes to
`ghcr.io/schrodump/schrodump:0.1.0-rc.3` and `schrodump/schrodump:0.1.0-rc.3` without becoming the
tag `compose.yaml` pulls by default. Cut a release candidate first: the pipeline signs with cosign,
attaches an SBOM and publishes the executor images, and none of that has an opportunity to be wrong
until a tag exists.

It needs two repository secrets, `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`, alongside the
`GITHUB_TOKEN` that GHCR uses. The `preflight` job reads them first and names whichever is missing,
so an absent secret costs seconds and publishes nothing, rather than surfacing as a
`docker/login-action` failure minutes deep in a multi-arch build.

### Before the first release: claim the Docker Hub namespace

The workflow pushes to `schrodump/schrodump` and `schrodump/mydumper`. **The credentials must own
the `schrodump` namespace**, and owning a token is not owning a namespace: with a valid token for
an account that does not, `docker/login-action` succeeds and the push fails with
`denied: requested access to the resource is denied` — after the multi-arch build.

The preflight cannot check this. It sees that both secrets exist; whether they can write to that
namespace is only answered by a registry that refuses.

1. Create the account or organization named exactly `schrodump` at hub.docker.com. A free personal
   account carries the namespace; an organization needs a paid plan.
2. Account Settings → Security → **Personal access tokens** → Generate. Scope **Read & Write** —
   read-only cannot push, and the first push has to *create* both repositories.
3. Add `DOCKERHUB_USERNAME` (the account name) and `DOCKERHUB_TOKEN` under repository
   Settings → Secrets and variables → Actions.

After the first push, check both repositories' visibility on Docker Hub. Do not assume it: what a
push-created repository defaults to has changed with plan and over time, and a private one fails
for everyone but you — the same failure mode as the GHCR step below, from the opposite direction.

### Installing a release candidate

Because `latest` does not move, the shipped `compose.yaml` will not pull an `-rc.N` on its own.
Name it in `.env`:

```sh
SCHRODUMP_IMAGE=schrodump/schrodump:0.1.0-rc.3
```

That is the same variable production should use to pin an exact version, so the path is exercised
by every CI run rather than only by whoever tries the candidate.

### After the FIRST tag only

A GitHub Container Registry package is created **private**, and nothing in the workflow can change
that — the package does not exist until the first push. So until someone flips it, every
`docker pull ghcr.io/schrodump/schrodump:...` from outside the organization fails, which looks
exactly like a release that did not publish.

Once the first release finishes, for **each** of `schrodump`, `mydumper`:

> Packages → the package → Package settings → Danger Zone → Change visibility → Public

Then verify from a logged-out client, because the org's own credentials cannot tell you whether a
stranger can pull:

```sh
docker logout ghcr.io
docker pull ghcr.io/schrodump/schrodump:0.1.0-rc.3
```

Docker Hub repositories are public by default and need no equivalent step.

## Reporting security issues

Do **not** open a public issue for security problems. Follow the process in
[`SECURITY.md`](SECURITY.md).

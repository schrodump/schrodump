# Security Policy

We take the security of Schrodump seriously — it holds credentials for, and encrypted
copies of, other people's databases. Thank you for helping keep it safe.

## Supported versions

Schrodump is pre-1.0 and under active development. Security fixes are applied to the
`main` branch and the latest published release only. There is no back-porting to older
versions before 1.0.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.** Public disclosure before a
fix is available puts every deployment at risk.

Report through **GitHub's private vulnerability reporting** for this repository:
[Security → Report a vulnerability](https://github.com/schrodump/schrodump/security/advisories/new).

It is private between you and the maintainers, it needs no account beyond the one you are already
reading this with, and it opens a draft advisory the fix can be prepared and reviewed against
before any of it becomes public.

Please include, as far as you can:

- affected component and version / commit,
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested remediation.

## Scope

In scope:

- the Schrodump server (`apps/*`),
- the workspace packages (`packages/core`, `packages/engines`, `packages/runner`,
  `packages/storage`),
- the client-side encryption, key handling, and manifest format,
- the ephemeral executor model and its access to the Docker API,
- credential handling for target databases and the S3-compatible destination.

Out of scope:

- vulnerabilities in third-party database client images run inside executors — report
  those upstream (we will help coordinate),
- the security of the operator's own target databases, S3 provider, or host,
- issues that require a already-compromised host or Docker daemon,
- missing hardening that is documented as the operator's responsibility.

## Coordinated disclosure

- We aim to **acknowledge** a report within **3 business days**.
- We work with you on a fix under a reasonable embargo and will agree on a disclosure
  date before going public.
- We credit reporters who wish to be named once the fix is released. Please give us a
  chance to ship the fix before any public disclosure.

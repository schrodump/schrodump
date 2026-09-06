## What this changes, and why

<!--
The why is the part that cannot be recovered from the diff a year from now. If this fixes a
defect, say what the defect let through — not just which line was wrong.
-->

## Evidence

<!--
Without evidence it is not done. Paste what you actually ran, not what you intend to run:

    pnpm typecheck && pnpm lint && pnpm test

If this touches dump, restore, verify or storage, the unit suites skip the parts that matter.
Say whether you ran the integration suites (SCHRODUMP_TEST_INTEGRATION=1, and the S3 variables
for the storage driver) or why they do not apply.

If you added a test: break the thing it guards and confirm the test goes red. A test that passes
against the bug is worse than no test, because it reports safety.
-->

## Before this can merge

- [ ] **Every commit is signed off** (`git commit -s`). The `dco` job checks the whole range and
      fails closed; `git rebase --signoff <base>` fixes a branch that already exists.
- [ ] New source files carry the SPDX header — `*.ts`, `*.tsx`, `*.mjs`, `*.js`, `*.sh`, the
      Dockerfiles and the workflows. In a shell script it goes under the shebang.
- [ ] If `README.md` changed, `README.pt-BR.md` and `README.es.md` changed in the same PR.
      `readme-sync` checks that they were touched; keeping the meaning aligned is on you.
- [ ] The dependency graph still holds: `core` imports nothing from the workspace; `engines`,
      `runner` and `storage` import only `core` and never each other; `apps/web` imports no
      workspace package at all.
- [ ] Nothing new writes a backup as anything other than `UNOBSERVED` until something has opened
      it and checked. An artifact nobody looked at is never green.

# design-sync notes — @schrodump/web

Repo-specific facts a re-sync needs. `config.json` holds the values; this file holds the why.

- **apps/web is a Next app, not a library.** No dist/, no `.d.ts` tree, no built stylesheet, and pnpm never links a workspace package into its own node_modules. `prepare.mjs` (= `buildCmd`) lays out a scratch package at `.design-sync/.cache/node_modules/@schrodump/web` and the converter runs with `--node-modules .design-sync/.cache/node_modules`. Re-run `prepare.mjs` before every build — it is what makes `package.json`, `src/`, `styles/tailwind.css` and `types/` exist.
- **The bundle entry is a curated view.** `prepare.mjs` `DS_SURFACE` lists the component files that form the design system; `src/components/ui` is linked file by file (the converter's source walk does not descend into a symlinked directory). App chrome and data-bound screens (AppShell with next/navigation and the auth client, the forms, the dialogs that mutate, the settings panels) stay out — the first build without this pulled next, better-auth and zod into a 1.6 MB bundle. Add a new DS component by adding its file to `DS_SURFACE`.
- **Declarations come from tsc.** `prepare.mjs` emits `.d.ts` for the curated files with the app's own TypeScript; without them every `<Name>Props` was an index signature. Types that resolve to aliases from `lib/domain.ts` (`ArtifactState`, `JobState`, …) are inlined by hand in `cfg.dtsPropsFor` — keep those in step with `apps/web/src/lib/domain.ts`.
- **Package-relative config paths point through the scratch package.** `cssEntry` is bounded to the package dir, so the compiled stylesheet is written INSIDE it (`styles/tailwind.css`); `extraFonts` and `docsDir` are repo-bounded and use the `../../../../` prefix that climbs out of `.cache/node_modules/@schrodump/web` to `.design-sync/`.
- **Tailwind v4 is compiled ahead of time.** `tailwind.css` imports the app's `globals.css`, scans `apps/web/src/components` AND `.design-sync/previews`, and safelists the layout/token families the design agent may use (`@source inline(...)`). A utility not in that closure does not exist in the shipped CSS. `next/font` is replaced by `fonts.css` (`@font-face` for the vendored woff2) plus the two `--font-*` variables set in `tailwind.css`.
- **Grouping comes from `docs/` stubs.** The converter's folder heuristic treats `ui/` and `components/` as generic, so every card would land in "general". `docsDir` points at `.design-sync/docs/`, one frontmatter-`category` stub per component with a one-line purpose; the stub body becomes the `.prompt.md` lead. Add a stub when adding a component.
- **Browser for the render check:** no playwright chromium is cached on this machine; the system Google Chrome is used via `DS_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` (playwright installed in `.ds-sync` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).
- **Toolchain:** `.nvmrc` says 22; the sync ran on node 24.20 (engines `>=22`), same as the repo's own tests here.
- **Overrides:** overlay and wide components carry `cardMode` (DialogShell/AuthFrame single with a viewport; ledgers, counters, bars, tiles, grids, form bars in column mode).

## Known render warns

- None left after authoring: every component has an owned preview and the render check reports no `bad`/`thin` (check the fresh validate log; a new warn is new).

## Re-sync risks

- `cfg.dtsPropsFor` inlines domain unions by hand — a change to `ARTIFACT_STATES`, `JOB_STATES`, `VERIFY_LEVELS`, `PROBE_FAILURE_CODES` or a component's props in `apps/web/src/lib/domain.ts` / the ui files must be mirrored there, or the `.d.ts` the design agent reads goes stale.
- `DS_SURFACE` in `prepare.mjs` is a hand list: a new reusable component in `apps/web/src/components/` is invisible until added (ui/ files are picked up automatically).
- Previews carry copy and numbers that mimic real screens (IPOG Nexus, cmtuga00, 1,284 artifacts); they are illustrative, not data.
- The safelisted utility families in `tailwind.css` are a curated set; a design that needs a class outside them renders unstyled for that class.
- Verified on node 24 + the app's pinned Tailwind/TypeScript; a Tailwind major bump changes the compiled class set.

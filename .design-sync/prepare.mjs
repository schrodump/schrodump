// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Everything the design-sync converter needs that the repo does not build on its own. Run from the
// repo root: `node .design-sync/prepare.mjs`. apps/web is a Next app, not a published library: it
// has no dist/, no .d.ts tree, no built stylesheet, and pnpm never links a workspace package into
// its own node_modules. This script lays out a scratch package the converter can read as
// `<node-modules>/@schrodump/web`, under .design-sync/.cache (gitignored). Nothing under apps/web
// is touched.
//
// 1. Stylesheet: compile .design-sync/tailwind.css with the app's own Tailwind v4 toolchain into
//    the scratch package's styles/tailwind.css — the `cssEntry` the bundle ships. It scans the components AND the
//    authored previews, so a preview's layout glue resolves too.
// 2. Curated source view: .cache/node_modules/@schrodump/web/src mirrors apps/web/src through
//    symlinks, except that src/components holds ONLY the design-system surface (DS_SURFACE below).
//    The converter synthesizes its bundle entry from that tree, so app chrome (AppShell with
//    next/navigation and the auth client) and the data-bound screens stay out of the bundle — the
//    first build without this pulled in next, better-auth and zod, 1.6 MB.
// 3. Declarations: emit .d.ts for the curated files with the app's own TypeScript into
//    .cache/node_modules/@schrodump/web/types, plus an index.d.ts barrel. The converter's prop
//    extraction reads a .d.ts tree; without one every <Name>Props came out as an index signature.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../apps/web");
const cache = resolve(here, ".cache");
mkdirSync(cache, { recursive: true });
const webRequire = createRequire(resolve(web, "package.json"));

// The design-system surface: the reusable pieces a design is built from. Screens, forms bound to
// the API, the dialogs that mutate, and the app shell are deliberately absent — they are
// compositions of these, and the design agent composes its own.
const DS_SURFACE = [
  "account-menu.tsx",
  "auth-frame.tsx",
  "brand-mark.tsx",
  "credential-field.tsx",
  "cron-reading.tsx",
  "feedback.tsx",
  "job-state-chip.tsx",
  "last-check.tsx",
  "locale-flag.tsx",
  "providers.tsx",
  "ruled-list.tsx",
  "settings-panel.tsx",
  "state-counters.tsx",
  "status-badge.tsx",
  "verdict-panel.tsx",
  "verify-level-chip.tsx",
];

// 2. scratch package with the curated source view
const nm = resolve(cache, "node_modules");
const pkg = resolve(nm, "@schrodump/web");
rmSync(nm, { recursive: true, force: true });
mkdirSync(resolve(pkg, "src/components"), { recursive: true });
mkdirSync(resolve(nm, "@types"), { recursive: true });
const link = (at, target) => symlinkSync(target, at, "dir");
for (const dep of ["react", "react-dom", "@types/react"]) {
  link(resolve(nm, dep), dirname(webRequire.resolve(`${dep}/package.json`)));
}
link(resolve(pkg, "node_modules"), resolve(web, "node_modules"));
link(resolve(pkg, "tsconfig.json"), resolve(web, "tsconfig.json"));
for (const entry of readdirSync(resolve(web, "src"))) {
  if (entry === "components" || entry === "app") continue;
  link(resolve(pkg, "src", entry), resolve(web, "src", entry));
}
// A real directory of file links: the converter's source walk does not descend into a symlinked
// directory, and the ui/ primitives would silently drop out of the bundle.
mkdirSync(resolve(pkg, "src/components/ui"));
for (const file of readdirSync(resolve(web, "src/components/ui"))) {
  if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
  link(resolve(pkg, "src/components/ui", file), resolve(web, "src/components/ui", file));
}
for (const file of DS_SURFACE) {
  const target = resolve(web, "src/components", file);
  if (!existsSync(target)) throw new Error(`DS_SURFACE names a file that does not exist: ${file}`);
  link(resolve(pkg, "src/components", file), target);
}
// 1. stylesheet
{
  const tailwind = webRequire("@tailwindcss/postcss");
  // postcss is not a direct dependency of apps/web (pnpm keeps it beside the plugin).
  const postcss = createRequire(webRequire.resolve("@tailwindcss/postcss"))("postcss");
  const from = resolve(here, "tailwind.css");
  // Inside the scratch package: the converter bounds `cssEntry` to the package directory.
  const to = resolve(pkg, "styles/tailwind.css");
  mkdirSync(dirname(to), { recursive: true });
  const result = await postcss([tailwind()]).process(readFileSync(from, "utf8"), { from, to });
  writeFileSync(to, result.css);
  console.log(`wrote ${to} (${result.css.length} bytes)`);
}

writeFileSync(
  resolve(pkg, "package.json"),
  JSON.stringify(
    { name: "@schrodump/web", version: "0.0.0", private: true, type: "module", types: "types/index.d.ts" },
    null,
    2,
  ) + "\n",
);

// 3. declarations
{
  const ts = webRequire("typescript");
  const configFile = ts.readConfigFile(resolve(web, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, web);
  const uiFiles = readdirSync(resolve(web, "src/components/ui"))
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => resolve(web, "src/components/ui", f));
  const rootNames = [...DS_SURFACE.map((f) => resolve(web, "src/components", f)), ...uiFiles];
  const outDir = resolve(pkg, "types");
  const program = ts.createProgram(rootNames, {
    ...parsed.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    plugins: undefined,
    outDir,
    rootDir: resolve(web, "src"),
  });
  const emitted = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics);
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    for (const d of errors.slice(0, 10)) {
      console.error(ts.formatDiagnostic(d, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => web, getNewLine: () => "\n" }));
    }
    throw new Error(`${errors.length} TypeScript error(s) while emitting declarations`);
  }
  const barrel = [
    "// Generated by .design-sync/prepare.mjs — the design-system surface of @schrodump/web.",
    ...DS_SURFACE.map((f) => `export * from "./components/${basename(f, ".tsx")}";`),
    ...uiFiles.map((f) => `export * from "./components/ui/${basename(f, ".tsx")}";`),
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "index.d.ts"), barrel);
  console.log(`emitted declarations for ${rootNames.length} files into ${outDir}`);
}
console.log(`scratch package ready at ${pkg}`);

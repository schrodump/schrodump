// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// pnpm materialises the whole workspace lockfile into node_modules/.pnpm regardless of --filter
// and --prod, so a server-only install still carries Next, the SWC binary, TypeScript and sharp —
// roughly 600 MB the runtime never loads.
//
// Walking the symlink graph is not enough to find them: pnpm also links optional peers and
// devDependencies, so `better-auth` reaches `next`, `prisma` reaches `typescript` and the
// packages' own devDependencies reach `vitest`. This walks DECLARED RUNTIME dependencies instead
// — `dependencies` and `optionalDependencies`, never `devDependencies` or `peerDependencies` —
// which is the set Node can actually require at runtime.
//
// A package deleted by mistake fails loudly on boot, so the container smoke test is the check on
// this file.

import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

const STORE = "/app/node_modules/.pnpm";
const ROOT_MODULES = "/app/node_modules";
const ROOTS = [
  "/app/apps/server",
  "/app/packages/core",
  "/app/packages/engines",
  "/app/packages/runner",
  "/app/packages/storage",
];

const keep = new Set();
const seen = new Set();

function manifestOf(dir) {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

// A package's dependencies live in its own nested node_modules when present, otherwise as
// siblings under the store entry that contains it, and finally at the workspace root.
function locate(fromDir, name) {
  const candidates = [join(fromDir, "node_modules", name)];
  if (fromDir.startsWith(`${STORE}/`)) {
    const id = fromDir.slice(STORE.length + 1).split("/")[0];
    candidates.push(join(STORE, id, "node_modules", name));
  }
  candidates.push(join(ROOT_MODULES, name));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function visit(dir) {
  const real = realpathSync(dir);
  if (seen.has(real)) return;
  seen.add(real);

  if (real.startsWith(`${STORE}/`)) keep.add(real.slice(STORE.length + 1).split("/")[0]);

  const manifest = manifestOf(real);
  if (manifest === null) return;

  const runtimeDeps = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const name of Object.keys(runtimeDeps)) {
    const found = locate(real, name);
    // Optional dependencies are allowed to be absent; a missing hard dependency would already
    // have failed the install.
    if (found !== null) visit(found);
  }
}

for (const root of ROOTS) visit(root);

let removed = 0;
for (const entry of readdirSync(STORE)) {
  // .pnpm/node_modules holds the resolution fallback links; removing the directory itself breaks
  // every require. Links inside it that now dangle point only at packages nothing can reach.
  if (entry === "node_modules" || entry === "lock.yaml" || keep.has(entry)) continue;
  rmSync(join(STORE, entry), { recursive: true, force: true });
  removed += 1;
}

process.stdout.write(`store pruned: kept ${String(keep.size)}, removed ${String(removed)}\n`);

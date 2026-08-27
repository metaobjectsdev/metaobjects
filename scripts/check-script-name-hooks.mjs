#!/usr/bin/env node
// No root script name may be the npm/bun lifecycle HOOK of another root script.
//
// npm and bun both run `pre<name>` before `<name>` and `post<name>` after it, with no
// per-script opt-out. So the moment a manifest declares BOTH `release` and `prerelease`,
// `bun run release <version>` stops meaning "release": it silently runs the prerelease
// publisher first, and `release` never starts.
//
// That is not hypothetical. The 0.24.2 cut ran the documented `bun run release 0.24.2`
// and got `scripts/prerelease.mjs` refusing on absent MO_REGISTRY_* credentials — an
// error naming a private registry the release has nothing to do with. It failed loudly
// only because those credentials were absent; had `tools/prerelease/registry.env`
// existed, the hook would have SUCCEEDED and published a private-registry iteration as
// an invisible side effect of every public release.
//
// The collision is a property of the two NAMES, so it is checked against the names
// rather than against either script's behaviour. Offline; reads one manifest.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {});
const declared = new Set(scripts);

const collisions = scripts.flatMap((name) => {
  for (const prefix of ["pre", "post"]) {
    if (!name.startsWith(prefix)) continue;
    const target = name.slice(prefix.length);
    if (declared.has(target)) return [{ hook: name, target, prefix }];
  }
  return [];
});

if (collisions.length) {
  console.error("\x1b[31m✗ package.json declares a script that is another script's lifecycle hook:\x1b[0m");
  for (const { hook, target, prefix } of collisions) {
    console.error(`    "${hook}" runs ${prefix === "pre" ? "BEFORE" : "AFTER"} "${target}" — ` +
                  `\`bun run ${target}\` silently invokes it first.`);
  }
  console.error("  Rename the hook-shaped script (e.g. `prerelease` → `prerelease:publish`).");
  process.exit(1);
}

console.log(`script-name-hooks: ✓ ${scripts.length} root scripts, no lifecycle-hook collisions`);

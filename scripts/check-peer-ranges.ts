#!/usr/bin/env bun
/**
 * Peer-range bounds gate.
 *
 * Every `peerDependencies` range in every publishable package must have a FINITE
 * UPPER BOUND. An open range (`>=8.20.0`) silently accepts a future breaking major
 * the code has never seen, and the adopter learns about it as a bundler error in
 * their own build.
 *
 * That is not hypothetical. `@metaobjectsdev/tanstack` shipped `@tanstack/react-table:
 * ">=8.20.0"` while react-table's `latest` moved to **9.1.2** — a ground-up rewrite
 * that deleted `useReactTable` and `getCoreRowModel` from its main entry. Both are
 * imported by `entity-grid.tsx`, so a fresh `npm i @tanstack/react-table` produced a
 * package that could not be bundled at all, with no peer warning, because 9.1.2
 * satisfies `>=8.20.0`. An adopting project hit it in production and had to pin
 * `^8.21.3` by hand. `drizzle-orm: ">=0.36.0"` was the same trap one release from
 * springing: `1.0.0-rc.4` is already published.
 *
 * The test is the definition: a range is unbounded exactly when it accepts a version
 * larger than anything that will ever exist.
 *
 * Why nothing else can catch this: a peer RANGE is only exercised when a fresh
 * resolver walks the registry. This workspace pins its devDependencies and freezes
 * them in `bun.lock`, so every test, typecheck and golden gate runs against the
 * version we chose — never the version an adopter would get. This check works because
 * it reads MANIFESTS, not `node_modules`, so it needs no network and cannot be fooled
 * by a warm lockfile.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const ROOTS = ["server/typescript/packages", "client/web/packages"];

/** A version no real release will reach. If the range still matches, it has no ceiling. */
const BEYOND_ANY_REAL_VERSION = "9999.0.0";

interface Violation { pkg: string; peer: string; range: string }
const violations: Violation[] = [];
let checked = 0;

for (const root of ROOTS) {
  for (const dir of readdirSync(join(REPO, root))) {
    const manifest = join(REPO, root, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      name: string; private?: boolean; peerDependencies?: Record<string, string>;
    };
    if (pkg.private === true) continue;   // never published — its peers bind nobody
    for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
      checked++;
      if (Bun.semver.satisfies(BEYOND_ANY_REAL_VERSION, range)) {
        violations.push({ pkg: pkg.name, peer, range });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("✖ unbounded peer ranges — each accepts any future major:\n");
  for (const v of violations) {
    console.error(`    ${v.pkg}\n      "${v.peer}": "${v.range}"`);
  }
  console.error(
    `\nGive each an upper bound at the next major you have NOT validated —` +
    `\n  "^8.20.0"  or  ">=0.36.0 <1.0.0"` +
    `\nA bound turns "the adopter's build mysteriously breaks" into a resolution` +
    `\nerror at install time, naming the conflict. Raising a bound is a deliberate` +
    `\nact: test against the new major first, then widen it.\n`,
  );
  process.exit(1);
}

console.log(`peer-range bounds: OK (${checked} peer ranges, all bounded)`);

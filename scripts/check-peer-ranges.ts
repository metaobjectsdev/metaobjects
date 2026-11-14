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
 *
 * Second rule, same walk: no publishable package may REQUIRE an install-time package
 * that nothing uses at run time, through any field npm installs by default —
 * `dependencies`, `optionalDependencies` (npm skips those only when the install fails)
 * or a non-optional peer (npm installs required peers automatically) — so one
 * declaration lands it in every `@metaobjectsdev/cli` install:
 *
 *   - the native Biome formatter (`@biomejs/biome`, which pulls a ~94 MB per-platform
 *     `@biomejs/cli-*` binary). Codegen formats through the WebAssembly build
 *     (`@biomejs/wasm-nodejs` + `@biomejs/js-api`, see `codegen-ts/src/format.ts`).
 *   - `dprint-node` (~25 MB: all seven platform binaries in one package) and `ts-poet`,
 *     which `require`s it on load. codegen-ts vendors the printer (`codegen-ts/src/poet.ts`)
 *     and runs dprint as WebAssembly (`@dprint/typescript`).
 *   - any `@types/*` package. Type definitions do nothing at run time; one belongs in
 *     `dependencies` only when a published `.d.ts` imports it, so a consumer's compile
 *     needs it — and then it goes in `ALLOWED_TYPES_DEPS` below, with that reason.
 *
 * Development use belongs in `devDependencies`; a genuine run-time need for the first two
 * must be an optional peer (`peerDependenciesMeta`).
 */
import { join } from "node:path";
import { enumerateWorkspacePackages } from "./publish-set.mjs";

/** A version no real release will reach. If the range still matches, it has no ceiling. */
const BEYOND_ANY_REAL_VERSION = "9999.0.0";

/** Packages no publishable package may require at install time, with why. */
function installOnly(name: string): string | undefined {
  if (name === "@biomejs/biome" || name.startsWith("@biomejs/cli-")) {
    return "the native Biome formatter (~94 MB binary); codegen formats through @biomejs/wasm-nodejs";
  }
  if (name === "dprint-node" || name === "ts-poet") {
    return "dprint-node's seven native binaries (~25 MB; ts-poet requires it on load); codegen-ts vendors the printer and runs dprint as WebAssembly";
  }
  if (name.startsWith("@types/")) {
    return "type definitions, unused at run time; list it in ALLOWED_TYPES_DEPS only if a published .d.ts imports it";
  }
  return undefined;
}

/**
 * `@types/*` run-time dependencies that are deliberate: `"<package> <dep>"` → why a
 * consumer's compile needs it (a published `.d.ts` that imports it). Empty today.
 */
const ALLOWED_TYPES_DEPS: Record<string, string> = {};

interface Violation { pkg: string; peer: string; range: string }
export interface InstallOnlyDep { pkg: string; dep: string; field: string; why: string }

/**
 * The walk behind both rules, over the workspace at `repo`. Returns what the CLI
 * prints and its exit decision, so the gate's own test can drive the real check
 * against a synthetic workspace (production callers pass nothing but the repo root).
 */
export function peerRangeReport(repo: string): {
  peerRanges: number;
  unboundedPeers: Violation[];
  installOnlyDeps: InstallOnlyDep[];
} {
  const violations: Violation[] = [];
  const installOnlyDeps: InstallOnlyDep[] = [];
  let checked = 0;

  for (const { pkg: manifest } of enumerateWorkspacePackages(repo)) {
    const pkg = manifest as {
      name: string; private?: boolean;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    if (pkg.private === true) continue;   // never published — its peers bind nobody
    const installed = [
      ...Object.keys(pkg.dependencies ?? {}).map((dep) => ({ dep, field: "dependencies" })),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((dep) => ({ dep, field: "optionalDependencies" })),
      ...Object.keys(pkg.peerDependencies ?? {})
        .filter((dep) => pkg.peerDependenciesMeta?.[dep]?.optional !== true)
        .map((dep) => ({ dep, field: "peerDependencies (required)" })),
    ];
    for (const { dep, field } of installed) {
      const why = installOnly(dep);
      if (why === undefined || ALLOWED_TYPES_DEPS[`${pkg.name} ${dep}`] !== undefined) continue;
      installOnlyDeps.push({ pkg: pkg.name, dep, field, why });
    }
    for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
      checked++;
      if (Bun.semver.satisfies(BEYOND_ANY_REAL_VERSION, range)) {
        violations.push({ pkg: pkg.name, peer, range });
      }
    }
  }
  return { peerRanges: checked, unboundedPeers: violations, installOnlyDeps };
}

if (import.meta.main) {
  const { peerRanges, unboundedPeers, installOnlyDeps } = peerRangeReport(join(import.meta.dir, ".."));

  if (unboundedPeers.length > 0) {
    console.error("✖ unbounded peer ranges — each accepts any future major:\n");
    for (const v of unboundedPeers) {
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

  if (installOnlyDeps.length > 0) {
    console.error("✖ a package nothing uses at run time is required at install time:\n");
    for (const v of installOnlyDeps) console.error(`    ${v.pkg}\n      ${v.field}: "${v.dep}" — ${v.why}`);
    console.error(
      `\nnpm installs it into every adopter's tree. Move it to devDependencies, or, if shipped` +
      `\ncode really needs it, mark the peer optional in peerDependenciesMeta (an @types/*` +
      `\npackage a published .d.ts imports goes in ALLOWED_TYPES_DEPS instead).\n`,
    );
    process.exit(1);
  }

  console.log(`peer-range bounds: OK (${peerRanges} peer ranges, all bounded)`);
}

// What a catalog entry costs to install — the one derivation behind both
// `meta gen --list --format json` and `meta eject --format json`.
//
// Two kinds of package, resolved two different ways:
//
//   dev      the `@metaobjectsdev/codegen-*` package the generator lives in. Its range
//            is the CLI's own version: the engine and the CLI ship in lockstep, so a
//            generator from a different minor is a version mismatch, not a choice.
//   runtime  the `@metaobjectsdev` runtime the EMITTED code imports, plus the
//            third-party packages it imports. The runtime's range is the CLI's version
//            for the same reason; the third-party RANGES are read from that runtime
//            package's own `peerDependencies` and are never written here.
//
// That last rule is the point of this module. A second copy of a peer range in the CLI
// is a second thing to keep in step, and the failure mode of drift is an adopter
// installing a major nothing was tested against — the ERESOLVE trap FR-040 §4.4
// documented, closed by construction rather than by a warning. If a range cannot be
// read, the package is reported WITHOUT one rather than guessed at.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GeneratorRegistryEntry } from "@metaobjectsdev/codegen-ts";
import { cliVersion } from "./version.js";
import { packageOf } from "./catalog.js";
import type { PackageManifest } from "./package-manifest.js";

/**
 * A package's declared peer ranges, or `{}` if they cannot be read.
 *
 * Resolves the package's ENTRY and walks up to the nearest manifest, rather than asking
 * for `"<pkg>/package.json"` directly. The direct form is the obvious one and it is
 * WRONG: a package's `exports` map gates every subpath, and `@metaobjectsdev/runtime-ts`
 * exports `.` / `./drivers` / `./fastify` / `./drizzle-fastify` / `./hono` and no
 * `./package.json`, so under real Node it throws ERR_PACKAGE_PATH_NOT_EXPORTED. It
 * appeared to work in-repo only because bun resolves a symlinked source tree; against
 * the published package it failed silently on the first try. Resolving the entry is
 * never gated — `.` is the one subpath every package exports.
 */
export function peerRangesOf(packageName: string): Record<string, string> {
  try {
    const req = createRequire(import.meta.url);
    let dir = dirname(req.resolve(packageName));
    // The entry sits under dist/; the manifest is at the package root above it.
    for (let hops = 0; hops < 8; hops++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const manifest = JSON.parse(readFileSync(candidate, "utf8")) as PackageManifest & {
          name?: string;
        };
        // Guard against stopping at a nested manifest that is not the package itself.
        if (manifest.name === packageName) {
          return (manifest.peerDependencies ?? {}) as Record<string, string>;
        }
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return {};
  } catch {
    return {};
  }
}

export interface InstallSet {
  /** Build-time packages, `name@range`. */
  dev: string[];
  /** Application-runtime packages, `name@range` (or bare `name` if no range is known). */
  runtime: string[];
  /** A paste-ready shell line, or "" when there is nothing to install. */
  command: string;
}

function spec(name: string, range: string | undefined): string {
  return range === undefined ? name : `${name}@${range}`;
}

/**
 * Record `name` at `range`, keyed by PACKAGE rather than by spec. A known range replaces
 * an unknown one: `queries` names `drizzle-orm` unpinned (it has no runtime package to
 * read a range from) while `entity` names it with the range `runtime-ts` declares, and
 * keying by spec put both in the set, so an adopter saw the package twice.
 *
 * Two DIFFERENT known ranges for one package keep the first recorded. That cannot happen
 * today (every third-party range is read from `runtime-ts`, and the ranges declared in
 * both `react` and `tanstack` are identical); if it ever can, it needs a diagnostic here.
 */
function addPackage(into: Map<string, string | undefined>, name: string, range: string | undefined): void {
  if (into.get(name) === undefined) into.set(name, range);
}

/** A spec as one shell word. A peer range carries `>=`, `<` and a space, and unquoted
 *  those are a redirect and a word break — the pasted line exits 1 and leaves a file
 *  named `=0.36.0` behind. Single quotes are safe here: no spec contains one. */
function shellWord(s: string): string {
  return /^[\w@/.^~:+-]+$/.test(s) ? s : `'${s}'`;
}

function specs(from: Map<string, string | undefined>): string[] {
  return [...from].map(([name, range]) => spec(name, range)).sort();
}

/**
 * The consolidated install set for a group of catalog entries.
 *
 * Consolidated, not per-entry: ejecting `hooks` and `grid` needs
 * `@metaobjectsdev/codegen-ts-tanstack` ONCE, and an adopter handed the same package
 * twice reasonably wonders which one to run.
 */
export function installSetFor(entries: readonly GeneratorRegistryEntry[]): InstallSet {
  const version = cliVersion();
  const dev = new Map<string, string | undefined>();
  const runtime = new Map<string, string | undefined>();

  for (const entry of entries) {
    const pkg = packageOf(entry.name);
    if (pkg !== undefined) addPackage(dev, pkg, `^${version}`);

    for (const rt of entry.runtimePackages ?? []) addPackage(runtime, rt, `^${version}`);

    if (entry.runtimePeers !== undefined && entry.runtimePeers.length > 0) {
      // Ranges come from whichever runtime package declares these as peers — the union
      // over this generator's runtimes, since a generator emitting against two of them
      // may take a peer from either. A generator with third-party peers but no runtime
      // package of its own has none to read, so its peers are named UNPINNED: honest,
      // and better than a made-up bound.
      const ranges: Record<string, string> = {};
      for (const rt of entry.runtimePackages ?? []) Object.assign(ranges, peerRangesOf(rt));
      for (const peer of entry.runtimePeers) addPackage(runtime, peer, ranges[peer]);
    }
  }

  const devList = specs(dev);
  const runtimeList = specs(runtime);
  const parts: string[] = [];
  if (devList.length > 0) parts.push(`npm i -D ${devList.map(shellWord).join(" ")}`);
  if (runtimeList.length > 0) parts.push(`npm i ${runtimeList.map(shellWord).join(" ")}`);

  return { dev: devList, runtime: runtimeList, command: parts.join(" && ") };
}

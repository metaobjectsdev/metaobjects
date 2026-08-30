// One answer to "what does this project declare as a dependency".
//
// Three commands ask it — `meta init` (is this package already declared, or must the
// scaffold add it?), `meta eject` (will the ejected file's imports resolve, or does the
// adopter's tsc report TS2307?), and stack detection (which frameworks is this project
// on?). They had three hand-rolled JSON-parse-and-union blocks covering DIFFERENT field
// sets, and the asymmetry was the cost: `eject` reported a peer-declared package as
// missing and told the adopter to install what they already had — advice that, followed,
// adds a second physical copy of a package whose class identity is load-bearing (the
// ts-poet split in 0.21.6 and the metadata node-guard split are both that bug).
//
// A fix to one had no way to find the other two: nothing referenced anything, and no
// shared name connected them to a grep.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The dependency-bearing fields of a package.json, all optional. */
export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Every package name the manifest declares, across ALL FOUR dependency fields.
 *
 * All four, because the question every caller is really asking is "will this resolve,
 * and will their typecheck be happy" — not "is it in one particular field". A library
 * consuming MetaObjects through `peerDependencies` (the correct declaration for a
 * package whose consumer supplies the version) has it declared, and so does one using
 * `optionalDependencies`.
 */
export function declaredDependencyNames(pkg: PackageManifest): Set<string> {
  const out = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const name of Object.keys(pkg[field] ?? {})) out.add(name);
  }
  return out;
}

/**
 * Read and parse `<cwd>/package.json`.
 *
 * `undefined` distinguishes "no readable manifest" from "a manifest declaring nothing",
 * which callers report differently: with no manifest there is nothing to compare
 * against, so the honest message names what a file needs rather than claiming it is
 * missing from a list that was never read.
 */
export function readPackageManifest(cwd: string): PackageManifest | undefined {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

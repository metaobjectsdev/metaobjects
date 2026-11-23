// Where this repo keeps OWNED copies of the reference generators, and what each should hold.
//
// ONE definition, read by the sync script that writes the copies and by the test that gates
// them (cli/test/owned-copies-current.test.ts), so the fix and the gate cannot disagree about
// what "current" is. A tier is a directory of owned generators and the `templates/` directory
// beside it, which is where the generators' `../templates/` specifiers resolve to
// (ADR-0034 Amendment 8).
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { REFERENCE_GENERATOR_NAMES as CORE_NAMES } from "@metaobjectsdev/codegen-ts";
import { REFERENCE_GENERATOR_NAMES as REACT_NAMES } from "@metaobjectsdev/codegen-ts-react";
import { REFERENCE_GENERATOR_NAMES as TANSTACK_NAMES } from "@metaobjectsdev/codegen-ts-tanstack";
import { closureOf, OWNED_TEMPLATES_DIR } from "../../src/lib/template-eject.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");

/** One place that owns generators, and the directory its template modules go in. */
interface OwnedTier {
  generators: string;
  templates: string;
}

const names = new Set<string>([...CORE_NAMES, ...REACT_NAMES, ...TANSTACK_NAMES]);

/** Same discovery the gate uses — a new owned copy is covered the moment it lands. */
export function ownedTiers(repo: string = REPO_ROOT): OwnedTier[] {
  const tiers: OwnedTier[] = [];
  const examples = join(repo, "examples");
  if (existsSync(examples)) {
    for (const e of readdirSync(examples, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const generators = join(examples, e.name, "codegen", "generators");
      if (!existsSync(generators)) continue;
      // A directory of BESPOKE generators — an example's own, written from scratch rather
      // than ejected (e.g. tasks-axi-rust's rust-cli.ts) — owns no reference copy, so it is
      // not a tier: the gate demands each tier hold at least one eject, and the sync script
      // never introduces one ("which copies an example owns is that example's decision").
      // It is a tier exactly when it already holds a file a reference generator is named for.
      const holdsOwnedCopy = readdirSync(generators).some(
        (f) => f.endsWith(".ts") && names.has(f.slice(0, -3)),
      );
      if (holdsOwnedCopy) tiers.push({ generators, templates: join(examples, e.name, "codegen", "templates") });
    }
  }
  return tiers;
}

export function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".ts"))
    .map((f) => join(f.parentPath, f.name))
    .sort();
}

/** What a tier should hold: the owned generators, and the union of the modules they call. */
export function expectedFor(tier: OwnedTier): { generators: Map<string, string>; templates: Map<string, string> } {
  const generators = new Map<string, string>();
  const templates = new Map<string, string>();
  for (const file of existsSync(tier.generators) ? readdirSync(tier.generators) : []) {
    if (!file.endsWith(".ts")) continue;
    const name = file.slice(0, -3);
    if (!names.has(name)) continue;
    const closure = closureOf(name);
    generators.set(join(tier.generators, file), closure.generator.content);
    for (const t of closure.templates) {
      templates.set(join(tier.templates, t.path.slice(`${OWNED_TEMPLATES_DIR}/`.length)), t.content);
    }
  }
  return { generators, templates };
}


// Every OWNED copy of a reference template in this repo must BE the shipped template.
//
// `meta init` / `meta eject` hand an adopter `codegen-ts/src/reference/<name>.ts`. This repo
// now carries owned copies of its own — this package's `src/`, and one set per example under
// `examples/*/codegen/generators/` — because 1.0 removed the four ownable generators from
// `@metaobjectsdev/codegen-ts/generators`. If a copy drifts, the suites and examples keep
// passing while proving nothing about what an adopter runs. That is ADR-0034's byte-identity
// blindness one level out, so it gets the same treatment.
//
// The copy set is DISCOVERED, not listed: a new owned copy added anywhere this scans is
// guarded the moment it lands, and cannot be added unguarded by forgetting a line here.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { readReferenceTemplate, REFERENCE_GENERATOR_NAMES } from "@metaobjectsdev/codegen-ts";
import type { ReferenceGeneratorName } from "@metaobjectsdev/codegen-ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

function ownedCopyDirs(): string[] {
  const dirs = [resolve(import.meta.dir, "..", "src")];
  const examples = join(REPO_ROOT, "examples");
  if (existsSync(examples)) {
    for (const e of readdirSync(examples, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = join(examples, e.name, "codegen", "generators");
      if (existsSync(d)) dirs.push(d);
    }
  }
  return dirs;
}

const NAMES = new Set<string>(REFERENCE_GENERATOR_NAMES);

describe("owned reference-template copies are byte-identical to the shipped templates", () => {
  const dirs = ownedCopyDirs();

  test("the scan finds this package's copies AND at least one example's", () => {
    // A scan that silently found nothing would pass every assertion below.
    expect(dirs.length).toBeGreaterThanOrEqual(2);
  });

  for (const dir of dirs) {
    const copies = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && NAMES.has(f.slice(0, -3)));
    const where = relative(REPO_ROOT, dir);

    test(`${where} holds at least one owned copy`, () => {
      expect(copies.length).toBeGreaterThan(0);
    });

    for (const file of copies) {
      const name = file.slice(0, -3) as ReferenceGeneratorName;
      test(`${where}/${file}`, () => {
        expect(readFileSync(join(dir, file), "utf8")).toBe(readReferenceTemplate(name));
      });
    }
  }
});

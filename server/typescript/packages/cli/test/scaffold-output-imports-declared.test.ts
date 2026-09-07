// Everything `meta gen` WRITES must be resolvable from what `meta init` DECLARED.
//
// It was not. A brand-new project — `npm init -y`, install the CLI, `meta init`,
// `meta gen`, then `npx tsc`, which is the next step `meta gen` itself prints —
// reported NINE TS2307s under pnpm, on five specifiers the generated files import and
// no manifest declared: drizzle-orm, zod, fastify, `@metaobjectsdev/runtime-ts` and its
// `/drizzle-fastify` subpath. npm hides four of the five by hoisting them out of the
// CLI's own dependency tree; pnpm's strict layout shows all five, which is why the
// release smoke test runs both.
//
// `addScaffoldDevDependencies` had already fixed this defect ONE LAYER IN — the
// generator sources under `codegen/generators/` import `@metaobjectsdev/codegen-ts` and
// `@metaobjectsdev/metadata`, and its own docstring records the scaffold arriving
// un-typecheckable with ten TS2307s. The identical argument reaches the generated
// output and nobody followed it there.
//
// Why no existing test could see it: every test that runs `gen` scaffolds into
// `test/fixtures/__tmp__/`, deliberately, so that node resolution walks up into cli's
// OWN node_modules — where fastify, drizzle-orm and zod all sit as devDependencies.
// `mkGenProjectDir`'s comment says so outright. So the generated imports resolved in
// every test for a reason that has nothing to do with the adopter's manifest. This test
// runs in the same place and asks a different question: not "does it resolve here" but
// "did the scaffolder DECLARE it", which is answerable from the manifest alone and is
// exactly what a strict installer will enforce.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.js";
import { declaredDependencyNames, type PackageManifest } from "../src/lib/package-manifest.js";

const PROBE_ENTITY = JSON.stringify({
  metadata: {
    package: "probe",
    children: [{
      "object.entity": {
        name: "Author",
        children: [
          { "source.rdb": { "@table": "authors" } },
          { "field.string": { name: "id" } },
          { "field.string": { name: "penName", "@column": "pen_name" } },
          { "identity.primary": { "@fields": ["id"] } },
        ],
      },
    }],
  },
}, null, 2);

/** Bare package specifiers imported by a generated file — not relative, not `node:`.
 *  A subpath resolves to its package (`@scope/pkg/sub` -> `@scope/pkg`), which is what
 *  a manifest declares. */
function bareImports(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/g)) {
    const spec = m[1];
    if (spec === undefined || spec.startsWith(".") || spec.startsWith("node:")) continue;
    const parts = spec.split("/");
    found.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec));
  }
  return found;
}

/**
 * THE STARTING MANIFEST IS A DIMENSION, and leaving it fixed is what let this ship broken.
 *
 * The declarations were made inside the function that fixes the module system, BELOW its
 * early returns — so they happened only on the one path where `"type"` had to be changed.
 * A project that already said `"type": "module"` got no declarations and no warning, and
 * the guard's own comment read "nothing to do, nothing to say". That is the adopter who
 * set their project up correctly, and under a strict installer their first `tsc` reported
 * TS2307 on all five files `meta init` had just written.
 *
 * This test could not see it because it used exactly one shape — `npm init -y`'s
 * `"type": "commonjs"` — which is the path that worked. A cold adoption probe on
 * Kysely + Express + pnpm found it in about ten minutes, on rc.4, the day the fix shipped.
 */
const STARTING_MANIFESTS = [
  // The `npm init -y` shape, which is the documented first step.
  { label: 'type: "commonjs" (npm init -y)', type: "commonjs" as string | undefined },
  // Already ESM — needs NO module-system edit, and used to get no declarations either.
  { label: 'type: "module" (already ESM)', type: "module" as string | undefined },
  // Silent on the point.
  { label: "no type field", type: undefined },
];

describe("meta init declares what meta gen's output imports", () => {
  for (const manifest of STARTING_MANIFESTS) {
  test(`every bare specifier in the generated files is a declared dependency — ${manifest.label}`, async () => {
    // In-package, so `gen` can resolve the scaffolded generators' own imports.
    const root = join(import.meta.dirname, "fixtures", "__tmp__");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "scaffold-deps-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify(
          manifest.type === undefined
            ? { name: "probe", version: "1.0.0" }
            : { name: "probe", version: "1.0.0", type: manifest.type },
          null,
          2,
        )}\n`,
      );
      expect(await initCommand([], dir)).toBe(0);
      writeFileSync(join(dir, "metaobjects", "meta.common.json"), PROBE_ENTITY);
      const { genCommand } = await import("../src/commands/gen.js");
      expect(await genCommand([], dir)).toBe(0);

      const outDir = join(dir, "src", "generated");
      const emitted = readdirSync(outDir).filter((f) => f.endsWith(".ts"));
      expect(emitted.length).toBeGreaterThan(0);

      const declared = declaredDependencyNames(
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest,
      );
      const undeclared: string[] = [];
      for (const file of emitted) {
        for (const spec of bareImports(readFileSync(join(outDir, file), "utf8"))) {
          if (!declared.has(spec)) undeclared.push(`${file} imports ${spec}`);
        }
      }
      // Named individually: the failure an adopter sees is a list of TS2307s, and the
      // useful message here is the same list, before they ever run tsc.
      expect(undeclared).toEqual([]);

      // ...and the specifiers that caused this test to exist are really present in the
      // output, so a regression that stops EMITTING them cannot make it pass vacuously.
      const all = new Set(emitted.flatMap((f) => [...bareImports(readFileSync(join(outDir, f), "utf8"))]));
      for (const required of ["drizzle-orm", "zod", "fastify", "@metaobjectsdev/runtime-ts"]) {
        expect([...all]).toContain(required);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  }
});

// Everything `meta gen` WRITES must be resolvable from what the toolchain TOLD YOU to
// install.
//
// It was not. A brand-new project — `npm init -y`, install the CLI, `meta init`,
// `meta gen`, then `npx tsc`, which is the next step `meta gen` itself prints —
// reported NINE TS2307s under pnpm, on five specifiers the generated files import and
// no manifest declared: drizzle-orm, zod, fastify, `@metaobjectsdev/runtime-ts` and its
// `/drizzle-fastify` subpath. npm hides four of the five by hoisting them out of the
// CLI's own dependency tree; pnpm's strict layout shows all five, which is why the
// release smoke test runs both.
//
// **Who is asked has changed; the question has not.** `meta init` used to wire a suite
// and therefore had to declare that suite's dependencies. Codegen is opt-in now: init
// wires nothing, declares nothing, and generates nothing, so asking init the question
// would pass vacuously. The obligation MOVED to `meta eject`, which reports the install
// set for exactly the generators you took — so that is what this test now applies and
// then checks the generated output against.
//
// Why no ordinary `gen` test could see the original defect, and still cannot: every
// test that runs `gen` scaffolds into `test/fixtures/__tmp__/`, deliberately, so node
// resolution walks up into cli's OWN node_modules — where fastify, drizzle-orm and zod
// all sit as devDependencies. `mkGenProjectDir`'s comment says so outright. So the
// generated imports resolve in every test for a reason that has nothing to do with the
// adopter's manifest. This test runs in the same place and asks a different question:
// not "does it resolve here" but "was it DECLARED", which is answerable from the
// manifest alone and is exactly what a strict installer enforces.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.js";
import { ejectCommand } from "../src/commands/eject.js";
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

/** The selection this test adopts — the server-side shape `meta init` used to wire. */
const SELECTION = ["entity", "queries", "routes", "barrel"] as const;

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

/** `name@range` -> `[name, range]`, tolerating a scoped name's leading `@`. */
function splitSpec(spec: string): [string, string] {
  const at = spec.lastIndexOf("@");
  return at <= 0 ? [spec, "*"] : [spec.slice(0, at), spec.slice(at + 1)];
}

/** Apply an eject payload's install set to the project's package.json — what an adopter
 *  does when they run the printed `install.command`. */
function applyInstallSet(
  dir: string,
  install: { dev: string[]; runtime: string[] },
): void {
  const path = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  for (const spec of install.runtime) { const [n, r] = splitSpec(spec); deps[n] = r; }
  for (const spec of install.dev) { const [n, r] = splitSpec(spec); devDeps[n] = r; }
  pkg.dependencies = deps;
  pkg.devDependencies = devDeps;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * THE STARTING MANIFEST IS A DIMENSION, and leaving it fixed is what let this ship broken.
 *
 * The declarations used to be made inside the function that fixes the module system,
 * BELOW its early returns — so they happened only on the one path where `"type"` had to
 * be changed. A project that already said `"type": "module"` got no declarations and no
 * warning, and the guard's own comment read "nothing to do, nothing to say". That is the
 * adopter who set their project up correctly, and under a strict installer their first
 * `tsc` reported TS2307 on all five files `meta init` had just written.
 *
 * The old test could not see it because it used exactly one shape — `npm init -y`'s
 * `"type": "commonjs"` — which is the path that worked. A cold adoption probe on
 * Kysely + Express + pnpm found it in about ten minutes, on rc.4, the day the fix shipped.
 * The dimension is kept even though the install set no longer travels through that
 * function: the lesson is about fixing one shape, not about that one function.
 */
const STARTING_MANIFESTS = [
  // The `npm init -y` shape, which is the documented first step.
  { label: 'type: "commonjs" (npm init -y)', type: "commonjs" as string | undefined },
  // Already ESM — needs NO module-system edit, and used to get no declarations either.
  { label: 'type: "module" (already ESM)', type: "module" as string | undefined },
  // Silent on the point.
  { label: "no type field", type: undefined },
];

function scaffoldedConfig(): string {
  return [
    'import { defineConfig } from "@metaobjectsdev/cli";',
    'import { entityFile } from "./codegen/generators/entity.js";',
    'import { queriesFile } from "./codegen/generators/queries.js";',
    'import { routesFile } from "./codegen/generators/routes.js";',
    'import { barrel } from "./codegen/generators/barrel.js";',
    "export default defineConfig({",
    '  outDir: "src/generated",',
    '  dialect: "sqlite",',
    '  extStyle: "js",',
    '  dbImport: "../db",',
    "  generators: [entityFile(), queriesFile(), routesFile(), barrel()],",
    "});",
    "",
  ].join("\n");
}

describe("meta eject declares what meta gen's output imports", () => {
  for (const manifest of STARTING_MANIFESTS) {
  test(`every bare specifier in the generated files is a declared dependency — ${manifest.label}`, async () => {
    // In-package, so `gen` can resolve the ejected generators' own imports.
    const root = join(import.meta.dirname, "fixtures", "__tmp__");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "scaffold-deps-"));
    const origLog = console.log;
    const logged: string[] = [];
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

      // Take a selection, and do what its install set says.
      console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
      expect(await ejectCommand([...SELECTION], dir, "json")).toBe(0);
      console.log = origLog;
      const payload = JSON.parse(logged.join("\n")) as {
        install: { dev: string[]; runtime: string[] };
      };
      applyInstallSet(dir, payload.install);
      writeFileSync(join(dir, "metaobjects.config.ts"), scaffoldedConfig());

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
      console.log = origLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  }

  test("`meta init` alone declares NOTHING — it wires nothing, so it needs nothing", async () => {
    const root = join(import.meta.dirname, "fixtures", "__tmp__");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "scaffold-nodeps-"));
    try {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "probe", version: "1.0.0" }, null, 2)}\n`);
      expect(await initCommand([], dir)).toBe(0);
      const declared = declaredDependencyNames(
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest,
      );
      // The five init used to add. Declaring any of them now would be declaring a
      // dependency on code this project may never generate.
      for (const d of ["drizzle-orm", "zod", "fastify",
                       "@metaobjectsdev/codegen-ts", "@metaobjectsdev/metadata"]) {
        expect([...declared], `must not declare ${d}`).not.toContain(d);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

# Opt-in codegen and the generator catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** No code generator runs until the adopter chooses it, and the choice is made from a
truthful, machine-readable catalog rather than from a default suite the CLI picked.

**Architecture:** The catalog is the generator registry we already have, completed — `layer`
joins the cross-port manifest, the TypeScript entry type gains the facts a selection needs
(`framework`, `requires`, `runtimePeers`, `configKeys`, `kind`), the react and tanstack packages
export their own registry slices and the CLI unions them, and `meta gen --list --format json`
plus `--probe` is the agent-facing door. `meta init` shrinks to layout + an empty documented
selection; `meta eject` becomes the copy door and takes multiple names. Every declared
compatibility fact is **resolved, not trusted** — gates run the generators and read the
imports back.

**Tech Stack:** TypeScript (Bun workspace), C# (.NET tool), Python (console script), Java/Kotlin
(Maven; already correct — no default suite).

**Spec:** `docs/superpowers/specs/2026-09-12-opt-in-codegen-and-generator-catalog-design.md`

## Global Constraints

- **This ships as a PATCH.** `docs/compatibility-policy.md:53` is narrowed in the same change:
  the scaffold-and-own promise is the **layout and the interfaces**, not which generators a
  fresh scaffold wires.
- **`metamodelVersion` does not move.** `registry.json` is the *generator* manifest, a different
  contract from `expected-registry.json`. No metamodel vocabulary is added; ADR-0023 is not engaged.
- **`layer` has exactly SIX values** — `model`, `persistence`, `api`, `client`, `docs`,
  `capability`. Do not reintroduce `trace` / `requirements` / `publish` / `primitive`; they are
  `capability`, discriminated by `--probe` (spec §8b).
- **34 generator names total** — the 29 already in `fixtures/generator-registry-conformance/registry.json`
  plus `form`, `hooks`, `grid`, `grid-hook`, `requirement-tests`, all `ports: ["typescript"]`.
- **Named constants for metamodel strings.** Generator stable names are not metamodel strings, but
  `layer` values are a closed set — declare them `as const` with a derived union type.
- **No `any`.** Use `unknown` and narrow.
- **Never a bare `bun test` at the repo root.** `cd server/typescript && bun test <path>`.
- **`scripts/ci-local.sh` prints "LOCAL CI FAILED" and still returns 0.** Grep the `SUMMARY`
  block; never branch on `$?`.
- **Agent-context prose changes need the corpus regenerated in the SAME commit** or `ts-unit`
  goes red. Read back the **python** fixture — it is the only port-only stack.
- **The repo is PUBLIC.** No private project names, no absolute home paths, in code, docs,
  fixtures, commit messages or branch names.

---

## File structure

| file | responsibility |
|---|---|
| `fixtures/generator-registry-conformance/registry.json` | cross-port truth: 34 names, `tier`, **`layer`**, `ports` |
| `server/typescript/packages/codegen-ts/src/generator-registry.ts` | the codegen-ts **slice** + the shared `GeneratorRegistryEntry` type and `Layer` union |
| `server/typescript/packages/codegen-ts-react/src/generator-registry.ts` | the react slice (`form`) |
| `server/typescript/packages/codegen-ts-tanstack/src/generator-registry.ts` | the tanstack slice (`hooks`, `grid`, `grid-hook`) |
| `server/typescript/packages/cli/src/lib/catalog.ts` | **new** — composes the three slices; the one place the TS port's full catalog exists |
| `server/typescript/packages/cli/src/commands/gen.ts` | `--list --format`, `--probe`, `project.*`, first-run pointer |
| `server/typescript/packages/cli/src/commands/eject.ts` | multi-name, `--format json`, consolidated install set |
| `server/typescript/packages/cli/src/commands/init.ts` | net shrink: no scaffolded generators, no db stub, no scaffold deps |
| `server/typescript/packages/codegen-ts/src/runner.ts` | the `requires` gate + the `api`-layer framework advisory |
| `server/csharp/MetaObjects.Cli/GenCommand.cs` | default suite removed; `--generators` required |
| `server/python/src/metaobjects/cli.py` | `_default_generators` removed; `--generators` required |

---

## Task 1: `layer` joins the cross-port manifest

**Files:**
- Modify: `fixtures/generator-registry-conformance/registry.json`
- Modify: `fixtures/generator-registry-conformance/README.md`
- Test: `server/typescript/packages/codegen-ts/test/golden/generator-registry-conformance.test.ts`

**Interfaces:**
- Produces: every manifest entry carries `"layer": "<one of the six>"`. The five new entries
  (`form`, `hooks`, `grid`, `grid-hook`, `requirement-tests`) exist with `ports: ["typescript"]`.

The assignment, verbatim from spec §8b — do not improvise:

| layer | members |
|---|---|
| `model` | entity, names, barrel, dto, value-object |
| `persistence` | queries, db-context, repository, exposed-table, relations, stored-proc |
| `api` | routes, routes-hono, filter-allowlist, validator, spring-config |
| `client` | form, hooks, grid, grid-hook |
| `docs` | docs, mermaid-er, api-docs |
| `capability` | prompt-render, output-parser, output-prompt, extractor, render-helper, payload, trace-helper, requirement-tests, shared-model, template, callable |

- [ ] **Step 1: Write the failing test** — extend the TS conformance test with a layer block.

```ts
const LAYERS = ["model", "persistence", "api", "client", "docs", "capability"] as const;

it("every manifest entry declares one of the six layers", () => {
  const bad = Object.entries(manifest.generators)
    .filter(([, e]) => !LAYERS.includes(e.layer as (typeof LAYERS)[number]))
    .map(([n, e]) => `${n}=${String(e.layer)}`);
  expect(bad, `entries with a missing/unknown layer: ${bad.join(", ")}`).toEqual([]);
});
```

Also widen `interface ManifestEntry` with `layer: string;`.

- [ ] **Step 2: Run it and watch it fail**

`cd server/typescript && bun test packages/codegen-ts/test/golden/generator-registry-conformance.test.ts`
Expected: FAIL — every entry reports `=undefined`.

- [ ] **Step 3: Add `layer` to all 29 manifest entries and add the five new ones**

Each new entry follows the existing shape, e.g.:

```json
"form": {
  "concept": "Per-entity React form component over the generated Zod schema.",
  "tier": "native",
  "layer": "client",
  "ports": ["typescript"]
},
"requirement-tests": {
  "concept": "Per-requirement test stub, one per requirement.functional claim.",
  "tier": "native",
  "layer": "capability",
  "ports": ["typescript"]
}
```

Update the `$comment` to name `layer` as a gated facet, and update
`fixtures/generator-registry-conformance/README.md` to document the six values and the
"a layer with one member does no grouping work" rationale.

- [ ] **Step 4: Run it and watch it pass** (the set-equality assertion will still fail — the TS
      registry does not yet expose the five new names. That is Task 2/3's job; leave it red and
      note it, or land Tasks 1-3 as one commit. **Land them as one commit** — a red conformance
      gate must never sit on `main`.)

- [ ] **Step 5: Do not commit yet.** Continue into Task 2.

---

## Task 2: the registry entry type gains the facts a selection needs

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generator-registry.ts`
- Modify: `server/typescript/packages/codegen-ts/src/index.ts` (export the new types)
- Test: `server/typescript/packages/codegen-ts/test/generator-registry.test.ts`

**Interfaces:**
- Produces:

```ts
export const GENERATOR_LAYERS = ["model", "persistence", "api", "client", "docs", "capability"] as const;
export type Layer = (typeof GENERATOR_LAYERS)[number];

export type GeneratorFramework = "fastify" | "hono" | "react" | "tanstack";

export interface GeneratorRegistryEntry {
  name: string;
  /** Forward compatibility (spec §9 / FR-043): today every entry is "generator". */
  kind: "generator";
  layer: Layer;
  tier: GeneratorTier;
  description: string;
  factory: () => Generator;
  options?: string;
  /** Absent = framework-neutral. */
  framework?: GeneratorFramework;
  /** Stable names whose output this generator's output imports. */
  requires?: readonly string[];
  /** The @metaobjectsdev runtime the EMITTED code imports. */
  runtimePackage?: string;
  /** Third-party packages the EMITTED code imports. Ranges come from the runtime
   *  package's own peerDependencies, never from here. */
  runtimePeers?: readonly string[];
  /** Config keys this generator reads: dbImport, apiPrefix, extStyle, … */
  configKeys?: readonly string[];
  /** True iff a reference template exists for `meta eject`. */
  ejectable: boolean;
  note?: string;
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { generatorRegistry, GENERATOR_LAYERS } from "../src/generator-registry.js";

it("every entry declares kind, layer and ejectable", () => {
  for (const [name, e] of Object.entries(generatorRegistry)) {
    expect(e.kind, name).toBe("generator");
    expect(GENERATOR_LAYERS, name).toContain(e.layer);
    expect(typeof e.ejectable, name).toBe("boolean");
  }
});

it("requires only names entries that exist in some slice", () => {
  // codegen-ts's slice is self-contained: no entry here requires a react/tanstack name.
  for (const [name, e] of Object.entries(generatorRegistry)) {
    for (const dep of e.requires ?? []) {
      expect(Object.keys(generatorRegistry), `${name} requires ${dep}`).toContain(dep);
    }
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd server/typescript && bun test packages/codegen-ts/test/generator-registry.test.ts`
Expected: FAIL — `kind` undefined.

- [ ] **Step 3: Extend the type and populate every codegen-ts entry**

Add `requirement-tests` to the registry (importing `requirementTests` from
`./generators/requirement-tests.js`; its factory is `() => requirementTests()`).

`ejectable` is `true` exactly for the names in `REFERENCE_GENERATOR_NAMES` — assert that
rather than hand-maintaining it:

```ts
import { REFERENCE_GENERATOR_NAMES } from "./reference-templates.js";
// … in each entry: ejectable: REFERENCE_GENERATOR_NAMES.includes(name as ReferenceGeneratorName)
```

Leave `requires` / `runtimePeers` **empty for now** — Task 9's gates derive the truth and this
plan populates them there. Declaring a guess first and gating it second is the failure mode this
design exists to prevent.

- [ ] **Step 4: Run it and watch it pass**

- [ ] **Step 5: Do not commit yet.** Continue into Task 3.

---

## Task 3: registry slices in react + tanstack, composed in the CLI

**Files:**
- Create: `server/typescript/packages/codegen-ts-react/src/generator-registry.ts`
- Create: `server/typescript/packages/codegen-ts-tanstack/src/generator-registry.ts`
- Modify: both packages' `src/index.ts`
- Create: `server/typescript/packages/cli/src/lib/catalog.ts`
- Create: `server/typescript/packages/cli/test/catalog-conformance.test.ts`
- Modify: `server/typescript/packages/codegen-ts/test/golden/generator-registry-conformance.test.ts`
  (narrow to one direction — see below)

**Interfaces:**
- Consumes: `GeneratorRegistryEntry`, `Layer` from `@metaobjectsdev/codegen-ts` (Task 2).
- Produces:
  - `export const reactGeneratorRegistry: Record<string, GeneratorRegistryEntry>` (`form`)
  - `export const tanstackGeneratorRegistry: Record<string, GeneratorRegistryEntry>`
    (`hooks`, `grid`, `grid-hook`)
  - `export function composeCatalog(): Record<string, GeneratorRegistryEntry>` in
    `cli/src/lib/catalog.ts`, plus `export function listCatalog(): GeneratorRegistryEntry[]`
    sorted by layer (in `GENERATOR_LAYERS` order) then name.

Why the conformance test moves: `codegen-ts` cannot import `codegen-ts-react` (dependency
direction), so its own registry is a **slice** and can only be checked one way — every name it
exposes is in the manifest with `typescript` in `ports`. Set equality is a property of the
**composed** catalog, so it is asserted in the CLI, which is the only package that can see all
three.

- [ ] **Step 1: Write the failing CLI conformance test**

```ts
// server/typescript/packages/cli/test/catalog-conformance.test.ts
import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeCatalog } from "../src/lib/catalog.js";

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate repo root");
    dir = parent;
  }
}

const manifest = JSON.parse(readFileSync(
  join(findRepoRoot(import.meta.dir), "fixtures/generator-registry-conformance/registry.json"),
  "utf-8",
)) as { generators: Record<string, { tier: string; layer: string; ports: string[] }> };

describe("composed TS catalog == the manifest's typescript slice", () => {
  const expected = new Set(Object.entries(manifest.generators)
    .filter(([, e]) => e.ports.includes("typescript")).map(([n]) => n));
  const actual = new Set(Object.keys(composeCatalog()));

  it("no rogue, no missing", () => {
    expect({
      extra: [...actual].filter((n) => !expected.has(n)).sort(),
      missing: [...expected].filter((n) => !actual.has(n)).sort(),
    }).toEqual({ extra: [], missing: [] });
  });

  it("layer and tier agree with the manifest", () => {
    const catalog = composeCatalog();
    for (const name of expected) {
      expect(catalog[name]!.layer, name).toBe(manifest.generators[name]!.layer);
      expect(catalog[name]!.tier, name).toBe(manifest.generators[name]!.tier);
    }
  });

  it("no name is registered by two slices", () => {
    // composeCatalog throws on a duplicate; this pins the behaviour.
    expect(() => composeCatalog()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd server/typescript && bun test packages/cli/test/catalog-conformance.test.ts`
Expected: FAIL — `../src/lib/catalog.js` does not exist.

- [ ] **Step 3: Write the two slices and the composer**

The react slice:

```ts
// server/typescript/packages/codegen-ts-react/src/generator-registry.ts
import type { GeneratorRegistryEntry } from "@metaobjectsdev/codegen-ts";
import { formFile } from "./form-file.js";
import { REFERENCE_GENERATOR_NAMES } from "./reference-templates.js";

export const reactGeneratorRegistry: Record<string, GeneratorRegistryEntry> = {
  form: {
    name: "form",
    kind: "generator",
    layer: "client",
    tier: "native",
    framework: "react",
    description: "Per-entity React form component over the generated Zod schema.",
    factory: () => formFile(),
    options: "filter?, target?",
    ejectable: REFERENCE_GENERATOR_NAMES.includes("form"),
  },
};
```

The tanstack slice mirrors it with `hooks` → `tanstackQuery()`, `grid` → `tanstackGrid()`,
`grid-hook` → `tanstackGridHook()`, all `framework: "tanstack"`, `layer: "client"`.

The composer:

```ts
// server/typescript/packages/cli/src/lib/catalog.ts
import { generatorRegistry, GENERATOR_LAYERS, type GeneratorRegistryEntry } from "@metaobjectsdev/codegen-ts";
import { reactGeneratorRegistry } from "@metaobjectsdev/codegen-ts-react";
import { tanstackGeneratorRegistry } from "@metaobjectsdev/codegen-ts-tanstack";

const SLICES: ReadonlyArray<readonly [string, Record<string, GeneratorRegistryEntry>]> = [
  ["@metaobjectsdev/codegen-ts", generatorRegistry],
  ["@metaobjectsdev/codegen-ts-react", reactGeneratorRegistry],
  ["@metaobjectsdev/codegen-ts-tanstack", tanstackGeneratorRegistry],
];

/** Which package a catalog entry came from — the install boundary, and the only
 *  fact composition adds that a slice cannot know about itself. */
export function packageOf(name: string): string | undefined {
  return SLICES.find(([, slice]) => name in slice)?.[0];
}

export function composeCatalog(): Record<string, GeneratorRegistryEntry> {
  const out: Record<string, GeneratorRegistryEntry> = {};
  for (const [pkg, slice] of SLICES) {
    for (const [name, entry] of Object.entries(slice)) {
      const prior = packageOf(name);
      if (name in out) {
        throw new Error(
          `generator "${name}" is registered by both ${prior} and ${pkg} — a stable name ` +
          "identifies ONE generator across the whole catalog (ADR-0021 D3).",
        );
      }
      out[name] = entry;
    }
  }
  return out;
}

export function listCatalog(): GeneratorRegistryEntry[] {
  return Object.values(composeCatalog()).sort((a, b) =>
    GENERATOR_LAYERS.indexOf(a.layer) - GENERATOR_LAYERS.indexOf(b.layer) ||
    a.name.localeCompare(b.name));
}
```

Note the composer must not call `packageOf` for the duplicate message before inserting — read
the prior package from the already-built `out` instead by tracking a parallel `Record<string,
string>`; fix the sketch above accordingly when implementing (the message must name both
packages).

Add `@metaobjectsdev/codegen-ts-react` and `-tanstack` to the CLI's `dependencies` if not
already there (they are — `eject.ts` imports both).

- [ ] **Step 4: Narrow the codegen-ts conformance test to one direction**

Replace the set-equality assertion with:

```ts
it("every name codegen-ts registers is a typescript name in the manifest", () => {
  const rogue = [...actualNames].filter((n) => !expectedNames.has(n)).sort();
  expect(rogue, `codegen-ts registers names the manifest does not give to typescript: ${rogue.join(", ")}`).toEqual([]);
});
```

…and add a comment saying the other direction is asserted on the COMPOSED catalog in
`packages/cli/test/catalog-conformance.test.ts`, because codegen-ts is a slice.

- [ ] **Step 5: Run both**

```
cd server/typescript && bun test packages/codegen-ts/test/generator-registry.test.ts \
  packages/codegen-ts/test/golden/generator-registry-conformance.test.ts \
  packages/cli/test/catalog-conformance.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit Tasks 1-3 together**

```bash
git add fixtures/generator-registry-conformance server/typescript/packages/codegen-ts \
  server/typescript/packages/codegen-ts-react server/typescript/packages/codegen-ts-tanstack \
  server/typescript/packages/cli
git commit -m "feat(catalog): layer joins the generator manifest, and the catalog is composed across packages"
```

---

## Task 4: `layer` reaches the other four ports

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/GeneratorRegistry.cs` (or wherever the entry record lives) + `server/csharp/MetaObjects.Codegen.Tests/GeneratorRegistryConformanceTests.cs`
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/GeneratorRegistry.java` + `.../GeneratorRegistryConformanceTest.java`
- Modify: `server/java/codegen-kotlin/.../GeneratorRegistryConformanceTest.kt` (+ the Kotlin registry)
- Modify: `server/python/src/metaobjects/codegen/generator_registry.py` + `server/python/tests/conformance/test_generator_registry_conformance.py`

**Interfaces:**
- Consumes: the manifest's `layer` field (Task 1).
- Produces: each port's registry entry carries a `layer`, and each port's conformance test
  asserts agreement with the manifest, exactly as it already asserts `tier`.

- [ ] **Step 1: Read each port's registry + conformance test before editing.** They are not
      identically shaped; the assertion to copy is the existing `tier` agreement block.

- [ ] **Step 2: Add the failing layer-agreement assertion in each port**, mirroring that block.

- [ ] **Step 3: Run each port's test and watch it fail.**

```
cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter GeneratorRegistryConformance
cd server/java && mvn -q -pl codegen-spring test -Dtest=GeneratorRegistryConformanceTest
cd server/java && mvn -q -pl codegen-kotlin test -Dtest=GeneratorRegistryConformanceTest
cd server/python && uv run --extra integration pytest tests/conformance/test_generator_registry_conformance.py
```

**Trap:** `dotnet test` prints `Passed!` for a project that did not compile. Count the result
lines, do not read the last one.

- [ ] **Step 4: Add `layer` to each port's registry entries** using the Task 1 table.

- [ ] **Step 5: Re-run all four; all green.**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(catalog): layer is gated in all five ports"
```

---

## Task 5: `meta gen --list --format json|toon` and `--probe`

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts` (`GEN_OPTIONS` gains `probe`)
- Modify: `server/typescript/packages/cli/src/commands/gen.ts`
- Create: `server/typescript/packages/cli/src/lib/catalog-listing.ts`
- Create: `server/typescript/packages/cli/test/gen-list-catalog.test.ts`

**Interfaces:**
- Consumes: `listCatalog()`, `packageOf()` (Task 3).
- Produces: `buildCatalogListing(opts): CatalogRow[]` where

```ts
export interface CatalogRow {
  name: string;
  kind: "generator";
  layer: Layer;
  framework?: string;
  tier: "native" | "neutral";
  package: string;
  description: string;
  useWhen?: string;
  emits?: string;
  requires?: readonly string[];
  configKeys?: readonly string[];
  install?: { dev: string[]; runtime: string[] };
  source: { kind: "reference-template" | "package-only"; ejectable: boolean; owned: boolean | null };
  project?: { wired: boolean; frameworkDetected: boolean | null; wouldEmit: number | null };
}
```

`--list` with no project loads nothing (like `meta types`). `--probe` requires a project: it
resolves the collection + config, loads the model, constructs **every** catalog generator and
dry-runs it in memory, and reports the file count per generator.

- [ ] **Step 1: Write the failing tests**

```ts
it("--list --format json emits one document, every row layered", async () => {
  const out = await captureStdout(() => genCommand(["--list"], tmpdir, "json"));
  const rows = JSON.parse(out) as CatalogRow[];
  expect(rows.length).toBe(23); // the manifest's typescript slice
  for (const r of rows) {
    expect(GENERATOR_LAYERS).toContain(r.layer);
    expect(r.kind).toBe("generator");
    expect(r.package).toMatch(/^@metaobjectsdev\//);
  }
});

it("--list needs no project at all", async () => {
  // an empty tmpdir — no metaobjects/, no config
  expect(await genCommand(["--list"], emptyTmp, "json")).toBe(0);
});

it("--probe reports wouldEmit from the real model", async () => {
  const rows = JSON.parse(await captureStdout(() => genCommand(["--list", "--probe"], projectTmp, "json")));
  const entity = rows.find((r) => r.name === "entity")!;
  expect(entity.project!.wouldEmit).toBeGreaterThan(0);
  const parser = rows.find((r) => r.name === "output-parser")!;
  expect(parser.project!.wouldEmit).toBe(0); // the fixture declares no template.prompt
});

it("--probe without a project is a usage error, not an empty listing", async () => {
  expect(await genCommand(["--list", "--probe"], emptyTmp, "json")).toBe(2);
});
```

- [ ] **Step 2: Run and watch fail.**

`cd server/typescript && bun test packages/cli/test/gen-list-catalog.test.ts`

- [ ] **Step 3: Implement.**

`useWhen` and `emits` come from the reference-template headers, which already carry them
(`use-when`, `emits`) — parse them the way `eject.ts` parses the import line, in
`catalog-listing.ts`, and leave them `undefined` for a non-ejectable entry. `owned` is
`true`/`false` when a project is present (does `codegen/generators/<name>.ts` exist?) and `null`
with no project. `frameworkDetected` reads `package.json` dependencies for the framework's own
package (`fastify`, `hono`, `react`, `@tanstack/react-query`); `null` with no manifest.

`wouldEmit` construction must not throw: wrap each `factory()` + dry-run in a try/catch and
report `null` with a `probeError` string rather than failing the whole listing — a generator
that needs required options (`template`, `shared-model`) cannot be probed and must say so.

Text format keeps the existing grouped rendering, regrouped by **layer** instead of tier, with
tier shown per row.

- [ ] **Step 4: Run; green.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(cli): meta gen --list is the catalog, with --probe answering 'what would this emit for MY model'"
```

---

## Task 6: the `requires` gate and the `api`-framework advisory

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/runner.ts`
- Create: `server/typescript/packages/codegen-ts/test/requires-gate.test.ts`

**Interfaces:**
- Consumes: `GeneratorRegistryEntry.requires`, `.framework`, `.layer`.
- Produces: two self-extinguishing warnings on `RunGenResult.warnings`. Neither fails a build.

`runGen` receives `generators: Generator[]` (factory instances), not names. Resolve each
instance's stable name via `generator.name` — the `Generator` interface already carries a
kebab-case `name`. Map it back to the catalog by that name; a generator whose name is not a
catalog key is an owned/third-party generator and is skipped silently (it has no declaration to
check).

- [ ] **Step 1: Write the failing tests**

```ts
it("warns when a wired generator's requires are not wired", async () => {
  const res = await runGen({ config: { ...base, generators: [tanstackGridHook()] }, ... });
  expect(res.warnings.join("\n")).toContain("grid-hook");
  expect(res.warnings.join("\n")).toContain("grid");
});

it("says nothing when the requirement is wired", async () => {
  const res = await runGen({ config: { ...base, generators: [tanstackGrid(), tanstackGridHook()] }, ... });
  expect(res.warnings.filter((w) => w.includes("requires"))).toEqual([]);
});

it("warns when two api-layer generators declare different frameworks", async () => {
  const res = await runGen({ config: { ...base, generators: [routesFile(), routesFileHono()] }, ... });
  expect(res.warnings.join("\n")).toMatch(/fastify.*hono|hono.*fastify/);
});

it("does NOT warn on form + hooks + grid — client is a composition, not a conflict", async () => {
  const res = await runGen({ config: { ...base, generators: [formFile(), tanstackQuery(), tanstackGrid()] }, ... });
  expect(res.warnings.filter((w) => w.includes("framework"))).toEqual([]);
});
```

The last two need the react/tanstack entries, which `codegen-ts` cannot import. Put those two
tests in `packages/cli/test/` and drive them through the composed catalog, passing the catalog
into `runGen` as an option:

```ts
/** The catalog the requires/framework gates check against. Injected because the
 *  composition lives in the CLI (codegen-ts cannot import its own dependents). */
catalog?: Record<string, GeneratorRegistryEntry>;
```

Defaulting to `generatorRegistry` keeps `runGen` correct for a programmatic embedder that never
composes.

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement both gates** in `runner.ts`, after generator resolution and before
      emission. Message shapes:

```
meta gen: "grid-hook" is wired but "grid" is not. grid-hook's output imports the
  module grid emits, so `tsc` will report an unresolved import. Wire grid, or keep
  your own hand-written equivalent at that path.
meta gen: two api-layer generators declare different frameworks — "routes" (fastify)
  and "routes-hono" (hono). Both emit a complete HTTP surface over the same entities,
  to different paths, so nothing fails; this is only a warning because migrating
  between them, or serving Node and edge from one model, is legitimate.
```

- [ ] **Step 4: Run; green.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(codegen): warn on an unsatisfied requires edge and on two api frameworks"
```

---

## Task 7: `meta eject` takes many names, reports JSON, consolidates the install set

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts` (`parseEjectArgs`: many positionals; `EJECT_OPTIONS` unchanged)
- Modify: `server/typescript/packages/cli/src/commands/eject.ts`
- Modify: `server/typescript/packages/cli/src/index.ts` (`eject` joins `FORMAT_AWARE_COMMANDS`; help text)
- Create: `server/typescript/packages/cli/test/eject-multi.test.ts`

**Interfaces:**
- Produces: `ejectCommand(args, cwd, fmt)`. JSON payload exactly as spec §D3:

```ts
interface EjectPayload {
  ejected: Array<{
    name: string; path: string; status: "created" | "preserved" | "replaced";
    wire: { import: string; entry: string };
    requires: readonly string[];
  }>;
  install: { dev: string[]; runtime: string[]; command: string };
  config: { keys: string[] };
}
```

`entry` is `${exportName}()`. `install.dev` is the set of packages the ejected FILES import
(what `requiredPackages()` already derives) plus each entry's own package; `install.runtime` is
the union of each entry's `runtimePackage` and `runtimePeers`, **with ranges read from the
runtime package's own `peerDependencies`** (a new `lib/peer-ranges.ts` helper — `runtimeTsPeerRanges()`
in `init.ts` already does exactly this for one package; generalize and move it, then delete the
init copy in Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
it("ejects several names in one call", async () => {
  expect(await ejectCommand(["entity", "queries", "routes"], tmp, "text")).toBe(0);
  for (const n of ["entity", "queries", "routes"]) {
    expect(existsSync(join(tmp, "codegen/generators", `${n}.ts`))).toBe(true);
  }
});

it("--format json emits ONE document and nothing else on stdout", async () => {
  const out = await captureStdout(() => ejectCommand(["form"], tmp, "json"));
  const payload = JSON.parse(out) as EjectPayload;
  expect(payload.ejected[0]!.name).toBe("form");
  expect(payload.ejected[0]!.wire.entry).toBe("formFile()");
  expect(payload.install.dev).toContain("@metaobjectsdev/codegen-ts-react@^" + cliVersion());
});

it("the install set is consolidated, not per-name", async () => {
  const payload = JSON.parse(await captureStdout(() => ejectCommand(["hooks", "grid"], tmp, "json")));
  const tanstack = payload.install.dev.filter((d) => d.startsWith("@metaobjectsdev/codegen-ts-tanstack"));
  expect(tanstack.length).toBe(1);
});

it("an unknown name refuses the WHOLE call, ejecting nothing", async () => {
  expect(await ejectCommand(["entity", "nonesuch"], tmp, "text")).toBe(2);
  expect(existsSync(join(tmp, "codegen/generators/entity.ts"))).toBe(false);
});
```

That last one matters: a partial eject leaves a repo half-changed with a non-zero exit, which is
the worst outcome. Validate every name before writing any file.

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement.** Keep every existing text-mode message (the preserved/differs/
      replaced branches are load-bearing and were written against real incidents) — they now
      print per name. Print the consolidated install block once, at the end.

- [ ] **Step 4: Run; green.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(cli): meta eject takes many names and reports one consolidated install set"
```

---

## Task 8: `meta init` scaffolds the layout and an empty selection

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/init.ts` (net shrink)
- Modify: `server/typescript/packages/cli/src/commands/gen.ts` (the first-run pointer)
- Modify: `server/typescript/packages/cli/test/init*.test.ts` (roughly a dozen assertions about the five)
- Create: `server/typescript/packages/cli/test/init-empty-selection.test.ts`

**What goes:**
- `SCAFFOLDED_GENERATOR_NAMES` and `writeOwnedGenerators`'s copy loop (the function stays, now
  only calling `writeCodegenTsconfig` — or fold that call into `init` and delete the wrapper).
- `DB_STUB_BODY`, `DB_STUB_NOTE`, `DB_STUB_REL_PATH`, `SCAFFOLD_DB_IMPORT` and the whole db-stub
  block in `init` — including the three-branch warning. `dbImport` leaves the scaffold, so
  nothing points at `src/db.ts`.
- `addScaffoldDevDependencies`, `addScaffoldRuntimeDependencies`, `scaffoldRuntimeDependencies`,
  `SCAFFOLD_OUTPUT_PEERS`, `runtimeTsPeerRanges` (the last one MOVES to `lib/peer-ranges.ts` in
  Task 7 — delete the copy here, import if still needed).
- `extStyle`, `dbImport`, `apiPrefix` from the scaffolded config body.

**What stays:** `metaobjects/`, `.metaobjects/`, `metaobjects.config.ts`, `tsconfig.codegen.json`,
the gitignores, agent context, ESM `"type": "module"` handling, `codegen/generators/` as an
empty directory (the tsconfig's `include` also names `metaobjects.config.ts`, so an empty
`codegen/` never makes the include match nothing).

The new config body is spec §D3's, verbatim, with `dialect` interpolated.

- [ ] **Step 1: Write the failing tests**

```ts
it("scaffolds no generators and wires none", async () => {
  await init({ cwd: tmp });
  const body = readFileSync(join(tmp, "metaobjects.config.ts"), "utf8");
  expect(body).toContain("generators: []");
  expect(body).not.toContain("./codegen/generators/");
  expect(readdirSync(join(tmp, "codegen/generators"))).toEqual([]);
});

it("scaffolds no db stub and no dbImport", async () => {
  await init({ cwd: tmp });
  expect(existsSync(join(tmp, "src/db.ts"))).toBe(false);
  expect(readFileSync(join(tmp, "metaobjects.config.ts"), "utf8")).not.toContain("dbImport");
});

it("adds no runtime or codegen dependencies to package.json", async () => {
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
  await init({ cwd: tmp });
  const pkg = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
  for (const d of ["drizzle-orm", "zod", "fastify", "@metaobjectsdev/codegen-ts"]) {
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(d);
  }
});

it("still sets type: module", async () => { /* … the ESM rule is unchanged … */ });

it("the config points at the catalog", async () => {
  await init({ cwd: tmp });
  expect(readFileSync(join(tmp, "metaobjects.config.ts"), "utf8"))
    .toContain("meta gen --list --format json --probe");
});
```

And in `gen.ts`:

```ts
it("an empty selection prints a pointer, not a warning, and exits 0", async () => {
  const code = await genCommand([], scaffoldedTmp, "text");
  expect(code).toBe(0);
  expect(stderr).toContain("Nothing is generated until you choose it");
  expect(stderr).toContain("meta gen --list");
  expect(stderr).not.toContain("WARN");
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement the shrink.** Then sweep the existing init tests: every assertion
      naming one of the five, `src/db.ts`, `dbImport`, or a scaffolded dependency has to be
      deleted or inverted. `git grep -n "SCAFFOLDED_GENERATOR_NAMES\|src/db.ts\|DB_STUB" server/typescript`
      finds them.

- [ ] **Step 4: Run the whole CLI suite.** `cd server/typescript && bun test packages/cli`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(cli): meta init scaffolds the layout and an empty documented selection"
```

---

## Task 9: the resolved-not-trusted gates, and the declarations they force

**Files:**
- Create: `server/typescript/packages/cli/test/catalog-declarations-resolved.test.ts`
- Modify: all three registry slices (populate `requires`, `runtimePeers`, `runtimePackage`, `configKeys`)

**Interfaces:**
- Consumes: `composeCatalog()`, a fixture model rich enough to make every generator emit.
- Produces: no runtime interface — this task's product is the *declarations*, made true.

The fixture model must carry: two entities with a relationship, a `template.prompt` with a
`@responseRef`, a `template.output`, a `layout.dataGrid`, a `source.rdb` with `@kind: storedProc`,
and one `requirement.functional`. `fixtures/conformance/` has pieces of each; assemble a
dedicated one at `server/typescript/packages/cli/test/fixtures/catalog-probe/` rather than
reaching into the conformance corpus (a corpus fixture changing shape must never break this).

- [ ] **Step 1: Write the failing gates**

```ts
it("runtimePeers ⊇ the third-party packages the emitted files import", async () => {
  for (const [name, entry] of Object.entries(composeCatalog())) {
    const files = await dryRunOne(entry, model);
    const imported = thirdPartyImportsOf(files);   // excludes @metaobjectsdev/* and relative
    const declared = new Set(entry.runtimePeers ?? []);
    const undeclared = [...imported].filter((p) => !declared.has(p));
    expect(undeclared, `${name} emits imports it does not declare: ${undeclared.join(", ")}`).toEqual([]);
  }
});

it("requires ⊇ the generators whose emitted paths this generator's output imports", async () => {
  const emitters = await pathOwners(composeCatalog(), model);   // path -> generator name
  for (const [name, entry] of Object.entries(composeCatalog())) {
    const files = await dryRunOne(entry, model);
    const needed = new Set(relativeImportTargets(files).map((p) => emitters.get(p)).filter(Boolean));
    needed.delete(name);
    const declared = new Set(entry.requires ?? []);
    const undeclared = [...needed].filter((n) => !declared.has(n!));
    expect(undeclared, `${name} depends on ${undeclared.join(", ")} but declares none of it`).toEqual([]);
  }
});

it("every ejectable entry has a reference template, and every template has an entry", () => {
  const catalog = composeCatalog();
  const templates = new Set([...coreTpl.REFERENCE_GENERATOR_NAMES,
    ...reactTpl.REFERENCE_GENERATOR_NAMES, ...tanstackTpl.REFERENCE_GENERATOR_NAMES]);
  expect([...templates].filter((n) => !(n in catalog))).toEqual([]);
  expect(Object.values(catalog).filter((e) => e.ejectable && !templates.has(e.name)).map((e) => e.name)).toEqual([]);
});

it("every reference-template header's documented facets agree with its catalog entry", () => {
  // use-when / emits parsed out of the header == entry.useWhen / entry.emits
});
```

- [ ] **Step 2: Run and read off the truth.** The first two tests FAIL and their messages are
      the answer: they name, per generator, exactly what to declare.

- [ ] **Step 3: Populate `requires` / `runtimePeers` / `runtimePackage` from the failures.**
      Do NOT guess ahead of the gate. `configKeys` is not derivable — read each generator for
      the `ctx.config.*` keys it touches and declare them by hand; add a fifth test asserting
      each declared key is a real `MetaobjectsConfig` property (a compile-time
      `keyof MetaobjectsConfig` type on the field does this for free — prefer that).

- [ ] **Step 4: Run; green.**

- [ ] **Step 5: Commit**

```bash
git commit -m "test(catalog): resolve every compatibility declaration against what the generators actually emit"
```

---

## Task 10: C# and Python lose their default suites

**Files:**
- Modify: `server/csharp/MetaObjects.Cli/GenCommand.cs`, `VerifyCommand.cs:250`
- Modify: `server/csharp/MetaObjects.Codegen.Tests/{CodegenDriftTests,NamesGeneratorTests,NoMagicPhysicalNamesTests,IntegrationFixtureDriftTests}.cs`
- Modify: `server/python/src/metaobjects/cli.py` (`_default_generators`, its call site at ~:510)
- Modify: the Python CLI tests that rely on a default run

**Interfaces:**
- Produces: `dotnet meta gen` and `metaobjects gen` with no `--generators` exit **2** with a
  usage error naming the catalog door, and generate nothing.

Note `VerifyCommand.cs:250` falls back to `DefaultGeneratorNames` when the config names none —
`verify --codegen` re-runs the config's list, so with no default suite it must report "nothing
selected, nothing to check" rather than silently checking nine artifacts nobody generates.

The test suites use the default set as a convenience list. Replace each with an explicit local
array named for what that test is about (`CodegenDriftTests` already documents that it was once
a hand-copied duplicate — the honest fix now is an explicit list, since there is no default to
track).

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact]
public void GenWithNoGeneratorsIsAUsageError()
{
    var outcome = GenCommand.Run(metadataDir, outDir, "Acme", emitAbstractShapes: false,
                                 generatorNames: null, templateRoot: null);
    Assert.False(outcome.Ok);
    Assert.Contains("--generators", outcome.Error);
    Assert.Empty(Directory.GetFiles(outDir, "*", SearchOption.AllDirectories));
}
```

```python
def test_gen_without_generators_is_a_usage_error(tmp_path, capsys):
    rc = main(["gen", "--metadata", str(md), "--out", str(out)])
    assert rc == 2
    assert "--generators" in capsys.readouterr().err
    assert not list(out.rglob("*"))
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Remove both default suites** and make `--generators` required. The error message
      in both ports:

```
gen: no generators selected. Nothing is generated until you choose it —
  pass --generators <a,b,c>. See the catalog: <port's list command>
```

- [ ] **Step 4: Run both ports' suites.** Count the `dotnet test` result lines.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(csharp,python): no default generator suite — --generators is required"
```

---

## Task 11: ADR-0034 Amendment 2, the compatibility-policy narrowing, and the docs

**Files:**
- Modify: `spec/decisions/ADR-0034-*.md` (Amendment 2)
- Modify: `docs/compatibility-policy.md:53`
- Modify: `docs/features/own-your-codegen.md`, `docs/features/cli.md`, `docs/features/codegen-concepts.md`
- Modify: `server/typescript/packages/cli/README.md` (quickstart), root `README.md`
- Modify: the `llms.txt` pair — ONE line, never the enumeration
- Modify: `agent-context/skills/metaobjects-codegen/SKILL.md` (+ references) and
  `metaobjects-runtime-ui`, and the always-on template
- Regenerate: the agent-context conformance corpus **in the same commit**
- Modify: `CHANGELOG.md`

ADR-0034 Amendment 2, verbatim intent from spec §6: Decision 2's "`meta init` scaffolds a
sensible default generator set" and the consequence "first-run still works (init scaffolds
defaults)" are replaced by — init scaffolds the layout and an empty documented selection;
`eject` is the copy door; the catalog is the composed registry behind `--list`. Everything else
in ADR-0034 stands. FR-040 was Amendment 1; do not renumber it.

`docs/compatibility-policy.md:53` becomes:

> - **The scaffold-and-own contract** — the *layout and the interfaces*
>   (`codegen/generators/`, the local-import config shape, `.metaobjects/`, the `Generator`
>   interface owned templates implement). NOT *which* generators a fresh scaffold wires: codegen
>   is opt-in, and the scaffolded selection is empty by design.

The skill gains spec §D4's **procedure**, not a list, plus intent-level recipes naming layers
only. It is gated by the existing capability-grounding test.

- [ ] **Step 1: Find the grounding test and read what it checks.**
      `git grep -rln "capability-grounding\|skill prose\|grounded" server/typescript/packages/*/test`

- [ ] **Step 2: Extend it** so every stable name AND every layer token the skill mentions must
      exist in the composed catalog.

- [ ] **Step 3: Write the prose.** Then regenerate the agent-context corpus and read back the
      **python** fixture.

- [ ] **Step 4: Prove the cross-cutting gates**

```bash
cd <repo-root>
bun test scripts/site && bun scripts/build-site-payload.ts --check
cd server/typescript && bun test packages/cli packages/codegen-ts
```

- [ ] **Step 5: Commit**

```bash
git commit -m "docs(catalog): codegen is opt-in — ADR-0034 Amendment 2, the narrowed compat clause, and the selection procedure"
```

---

## Task 12: full local CI

- [ ] **Step 1:** `nm-triage` in the repo; note the pre-gate line.
- [ ] **Step 2:** `scripts/ci-local.sh --strict-toolchains`, then **grep the SUMMARY block** —
      the script exits 0 on a red gate.
- [ ] **Step 3:** Fix whatever it names; re-run the affected lane only.

---

## Self-review notes

- **Spec coverage.** §2 items 1-4 → Tasks 8, 10; §3 D1 → Task 1 (no stored bundle exists
  anywhere in the plan); D2(a) → Task 3, D2(b) → Tasks 2 + 9; D3 → Tasks 5 + 7 + 8; D4 → Tasks 6
  + 11; D5 → Task 9 + Tasks 1/4. §4 cross-port → Tasks 1, 4, 10. §6 → Task 11. §7 → every task.
  §8a → Task 6. §8b → Task 1. §9 (`kind`) → Task 2.
- **Not covered, deliberately:** §10's validation probe (put an adopting agent on a fresh
  `meta init`) is a measurement, not an implementation step; it runs after this ships.
- **Type consistency.** `Layer`, `GENERATOR_LAYERS`, `GeneratorRegistryEntry`, `composeCatalog`,
  `listCatalog`, `packageOf`, `CatalogRow`, `EjectPayload` are used with those exact names in
  every task that names them.

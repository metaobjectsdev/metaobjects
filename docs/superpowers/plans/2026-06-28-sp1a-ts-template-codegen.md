# SP-1a — TS declarative Mustache template-codegen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a consumer able to author a Mustache template generator on the TS port declaratively — `{ template, scope, outputPattern }`, no `walk` code — for the three built-in scopes (`perEntity` / `perPackage` / `perModel`), and gate the neutral contract with a new cross-port conformance corpus.

**Architecture:** Add a `perPackage` engine helper + rename `oncePerRun`→`perModel` (alias kept). Add a neutral, structural **template data-dict builder** (distinct from the Markdown-flavored docs builder). Add an **output-pattern expander**. Wire `scope` + `outputPattern` into the existing `templateGenerator()` as a built-in walk. Add a **JSON spec** shape + parser (the surface the CLI ports will reuse) with a JSON Schema. Author `fixtures/template-codegen-conformance/` and gate TS against it.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/metadata` (loader + MetaObject API), `@metaobjectsdev/render` (Mustache engine + `RenderFormat`), `@metaobjectsdev/codegen-ts` (Generator plumbing).

## Global Constraints

- **Named constants for metamodel strings** — import from `@metaobjectsdev/metadata` (e.g. `FIELD_ATTR_MAX_LENGTH`, `FIELD_ATTR_VALUES`, `VALIDATOR_SUBTYPE_REQUIRED`, `IDENTITY_SUBTYPE_PRIMARY`, relationship attr consts). Never inline `"maxLength"`, `"required"`, etc.
- **No `any`** — use `unknown` and narrow.
- **ESM only**, `.js` import specifiers in source.
- **No backwards-compat hacks**; `oncePerRun` stays only as a thin documented alias.
- **TDD** — failing test first, minimal impl, frequent commits.
- **Run tests scoped**: `cd server/typescript/packages/codegen-ts && bun test`. NEVER bare `bun test` at repo root.
- **Neutral contract is byte-gated**: the data dict, scope names (`perEntity`/`perPackage`/`perModel`), and output-pattern grammar are the only cross-port-shared surface; they must match the spec exactly (`docs/superpowers/specs/2026-06-28-mustache-codegen-parity-design.md`).
- **Public-repo hygiene**: no private names, no absolute home paths in committed files/fixtures.
- **Commit trailers** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky`.

---

## File Structure

- `server/typescript/packages/codegen-ts/src/generator.ts` — **modify**: add `perPackage`, add `perModel` (alias `oncePerRun` + deprecate).
- `server/typescript/packages/codegen-ts/src/template-codegen/output-pattern.ts` — **create**: `expandOutputPattern`.
- `server/typescript/packages/codegen-ts/src/template-codegen/template-data.ts` — **create**: the neutral structural data-dict builders.
- `server/typescript/packages/codegen-ts/src/template-codegen/template-spec.ts` — **create**: JSON-spec types + `templateSpecToGenerators`.
- `server/typescript/packages/codegen-ts/src/template-codegen/template-spec.schema.json` — **create**: JSON Schema for the spec.
- `server/typescript/packages/codegen-ts/src/generators/template-generator.ts` — **modify**: accept `scope` + `outputPattern` (built-in walk).
- `server/typescript/packages/codegen-ts/src/index.ts` — **modify**: export the new public API.
- `fixtures/template-codegen-conformance/` — **create**: metadata + templates + spec manifest + expected output.
- `server/typescript/packages/codegen-ts/test/template-codegen/*.test.ts` — **create**: unit + conformance tests.

---

## Task 1: `perPackage` engine helper + `perModel` rename

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generator.ts:76-88`
- Test: `server/typescript/packages/codegen-ts/test/template-codegen/scope-helpers.test.ts`

**Interfaces:**
- Consumes: `GenContext`, `EmittedFile`, `MetaObject` (already in `generator.ts`).
- Produces:
  - `perPackage(fn: (pkg: string, entities: MetaObject[], ctx: GenContext) => EmittedFile | EmittedFile[] | Promise<…>): (ctx) => Promise<EmittedFile[]>` — groups matched entities by `entity.package`, runs `fn` once per package (packages sorted ascending; entities within a package preserve `ctx.entities` order).
  - `perModel` — exported alias of the existing `oncePerRun` body (same signature).
  - `oncePerRun` — kept, JSDoc `@deprecated` → use `perModel`.

- [ ] **Step 1: Write the failing test**

```ts
// test/template-codegen/scope-helpers.test.ts
import { describe, test, expect } from "bun:test";
import { perPackage, perModel, oncePerRun } from "../../src/generator.js";
import type { GenContext, EmittedFile } from "../../src/generator.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { resolve } from "node:path";

const FIXTURE = resolve(import.meta.dir, "../fixtures/single-entity.json"); // existing fixture

async function ctxFor(path: string): Promise<GenContext> {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(path)]);
  expect(res.errors).toEqual([]);
  const entities = res.root.objects();
  return {
    entities, loadedRoot: res.root, matches: () => true,
    config: {} as GenContext["config"], warn: () => {},
  };
}

describe("perPackage", () => {
  test("runs fn once per distinct package, packages sorted", async () => {
    const ctx = await ctxFor(FIXTURE);
    const seen: string[] = [];
    const gen = perPackage((pkg, ents) => {
      seen.push(pkg);
      return { path: `${pkg || "_"}/out.txt`, content: `${ents.length}` } as EmittedFile;
    });
    const files = await gen(ctx);
    // distinct packages == number of emitted files
    const pkgs = [...new Set(ctx.entities.map((e) => e.package))].sort();
    expect(seen).toEqual(pkgs);
    expect(files.length).toBe(pkgs.length);
  });
});

describe("perModel / oncePerRun alias", () => {
  test("perModel runs fn once with all matched entities", async () => {
    const ctx = await ctxFor(FIXTURE);
    let calls = 0;
    const gen = perModel((ents) => { calls++; return { path: "all.txt", content: `${ents.length}` }; });
    const files = await gen(ctx);
    expect(calls).toBe(1);
    expect(files.length).toBe(1);
  });
  test("oncePerRun is the same function as perModel (alias)", () => {
    expect(oncePerRun).toBe(perModel);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/scope-helpers.test.ts`
Expected: FAIL — `perPackage`/`perModel` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/generator.ts`, after `oncePerRun` (line ~88), add:

```ts
/** One-file-per-package convenience. Groups matched entities by package, runs
 *  `fn` once per package (packages ascending; entities keep ctx order). */
export function perPackage(
  fn: (pkg: string, entities: MetaObject[], ctx: GenContext) =>
    | EmittedFile
    | EmittedFile[]
    | Promise<EmittedFile | EmittedFile[]>,
): (ctx: GenContext) => Promise<EmittedFile[]> {
  return async (ctx) => {
    const matched = ctx.entities.filter(ctx.matches);
    const byPkg = new Map<string, MetaObject[]>();
    for (const e of matched) {
      const pkg = e.package ?? "";
      (byPkg.get(pkg) ?? byPkg.set(pkg, []).get(pkg)!).push(e);
    }
    const out: EmittedFile[] = [];
    for (const pkg of [...byPkg.keys()].sort()) {
      const r = await fn(pkg, byPkg.get(pkg)!, ctx);
      out.push(...(Array.isArray(r) ? r : [r]));
    }
    return out;
  };
}

/** App-scope convenience — run once over all matched entities (the whole model). */
export const perModel = oncePerRun;
```

Then change the existing `oncePerRun` JSDoc (line ~76) to:

```ts
/** Called once with all matching entities. Use for barrels and cross-entity files.
 *  @deprecated Use {@link perModel} — "run" is ambiguous under multi-target output. */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/scope-helpers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the package suite to confirm no regression**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: PASS — all existing tests still green (`oncePerRun` callers unaffected).

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/generator.ts server/typescript/packages/codegen-ts/test/template-codegen/scope-helpers.test.ts
git commit -m "feat(codegen-ts): add perPackage scope helper + perModel (alias oncePerRun)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 2: Output-pattern expander

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/template-codegen/output-pattern.ts`
- Test: `server/typescript/packages/codegen-ts/test/template-codegen/output-pattern.test.ts`

**Interfaces:**
- Produces: `expandOutputPattern(pattern: string, vars: { name?: string; package?: string }): string`
  - Placeholders: `{name}` → `vars.name`; `{Name}` → PascalCase of `vars.name`; `{package}` → `vars.package` with `::` replaced by `/`.
  - A placeholder used with no corresponding var → throw `Error` (`unknown/empty`). An unknown placeholder token → throw. `perModel` patterns use neither `{name}` nor `{package}` and pass through literally.

- [ ] **Step 1: Write the failing test**

```ts
// test/template-codegen/output-pattern.test.ts
import { describe, test, expect } from "bun:test";
import { expandOutputPattern } from "../../src/template-codegen/output-pattern.js";

describe("expandOutputPattern", () => {
  test("{name} and {package} (:: → /)", () => {
    expect(expandOutputPattern("{package}/{name}Service.ts", { name: "order", package: "acme::sales" }))
      .toBe("acme/sales/orderService.ts");
  });
  test("{Name} is PascalCase", () => {
    expect(expandOutputPattern("{Name}.cs", { name: "order_line" })).toBe("OrderLine.cs");
  });
  test("literal pattern (perModel) passes through", () => {
    expect(expandOutputPattern("registry.ts", {})).toBe("registry.ts");
  });
  test("empty package collapses to no leading slash", () => {
    expect(expandOutputPattern("{package}/{name}.ts", { name: "x", package: "" })).toBe("x.ts");
  });
  test("unknown placeholder throws", () => {
    expect(() => expandOutputPattern("{bogus}.ts", { name: "x" })).toThrow(/unknown placeholder/i);
  });
  test("{name} with no name var throws", () => {
    expect(() => expandOutputPattern("{name}.ts", {})).toThrow(/name/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/output-pattern.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/template-codegen/output-pattern.ts
// Expands the tiny, fixed output-pattern grammar shared cross-port (SP-1).
// Placeholders: {name}, {Name} (PascalCase), {package} (:: → /).

const KNOWN = new Set(["name", "Name", "package"]);

function pascalCase(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export function expandOutputPattern(
  pattern: string,
  vars: { name?: string; package?: string },
): string {
  // Replace each {token}; a normalize pass then collapses an empty package's
  // leading "/" so `{package}/{name}` with no package yields just `{name}`.
  let pkgWasEmpty = false;
  const out = pattern.replace(/\{(\w+)\}/g, (_m, token: string) => {
    if (!KNOWN.has(token)) throw new Error(`unknown placeholder {${token}} in output pattern '${pattern}'`);
    if (token === "package") {
      const p = (vars.package ?? "").replaceAll("::", "/");
      if (p === "") pkgWasEmpty = true;
      return p;
    }
    if (vars.name === undefined) throw new Error(`output pattern '${pattern}' uses {${token}} but no entity name is in scope`);
    return token === "Name" ? pascalCase(vars.name) : vars.name;
  });
  return pkgWasEmpty ? out.replace(/^\/+/, "").replace(/\/{2,}/g, "/") : out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/output-pattern.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/template-codegen/output-pattern.ts server/typescript/packages/codegen-ts/test/template-codegen/output-pattern.test.ts
git commit -m "feat(codegen-ts): output-pattern expander for template codegen

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 3: Neutral structural data-dict builder

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/template-codegen/template-data.ts`
- Test: `server/typescript/packages/codegen-ts/test/template-codegen/template-data.test.ts`

**Interfaces:**
- Produces (the **neutral byte-gated contract** — keep field names EXACT per spec §3.2):
  ```ts
  export interface EntityTemplateData {
    name: string;
    package: string;
    fields: { name: string; type: string; required: boolean; isArray: boolean; maxLength?: number; enumValues?: string[] }[];
    identities: { kind: string; fields: string[] }[];
    relationships: { name: string; cardinality: string; targetRef: string }[];
  }
  export interface PackageTemplateData { package: string; entities: EntityTemplateData[]; }
  export interface ModelTemplateData { packages: PackageTemplateData[]; }
  export function buildEntityTemplateData(entity: MetaObject): EntityTemplateData;
  export function buildPackageTemplateData(pkg: string, entities: MetaObject[]): PackageTemplateData;
  export function buildModelTemplateData(root: MetaRoot): ModelTemplateData;
  ```
- Consumes: `MetaObject`/`MetaRoot` and metamodel consts. `type` is the **neutral field subtype** (`field.subType`), with `[]` NOT appended (the `isArray` flag carries that). `required` ← a REQUIRED validator present. `maxLength`/`enumValues` only when set. `identities[].kind` ← `identity.subType`; `.fields` ← `identity.fields`. `relationships[].cardinality` ← `rel.cardinality ?? ""`; `.targetRef` ← `rel.objectRef ?? ""`; `.name` ← `rel.name`. `buildModelTemplateData` groups `root.objects()` by package (ascending), entities in `root.objects()` order; abstract objects are EXCLUDED (they never emit instance artifacts).

- [ ] **Step 1: Write the failing test**

```ts
// test/template-codegen/template-data.test.ts
import { describe, test, expect } from "bun:test";
import { buildEntityTemplateData, buildModelTemplateData } from "../../src/template-codegen/template-data.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { resolve } from "node:path";

async function load(path: string) {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(path)]);
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("buildEntityTemplateData", () => {
  test("emits neutral structural fields (subtype, required, isArray)", async () => {
    const root = await load(resolve(import.meta.dir, "../fixtures/single-entity.json"));
    const entity = root.objects()[0]!;
    const data = buildEntityTemplateData(entity);
    expect(data.name).toBe(entity.name);
    expect(data.package).toBe(entity.package ?? "");
    expect(Array.isArray(data.fields)).toBe(true);
    for (const f of data.fields) {
      expect(typeof f.type).toBe("string");
      expect(f.type).not.toContain("[]");          // isArray carries arrayness
      expect(typeof f.required).toBe("boolean");
      expect(typeof f.isArray).toBe("boolean");
    }
    // identities present with kind+fields
    for (const id of data.identities) {
      expect(typeof id.kind).toBe("string");
      expect(Array.isArray(id.fields)).toBe(true);
    }
  });
});

describe("buildModelTemplateData", () => {
  test("groups by package ascending; abstracts excluded", async () => {
    const root = await load(resolve(import.meta.dir, "../fixtures/single-entity.json"));
    const model = buildModelTemplateData(root);
    const pkgs = model.packages.map((p) => p.package);
    expect(pkgs).toEqual([...pkgs].sort());
    const names = model.packages.flatMap((p) => p.entities.map((e) => e.name));
    const concrete = root.objects().filter((o) => o.isAbstract !== true).map((o) => o.name);
    expect(names.sort()).toEqual(concrete.sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/template-data.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/template-codegen/template-data.ts
// The NEUTRAL, structural codegen template data dict (SP-1 §3.2). Distinct from
// the Markdown-flavored EntityDocData — this carries raw structural facts only,
// so a consumer's Mustache template emits any language's code from it. Field
// names here are a byte-gated cross-port contract; change them only via the spec.
import type { MetaObject, MetaRoot, MetaField } from "@metaobjectsdev/metadata";
import {
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_VALUES,
  FIELD_SUBTYPE_ENUM,
  VALIDATOR_SUBTYPE_REQUIRED,
} from "@metaobjectsdev/metadata";

export interface FieldTemplateData {
  name: string;
  type: string;          // neutral field subtype, e.g. "string" | "int" | "currency"
  required: boolean;
  isArray: boolean;
  maxLength?: number;
  enumValues?: string[];
}
export interface EntityTemplateData {
  name: string;
  package: string;
  fields: FieldTemplateData[];
  identities: { kind: string; fields: string[] }[];
  relationships: { name: string; cardinality: string; targetRef: string }[];
}
export interface PackageTemplateData { package: string; entities: EntityTemplateData[]; }
export interface ModelTemplateData { packages: PackageTemplateData[]; }

function requiredOf(field: MetaField): boolean {
  return field.validators().some((v) => v.subType === VALIDATOR_SUBTYPE_REQUIRED);
}

function fieldData(field: MetaField): FieldTemplateData {
  const d: FieldTemplateData = {
    name: field.name,
    type: field.subType,
    required: requiredOf(field),
    isArray: field.isArray === true,
  };
  const max = field.attr(FIELD_ATTR_MAX_LENGTH);
  if (typeof max === "number") d.maxLength = max;
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const vals = field.attr(FIELD_ATTR_VALUES);
    if (Array.isArray(vals)) d.enumValues = vals.map(String);
  }
  return d;
}

export function buildEntityTemplateData(entity: MetaObject): EntityTemplateData {
  return {
    name: entity.name,
    package: entity.package ?? "",
    fields: entity.fields().map(fieldData),
    identities: entity.identities().map((i) => ({ kind: i.subType, fields: [...i.fields] })),
    relationships: entity.relationships().map((r) => ({
      name: r.name,
      cardinality: r.cardinality ?? "",
      targetRef: r.objectRef ?? "",
    })),
  };
}

export function buildPackageTemplateData(pkg: string, entities: MetaObject[]): PackageTemplateData {
  return { package: pkg, entities: entities.map(buildEntityTemplateData) };
}

export function buildModelTemplateData(root: MetaRoot): ModelTemplateData {
  const concrete = root.objects().filter((o) => o.isAbstract !== true);
  const byPkg = new Map<string, MetaObject[]>();
  for (const o of concrete) {
    const pkg = o.package ?? "";
    (byPkg.get(pkg) ?? byPkg.set(pkg, []).get(pkg)!).push(o);
  }
  return {
    packages: [...byPkg.keys()].sort().map((pkg) => buildPackageTemplateData(pkg, byPkg.get(pkg)!)),
  };
}
```

> Note for the implementer: confirm `MetaField.attr()`, `MetaIdentity.fields`, and `MetaRelationship.name/cardinality/objectRef` accessor names against the real classes (`metadata/src/core/field/meta-field.ts`, `…/identity/meta-identity.ts`, `…/relationship/meta-relationship.ts`). If `attr()` returns a wrapped value, narrow it before the `typeof`/`Array.isArray` checks. These were verified to exist during planning; only the exact return-type narrowing may need a tweak.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/template-data.test.ts`
Expected: PASS (2 tests). Fix accessor narrowing if the build complains.

- [ ] **Step 5: Typecheck**

Run: `cd server/typescript/packages/codegen-ts && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/template-codegen/template-data.ts server/typescript/packages/codegen-ts/test/template-codegen/template-data.test.ts
git commit -m "feat(codegen-ts): neutral structural template data-dict builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 4: Wire `scope` + `outputPattern` into `templateGenerator`

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/template-generator.ts`
- Test: `server/typescript/packages/codegen-ts/test/template-codegen/scope-walk.test.ts`

**Interfaces:**
- Consumes: `buildEntityTemplateData`/`buildPackageTemplateData`/`buildModelTemplateData` (Task 3), `expandOutputPattern` (Task 2), `TemplateWalkResult` (existing).
- Produces: `TemplateGeneratorOpts` gains `scope?: "perEntity" | "perPackage" | "perModel"` and `outputPattern?: string`. Rule: exactly one of (`walk`) or (`scope` + `outputPattern`) must be provided — both or neither → throw at factory time. When `scope` is set, the generator derives the walk internally:
  - `perEntity`: one `TemplateWalkResult` per concrete entity → `{ data: buildEntityTemplateData(e), outputPath: expandOutputPattern(pattern, { name: e.name, package: e.package }) }`.
  - `perPackage`: one per package (ascending) → `{ data: buildPackageTemplateData(pkg, ents), outputPath: expandOutputPattern(pattern, { package: pkg }) }`.
  - `perModel`: one total → `{ data: buildModelTemplateData(root), outputPath: expandOutputPattern(pattern, {}) }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/template-codegen/scope-walk.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "../../src/index.js";
import { templateGenerator } from "../../src/generators/template-generator.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "tmpl-scope-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function gen(outDir: string, projectRoot: string) {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(resolve(import.meta.dir, "../fixtures/single-entity.json"))]);
  expect(res.errors).toEqual([]);
  await runGen({
    config: defineConfig({
      outDir, extStyle: "none", dbImport: "~/db", dialect: "sqlite",
      generators: [templateGenerator({
        name: "entity-name-list",
        template: "scopecheck/entity",
        scope: "perEntity",
        outputPattern: "{name}.txt",
      })],
    }),
    metadata: res.root,
    projectRoot,
  });
}

describe("templateGenerator scope=perEntity", () => {
  test("emits one file per concrete entity via the named walk", async () => {
    // project template: templates/scopecheck/entity.mustache
    const tdir = join(tmp, "templates", "scopecheck");
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, "entity.mustache"), "name={{name}} pkg={{package}}\n");
    const outDir = join(tmp, "out");
    await gen(outDir, tmp);
    const files = readdirSync(outDir).sort();
    expect(files.length).toBeGreaterThan(0);
    const first = readFileSync(join(outDir, files[0]!), "utf8");
    expect(first).toMatch(/^name=/);
  });
});

describe("templateGenerator option validation", () => {
  test("throws when both walk and scope are given", () => {
    expect(() => templateGenerator({
      name: "bad", template: "x", scope: "perEntity", outputPattern: "{name}.txt",
      walk: () => [],
    })).toThrow(/exactly one/i);
  });
  test("throws when neither walk nor scope is given", () => {
    expect(() => templateGenerator({ name: "bad2", template: "x" })).toThrow(/exactly one/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/scope-walk.test.ts`
Expected: FAIL — `scope`/`outputPattern` not on opts; validation absent.

- [ ] **Step 3: Write minimal implementation**

In `src/generators/template-generator.ts`:
1. Import at top:
   ```ts
   import { expandOutputPattern } from "../template-codegen/output-pattern.js";
   import { buildEntityTemplateData, buildPackageTemplateData, buildModelTemplateData } from "../template-codegen/template-data.js";
   ```
2. Add to `TemplateGeneratorOpts`:
   ```ts
   /** Built-in walk scope. Mutually exclusive with `walk`. */
   scope?: "perEntity" | "perPackage" | "perModel";
   /** Output path pattern for the built-in walk: {name} {Name} {package}. Required with `scope`. */
   outputPattern?: string;
   ```
   And relax `walk` to optional: `walk?: (root: MetaRoot) => …`.
3. At the top of the `templateGenerator` factory body, validate + derive a walk:
   ```ts
   const hasWalk = typeof opts.walk === "function";
   const hasScope = opts.scope !== undefined;
   if (hasWalk === hasScope) {
     throw new Error(`templateGenerator(${opts.name}): provide exactly one of \`walk\` or (\`scope\` + \`outputPattern\`)`);
   }
   if (hasScope && (opts.outputPattern === undefined || opts.outputPattern === "")) {
     throw new Error(`templateGenerator(${opts.name}): \`scope\` requires \`outputPattern\``);
   }
   const walk = hasWalk ? opts.walk! : scopeWalk(opts.scope!, opts.outputPattern!);
   ```
   Replace the later `await opts.walk(ctx.loadedRoot)` with `await walk(ctx.loadedRoot)`.
4. Add the `scopeWalk` factory in the same file:
   ```ts
   function scopeWalk(
     scope: "perEntity" | "perPackage" | "perModel",
     pattern: string,
   ): (root: MetaRoot) => TemplateWalkResult[] {
     return (root) => {
       const concrete = root.objects().filter((o) => o.isAbstract !== true);
       if (scope === "perEntity") {
         return concrete.map((e) => ({
           data: buildEntityTemplateData(e),
           outputPath: expandOutputPattern(pattern, { name: e.name, package: e.package ?? "" }),
         }));
       }
       if (scope === "perPackage") {
         const byPkg = new Map<string, typeof concrete>();
         for (const o of concrete) {
           const pkg = o.package ?? "";
           (byPkg.get(pkg) ?? byPkg.set(pkg, []).get(pkg)!).push(o);
         }
         return [...byPkg.keys()].sort().map((pkg) => ({
           data: buildPackageTemplateData(pkg, byPkg.get(pkg)!),
           outputPath: expandOutputPattern(pattern, { package: pkg }),
         }));
       }
       return [{ data: buildModelTemplateData(root), outputPath: expandOutputPattern(pattern, {}) }];
     };
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/scope-walk.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the package suite + typecheck**

Run: `cd server/typescript/packages/codegen-ts && bun test && bun run typecheck`
Expected: PASS — existing `templateGenerator` callers (docs) still pass `walk`, so they hit the `hasWalk` path unchanged.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/generators/template-generator.ts server/typescript/packages/codegen-ts/test/template-codegen/scope-walk.test.ts
git commit -m "feat(codegen-ts): built-in scope walks (perEntity/perPackage/perModel) in templateGenerator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 5: JSON template-spec shape + parser + schema

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/template-codegen/template-spec.ts`
- Create: `server/typescript/packages/codegen-ts/src/template-codegen/template-spec.schema.json`
- Test: `server/typescript/packages/codegen-ts/test/template-codegen/template-spec.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TemplateSpecEntry { name: string; template: string; scope: "perEntity" | "perPackage" | "perModel"; outputPattern: string; format?: RenderFormat; target?: string; }
  export interface TemplateSpecFile { generators: TemplateSpecEntry[]; }
  export function parseTemplateSpec(json: unknown): TemplateSpecFile;   // validates shape, throws on bad input
  export function templateSpecToGenerators(spec: TemplateSpecFile): Generator[];  // maps each entry → templateGenerator(...)
  ```
- This is the **CLI-port-facing surface** (C#/Python reuse the JSON shape + schema). On TS it lets a consumer load a spec file and spread it into `generators`. The schema file is the published contract.

- [ ] **Step 1: Write the failing test**

```ts
// test/template-codegen/template-spec.test.ts
import { describe, test, expect } from "bun:test";
import { parseTemplateSpec, templateSpecToGenerators } from "../../src/template-codegen/template-spec.js";

const VALID = {
  generators: [
    { name: "svc", template: "service/entity", scope: "perEntity", outputPattern: "{name}.service.ts" },
    { name: "reg", template: "app/registry", scope: "perModel", outputPattern: "registry.ts", format: "text" },
  ],
};

describe("parseTemplateSpec", () => {
  test("accepts a valid spec", () => {
    const spec = parseTemplateSpec(VALID);
    expect(spec.generators.length).toBe(2);
    expect(spec.generators[0]!.scope).toBe("perEntity");
  });
  test("rejects an unknown scope", () => {
    expect(() => parseTemplateSpec({ generators: [{ name: "x", template: "t", scope: "perThing", outputPattern: "x" }] }))
      .toThrow(/scope/i);
  });
  test("rejects a missing required field", () => {
    expect(() => parseTemplateSpec({ generators: [{ name: "x", template: "t", scope: "perModel" }] }))
      .toThrow(/outputPattern/i);
  });
  test("rejects a non-object", () => {
    expect(() => parseTemplateSpec(null)).toThrow();
  });
});

describe("templateSpecToGenerators", () => {
  test("maps each entry to a Generator with the entry name", () => {
    const gens = templateSpecToGenerators(parseTemplateSpec(VALID));
    expect(gens.map((g) => g.name)).toEqual(["svc", "reg"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/template-spec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/template-codegen/template-spec.ts
// The declarative JSON template-spec the CLI ports (C#/Python) consume, and TS
// can spread into `generators`. Shape is the cross-port contract (SP-1 §4).
import type { RenderFormat } from "@metaobjectsdev/render";
import type { Generator } from "../generator.js";
import { templateGenerator } from "../generators/template-generator.js";

const SCOPES = ["perEntity", "perPackage", "perModel"] as const;
type Scope = (typeof SCOPES)[number];

export interface TemplateSpecEntry {
  name: string;
  template: string;
  scope: Scope;
  outputPattern: string;
  format?: RenderFormat;
  target?: string;
}
export interface TemplateSpecFile { generators: TemplateSpecEntry[]; }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseTemplateSpec(json: unknown): TemplateSpecFile {
  if (!isRecord(json) || !Array.isArray(json.generators)) {
    throw new Error("template-spec: expected an object with a `generators` array");
  }
  const generators = json.generators.map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`template-spec generators[${i}]: expected an object`);
    for (const key of ["name", "template", "scope", "outputPattern"] as const) {
      if (typeof raw[key] !== "string" || raw[key] === "") {
        throw new Error(`template-spec generators[${i}]: missing or empty required string '${key}'`);
      }
    }
    if (!SCOPES.includes(raw.scope as Scope)) {
      throw new Error(`template-spec generators[${i}]: scope must be one of ${SCOPES.join(" | ")}, got '${String(raw.scope)}'`);
    }
    const entry: TemplateSpecEntry = {
      name: raw.name as string, template: raw.template as string,
      scope: raw.scope as Scope, outputPattern: raw.outputPattern as string,
    };
    if (typeof raw.format === "string") entry.format = raw.format as RenderFormat;
    if (typeof raw.target === "string") entry.target = raw.target;
    return entry;
  });
  return { generators };
}

export function templateSpecToGenerators(spec: TemplateSpecFile): Generator[] {
  return spec.generators.map((e) =>
    templateGenerator({
      name: e.name, template: e.template, scope: e.scope, outputPattern: e.outputPattern,
      ...(e.format !== undefined ? { format: e.format } : {}),
      ...(e.target !== undefined ? { target: e.target } : {}),
    }),
  );
}
```

```json
// src/template-codegen/template-spec.schema.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://metaobjects.dev/schema/template-spec.json",
  "title": "MetaObjects template-codegen spec",
  "type": "object",
  "required": ["generators"],
  "additionalProperties": false,
  "properties": {
    "generators": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "template", "scope", "outputPattern"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "template": { "type": "string", "minLength": 1 },
          "scope": { "enum": ["perEntity", "perPackage", "perModel"] },
          "outputPattern": { "type": "string", "minLength": 1 },
          "format": { "enum": ["text", "html", "xml", "csv", "json", "markdown", "spreadsheet"] },
          "target": { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/template-spec.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add a schema↔parser drift test**

Append to `template-spec.test.ts`:

```ts
import schema from "../../src/template-codegen/template-spec.schema.json" with { type: "json" };

test("schema enumerates the same scopes the parser accepts", () => {
  const scopeEnum = (schema as any).properties.generators.items.properties.scope.enum;
  expect(scopeEnum).toEqual(["perEntity", "perPackage", "perModel"]);
});
```

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/template-spec.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Ensure the schema ships — confirm `files: ["src"]` already includes it (it does); no package.json change needed. Commit**

```bash
git add server/typescript/packages/codegen-ts/src/template-codegen/template-spec.ts server/typescript/packages/codegen-ts/src/template-codegen/template-spec.schema.json server/typescript/packages/codegen-ts/test/template-codegen/template-spec.test.ts
git commit -m "feat(codegen-ts): JSON template-spec shape + parser + schema (CLI-port contract)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 6: Public exports

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/index.ts`
- Test: `server/typescript/packages/codegen-ts/test/template-codegen/exports.test.ts`

**Interfaces:**
- Produces: from `@metaobjectsdev/codegen-ts` — `perPackage`, `perModel` (alongside existing `perEntity`/`oncePerRun`); `expandOutputPattern`; `buildEntityTemplateData`/`buildPackageTemplateData`/`buildModelTemplateData` + their types; `parseTemplateSpec`/`templateSpecToGenerators` + `TemplateSpecFile`/`TemplateSpecEntry`.

- [ ] **Step 1: Write the failing test**

```ts
// test/template-codegen/exports.test.ts
import { describe, test, expect } from "bun:test";
import * as api from "../../src/index.js";

describe("public exports", () => {
  test("scope helpers + template-codegen API are exported", () => {
    for (const name of [
      "perEntity", "perPackage", "perModel", "oncePerRun",
      "expandOutputPattern",
      "buildEntityTemplateData", "buildPackageTemplateData", "buildModelTemplateData",
      "parseTemplateSpec", "templateSpecToGenerators",
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/exports.test.ts`
Expected: FAIL — new names not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/index.ts`:
1. Update the generator export line (currently `export { perEntity, oncePerRun } from "./generator.js";`) to:
   ```ts
   export { perEntity, perPackage, perModel, oncePerRun } from "./generator.js";
   ```
2. Add a block:
   ```ts
   // SP-1 declarative Mustache template-codegen — scope walks, neutral data dict,
   // output-pattern, and the JSON template-spec the CLI ports reuse.
   export { expandOutputPattern } from "./template-codegen/output-pattern.js";
   export {
     buildEntityTemplateData, buildPackageTemplateData, buildModelTemplateData,
   } from "./template-codegen/template-data.js";
   export type {
     FieldTemplateData, EntityTemplateData, PackageTemplateData, ModelTemplateData,
   } from "./template-codegen/template-data.js";
   export { parseTemplateSpec, templateSpecToGenerators } from "./template-codegen/template-spec.js";
   export type { TemplateSpecEntry, TemplateSpecFile } from "./template-codegen/template-spec.js";
   ```

- [ ] **Step 4: Run test + typecheck**

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/exports.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/index.ts server/typescript/packages/codegen-ts/test/template-codegen/exports.test.ts
git commit -m "feat(codegen-ts): export template-codegen public API

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 7: Cross-port conformance corpus + TS gate

**Files:**
- Create: `fixtures/template-codegen-conformance/README.md`
- Create: `fixtures/template-codegen-conformance/metadata/meta.shop.json`
- Create: `fixtures/template-codegen-conformance/templates/{entity,package,model}.mustache`
- Create: `fixtures/template-codegen-conformance/spec.json`
- Create: `fixtures/template-codegen-conformance/expected/**` (generated, then committed)
- Create: `server/typescript/packages/codegen-ts/test/template-codegen/conformance.test.ts`

**Interfaces:**
- Consumes: `parseTemplateSpec`, `templateSpecToGenerators`, `runGen`, the metadata loader.
- Produces: a port-agnostic corpus (metadata + templates + `spec.json` + `expected/`) every port runs. The TS test loads the metadata, runs the spec, and asserts byte-identical output against `expected/`.

- [ ] **Step 1: Author the corpus inputs**

`fixtures/template-codegen-conformance/metadata/meta.shop.json` — two entities in one package, exercising the dict fields (string + maxLength, enum, a relationship, a primary identity):

```json
{ "metadata.root": {
    "package": "shop",
    "children": [
      { "object.entity": { "name": "Product", "children": [
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "name", "@maxLength": 120, "children": [ { "validator.required": {} } ] } },
        { "field.enum": { "name": "status", "@values": ["ACTIVE", "ARCHIVED"] } },
        { "identity.primary": { "@fields": ["id"] } }
      ] } },
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "productId" } },
        { "identity.primary": { "@fields": ["id"] } },
        { "relationship.association": { "name": "product", "@cardinality": "one", "@objectRef": "Product" } }
      ] } }
    ]
}}
```

`templates/entity.mustache`:
```
// {{name}} ({{package}})
{{#fields}}- {{name}}: {{type}}{{#isArray}}[]{{/isArray}}{{#required}} required{{/required}}{{#maxLength}} maxLength={{maxLength}}{{/maxLength}}
{{/fields}}
{{#relationships}}rel {{name}} -> {{targetRef}} ({{cardinality}})
{{/relationships}}
```

`templates/package.mustache`:
```
package {{package}}: {{#entities}}{{name}} {{/entities}}
```

`templates/model.mustache`:
```
model:
{{#packages}}  {{package}}: {{#entities}}{{name}} {{/entities}}
{{/packages}}
```

`spec.json`:
```json
{ "generators": [
  { "name": "ent", "template": "entity", "scope": "perEntity", "outputPattern": "{name}.txt" },
  { "name": "pkg", "template": "package", "scope": "perPackage", "outputPattern": "{package}/_package.txt" },
  { "name": "mdl", "template": "model", "scope": "perModel", "outputPattern": "_model.txt" }
] }
```

`README.md`: one paragraph describing the corpus + that every port runs `spec.json` over `metadata/` with `templates/` and must byte-match `expected/`.

- [ ] **Step 2: Write the conformance test (initially generates, then asserts)**

```ts
// test/template-codegen/conformance.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { runGen, defineConfig, parseTemplateSpec, templateSpecToGenerators } from "../../src/index.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/template-codegen-conformance");

function walkFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkFiles(p, base) : [relative(base, p)];
  });
}

describe("template-codegen conformance (TS)", () => {
  test("spec.json over metadata/ matches expected/ byte-for-byte", async () => {
    const spec = parseTemplateSpec(JSON.parse(readFileSync(join(CORPUS, "spec.json"), "utf8")));
    const loader = new MetaDataLoader();
    const res = await loader.load([new FileSource(join(CORPUS, "metadata", "meta.shop.json"))]);
    expect(res.errors).toEqual([]);

    const out = mkdtempSync(join(tmpdir(), "tmpl-conf-"));
    try {
      await runGen({
        config: defineConfig({
          outDir: out, extStyle: "none", dbImport: "~/db", dialect: "sqlite",
          generators: templateSpecToGenerators(spec),
        }),
        metadata: res.root,
        projectRoot: CORPUS, // templates/ resolves under the corpus
      });
      const expectedDir = join(CORPUS, "expected");
      const got = walkFiles(out).sort();
      const want = walkFiles(expectedDir).sort();
      expect(got).toEqual(want);
      for (const rel of want) {
        expect(`${rel}:\n${readFileSync(join(out, rel), "utf8")}`)
          .toBe(`${rel}:\n${readFileSync(join(expectedDir, rel), "utf8")}`);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
```

> Confirm the `CORPUS` relative depth: from `codegen-ts/test/template-codegen/` to the repo-root `fixtures/` is `../../../../../../fixtures/...`. Adjust the `..` count if the test fails to find `spec.json` — print `CORPUS` once to verify.

- [ ] **Step 3: Generate the expected/ tree once, then verify it is correct**

Temporarily point the test's `out` at `join(CORPUS, "expected")` (or add a throwaway script that runs the same `runGen`), run it, and **inspect** the emitted files by eye — confirm `Product.txt`, `Order.txt`, `shop/_package.txt`, and `_model.txt` contain the expected structural content (e.g. `Order.txt` has `rel product -> Product (one)`; `Product.txt` has `name: string required maxLength=120` and `status: enum`). Then restore the test to emit to a tmp dir and assert against `expected/`.

Run: `cd server/typescript/packages/codegen-ts && bun test test/template-codegen/conformance.test.ts`
Expected: PASS once `expected/` is committed.

- [ ] **Step 4: Run the whole package suite + typecheck**

Run: `cd server/typescript/packages/codegen-ts && bun test && bun run typecheck`
Expected: PASS — full green.

- [ ] **Step 5: Commit**

```bash
git add fixtures/template-codegen-conformance server/typescript/packages/codegen-ts/test/template-codegen/conformance.test.ts
git commit -m "test(codegen-ts): template-codegen conformance corpus + TS gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 8: Final verification + workspace typecheck

- [ ] **Step 1: Run the full server-TS suite scoped**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: all green (existing + new ~7 test files).

- [ ] **Step 2: Workspace build + typecheck**

Run (repo root): `bun run --filter '*' build && bun run --filter '*' typecheck`
Expected: no errors.

- [ ] **Step 3: Confirm packed tarball includes the schema asset**

Run: `cd server/typescript/packages/codegen-ts && npm pack --dry-run 2>&1 | grep template-spec.schema.json`
Expected: the schema file is listed (ships via `files: ["src"]`).

- [ ] **Step 4: No commit needed if clean; otherwise commit any fixups, then proceed to the no-mistakes gate (isolated worktree, `--skip=ci`, admin-merge after local green) per the repo flow.**

---

## Self-Review (against the spec)

- **§3.1 scope names** → Tasks 1, 4, 5, 7 use `perEntity`/`perPackage`/`perModel` exactly; `oncePerRun` aliased+deprecated (Task 1).
- **§3.2 data dict** → Task 3 emits the exact field set (name/package/fields[name,type,required,isArray,maxLength?,enumValues?]/identities[kind,fields]/relationships[name,cardinality,targetRef]); abstracts excluded; `type` is neutral subtype, arrayness via `isArray`.
- **§3.3 output-pattern grammar** → Task 2 (`{name}`/`{Name}`/`{package}`; unknown → throw).
- **§3.4 template resolution** → reuses existing `projectProvider` (Task 4 passes `projectRoot`; templates resolve under `templates/`).
- **§3.5 conformance corpus** → Task 7 creates `fixtures/template-codegen-conformance/` + TS gate.
- **§4 TS wiring** → Task 4 (`scope`+`outputPattern` on `templateGenerator`; `walk` kept for power users); Task 5 (JSON spec + schema, the CLI-port contract).
- **§5 SP-1a deliverables** → scope walks (T4) + `perPackage` helper (T1) + `oncePerRun`→`perModel` (T1) + outputPattern (T2) + data-dict (T3) + JSON-spec schema (T5) + corpus (T7). All covered.
- **Out of scope (§6)** honored: no native-generator registration, no docs rewrite, no extra data-dict fields beyond v1, no other ports.

Placeholder scan: none. Type consistency: `EntityTemplateData`/`TemplateSpecEntry`/`scope` union spelled identically across Tasks 3/4/5/6. Accessor caveat flagged in Task 3 for the implementer to narrow against the real `MetaField.attr` return type.

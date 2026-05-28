# Cross-Port templateGenerator — Plan 0: Conformance Fixtures + TS Harness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the shared declarative fixture format and a TS reference harness for cross-port `templateGenerator()` byte-equivalence testing. This locks the contract every per-port implementation will hang off.

**Architecture:** Each fixture is a self-contained directory under `fixtures/render-conformance/template-generator/`. The fixture declares its metadata (entities + fields), its Mustache template, the *declarative* walk result (`walk.json`: list of `{entity, data, outputPath}` tuples), and the byte-exact `expected/` outputs. A small per-port adapter turns `walk.json` into the port's walk-function signature; the assertion is "files emitted by `templateGenerator()` equal `expected/` byte-for-byte." The TS adapter ships with this plan; Java / C# / Python adapters ship in their respective plans.

**Tech Stack:** TypeScript / Bun test runner / Mustache (via `@metaobjectsdev/render`) / programmatic metadata construction (via `_meta-build.ts` helpers).

**Scope boundary:** This plan ships fixtures + TS harness only. Per-port implementations (`templateGenerator` in C# / Java / Python) and their conformance adapters are out of scope — they get their own plans (Plans 1-3).

---

## File Structure

**Fixtures** (under `fixtures/render-conformance/template-generator/`):

```
fixtures/render-conformance/template-generator/
  README.md                                    # Fixture format spec
  fixture-001-flat-entity-walk/
    meta.json                                  # { format, entities: [{name, fields: [...]}] }
    template.mustache                          # The shared template
    walk.json                                  # [{ entity, data, outputPath }, ...]
    expected/<outputPath>                      # Byte-exact expected files (one per walk entry)
  fixture-002-aggregate-walk/
    (same shape)
  fixture-003-filter-driven-walk/
    (same shape)
```

**Harness** (TS side):

- `server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts` — the harness; one Bun `describe` per fixture, one `test` per emitted file.

## Self-contained Files (no per-port harness duplication)

Each fixture's `meta.json` describes its own metadata in a **test-only** declarative schema (not the YAML loader format) — this keeps fixtures simple and avoids coupling the conformance corpus to any port's specific loader. The TS adapter parses `meta.json` and builds a `MetaRoot` programmatically via the existing `_meta-build` helpers; other ports do the same with their own equivalent.

---

## Task 1: Document the fixture format (README)

**Files:**
- Create: `fixtures/render-conformance/template-generator/README.md`

- [ ] **Step 1: Write the README**

```markdown
# template-generator conformance fixtures

Cross-port byte-equivalence corpus for the `templateGenerator()` factory
(see `spec/design-docs/2026-05-28-cross-port-template-generator.md`).

Each port's conformance harness reads every fixture directory under
`fixtures/render-conformance/template-generator/`, runs its
`templateGenerator()` with the fixture's metadata + template + walk,
and asserts each emitted file equals `expected/<outputPath>` byte-for-byte.

## Fixture format

Each fixture is a directory containing:

| File | Purpose |
|---|---|
| `meta.json` | Declarative metadata (entities + fields) the harness materializes into a MetaRoot. |
| `template.mustache` | The shared Mustache template. |
| `walk.json` | Declarative walk result: list of `{ entity?, data, outputPath }` tuples. |
| `expected/<outputPath>` | Byte-exact expected output, one file per walk entry. |

### `meta.json` schema

```json
{
  "format": "text",
  "entities": [
    { "name": "Post", "fields": [
        { "name": "id", "type": "long" },
        { "name": "title", "type": "string" }
    ]},
    { "name": "Comment", "fields": [
        { "name": "id", "type": "long" }
    ]}
  ]
}
```

`format` is one of the port's render formats (`text` / `html` / `markdown` / etc.) and drives escaping. `entities[].fields[].type` is one of the shared `FIELD_SUBTYPE_*` shortnames (`string`, `long`, `boolean`, `int`, `double`, `date`).

### `walk.json` schema

```json
[
  { "entity": "Post",    "data": { "name": "Post" },    "outputPath": "Post.txt" },
  { "entity": "Comment", "data": { "name": "Comment" }, "outputPath": "Comment.txt" }
]
```

- `entity` (optional): name of the entity from `meta.json` this walk entry corresponds to. The per-port adapter MAY use this to look up the actual entity object and validate the data dict refers to a known entity. Omit for aggregator-pattern fixtures (one output file aggregating all entities).
- `data`: the dict passed to `render()` as the payload for this output.
- `outputPath`: relative path under the fixture's `expected/` directory.

### Adding a new fixture

1. Create the fixture directory.
2. Write `meta.json`, `template.mustache`, `walk.json`.
3. Generate `expected/<outputPath>` by hand (or by running the TS harness with a deliberate placeholder + copying the output once you've eyeball-confirmed it).
4. Run every port's conformance harness — all should pass.

## Per-port adapters

Each port's conformance harness:

1. Parses `meta.json` → builds a MetaRoot via its own `_meta-build`-equivalent helpers.
2. Parses `walk.json` → builds a walk function returning those tuples (resolving `entity` references against the MetaRoot when present).
3. Reads `template.mustache` → registers it in an in-memory Provider.
4. Calls `templateGenerator(...)` → gets emitted files.
5. For each emitted file, asserts its content equals `expected/<outputPath>` byte-for-byte.

The adapter is the only per-port code in the conformance suite.
```

- [ ] **Step 2: Commit**

```bash
git add fixtures/render-conformance/template-generator/README.md
git commit -m "docs(fixtures): template-generator conformance format spec"
```

---

## Task 2: fixture-001 — flat per-entity walk

**Files:**
- Create: `fixtures/render-conformance/template-generator/fixture-001-flat-entity-walk/meta.json`
- Create: `fixtures/render-conformance/template-generator/fixture-001-flat-entity-walk/template.mustache`
- Create: `fixtures/render-conformance/template-generator/fixture-001-flat-entity-walk/walk.json`
- Create: `fixtures/render-conformance/template-generator/fixture-001-flat-entity-walk/expected/Post.txt`
- Create: `fixtures/render-conformance/template-generator/fixture-001-flat-entity-walk/expected/Comment.txt`

- [ ] **Step 1: Create `meta.json`**

```json
{
  "format": "text",
  "entities": [
    {
      "name": "Post",
      "fields": [
        { "name": "id", "type": "long" },
        { "name": "title", "type": "string" }
      ]
    },
    {
      "name": "Comment",
      "fields": [
        { "name": "id", "type": "long" },
        { "name": "body", "type": "string" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Create `template.mustache`**

```mustache
# {{name}}

Fields:
{{#fields}}
- {{name}} ({{type}})
{{/fields}}
```

- [ ] **Step 3: Create `walk.json`**

```json
[
  {
    "entity": "Post",
    "data": {
      "name": "Post",
      "fields": [
        { "name": "id", "type": "long" },
        { "name": "title", "type": "string" }
      ]
    },
    "outputPath": "Post.txt"
  },
  {
    "entity": "Comment",
    "data": {
      "name": "Comment",
      "fields": [
        { "name": "id", "type": "long" },
        { "name": "body", "type": "string" }
      ]
    },
    "outputPath": "Comment.txt"
  }
]
```

- [ ] **Step 4: Create `expected/Post.txt`** (note trailing newline)

```
# Post

Fields:
- id (long)
- title (string)
```

- [ ] **Step 5: Create `expected/Comment.txt`** (note trailing newline)

```
# Comment

Fields:
- id (long)
- body (string)
```

- [ ] **Step 6: Commit**

```bash
git add fixtures/render-conformance/template-generator/fixture-001-flat-entity-walk/
git commit -m "fixtures(template-gen): fixture-001 flat per-entity walk"
```

---

## Task 3: TS harness — discover + load + run + assert

**Files:**
- Create: `server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts`

- [ ] **Step 1: Write the harness** (covers fixture-001 only at this point — fixtures 002 and 003 are added in later tasks; harness auto-discovers them via `readdirSync`)

```typescript
// Cross-port byte-equivalence harness for templateGenerator().
//
// Fixture format: see fixtures/render-conformance/template-generator/README.md.
// For each fixture dir, materializes the meta.json into a MetaRoot, builds a
// walk function from walk.json, runs templateGenerator(), and asserts each
// emitted file equals expected/<outputPath> byte-for-byte.

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { InMemoryProvider, type RenderFormat } from "@metaobjectsdev/render";
import { templateGenerator } from "../../src/generators/template-generator.js";
import {
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_DATE,
  OBJECT_SUBTYPE_ENTITY,
  type MetaRoot, type MetaObject,
} from "@metaobjectsdev/metadata";
import { metaRoot, metaObject, metaField } from "../_meta-build.js";
import type { GenContext } from "../../src/generator.js";

const CORPUS = join(
  import.meta.dir,
  "../../../../../../fixtures/render-conformance/template-generator",
);

interface FixtureField { name: string; type: string }
interface FixtureEntity { name: string; fields: FixtureField[] }
interface FixtureMeta { format: RenderFormat; entities: FixtureEntity[] }
interface WalkEntry { entity?: string; data: object; outputPath: string }

const FIELD_TYPE_MAP: Record<string, string> = {
  string: FIELD_SUBTYPE_STRING,
  long: FIELD_SUBTYPE_LONG,
  int: FIELD_SUBTYPE_INT,
  double: FIELD_SUBTYPE_DOUBLE,
  boolean: FIELD_SUBTYPE_BOOLEAN,
  date: FIELD_SUBTYPE_DATE,
};

function buildRootFromMeta(meta: FixtureMeta): MetaRoot {
  const root = metaRoot("root", "conformance");
  for (const e of meta.entities) {
    const obj = metaObject(OBJECT_SUBTYPE_ENTITY, e.name);
    for (const f of e.fields) {
      const subtype = FIELD_TYPE_MAP[f.type];
      if (!subtype) throw new Error(`Unknown field type "${f.type}" in fixture`);
      obj.addChild(metaField(subtype, f.name));
    }
    root.addChild(obj);
  }
  return root;
}

function makeCtx(root: MetaRoot): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    warn: () => {},
  };
}

function fixtureDirs(): string[] {
  if (!existsSync(CORPUS)) return [];
  return readdirSync(CORPUS)
    .filter((n) => n.startsWith("fixture-"))
    .filter((n) => statSync(join(CORPUS, n)).isDirectory())
    .sort();
}

function collectExpectedFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(dir, "expected");
  if (!existsSync(root)) return out;
  function recurse(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) recurse(full);
      else out.set(relative(root, full), readFileSync(full, "utf8"));
    }
  }
  recurse(root);
  return out;
}

describe("template-generator conformance corpus", () => {
  const dirs = fixtureDirs();
  expect(dirs.length).toBeGreaterThan(0);

  for (const name of dirs) {
    describe(name, () => {
      const dir = join(CORPUS, name);
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as FixtureMeta;
      const tpl = readFileSync(join(dir, "template.mustache"), "utf8");
      const walk = JSON.parse(readFileSync(join(dir, "walk.json"), "utf8")) as WalkEntry[];
      const expected = collectExpectedFiles(dir);

      test("emits exactly the files declared in walk.json", async () => {
        const provider = new InMemoryProvider({ "conformance/template": tpl });
        const root = buildRootFromMeta(meta);
        const byName = new Map<string, MetaObject>(root.objects().map((o) => [o.name, o]));
        const gen = templateGenerator({
          name: name,
          template: "conformance/template",
          provider,
          format: meta.format,
          walk: () => walk.map((w) => {
            if (w.entity !== undefined && !byName.has(w.entity)) {
              throw new Error(`walk.json references unknown entity "${w.entity}"`);
            }
            return { data: w.data, outputPath: w.outputPath };
          }),
        });
        const files = await gen.generate(makeCtx(root));
        const emittedPaths = files.map((f) => f.path).sort();
        const expectedPaths = walk.map((w) => w.outputPath).sort();
        expect(emittedPaths).toEqual(expectedPaths);
      });

      for (const w of walk) {
        test(`expected/${w.outputPath} matches byte-for-byte`, async () => {
          const provider = new InMemoryProvider({ "conformance/template": tpl });
          const root = buildRootFromMeta(meta);
          const gen = templateGenerator({
            name: name,
            template: "conformance/template",
            provider,
            format: meta.format,
            walk: () => walk.map((x) => ({ data: x.data, outputPath: x.outputPath })),
          });
          const files = await gen.generate(makeCtx(root));
          const emitted = files.find((f) => f.path === w.outputPath);
          expect(emitted).toBeDefined();
          const exp = expected.get(w.outputPath);
          expect(exp).toBeDefined();
          expect(emitted!.content).toBe(exp!);
        });
      }
    });
  }
});
```

- [ ] **Step 2: Run harness to verify fixture-001 passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/conformance/template-generator-conformance.test.ts`

Expected: All tests pass. The describe `template-generator conformance corpus > fixture-001-flat-entity-walk` reports:
- `emits exactly the files declared in walk.json` — PASS
- `expected/Post.txt matches byte-for-byte` — PASS
- `expected/Comment.txt matches byte-for-byte` — PASS

If a test fails with `expected.get(...)` returning undefined: the file under `expected/` doesn't match what `walk.json` declared. If the byte-for-byte assertion fails: copy `actual` (visible in the assertion failure diff) into the expected file ONLY after confirming the difference is the intended template output (don't blindly accept).

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts
git commit -m "test(codegen-ts): conformance harness for cross-port templateGenerator"
```

---

## Task 4: fixture-002 — aggregator walk (ONE file from all entities)

**Files:**
- Create: `fixtures/render-conformance/template-generator/fixture-002-aggregate-walk/meta.json`
- Create: `fixtures/render-conformance/template-generator/fixture-002-aggregate-walk/template.mustache`
- Create: `fixtures/render-conformance/template-generator/fixture-002-aggregate-walk/walk.json`
- Create: `fixtures/render-conformance/template-generator/fixture-002-aggregate-walk/expected/index.txt`

- [ ] **Step 1: Create `meta.json`**

```json
{
  "format": "text",
  "entities": [
    { "name": "Post", "fields": [{ "name": "id", "type": "long" }] },
    { "name": "Comment", "fields": [{ "name": "id", "type": "long" }] },
    { "name": "User", "fields": [{ "name": "id", "type": "long" }] }
  ]
}
```

- [ ] **Step 2: Create `template.mustache`**

```mustache
Entities ({{count}}):
{{#entities}}
- {{name}}
{{/entities}}
```

- [ ] **Step 3: Create `walk.json`**

```json
[
  {
    "data": {
      "count": 3,
      "entities": [
        { "name": "Post" },
        { "name": "Comment" },
        { "name": "User" }
      ]
    },
    "outputPath": "index.txt"
  }
]
```

Note: no `entity` field — this is an aggregate, not per-entity.

- [ ] **Step 4: Create `expected/index.txt`** (trailing newline)

```
Entities (3):
- Post
- Comment
- User
```

- [ ] **Step 5: Re-run harness to verify both fixtures pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/conformance/template-generator-conformance.test.ts`

Expected: `template-generator conformance corpus > fixture-002-aggregate-walk` reports:
- `emits exactly the files declared in walk.json` — PASS
- `expected/index.txt matches byte-for-byte` — PASS

Plus all fixture-001 tests continue to pass.

- [ ] **Step 6: Commit**

```bash
git add fixtures/render-conformance/template-generator/fixture-002-aggregate-walk/
git commit -m "fixtures(template-gen): fixture-002 aggregator walk (single output)"
```

---

## Task 5: fixture-003 — filter-driven walk (subset of entities → multiple outputs)

**Files:**
- Create: `fixtures/render-conformance/template-generator/fixture-003-filter-driven-walk/meta.json`
- Create: `fixtures/render-conformance/template-generator/fixture-003-filter-driven-walk/template.mustache`
- Create: `fixtures/render-conformance/template-generator/fixture-003-filter-driven-walk/walk.json`
- Create: `fixtures/render-conformance/template-generator/fixture-003-filter-driven-walk/expected/User.txt`
- Create: `fixtures/render-conformance/template-generator/fixture-003-filter-driven-walk/expected/Account.txt`

- [ ] **Step 1: Create `meta.json`** (Post and Comment in metadata but NOT walked — they don't produce output)

```json
{
  "format": "text",
  "entities": [
    { "name": "Post",    "fields": [{ "name": "id", "type": "long" }] },
    { "name": "Comment", "fields": [{ "name": "id", "type": "long" }] },
    { "name": "User",    "fields": [{ "name": "id", "type": "long" }, { "name": "email", "type": "string" }] },
    { "name": "Account", "fields": [{ "name": "id", "type": "long" }, { "name": "balance", "type": "double" }] }
  ]
}
```

- [ ] **Step 2: Create `template.mustache`**

```mustache
{{name}}
  {{#fields}}
  - {{name}}: {{type}}
  {{/fields}}
```

- [ ] **Step 3: Create `walk.json`** (only User and Account — Post / Comment are filtered out at walk time)

```json
[
  {
    "entity": "User",
    "data": {
      "name": "User",
      "fields": [
        { "name": "id", "type": "long" },
        { "name": "email", "type": "string" }
      ]
    },
    "outputPath": "User.txt"
  },
  {
    "entity": "Account",
    "data": {
      "name": "Account",
      "fields": [
        { "name": "id", "type": "long" },
        { "name": "balance", "type": "double" }
      ]
    },
    "outputPath": "Account.txt"
  }
]
```

- [ ] **Step 4: Create `expected/User.txt`** (trailing newline)

```
User
  - id: long
  - email: string
```

- [ ] **Step 5: Create `expected/Account.txt`** (trailing newline)

```
Account
  - id: long
  - balance: double
```

- [ ] **Step 6: Re-run harness to verify all three fixtures pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/conformance/template-generator-conformance.test.ts`

Expected: nine tests total (`emits exactly the files...` + per-file byte assertions across all three fixtures), all PASS.

- [ ] **Step 7: Commit**

```bash
git add fixtures/render-conformance/template-generator/fixture-003-filter-driven-walk/
git commit -m "fixtures(template-gen): fixture-003 filter-driven walk (subset of entities)"
```

---

## Task 6: Run the full codegen-ts test suite to confirm no regressions

- [ ] **Step 1: Run the full suite**

Run: `cd server/typescript/packages/codegen-ts && bun test`

Expected: All pre-existing tests pass + the new conformance suite. No skipped / failed tests.

- [ ] **Step 2: Run the workspace-wide TS suite as a final guard**

Run: `cd server/typescript && bun test`

Expected: All packages green. Plan 0 only added test files and fixture files — there should be zero regressions in any other package.

- [ ] **Step 3: No commit needed** (read-only verification)

---

## Task 7: Update the design doc roadmap entry

**Files:**
- Modify: `spec/design-docs/2026-05-28-cross-port-template-generator.md` — under "Conformance" section, replace the "fixture-001/002/003" stub layout with a one-line link to the shipped fixtures README.

- [ ] **Step 1: Update the design doc**

Find the block:

````markdown
```
fixtures/render-conformance/template-generator/
  fixture-001-flat-entity-walk/
    metadata/             # shared YAML — defines a small entity set
    template.mustache     # shared template
    walk.json             # declarative "what walk should return" — a list of
                          # (entity-name → data dict, output filename) tuples
                          # the per-port adapter materializes
    expected/             # byte-exact expected output files
  fixture-002-aggregate-walk/
    ...
  fixture-003-filter-driven-walk/
    ...
```
````

Replace with:

````markdown
See [the corpus README](../../fixtures/render-conformance/template-generator/README.md) for
the shipped fixture format and the three reference fixtures (flat per-entity walk,
aggregator walk, filter-driven walk). Plan 0 also ships the TS reference harness at
`server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts`.
````

- [ ] **Step 2: Commit**

```bash
git add spec/design-docs/2026-05-28-cross-port-template-generator.md
git commit -m "docs(design): link cross-port templateGen design doc to shipped fixtures"
```

---

## Self-Review

**1. Spec coverage**

Plan 0's mandate per the design doc was "Conformance via shared declarative fixtures + reference harness." Coverage:
- Declarative `walk.json` schema → Task 1 (README documents schema) + Task 3 (harness consumes it)
- Three fixtures per spec (flat per-entity, aggregate, filter-driven) → Tasks 2, 4, 5
- TS reference harness → Task 3
- Per-port adapter contract documented for future plans → Task 1 README

No gaps. The design doc's "Open questions" (e.g., should `walk.json` be canonical) are explicitly punted to Plan 1-3 implementation — Plan 0 just locks the format declaratively.

**2. Placeholder scan**

Searched for "TBD", "TODO", "implement later", "add appropriate", "similar to Task". None found. Every step has either concrete file content or a runnable command with expected output.

**3. Type consistency**

- `FixtureMeta`, `FixtureEntity`, `FixtureField`, `WalkEntry` defined in Task 3 are consistent with the JSON shapes in Tasks 2, 4, 5.
- `templateGenerator(opts)` signature matches the rc.12 factory at `server/typescript/packages/codegen-ts/src/generators/template-generator.ts`.
- `metaRoot` / `metaObject` / `metaField` helpers from `_meta-build.ts` match the existing usage in `test/generators/template-generator.test.ts`.
- `OBJECT_SUBTYPE_ENTITY` and `FIELD_SUBTYPE_*` constants are exported from `@metaobjectsdev/metadata` (verified via `server/typescript/packages/metadata/src/index.ts`).

No inconsistencies.

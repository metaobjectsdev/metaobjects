# Program A — data-name constants (TypeScript vertical) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit, per declared object, a `<Entity>Names` artifact carrying the physical
database names and per-field logical/physical names, and make the generated TypeScript
read it — so the constants are load-bearing rather than decorative.

**Architecture:** One resolution helper produces every name in a single generator run
(spec §A3), a new `namesFile()` generator emits `<Entity>.names.ts` from it (§A1/§A2),
and the entity generator references those constants instead of embedding literals (§A6).
Consumption is conditional on the names generator being active in the run, because
TypeScript's ADR-0034 scaffold-and-own model makes any new generator opt-in for existing
adopters (§A5).

**Tech Stack:** TypeScript, Bun test, ts-poet (`code` templates), Drizzle, the
`@metaobjectsdev/metadata` loader.

**Spec:** [`docs/superpowers/specs/2026-08-30-name-constants-and-magic-string-elimination-design.md`](../specs/2026-08-30-name-constants-and-magic-string-elimination-design.md) §A1–A6

**Scope note.** This plan is the TypeScript vertical plus the standalone §A4 bug fix.
Program A ships in **all five ports** — the C#/Java/Kotlin/Python fan-out follows the
shape proven here and gets its own plan. Programs B and C are out of scope entirely.

## Global Constraints

- **No magic metamodel strings.** Import named constants from
  `@metaobjectsdev/metadata/constants`. Never inline `"object.entity"`, `"@column"`, or a
  bare subtype literal. (`AGENTS.md`; this program's own doctrine.)
- **Never call `own*()` accessors** unless emitting a generated subclass. Resolving
  accessors (`attr()`, `children()`, `fields()`) are the default — `own*()` silently drops
  everything inherited via `extends`. Every `own*()` call carries a comment naming its
  sanctioned case. (ADR-0039.)
- **No `any`.** Use `unknown` and narrow.
- **Never `instanceof` a metadata node** from outside `@metaobjectsdev/metadata` — use the
  exported guards (`isMetaObject`, `isMetaField`, `isMetaSource`, …). Two physical copies
  of the package make `instanceof` return false for a real node, silently.
- **Every name comes from the same resolver, in the same run, with the same arguments as
  the DDL/ORM binding it describes.** (§A3. This is the rule the whole program rests on.)
- **Run tests scoped:** `cd server/typescript && bun test <path>`. Never a bare `bun test`
  at the repo root — it walks `java/`, `python/`, `csharp/` and takes many minutes.
- **Goldens live outside the package that stales them.** After any change to emitted
  bytes, regenerate and review `server/typescript/packages/codegen-ts/test/golden/`.

---

### Task 1: §A4 — a projection's `dbCol` must read `@column`

`projection-decl.ts:141` calls `columnNameFromField(f.name, strategy)`. That function
(`codegen-ts/src/naming.ts:41`) takes a **string**, so it structurally cannot see
`@column`; it just applies the naming strategy. The correct resolver is
`resolveColumnName(field, strategy)` (`metadata/src/naming.ts:88`), which reads
`field.attr(FIELD_ATTR_COLUMN)` first and falls back to the strategy.

A projection field that declares or inherits `@column` therefore gets a `dbCol` that
disagrees with the column the DDL actually emits. It is invisible in-repo today because no
fixture declares a `@column` that differs from the strategy's answer — the "a corpus that
loses coverage fails nothing" pattern. **The regression fixture closing that gap is the
point of this task, not the one-line fix.**

This is a bug independent of the rest of Program A and ships on its own.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/projection-decl.ts:141`
- Test: `server/typescript/packages/codegen-ts/test/templates/projection-decl.test.ts`

**Interfaces:**
- Consumes: `resolveColumnName(field: MetaData, strategy?: ColumnNamingStrategy): string`
  from `@metaobjectsdev/metadata`.
- Produces: nothing new. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Append to `server/typescript/packages/codegen-ts/test/templates/projection-decl.test.ts`.
Match the loader idiom already used in `test/projection/entity-file.test.ts`.

```ts
// §A4 — the coverage gap that hid the bug: a @column that DIFFERS from what the naming
// strategy would produce. Every pre-existing fixture used a @column equal to the
// strategy's answer, so the wrong resolver returned the right string by coincidence.
test("a projection field's dbCol honours @column, not just the naming strategy", async () => {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "Author",
            children: [
              { "source.rdb": { "@table": "authors" } },
              { "field.int": { name: "id" } },
              // snake_case of "firstName" is "first_name"; @column deliberately is NOT that.
              { "field.string": { name: "firstName", "@column": "given_name" } },
              { "identity.primary": { name: "id", "@fields": "id" } },
            ],
          },
        },
        {
          // FR-024 (B4b): a projection NEVER object-level `extends` an entity — subtype-rules
          // rejects it. Each field binds individually with `extends: "<Entity>.<field>"`,
          // which is also the stronger regression: the projection's own field node carries no
          // @column of its own, so this exercises resolveColumnName's INHERITANCE path.
          "object.projection": {
            name: "AuthorSummary",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_author_summary" } },
              { "field.int": { name: "id", extends: "Author.id" } },
              { "field.string": { name: "firstName", extends: "Author.firstName" } },
              { "identity.primary": { name: "id", extends: "Author.id" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(result.errors).toEqual([]);
  const proj = result.root.children().find((c) => c.name === "AuthorSummary") as MetaObject;

  const out = renderProjectionDecl(proj, result.root, {
    dialect: "postgres",
    columnNamingStrategy: "snake_case",
  });

  expect(out).toContain(`dbCol: "given_name"`);
  expect(out).not.toContain(`dbCol: "first_name"`);
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
cd server/typescript && bun test packages/codegen-ts/test/templates/projection-decl.test.ts -t "honours @column"
```

Expected: FAIL. The received output contains `dbCol: "first_name"` — the strategy's answer,
with `@column` dropped. If it fails any other way (loader error, missing export), fix the
fixture before touching the source; a test that fails for the wrong reason proves nothing.

- [ ] **Step 3: Fix the call site**

In `server/typescript/packages/codegen-ts/src/templates/projection-decl.ts`, change the
`dbCol` line inside the `allFields.map(...)`:

```ts
    // §A4: resolveColumnName, NOT columnNameFromField — the latter takes a string and so
    // cannot read @column, silently substituting the naming strategy's answer for a
    // declared or inherited physical name. ADR-0039: resolving accessor, so a projection
    // field inheriting @column through `extends` resolves it.
    const dbCol = resolveColumnName(f, columnNamingStrategy);
```

Add `resolveColumnName` to the existing `@metaobjectsdev/metadata` import in that file. If
`columnNameFromField` becomes unused there, drop it from the import list; leave it exported
from `naming.ts` — `column-mapper.ts` and `extract-view-spec.ts` use it correctly, behind
their own `@column` checks.

- [ ] **Step 4: Run the test and the surrounding suites**

```bash
cd server/typescript && bun test packages/codegen-ts/test/templates/projection-decl.test.ts
cd server/typescript && bun test packages/codegen-ts/test/projection
```

Expected: all PASS. The new test passes; nothing else moves, because every existing fixture
used a `@column` equal to the strategy's answer.

- [ ] **Step 5: Check the goldens did not move**

```bash
git status --short server/typescript/packages/codegen-ts/test/golden/
```

Expected: **empty**. No committed golden declares a divergent `@column`, so byte-identical
output is the correct result here. If a golden did move, stop and read the diff — it means
a shipped example was getting the wrong column name.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/projection-decl.ts \
        server/typescript/packages/codegen-ts/test/templates/projection-decl.test.ts
git commit -m "fix(codegen-ts): a projection's dbCol ignored @column

projection-decl.ts passed f.name (a string) to columnNameFromField, which applies the
naming strategy and cannot read @column. A projection field declaring or inheriting a
physical column name got the strategy's guess instead, disagreeing with the column the
DDL emits.

Invisible until now because no fixture declared a @column that DIFFERS from the
strategy's answer, so the wrong resolver returned the right string by coincidence. The
regression test closes that coverage gap; the fix is one call."
```

---

### Task 2: The name-resolution helper

§A3 is the rule the program rests on: every name must come from the same resolver, in the
same run, with the same arguments as the binding it describes. The way to make that
structural rather than a convention is one function that both the names generator (Task 3)
and the consuming entity generator (Task 5) call.

§A2 fixes the shape: per object `{ kind, schema, name, readOnly }` — **not** kind-specific
keys, because `resolveTableName` delegates to `source.physicalName` for any `@kind`, so
`$table` can already hold a view or stored-proc name. Per field `{ name, column }`, always
both, always distinguished — the showcase already collides (`createdAt` / `created_at`).

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/names.ts`
- Test: `server/typescript/packages/codegen-ts/test/names.test.ts`

**Interfaces:**
- Consumes: `resolveTableName(entity)`, `resolveTableSchema(entity)`,
  `resolveColumnName(field, strategy)` from `@metaobjectsdev/metadata`.
- Produces — Tasks 3 and 5 both import these exact names:

```ts
export interface FieldNames { readonly name: string; readonly column: string; }
export interface ObjectNames {
  readonly kind: string;
  readonly name: string;
  readonly schema?: string;
  readonly readOnly: boolean;
  readonly fields: Readonly<Record<string, FieldNames>>;
}
export function resolveObjectNames(
  obj: MetaObject,
  strategy?: ColumnNamingStrategy,
): ObjectNames | undefined;
```

`resolveObjectNames` returns `undefined` for an object with no primary `source.*` child —
persistability derives from a declared source, **never** from an object subtype (#248).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { resolveObjectNames } from "../src/names.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}
const obj = (root: Awaited<ReturnType<typeof load>>, name: string) =>
  root.children().find((c) => c.name === name) as MetaObject;

describe("resolveObjectNames", () => {
  test("carries kind and physical name, and both field names", async () => {
    const root = await load([{
      "object.entity": {
        name: "Subscriber",
        children: [
          { "source.rdb": { "@table": "subscribers" } },
          { "field.int": { name: "id" } },
          { "field.timestamp": { name: "createdAt", "@column": "created_at" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ],
      },
    }]);
    const n = resolveObjectNames(obj(root, "Subscriber"), "snake_case");
    expect(n?.kind).toBe("table");
    expect(n?.name).toBe("subscribers");
    expect(n?.readOnly).toBe(false);
    // The collision the shape exists for: logical name != physical column.
    expect(n?.fields.createdAt).toEqual({ name: "createdAt", column: "created_at" });
  });

  test("a view-kind source is readOnly and keeps its own kind", async () => {
    const root = await load([{
      "object.entity": {
        name: "Report",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_report" } },
          { "field.int": { name: "id" } },
        ],
      },
    }]);
    const n = resolveObjectNames(obj(root, "Report"), "snake_case");
    expect(n?.kind).toBe("view");
    expect(n?.name).toBe("v_report");
    expect(n?.readOnly).toBe(true);
  });

  test("an object with no source resolves to undefined, not a phantom table", async () => {
    // #248: persistability derives from a declared source, never from the subtype.
    const root = await load([{
      "object.value": { name: "Money", children: [{ "field.long": { name: "cents" } }] },
    }]);
    expect(resolveObjectNames(obj(root, "Money"), "snake_case")).toBeUndefined();
  });

  test("an inherited @column resolves through extends", async () => {
    // ADR-0039: resolving accessors, so a concrete field inherits its parent's @column.
    const root = await load([
      {
        "object.entity": {
          name: "BaseThing",
          abstract: true,
          children: [{ "field.string": { name: "firstName", "@column": "given_name" } }],
        },
      },
      {
        "object.entity": {
          name: "Thing",
          extends: "BaseThing",
          children: [
            { "source.rdb": { "@table": "things" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const n = resolveObjectNames(obj(root, "Thing"), "snake_case");
    expect(n?.fields.firstName?.column).toBe("given_name");
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd server/typescript && bun test packages/codegen-ts/test/names.test.ts
```

Expected: FAIL — `Cannot find module '../src/names.js'`.

- [ ] **Step 3: Implement**

```ts
/**
 * §A2/§A3 — the ONE place a data name is resolved for a generator run.
 *
 * Both the names artifact (namesFile) and the entity generator that consumes it call this,
 * so the constant and the binding it describes cannot be produced by different resolvers or
 * different arguments. That is the whole rule; a name computed twice is a name that can
 * disagree with itself.
 */
import {
  isMetaSource,
  resolveColumnName,
  resolveTableName,
  resolveTableSchema,
  type ColumnNamingStrategy,
  type MetaObject,
  type MetaSource,
  SOURCE_ROLE_PRIMARY,
} from "@metaobjectsdev/metadata";

export interface FieldNames { readonly name: string; readonly column: string; }

export interface ObjectNames {
  /** The `source.rdb @kind` value — `table` | `view` | `materializedView` | … */
  readonly kind: string;
  /** The PHYSICAL name. Not necessarily a table: resolveTableName delegates to
   *  source.physicalName for every @kind, so this can be a view or a proc. */
  readonly name: string;
  readonly schema?: string;
  readonly readOnly: boolean;
  readonly fields: Readonly<Record<string, FieldNames>>;
}

export function resolveObjectNames(
  obj: MetaObject,
  strategy?: ColumnNamingStrategy,
): ObjectNames | undefined {
  // #248: an object participates in the database iff it declares (or inherits) a primary
  // source. Never gate on the object subtype. ADR-0039: resolving children().
  //
  // isMetaSource, not `instanceof` — two physical copies of @metaobjectsdev/metadata in
  // one process give the class and the instance different identities, and the failure is
  // SILENT: the entity reads as "not backed by any store" and emits nothing.
  const source = obj.children().find(
    (c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY,
  );
  if (source === undefined) return undefined;

  const fields: Record<string, FieldNames> = {};
  // ADR-0039: fields() is the RESOLVING accessor — inherited fields must appear, and an
  // inherited @column must resolve, or the constant disagrees with the DDL.
  for (const f of obj.fields()) {
    fields[f.name] = { name: f.name, column: resolveColumnName(f, strategy) };
  }

  const schema = resolveTableSchema(obj);
  return {
    // `effectiveKind`, NOT a `kind` property — MetaSource exposes the @kind value through
    // that accessor, defaulting to "table" per ADR-0007 Rule 3, and resolving it through
    // `extends` so an inherited source's @kind is seen.
    kind: source.effectiveKind,
    name: resolveTableName(obj),
    ...(schema === undefined ? {} : { schema }),
    // Derived from the source's OWN logic, never a hand-rolled kind list here — a second
    // list would drift from the loader's the first time a read-only kind is added.
    readOnly: source.isReadOnly(),
    fields,
  };
}
```

**That import does not resolve yet — Step 3a fixes it.**

- [ ] **Step 3a: Re-export `SOURCE_ROLE_PRIMARY` from the metadata barrel**

`SOURCE_ROLE_PRIMARY` is defined at
`server/typescript/packages/metadata/src/persistence/source/source-constants.ts:115` but is
**not re-exported from `metadata/src/index.ts`**, so `codegen-ts` cannot import it. Add it
to the barrel beside the other `SOURCE_*` exports.

Do **not** inline `"primary"` instead. That is precisely the magic string this program
exists to remove, and writing one inside Program A's own first task would be the joke that
writes itself.

```bash
bun run --filter '*' build
```

Expected: clean build; the import in `names.ts` now resolves.

- [ ] **Step 4: Run the tests**

```bash
cd server/typescript && bun test packages/codegen-ts/test/names.test.ts
```

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/names.ts \
        server/typescript/packages/codegen-ts/test/names.test.ts \
        server/typescript/packages/metadata/src/index.ts
git commit -m "feat(codegen-ts): resolveObjectNames — one resolver for every data name

Spec §A2/§A3. Both the names artifact and the generated code that consumes it call this,
so a constant and the binding it describes cannot come from different resolvers. Carries
{kind, name, schema, readOnly} rather than kind-specific keys, because resolveTableName
delegates to source.physicalName for any @kind and so already returns view and proc names.
Returns undefined with no primary source (#248: persistability derives from a declared
source, never from a subtype)."
```

---

### Task 3: The `namesFile()` generator

§A1: one file per object, in the port's own idiom, copying the shape the FR-009 filter
allowlist already ships. It is a **separate generator**, never a boolean on the entity
generator — a new artifact is a MINOR under `docs/compatibility-policy.md`, adds zero bytes
to existing files, and a flag would move every `$table`-carrying golden for the same
functionality.

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/templates/names-decl.ts`
- Create: `server/typescript/packages/codegen-ts/src/reference/names.ts` (the ownable
  reference template — FR-040)
- Modify: `server/typescript/packages/codegen-ts/src/index.ts` (export both)
- Test: `server/typescript/packages/codegen-ts/test/templates/names-decl.test.ts`

**Interfaces:**
- Consumes: `resolveObjectNames`, `ObjectNames` from Task 2.
- Produces: `renderNamesDecl(obj: MetaObject, strategy?: ColumnNamingStrategy): string`
  and a `namesFile(): Generator` factory whose `name` is `"names"`. Task 5 checks for that
  exact generator name.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { renderNamesDecl } from "../../src/templates/names-decl.js";

async function subscriber(): Promise<MetaObject> {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [{
        "object.entity": {
          name: "Subscriber",
          children: [
            { "source.rdb": { "@table": "subscribers" } },
            { "field.int": { name: "id" } },
            { "field.timestamp": { name: "createdAt", "@column": "created_at" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      }],
    },
  });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(r.errors).toEqual([]);
  return r.root.children().find((c) => c.name === "Subscriber") as MetaObject;
}

describe("renderNamesDecl", () => {
  test("emits a const object carrying the physical name and both field names", async () => {
    const out = renderNamesDecl(await subscriber(), "snake_case");
    expect(out).toContain("export const SubscriberNames = {");
    expect(out).toContain(`name: "subscribers"`);
    expect(out).toContain(`kind: "table"`);
    expect(out).toContain("readOnly: false");
    expect(out).toContain(`createdAt: { name: "createdAt", column: "created_at" }`);
    expect(out).toContain("} as const;");
  });

  test("omits schema entirely when undeclared, rather than emitting undefined", async () => {
    expect(renderNamesDecl(await subscriber(), "snake_case")).not.toContain("schema");
  });

  // Field order must follow the MODEL, not declaration order — the renderer sorts for
  // exactly this reason. Rendering the SAME object twice does not test that: it is
  // deterministic whether or not the sort exists, so such a test passes with `.sort()`
  // deleted. Two fixtures declaring the same fields in different order is the test that
  // has teeth.
  test("field order does not depend on declaration order", async () => {
    const ab = await entityWithFieldOrder(["alpha", "beta"]);
    const ba = await entityWithFieldOrder(["beta", "alpha"]);
    expect(renderNamesDecl(ab, "snake_case")).toBe(renderNamesDecl(ba, "snake_case"));
  });
});
```

Write `entityWithFieldOrder(order: string[])` beside `subscriber()`: same loader idiom,
emitting `field.string` children in the given order, each with an `@column` that is NOT the
strategy's answer for its name (so the test also proves the column is carried, not
recomputed).

- [ ] **Step 2: Run and confirm it fails**

```bash
cd server/typescript && bun test packages/codegen-ts/test/templates/names-decl.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the renderer**

```ts
/**
 * §A1/§A2 — `<Entity>Names`: the physical database names for one object, as constants a
 * hand-written consumer references instead of a string literal.
 *
 * Shape copied from the FR-009 filter allowlist, which is the same problem (a per-entity
 * name artifact) already solved in all five ports. Deliberately NOT folded into the entity
 * descriptor: four of five ports have no descriptor to extend, and merging in TypeScript
 * alone would make TS the odd port out on the axis this project protects hardest.
 */
import type { ColumnNamingStrategy, MetaObject } from "@metaobjectsdev/metadata";
import { resolveObjectNames } from "../names.js";

export function renderNamesDecl(obj: MetaObject, strategy?: ColumnNamingStrategy): string {
  const n = resolveObjectNames(obj, strategy);
  if (n === undefined) return "";

  // Sorted, so output depends on the model rather than on child order.
  const fieldRows = Object.keys(n.fields).sort().map((k) => {
    const f = n.fields[k];
    if (f === undefined) return "";
    return `    ${k}: { name: ${JSON.stringify(f.name)}, column: ${JSON.stringify(f.column)} },`;
  }).filter((r) => r !== "").join("\n");

  const schemaLine = n.schema === undefined ? "" : `\n  schema: ${JSON.stringify(n.schema)},`;

  return `export const ${obj.name}Names = {
  kind: ${JSON.stringify(n.kind)},
  name: ${JSON.stringify(n.name)},${schemaLine}
  readOnly: ${n.readOnly},
  fields: {
${fieldRows}
  },
} as const;
`;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd server/typescript && bun test packages/codegen-ts/test/templates/names-decl.test.ts
```

Expected: 3 PASS.

- [ ] **Step 5: Add the generator factory as an ownable reference template**

Create `server/typescript/packages/codegen-ts/src/reference/names.ts`. Copy the header
shape from `src/reference/entity.ts`, including its `targets:` block — FR-040 requires every
reference template to document its own swap point.

```ts
/**
 * names — `<Entity>.names.ts`, the physical database names for each object.
 *
 * targets: the emit step. Replace `renderNamesDecl` to change the artifact's SHAPE
 * (e.g. flat `SUBSCRIBER_TABLE` constants instead of a nested object); keep
 * `resolveObjectNames` so the names still come from the same resolver as the DDL.
 */
import {
  perEntity,
  renderNamesDecl,
  type Generator,
} from "@metaobjectsdev/codegen-ts";

export function namesFile(): Generator {
  return {
    name: "names",
    // §A6 — the marker the runner aggregates into ResolvedGenConfig.includeNames, so the
    // entity generator can tell whether this artifact will exist. Exactly the mechanism
    // routesFileHono already uses via emitsHonoRoutes/includeHonoRoutes.
    emitsNames: true,
    generate: perEntity((entity, ctx) => {
      // The strategy lives on the RENDER CONTEXT, not on ResolvedGenConfig — `ctx.config`
      // carries outDir/extStyle/dbImport/dialect and nothing about naming.
      const body = renderNamesDecl(entity, ctx.renderContext?.columnNamingStrategy);
      if (body === "") return [];   // no primary source ⇒ no names artifact (#248)
      return [{ path: `${entity.name}.names.ts`, content: body }];
    }),
  };
}
```

Three things here are load-bearing and were wrong in an earlier draft of this plan — check
each against the source before writing:

- **`perEntity` takes ONE argument** (`src/generator.ts:73`) and returns a
  `(ctx) => Promise<EmittedFile[]>`, i.e. the `generate` function — not a whole `Generator`.
  The factory builds the object literal itself.
- **`ctx.config` is `ResolvedGenConfig`** (`src/metaobjects-config.ts:46-67`): `outDir`,
  `extStyle`, `dbImport`, `dialect`, `outputLayout`, `includeHonoRoutes`,
  `providedEnumModule`. `columnNamingStrategy` and `generators` live on the USER-facing
  config, not this one.
- **`emitsNames` must be added to the `Generator` interface** (`src/generator.ts:41`) beside
  `emitsHonoRoutes`, **in this task** — Step 6a below. Setting a property the interface does
  not declare fails Step 7's typecheck, so the declaration cannot wait for Task 5.

- [ ] **Step 6a: Declare `emitsNames` on the `Generator` interface**

In `server/typescript/packages/codegen-ts/src/generator.ts`, beside `emitsHonoRoutes`:

```ts
  /** §A6 — marks the generator that emits the <Entity>Names artifact. The runner
   *  aggregates this across the suite into ResolvedGenConfig.includeNames, which the
   *  entity generator reads to decide whether it may reference those constants.
   *  Same mechanism as emitsHonoRoutes/includeHonoRoutes. */
  emitsNames?: boolean;
```

Task 5 adds the config field and the runner aggregation that consume it. The declaration
lives here because this is the task that sets it — a marker set against an interface that
does not declare it fails Step 7.

- [ ] **Step 6: Export both from the package barrel**

Add to `server/typescript/packages/codegen-ts/src/index.ts`:

```ts
export { renderNamesDecl } from "./templates/names-decl.js";
export { resolveObjectNames, type ObjectNames, type FieldNames } from "./names.js";
```

- [ ] **Step 7: Build and typecheck**

```bash
cd <repo-root> && bun run --filter '*' build && bun run --filter '*' typecheck
```

Expected: clean. `bun test` transpiles per file and does NOT typecheck, so this is the only
step that catches a wrong signature.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/names.ts \
        server/typescript/packages/codegen-ts/src/templates/names-decl.ts \
        server/typescript/packages/codegen-ts/src/reference/names.ts \
        server/typescript/packages/codegen-ts/src/generator.ts \
        server/typescript/packages/codegen-ts/src/index.ts \
        server/typescript/packages/codegen-ts/test/templates/names-decl.test.ts
git commit -m "feat(codegen-ts): namesFile() emits <Entity>Names

Spec §A1/§A2. A separate generator, never a flag on the entity generator: a new artifact
is a MINOR and adds zero bytes to existing files, where a flag would move every
\$table-carrying golden for the same functionality. Shape copied from the FR-009 filter
allowlist — the same per-entity name-artifact problem, already solved in five ports."
```

---

### Task 4: Make it ejectable and scaffolded

§A5: TypeScript is opt-in **by construction**. ADR-0034 scaffold-and-own means `meta gen`
runs the adopter's *copy* of a generator, so a packaged template change cannot reach anyone
who has ejected. The honest maximum is: every new `meta init` gets it, existing projects add
one config line.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/reference-templates.ts:16`
- Modify: `server/typescript/packages/cli/src/commands/init.ts:31`
- Test: `server/typescript/packages/cli/test/init-scaffold.test.ts` (or the existing init
  test file — find it with `git grep -l SCAFFOLDED_GENERATOR_NAMES server/typescript/packages/cli/test`)

**Interfaces:**
- Consumes: the `"names"` reference template from Task 3.
- Produces: `"names"` as a member of `REFERENCE_GENERATOR_NAMES` and of
  `SCAFFOLDED_GENERATOR_NAMES`.

- [ ] **Step 1: Write the failing tests**

```ts
test("names is an ejectable reference generator", () => {
  expect(REFERENCE_GENERATOR_NAMES).toContain("names");
});

test("meta init scaffolds the names generator", async () => {
  // Follow the existing init test's temp-dir + run idiom in this file.
  const dir = await scaffoldProject();
  expect(existsSync(join(dir, "codegen/generators/names.ts"))).toBe(true);
  expect(readFileSync(join(dir, "metaobjects.config.ts"), "utf8")).toContain("namesFile()");
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd server/typescript && bun test packages/cli/test -t "names"
```

Expected: FAIL — `"names"` is not in the list.

- [ ] **Step 3: Register it**

`reference-templates.ts:16`:

```ts
export const REFERENCE_GENERATOR_NAMES = ["entity", "queries", "routes", "routes-hono", "barrel", "names"] as const;
```

`init.ts:31`:

```ts
const SCAFFOLDED_GENERATOR_NAMES: readonly ReferenceGeneratorName[] = ["entity", "queries", "routes", "barrel", "names"];
```

Then update the scaffolded `metaobjects.config.ts` template in `init.ts` to import and list
`namesFile()`. Find the existing generator list in that file and extend it — do not rewrite it.

- [ ] **Step 4: Run the tests**

```bash
cd server/typescript && bun test packages/cli/test
cd server/typescript && bun test packages/codegen-ts/test
```

Expected: PASS. `meta eject --list` now names six generators.

- [ ] **Step 5: Verify the eject path end-to-end by hand**

```bash
cd /tmp && rm -rf names-eject && mkdir names-eject && cd names-eject
node <repo-root>/server/typescript/packages/cli/dist/index.js init
node <repo-root>/server/typescript/packages/cli/dist/index.js eject --list
```

Expected: `--list` includes `names`, and `codegen/generators/names.ts` exists after `init`.
Read the scaffolded config and confirm it imports from the local copy, not the package.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/reference-templates.ts \
        server/typescript/packages/cli/src/commands/init.ts \
        server/typescript/packages/cli/test
git commit -m "feat(cli): scaffold and eject the names generator

Spec §A5. TypeScript is opt-in by construction under ADR-0034 — meta gen runs the
adopter's copy, so a packaged change cannot reach anyone who has ejected. New projects get
it from meta init; existing ones add one config line."
```

---

### Task 5: The generated code consumes the artifact

§A6, and the half that pays for the program. Today the entity file embeds
`sqliteTable("subscribers", …)` and `createdAt: text("created_at")` — two independent
spellings of names the names artifact also carries, held together only by both calling the
same resolver. Once the entity file *references* the constants, `persistence-conformance`
(real queries against Testcontainers Postgres) and `api-contract-conformance` (each port's
generated API, booted) cover those names with no new corpus written.

**Consumption is conditional.** The names generator is opt-in (Task 4), so an entity file
that imported it unconditionally would break every project that has not enabled it.

**The mechanism already exists — copy it, do not invent one.** `routesFileHono` sets
`emitsHonoRoutes` on its `Generator`, the runner aggregates that across the suite into
`ResolvedGenConfig.includeHonoRoutes`, and api-docs reads that flag to auto-detect whether
to document the Hono surface. Task 3 sets `emitsNames`; this task adds the matching
`includeNames?: boolean` to `ResolvedGenConfig` and the runner aggregation. A generator
cannot scan `ctx.config.generators` — that field does not exist on `ResolvedGenConfig`.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/metaobjects-config.ts` (add `includeNames?: boolean` to `ResolvedGenConfig`) — the `Generator.emitsNames` marker it aggregates was declared in Task 3 Step 6a
- Modify: `server/typescript/packages/codegen-ts/src/runner.ts` (aggregate the marker — find how `includeHonoRoutes` is aggregated and mirror it exactly)
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-file.ts`
- Modify: `server/typescript/packages/codegen-ts/src/templates/drizzle-schema.ts`
- Test: `server/typescript/packages/codegen-ts/test/templates/names-consumption.test.ts`
- Regenerate: `server/typescript/packages/codegen-ts/test/golden/`

**Interfaces:**
- Consumes: `resolveObjectNames` (Task 2), `emitsNames` (Task 3).
- Produces: `ResolvedGenConfig.includeNames?: boolean`. Emitted bytes change **only** when
  the names generator is active.

- [ ] **Step 1: Write the failing tests — BOTH arms**

Both arms, in one test file. A conditional whose off-arm is untested is how a default-off
knob ships broken.

```ts
test("with the names generator ACTIVE, the table binding references the constants", async () => {
  const out = await renderEntityWithGenerators(true);
  expect(out).toContain(`import { SubscriberNames } from "./Subscriber.names.js"`);
  expect(out).toContain("sqliteTable(SubscriberNames.name");
  expect(out).toContain("text(SubscriberNames.fields.createdAt.column)");
  expect(out).not.toContain(`sqliteTable("subscribers"`);
});

test("with the names generator ABSENT, output is byte-identical to today", async () => {
  const out = await renderEntityWithGenerators(false);
  expect(out).toContain(`sqliteTable("subscribers"`);
  expect(out).toContain(`text("created_at")`);
  expect(out).not.toContain("SubscriberNames");
});
```

Write `renderEntityWithGenerators(active: boolean)` in the test file: build the loader
fixture as in Task 3, then construct the `GenContext` with `config.includeNames` set to
`active`. Read `src/generator.ts:16` for the exact `GenContext` shape and
`src/metaobjects-config.ts:46` for `ResolvedGenConfig`'s required fields — the stub must
supply `outDir`, `extStyle`, `dbImport` and `dialect` or it will not typecheck.

- [ ] **Step 2: Run and confirm the ACTIVE arm fails and the ABSENT arm passes**

```bash
cd server/typescript && bun test packages/codegen-ts/test/templates/names-consumption.test.ts
```

Expected: the "ACTIVE" test FAILS (no import emitted); the "ABSENT" test PASSES already.
That asymmetry is the proof the change is additive.

- [ ] **Step 3: Implement conditional consumption**

In `entity-file.ts`, derive the flag once and thread it into the Drizzle emitter:

```ts
// §A6 — consume the names artifact only when the run actually emits it. The names
// generator is opt-in (ADR-0034 scaffold-and-own), so an unconditional import would
// break every project that has not enabled it. The flag is aggregated by the runner from
// each generator's `emitsNames` marker — the same path includeHonoRoutes takes.
const namesActive = ctx.config.includeNames === true;
```

In `drizzle-schema.ts`, take that flag and emit either the constant reference or the
literal. Keep both paths going through `resolveObjectNames` so the literal arm and the
constant arm cannot disagree.

- [ ] **Step 4: Run both arms**

```bash
cd server/typescript && bun test packages/codegen-ts/test/templates/names-consumption.test.ts
cd server/typescript && bun test packages/codegen-ts/test
```

Expected: all PASS.

- [ ] **Step 5: Confirm the goldens did NOT move**

```bash
cd <repo-root> && git status --short server/typescript/packages/codegen-ts/test/golden/
```

Expected: **empty**. No golden project enables the names generator yet, so the off-arm
keeps every byte. A moved golden here means the conditional leaked — stop and fix it before
regenerating anything.

- [ ] **Step 6: Add ONE golden that enables the generator**

Add a golden fixture whose config lists `namesFile()`, so the on-arm has byte coverage too.
Follow the existing golden fixture layout in `test/golden/`. Regenerate and read the diff
line by line: the new `.names.ts` file, plus constant references replacing literals in that
fixture's entity file, and nothing else.

- [ ] **Step 7: Prove the generated code still executes**

Codegen tests must execute generated code, not just diff strings. Run the suites that boot
generated output against a real engine:

```bash
cd server/typescript && bun test packages/integration-tests/test
```

Expected: PASS. If the constant reference is wrong, a query fails here — which is exactly
the coverage §A6 exists to buy.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/ \
        server/typescript/packages/codegen-ts/test/
git commit -m "feat(codegen-ts): generated code reads the names artifact

Spec §A6. The entity file's Drizzle binding references <Entity>Names instead of embedding
the physical names a second time. Conditional on the names generator being active, so
output is byte-identical for every project that has not enabled it.

This is what makes the artifact load-bearing. FR-007 rejected a codegen-output corpus, but
the BEHAVIOUR corpora are not idiomatic-divergent: once generated code reads these names, a
wrong one fails persistence-conformance and api-contract-conformance in every port, with no
new corpus written."
```

---

### Task 6: Teach the doctrine where it is read

§"The doctrine, and where it is taught". Getting rid of magic strings is the point; the
constants are only the mechanism, and the highest-leverage work reaches adopters.

**Files:**
- Modify: `server/typescript/packages/sdk/src/agent-docs/body.ts`
- Modify: `agent-context/skills/metaobjects-codegen/SKILL.md`
- Modify: `docs/ports/typescript.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Document the artifact in the TS port page**

Add a section to `docs/ports/typescript.md` showing `<Entity>Names`, what each key means,
and the one-line config addition for an existing project. Show the `createdAt` /
`created_at` collision — it is the reason `name` and `column` are always both present.

- [ ] **Step 2: Carry the honest framing into the skill**

The spec is explicit: the skills must include *prefer the typed handle where one exists*.
A skill that tells an agent to replace `subscribers.createdAt` (a Drizzle column object,
type-checked) with a string constant would make generated code **worse**. Write that
caveat, not just the rule.

- [ ] **Step 3: Verify every fenced example loads**

```bash
cd <repo-root> && bun scripts/check-doc-examples.ts
```

Expected: PASS. Every fenced JSON block under `docs/` and the skills is loaded against the
strict registry — three times a doc has taught vocabulary the loader had already retired,
and an adopter found it every time.

- [ ] **Step 4: Run the gates lane**

```bash
cd <repo-root> && bash scripts/ci-local.sh --only gates
```

Expected: LOCAL CI PASSED.

- [ ] **Step 5: Commit**

```bash
git add docs/ports/typescript.md agent-context/skills/ server/typescript/packages/sdk/src/agent-docs/
git commit -m "docs: teach the names artifact, with the typed-handle caveat

Spec §'The doctrine, and where it is taught'. Includes the caveat the spec insists on:
prefer the typed handle where one exists. Telling an agent to replace a type-checked
Drizzle column object with a string constant would make generated code worse."
```

---

## Done when

- `meta init` scaffolds a `names` generator; `meta eject --list` offers it.
- A project enabling it emits `<Entity>.names.ts`, and its entity file references those
  constants rather than embedding physical names twice.
- A project **not** enabling it produces byte-identical output to before.
- A projection field's `dbCol` honours `@column`, with a regression fixture whose `@column`
  differs from the naming strategy's answer.
- `bash scripts/ci-local.sh --quick` is green.

## Not in this plan

- **The other four ports.** C#, Java, Kotlin and Python each get the artifact and the
  consumption rewiring, following the shape proven here, in a follow-up plan. Program A's
  scope is all five ports; this plan is the first vertical.
- **Programs B and C.** Separate programs with separate justifications (spec §B, §C).
- **Removing `$table` / `dbCol`.** §A4 is explicit: leave them. Removing them buys nothing
  and breaks ejected copies.

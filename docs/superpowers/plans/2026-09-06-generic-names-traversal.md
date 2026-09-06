# Generic `<Node>Names` Traversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four hard-coded collections in `<Entity>Names` with a recursive traversal of the metadata tree that works for any registered type, in all five ports, and extend it to value objects, sourceless projections and requirements.

**Architecture:** Two new per-type registry fields (`collection`, `nameAttrs`) move all type knowledge out of the generators and into `spec/metamodel/*.json`. Each port's names emitter becomes one recursive case: emit identity, inline authored attrs plus resolved name-attrs, then recurse into a named collection per child type. Abstract parents are resolved-inline, so no artifact references another.

**Tech Stack:** TypeScript (reference port, ts-poet), C# (.NET 8), Java 21 + Kotlin (KotlinPoet), Python 3.10.

**Spec:** `docs/superpowers/specs/2026-09-06-generic-names-traversal-design.md`

## Global Constraints

- **`metamodelVersion` moves `0.14` → `0.15`.** Set it with `node scripts/check-metamodel-version.mjs --set 0.15`, never by hand — it writes the manifest and all four port constants together.
- **All four registries publish** this release, forced by the `expected-registry.json` change. npm/PyPI/NuGet `0.25.0`, Maven `7.25.0`.
- **This repo is PUBLIC.** No other-project names, no absolute home paths in any committed file, commit messages included.
- **ADR-0039:** resolving accessors are the default. `own*` is legal only where codegen emits a generated subclass and must not re-emit inherited members; every such call carries a comment naming the sanctioned case.
- **ADR-0023:** never invent a metamodel attribute. `collection` and `nameAttrs` are registry *type-definition* fields, not metadata attrs — they go in `spec/metamodel/*.json` type entries, and are covered by `registry-conformance`.
- **No `any`.** Use `unknown` and narrow. Named constants for all metamodel strings, imported from `@metaobjectsdev/metadata/constants`.
- **Never `instanceof` a metadata node across packages.** Use the exported guards (`isMetaObject`, `isMetaField`, …).
- **Commit to `main`, forward-only.** No side branches unless asked. Stage explicitly — never `git add -A`.
- **Run `bun test` scoped** (`cd server/typescript && bun test`), never bare at the repo root. `bun test` does not typecheck; run `bun run --filter '*' typecheck` too.
- **`dotnet test` prints `Passed!` for a project that did not compile** — always `grep -c 'error CS'` the output as well.

---

## Phase 0 — The packaged fixes

Independent of the redesign, lower risk, and each lands on its own. Doing them first shrinks the open-issue list before the large change starts.

### Task 1: A TPH subtype's `$path` names the address it is served at

The generated grid hook builds its fetch URL from `<Sub>.$path` with no TPH awareness, so an opted-in per-subtype grid requests `/api/cars` while routes mount `/api/vehicles/car`. Fixing `$path` at its single source fixes every consumer.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-ui-descriptor.ts` (move `restPath` in; `buildEntityUiDescriptor` uses it)
- Modify: `server/typescript/packages/codegen-ts/src/api-surface.ts:72-78` (re-export `restPath`, keep the public surface stable)
- Test: `server/typescript/packages/codegen-ts/test/agent-ui-page-parity.test.ts`
- Test: `server/typescript/packages/codegen-ts/test/golden/api-docs-accuracy.test.ts`

**Interfaces:**
- Consumes: `tphDiscriminatorPin`, `tphDiscriminatorBase` from `./zod-validators.js`; `tphRouteSegment` from `./tph-discriminator.js`. Neither imports `entity-ui-descriptor.ts`, so moving `restPath` creates no cycle.
- Produces: `restPath(entity: MetaObject): string`, unchanged signature, exported from both `templates/entity-ui-descriptor.ts` and (re-exported) `api-surface.ts`, so `index.ts:102` and `generators/agent-ui-page.ts:46` need no edit.

- [ ] **Step 1: Write the failing test**

In `agent-ui-page-parity.test.ts`, replace the assertion that a TPH subtype's own `$path` DIFFERS from its mounted address (the block whose comment at line ~47 calls it *"the 'own `$path` names nothing' defect"*) with one that they AGREE:

```ts
test("a TPH subtype's emitted $path is the address it is served at", () => {
  const emitted = renderAll(tphFixtureRoot());              // existing helper
  const subPath = ownPathOf(emitted, "Car");                // existing helper
  expect(subPath).toBe("/vehicles/car");
  expect(ownPathOf(emitted, "Vehicle")).toBe("/vehicles");  // base unchanged
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/agent-ui-page-parity.test.ts`
Expected: FAIL — received `"/cars"`.

- [ ] **Step 3: Move `restPath` and point the descriptor at it**

Cut `restPath` from `api-surface.ts` into `entity-ui-descriptor.ts` verbatim, adding the two imports named in **Interfaces**. In `api-surface.ts` replace the definition with `export { restPath } from "./templates/entity-ui-descriptor.js";`. Then in `buildEntityUiDescriptor`:

```ts
    entity: obj.name,
    path: restPath(obj),   // the address this object is SERVED at; a TPH subtype is
                           // mounted under its base, so its own resourcePath names nothing.
```

Update `resourcePath`'s doc comment: it is no longer what `$path` emits, it is the object's own pluralized resource path and the input `restPath` composes from.

- [ ] **Step 4: Run the codegen-ts suite**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: PASS. Non-TPH goldens are byte-identical because `restPath(x) === resourcePath(x)` for every non-TPH-subtype object; no golden snapshot contains a TPH hierarchy.

- [ ] **Step 5: Typecheck**

Run: `cd /` + repo root, `bun run --filter '*' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/entity-ui-descriptor.ts \
        server/typescript/packages/codegen-ts/src/api-surface.ts \
        server/typescript/packages/codegen-ts/test/agent-ui-page-parity.test.ts
git commit  # subject: fix(codegen-ts)!: a TPH subtype's $path named an endpoint that 404s
```

---

### Task 2: The agent context says the loader is strict; that is true of `verify` and false of `gen`

**Files:**
- Modify: `agent-context/templates/always-on.md.mustache:61`
- Regenerate: the 10 mirrors under `fixtures/agent-context-conformance/*/expected/.metaobjects/{AGENTS,CLAUDE}.md`

**Measured behaviour, to be stated accurately:**
- An unregistered **type or subType** is a hard load error in BOTH commands — `parser-core.ts:638-643` and `:1391` push to the unconditional `errors` sink, and `sdk/src/memory.ts:148` throws on the first.
- An undeclared **`@attr`** is `ERR_UNKNOWN_ATTR` only under strict (`attr-schema-validate.ts:158`), and `loadMemory` defaults strict OFF (`memory.ts:133`). `verify.ts:249` opts in; `gen.ts` never does.

- [ ] **Step 1: Rewrite the sentence**

Replace *"The loader is STRICT: an attribute or subtype no provider registers fails the LOAD, so inventing one is a build failure rather than a shortcut."* with:

> **An unregistered type or subtype fails the load in every command. An undeclared `@attr` fails `meta verify`, which loads strict — `meta gen` does not, so an invented attribute passes codegen silently and is caught by the drift gate, not by the build.** Inventing vocabulary is therefore a `verify` failure, not a shortcut.

- [ ] **Step 2: Regenerate the mirrors**

Run the agent-context fixture regeneration (the `agent-context-conformance` lane's regen entrypoint), then confirm all 10 mirrors changed:

Run: `git status --short fixtures/agent-context-conformance/`
Expected: 10 modified files, 2 per stack × 5 stacks.

- [ ] **Step 3: Run the conformance lane**

Run: `bash scripts/ci-local.sh --only gates`
Expected: `agent-context` drift gate green.

- [ ] **Step 4: Commit**

```bash
git add agent-context/templates/always-on.md.mustache fixtures/agent-context-conformance
git commit  # subject: fix(agent-context): "the loader is STRICT" is true of verify and false of gen
```

---

### Task 3: Java and Kotlin codegen skill references still teach removed members

The `typescript.md`, `csharp.md` and `python.md` rows were rewritten when `<Entity>Names` v2 landed; these two were missed. They still describe `KIND` / `NAME` / `SCHEMA` / `READ_ONLY`, and the Kotlin row still shows `AuthorTable : Table(AuthorNames.NAME)` — which now binds a table called `Author`.

**Files:**
- Modify: `agent-context/skills/metaobjects-codegen/references/kotlin.md:123`
- Modify: `agent-context/skills/metaobjects-codegen/references/java.md:109`
- Regenerate: the mirrored copies under `fixtures/agent-context-conformance/*/expected/.claude/skills/`

- [ ] **Step 1: Correct both rows**

`READ_ONLY` no longer exists — it was a derivation over `@kind`, so the question to ask is `SOURCE_<ROLE>_KIND`. `NAME` holds the object's metamodel name. The table binding is `SOURCE_PRIMARY_TABLE`. Match the wording already used in `docs/ports/java.md:362` and `docs/ports/kotlin.md:310`, which are correct.

- [ ] **Step 2: Regenerate mirrors and confirm**

Run: `git status --short fixtures/agent-context-conformance/`
Expected: the java-bearing stacks' skill mirrors changed.

- [ ] **Step 3: Run the gate**

Run: `bash scripts/ci-local.sh --only gates`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add agent-context/skills/metaobjects-codegen/references/java.md \
        agent-context/skills/metaobjects-codegen/references/kotlin.md \
        fixtures/agent-context-conformance
git commit  # subject: fix(agent-context): two skill rows still taught the members v2 removed
```

---

### Task 4: Rule on the same-role refusal

`sourcesOf` throws when two sources in one role disagree on a physical name. `validateSourceRoles` constrains only the *primary* count, so two `@role: replica` children load with zero errors — codegen refuses a model the loader accepts, and a model that previously generated now aborts `meta gen` in all five ports.

**Decision to implement:** keep the refusal, and give the loader the matching rule so the diagnosis arrives at load time in every port rather than at codegen time in one. A model with two same-role sources that disagree on a physical name is not expressible — the artifact keys by role, and two values cannot share one key.

**Files:**
- Modify: `server/typescript/packages/metadata/src/persistence/source/validate-source-physical-names.ts`
- Modify: `server/typescript/packages/codegen-ts/src/names.ts:199` (`sourcesOf` — throw `MetaModelError`, not bare `Error`)
- Create: a negative conformance fixture under `fixtures/conformance/`
- Mirror the loader rule in the C#, Java and Python loaders (Kotlin inherits the JVM's)

- [ ] **Step 1: Write the failing conformance fixture**

A `Ledger` with two `@role: replica` `source.rdb` children naming different views. Expected: a load ERROR with a new code `ERR_DUPLICATE_SOURCE_ROLE`, asserted by source + code (the corpus compares code and source, never message text).

- [ ] **Step 2: Run the corpus and confirm it fails**

Run: `cd server/typescript && bun test packages/metadata/test/conformance`
Expected: FAIL — the fixture loads clean.

- [ ] **Step 3: Add the loader rule in TS**

Refuse at load when two sources resolve the same `@role` and disagree on their resolved physical name. Agreement stays legal — an abstract base and its child may each declare a `@role: primary` source naming the same relation, which `primaryRdbSource` already permits and a TS test already pins. Do not re-tighten that.

- [ ] **Step 4: Downgrade `sourcesOf` to a plain lookup**

With the loader refusing, `sourcesOf` cannot meet a disagreement. Keep a defensive throw but raise `MetaModelError` so callers that classify model errors classify this one.

- [ ] **Step 5: Mirror in C#, Java, Python; run each port's conformance**

Run: `bash scripts/ci-local.sh --only java-fast`, `--only python`, `--only csharp`
Expected: green in all three.

- [ ] **Step 6: Commit**

```bash
git commit  # subject: fix!: two sources in one role that disagree now fail the LOAD, not codegen
```

---

## Phase 1 — Registry vocabulary

### Task 5: `collection` and `nameAttrs` on every type definition

**Files:**
- Modify: every `spec/metamodel/*.json` (18 files)
- Modify: `server/typescript/packages/metadata/src/provider-data.ts:78` (`TypeDef`)
- Regenerate: `server/typescript/packages/metadata/src/**/*-definition.embedded.ts` via `bun run scripts/generate-embedded-metamodel.ts`

**Interfaces:**
- Produces: `TypeDef.collection?: string` — the collection key children of this type group under. A property of the TYPE: every subType of a type declares the same value. `view` → `"views"`, `field` → `"fields"`, `source` → `"sources"`, `identity` → `"identities"`, `index` → `"indexes"`, `requirement` → `"requirements"`, `validator` → `"validators"`, `layout` → `"layouts"`, `origin` → `"origins"`, `relationship` → `"relationships"`, `template` → `"templates"`, `object` → `"objects"`.
- Produces: `TypeDef.collectionKey?: string` — the ATTR whose value keys an entry inside that collection. Omitted for every core type except `source`, which declares `"role"`. Omitted means the node's `name`. This exists because `source.rdb` declares no `defaultName` and is conventionally authored unnamed — the registry's own `rules` string says an object's sources are "distinguished by @role" — so keying by name would collapse a write-through entity's table and replica view into one entry and lose the replica's physical name, which is the defect the v2 restructure existed to fix.
- Produces: `TypeDef.nameAttrs?: readonly string[]` — the attrs of this subType that hold NAMES. `source.rdb` → `["table","view","materializedView","proc","function"]` (all five aliases; exactly one ever resolves, so the emitter needs no `@kind` branch). `field.*` → `["column"]`. `identity.*` / `index.*` → the resolved-index-name attr. Most types → omitted.

- [ ] **Step 1: Write the failing test**

`server/typescript/packages/metadata/test/provider-data-collection.test.ts`:

```ts
import { expect, test } from "bun:test";
import { coreProviders } from "../src/core-types.js";
import { composeRegistry } from "../src/provider.js";

test("every registered type declares a collection key", () => {
  const reg = composeRegistry(coreProviders);
  const missing = reg.allTypes()
    .filter((t) => reg.collectionOf(t.type) === undefined)
    .map((t) => `${t.type}.${t.subType}`);
  expect(missing).toEqual([]);
});

test("source.rdb declares all five kind aliases as name attrs", () => {
  const reg = composeRegistry(coreProviders);
  expect([...reg.nameAttrsOf("source", "rdb")].sort())
    .toEqual(["function", "materializedView", "proc", "table", "view"]);
});

test("source keys its collection by @role; everything else by name", () => {
  const reg = composeRegistry(coreProviders);
  expect(reg.collectionKeyOf("source")).toBe("role");
  expect(reg.collectionKeyOf("field")).toBeUndefined();   // undefined => the node's name
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server/typescript/packages/metadata && bun test test/provider-data-collection.test.ts`
Expected: FAIL — `reg.collectionOf` is not a function.

- [ ] **Step 3: Extend `TypeDef` and add the registry accessors**

```ts
export interface TypeDef {
  type: string;
  subType: string;
  description: string;
  /** The collection key children of this TYPE group under in a names artifact
   *  (`view` → `views`). Declared, never pluralized at runtime: five ports each
   *  inflecting the same word and agreeing forever is a worse bet than one string
   *  the byte-gated manifest pins. */
  collection?: string;
  /** The attrs of this subType that hold NAMES. A LIST because `source.rdb`'s
   *  physical-name attr is chosen by `@kind` — an attr VALUE, not a subType — so
   *  it declares all five aliases and exactly one ever resolves. */
  nameAttrs?: readonly string[];
  // …existing members unchanged
}
```

- [ ] **Step 4: Populate all 18 spec files, then regenerate the embeds**

Run: `bun run scripts/generate-embedded-metamodel.ts`
The generator round-trips the JSON verbatim (`JSON.stringify(JSON.parse(raw), null, 2)`), so the new fields flow into every TS embed with no generator change.

- [ ] **Step 5: Run the metadata suite**

Run: `cd server/typescript/packages/metadata && bun test`
Expected: PASS, including the per-concern `*-definition-embed.test.ts` drift tests.

- [ ] **Step 6: Commit**

```bash
git commit  # subject: feat(metamodel): a type declares its collection key and which attrs are names
```

---

### Task 6: The TS manifest emitter carries both fields; regenerate the canonical

**Files:**
- Modify: `server/typescript/packages/metadata/src/registry-manifest.ts`
- Regenerate: `fixtures/registry-conformance/expected-registry.json` via `bun run scripts/regen-expected-registry.ts`

- [ ] **Step 1: Write the failing test**

Assert the emitted manifest entry for `source.rdb` carries `nameAttrs`, and for `view.text` carries `collection: "views"`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server/typescript/packages/metadata && bun test test/registry-manifest.test.ts`

- [ ] **Step 3: Emit both fields**

Order them deterministically with the existing keys — the other four ports byte-match this serialization, so key order is contract.

- [ ] **Step 4: Regenerate the canonical and set the version**

```bash
bun run scripts/regen-expected-registry.ts
node scripts/check-metamodel-version.mjs --set 0.15
```

- [ ] **Step 5: Confirm TS registry-conformance is green and the other four are RED**

Run: `bash scripts/ci-local.sh --only ts-fast`
Expected: green. The other four ports are expected to go red until Tasks 7-9 land — that is the documented intermediate state named in `scripts/regen-expected-registry.ts`'s own header.

- [ ] **Step 6: Commit**

```bash
git commit  # subject: feat(metamodel)!: the manifest carries collection + nameAttrs; metamodelVersion 0.15
```

---

### Task 7: C# reads and emits both fields

**Files:**
- Modify: `server/csharp/MetaObjects/Registry/Spec/SpecMetamodelReader.cs`
- Modify: the C# registry manifest emitter
- Modify: `server/csharp/MetaObjects/SpecMetamodel/` embedded copies

- [ ] **Step 1: Refresh the embedded spec copies, then run registry-conformance**

Run: `bash scripts/ci-local.sh --only csharp`
Expected: FAIL — manifest mismatch on the two new keys.

- [ ] **Step 2: Parse and emit both fields**

- [ ] **Step 3: Re-run**

Run: `cd server/csharp && dotnet test MetaObjects.Conformance.Tests 2>&1 | tee /dev/stderr | grep -c 'error CS'`
Expected: `0`, and `Passed!` with a non-zero test count.

- [ ] **Step 4: Commit**

---

### Task 8: Java reads and emits both fields (Kotlin inherits the JVM registry)

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/registry/spec/SpecMetamodelReader.java`
- Modify: the Java registry manifest emitter
- Modify: the embedded spec resources

- [ ] **Step 1: Run registry-conformance and confirm the mismatch**

Run: `bash scripts/ci-local.sh --only java-fast`
Expected: FAIL on the manifest byte-match.

- [ ] **Step 2: Parse and emit both fields**

- [ ] **Step 3: Re-run both JVM lanes**

Run: `bash scripts/ci-local.sh --only java-fast`
Expected: green for java AND kotlin — the Kotlin lane composes the same registry.

- [ ] **Step 4: Commit**

---

### Task 9: Python reads and emits both fields

**Files:**
- Modify: the Python spec-metamodel reader and registry manifest emitter under `server/python/src/metaobjects/`

- [ ] **Step 1: Run and confirm the mismatch**

Run: `bash scripts/ci-local.sh --only python`
Expected: FAIL.

- [ ] **Step 2: Parse and emit both fields**

- [ ] **Step 3: Re-run**

Run: `cd server/python && uv run --extra integration pytest tests/ -q`
Expected: PASS. The `--extra integration` is required; without it collection fails on 9 modules.

- [ ] **Step 4: Commit — all five registries now byte-match at `metamodelVersion` 0.15**

---

## Phase 2 — The TypeScript resolver and emitter (reference port)

### Task 10: `resolveNodeNames` — one recursive case

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/names.ts`
- Test: `server/typescript/packages/codegen-ts/test/names.test.ts`

**Interfaces:**
- Produces:

```ts
export interface NodeNames {
  readonly type: string;
  readonly subType: string;
  readonly name: string;
  /** Authored attrs (own or inherited from an abstract parent) plus every
   *  name-bearing attr that RESOLVES, derived or not. */
  readonly attrs: Readonly<Record<string, string | number | boolean>>;
  /** One entry per child TYPE present, keyed by the type's declared
   *  `collection`, then by the child's metadata name. */
  readonly collections: Readonly<Record<string, Readonly<Record<string, NodeNames>>>>;
}
export function resolveNodeNames(
  node: MetaData,
  registry: TypeRegistry,
  strategy?: ColumnNamingStrategy,
): NodeNames;
```

- Replaces: `ObjectNames`, `FieldNames`, `SourceNames`, `KeyNames`, `SuperNames`, `resolveObjectNames`, `resolveSuperFragmentNames`, `namesArtifactSuperOf`, and every `own*` member of the artifact.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum: a value object (no source) resolves to a node with `fields` and no `sources`; an abstract parent's fields and authored attrs appear inlined in the concrete child with no `superNames`; a write-through entity carries `sources.primary.table` AND `sources.replica.view`; a `@kind: storedProc` projection carries `sources.primary.proc`; a field whose `column` comes from the naming strategy still carries `column`; a provider-registered custom child type appears under its declared `collection`.

- [ ] **Step 2: Run and confirm failure**

Run: `cd server/typescript/packages/codegen-ts && bun test test/names.test.ts`

- [ ] **Step 3: Implement the recursion**

Walk `node.children()` — resolving, per ADR-0039. Group each child by `registry.collectionOf(child.type)`; a child whose type declares no collection is a hard error naming the type, never silently dropped. Inline `node`'s authored attrs, then for each name in `registry.nameAttrsOf(node.type, node.subType)` inline its resolved value when one exists. Recurse. Attrs are inlined, never recursed into — that is what bounds the walk.

Delete the `primaryRdbSource` gate: every concrete node resolves.

- [ ] **Step 4: Run to green, then the whole package**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: the golden snapshots FAIL — Task 11 rewrites them.

- [ ] **Step 5: Commit**

---

### Task 11: The TS emitter renders the nested `as const`

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/names-decl.ts`
- Regenerate: `server/typescript/packages/codegen-ts/test/golden/__snapshots__/**/*.names.ts`

**Target output** (`Order`, package `shop::commerce`):

```ts
export const OrderNames = {
  type: "object", subType: "entity", name: "Order",
  sources: {
    primary: { type: "source", subType: "rdb", kind: "table", table: "orders" },
  },
  fields: {
    customerId: { type: "field", subType: "long", name: "customerId", column: "customer_id" },
    id:         { type: "field", subType: "long", name: "id",         column: "id" },
  },
  identities: {
    primary:      { type: "identity", subType: "primary",   name: "primary" },
    ref_customer: { type: "identity", subType: "reference", name: "ref_customer" },
  },
} as const;
```

An empty collection is OMITTED, not emitted as `{}` — a collection key present means children of that type exist.

- [ ] **Step 1: Update the golden for one entity by hand, run, confirm the diff is exactly the intended shape**
- [ ] **Step 2: Implement the emitter**
- [ ] **Step 3: Regenerate all goldens; read the diff before accepting it**
- [ ] **Step 4: Run the package suite + typecheck**
- [ ] **Step 5: Commit**

---

### Task 12: Rewire every TS consumer — and fix the callable bug

`callable-file.ts:140` emits `${namesConst}.name` for a stored procedure. That member now holds the object's name, so every generated callable is `SELECT * FROM <ObjectName>(…)`. Its own comments at lines 118 and 135 already say `sources.primary.proc`.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/callable-file.ts:140` **and its KDoc at :170**
- Modify: `src/templates/drizzle-schema.ts`, `src/templates/entity-constants.ts`, `src/templates/projection-decl.ts`, `src/templates/view-decl.ts`, `src/projection/extract-view-spec.ts`, `src/generators/agent-docs-file.ts`
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts`

- [ ] **Step 1: Write the failing test proving the callable bug**

Render a projection with `@kind: storedProc, @proc: "zz_phys_proc"` and assert the emitted file contains `sources.primary.proc` and does NOT contain `Names.name` inside the `sql` template.

- [ ] **Step 2: Run and confirm it fails**
- [ ] **Step 3: Fix the call sites**
- [ ] **Step 4: Run codegen-ts + migrate-ts suites and typecheck**
- [ ] **Step 5: Commit**

---

### Task 13: `no-magic-physical-names` asserts per-consumer

The gate passed while the callable referenced the wrong member, because it asks whether a member appears in SOME consumer and the entity file's `$table:` line satisfied that.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/test/no-magic-physical-names.test.ts`
- Modify: the four sibling gates (`NoMagicPhysicalNamesTest` in codegen-spring and codegen-kotlin, the C# and Python equivalents) in their own port tasks

- [ ] **Step 1: Add a case that FAILS on today's tree** — a stored-proc projection whose callable must reference `sources.primary.proc` specifically. Confirm it goes red before Task 12's fix and green after.
- [ ] **Step 2: Replace the "appears somewhere" assertion with a per-emitted-file expectation table**
- [ ] **Step 3: Prove the gate has teeth — revert one call site, confirm RED, restore, confirm GREEN**
- [ ] **Step 4: Commit**

---

### Task 14: Artifacts for value objects, sourceless projections and requirements

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/reference/entity.ts` (emit `.names.ts` for every concrete object)
- Create: a requirements names emitter beside `src/generators/requirements-file.ts`
- Modify: `src/generators/requirement-tests.ts` — the stub's test name and `Claims:` comment reference constants instead of literals

- [ ] **Step 1: Write failing tests** — a value object emits `<Value>.names.ts`; a requirement emits `<Requirement>.names.ts` carrying nested `requirements`; an abstract emits NOTHING.
- [ ] **Step 2: Run, confirm failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run codegen-ts suite + typecheck**
- [ ] **Step 5: Commit**

---

## Phase 3 — Cross-port corpus

### Task 15: A names corpus every port runs

**Files:**
- Create: `fixtures/codegen-conformance/names/` + cases + README

Required cases, each named for the path it covers: value object (no source); sourceless projection; abstract parent contributing fields AND authored attrs; write-through entity with a replica view; stored-proc projection; TPH hierarchy; provider-registered custom child type; requirement with nested children; a field whose `column` is derived rather than authored.

The README states which case covers which path — a corpus that loses coverage fails nothing.

- [ ] **Step 1: Author the cases and the expected artifacts**
- [ ] **Step 2: Wire the TS runner; confirm green**
- [ ] **Step 3: Commit**

---

## Phase 4 — The other four ports

Each task: port the recursion, render nested types, drop the `SOURCE_`/`IDENTITY_`/`INDEX_` prefixes (nesting namespaces them now), rewrite the three tests that pin those prefixes, strengthen that port's no-magic gate per Task 13, and run the corpus.

### Task 16: C#

**Files:** `server/csharp/MetaObjects.Codegen/Generators/NamesGenerator.cs`, `CSharpNaming.cs`, `Generators/CallableGenerator.cs`, `Generators/DbContextGenerator.cs`

**Target:** `SubscriberNames.Sources.Primary.Table`, `SubscriberNames.Fields.Email.Column` — nested static classes.

- [ ] Steps: failing corpus run → implement → `dotnet test` with `grep -c 'error CS'` → commit

### Task 17: Java

**Files:** `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringNamesGenerator.java`, `SpringNaming.java`

**Target:** `SubscriberNames.Sources.Primary.TABLE` — nested static classes.

- [ ] Steps: failing corpus run → implement → `--only java-fast` → commit

### Task 18: Kotlin

**Files:** `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinNamesGenerator.kt`, `KotlinGenUtil.kt`, `KotlinExposedTableGenerator.kt`, `KotlinStoredProcGenerator.kt`

**Target:** nested `object`s.

- [ ] Steps: failing corpus run → implement → `--only java-fast` → commit

### Task 19: Python

**Files:** `server/python/src/metaobjects/codegen/generators/names_generator.py`, `server/python/src/metaobjects/naming.py`

**Target:** nested classes — `SubscriberNames.Sources.Primary.TABLE`.

- [ ] Steps: failing corpus run → implement → `uv run --extra integration pytest tests/ -q` → commit

---

## Phase 5 — Documentation and release preparation

### Task 20: Every adopter-facing surface

**Files:** `docs/ports/{typescript,csharp,java,kotlin,python}.md`, `docs/features/{entities,field-types,relationships,abstracts-and-inheritance,source-kinds}.md`, `docs/recipes/csharp-angular18.md`, `docs/features/cli.md:140`, `agent-context/skills/**`, and the regenerated fixture mirrors. Add a migration guide under `docs/features/migrations/`.

- [ ] **Step 1: Rewrite every `<X>Names` example to the nested shape, per port**
- [ ] **Step 2: Run the shipped-doc-examples gate** — `bash scripts/ci-local.sh --only gates`, which loads every fenced JSON block under `docs/` against the strict registry
- [ ] **Step 3: CHANGELOG entry** leading with the migration, as the v2 entry does
- [ ] **Step 4: Commit**

### Task 21: Regenerate the showcase and run the full gate

- [ ] **Step 1:** `bun scripts/regen-showcase.ts` — the JVM half pins the RELEASED plugin version, so leave `examples/showcase/jvm/pom.xml` until the release bumps it
- [ ] **Step 2:** `bun run site:payload`
- [ ] **Step 3:** Full `bash scripts/ci-local.sh` — redirect to a file and grep the verdict; piping through `tail` reports tail's exit code
- [ ] **Step 4:** Commit

---

## Self-Review

**Spec coverage.** Artifact definition → Tasks 10, 11, 14. Node entry shape → Task 10. Registry-declared collections and their keys → Tasks 5-9. Abstracts resolved-inline → Task 10 (deletes `namesArtifactSuperOf` / `resolveSuperFragmentNames`). Per-port nested rendering → Tasks 11, 16-19. Requirements → Task 14. Prefix removal → Tasks 16-19. Gates → Tasks 13, 15. Versioning → Task 6. Packaged fixes → Tasks 1-4. Open decision (same-role refusal) → Task 4, ruled. **One spec item has no task by design:** the deferred `$apiPrefix`-on-the-entity-const observation, which the spec records as explicitly not acted on.

**Placeholder scan.** No TBD/TODO. Tasks 16-19 carry target output and exact commands rather than literal source, because the artifact's emitted SHAPE is the specification and each port's emitter internals differ; the corpus in Task 15 is the executable acceptance criterion for all four.

**Type consistency.** `resolveNodeNames` / `NodeNames` / `collections` / `attrs` are used with those exact names in Tasks 10, 11, 12, 14. `collectionOf(type)`, `collectionKeyOf(type)` and `nameAttrsOf(type, subType)` are introduced in Task 5 and used in Task 10. `restPath` keeps its Task 1 signature throughout.

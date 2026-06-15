# FR-033 — Provider definitions as declarative data + metamodel docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a provider's *declarative* metamodel definition (vocabulary + attr constraints + descriptions + rule prose) live in single-sourced JSON the provider reads, then emit it in the registry manifest (gated) and render it as tiered LLM-readable markdown.

**Architecture:** The TS registry already carries `TypeDefinition.description` and `AttrSchema.description` — the data model is ready; today they're hand-coded per port and the manifest *excludes* them. This plan: (1) define a JSON definition-file format + a `defineProviderFromData()` helper that turns file data + a code-supplied factory map into the `register()` calls a provider makes; (2) convert one core provider (field) to read its embedded global file (+ optional language-specific overlay), prove it; (3) grow the registry manifest to emit descriptions and extend `registry-conformance` (coverage + identity); (4) convert the remaining core providers; (5) render tiered metamodel docs from the manifest and wire them into the `metaobjects-authoring` skill; (6) fan out the read-the-file mechanism to Java/C#/Python/Kotlin. The data/code boundary is firm: declarative facts + rule *prose* in JSON; **factories, imperative validation, and codegen stay code**.

**Tech Stack:** TS (reference) — `@metaobjectsdev/metadata` providers/registry/registry-manifest; Bun test. Java (Maven), C# (dotnet), Python (uv/pytest) for the fan-out. Shared corpora under `fixtures/`; shared source under `spec/metamodel/`.

**Spec:** `docs/superpowers/specs/2026-06-13-metamodel-self-description-design.md` (FR-033, GH #23).

---

## File structure (created / modified)

**Phase 1 — TS foundation (field provider)**
- Create `spec/metamodel/field.json` — global declarative definition for the field provider (vocab + attrs + constraints + descriptions + rule prose). The single source.
- Create `server/typescript/packages/metadata/src/provider-data.ts` — the format types (`ProviderDefinition`, `TypeDef`, `AttrDef`) + `defineProviderFromData(data, factories, opts?)` that produces `TypeDefinition`s for `registry.register()`. One responsibility: turn declarative data + a factory map into registrable defs.
- Create `server/typescript/packages/metadata/src/core/field/field-definition.embedded.ts` — generated constant embedding `spec/metamodel/field.json` at build (mirrors the existing template-embedding generated module).
- Modify `server/typescript/packages/metadata/src/core/field/field-provider.ts` (or wherever field types register — see Task 4) — register via `defineProviderFromData` instead of the hand-coded `field-schema.ts` attr arrays.
- Modify `server/typescript/packages/metadata/src/registry-manifest.ts` — add `description` (and `rules`/`example`/`whenToUse` when present) to `ManifestType` + `ManifestAttr`; move `description` out of the excluded set.
- Modify `server/typescript/packages/metadata/src/registry-manifest-exclusions.ts` — document `description` as now IN the v1 manifest boundary.
- Modify `fixtures/registry-conformance/expected-registry.json` — regenerated with descriptions.
- Modify `server/typescript/packages/metadata/test/registry-conformance.test.ts` — assert description coverage (every entry has a non-empty description).
- Create `server/typescript/packages/metadata/test/provider-data.test.ts` — unit tests for `defineProviderFromData`.
- Add an embed byte-identity test (Task 4) mirroring the existing template-embed gate.

**Phase 2 — convert remaining TS core providers** (one `spec/metamodel/<provider>.json` + embed + provider edit each).

**Phase 3 — doc-gen** — `server/typescript/packages/metadata/src/metamodel-docs/` (neutral engine) + `meta docs --metamodel` wiring + agent-context wiring + a docs conformance gate.

**Phase 4 — cross-port fan-out** — each port: a `provider-data` reader, embed the same `spec/metamodel/*.json`, emit descriptions in its manifest; `registry-conformance` green.

---

## Phase 1 — TS foundation on the field provider

### Task 1: The provider-definition data format

**Files:**
- Create: `server/typescript/packages/metadata/src/provider-data.ts`
- Test: `server/typescript/packages/metadata/test/provider-data.test.ts`

- [ ] **Step 1: Write the failing test** (`provider-data.test.ts`)

```ts
import { test, expect } from "bun:test";
import { defineProviderFromData, type ProviderDefinition } from "../src/provider-data.js";
import { TypeRegistry } from "../src/registry.js";
import { MetaField } from "../src/core/field/meta-field.js";
import { TypeId } from "../src/shared/type-id.js"; // adjust import to the real TypeId location

const DATA: ProviderDefinition = {
  provider: "test-fields",
  types: [
    {
      type: "field", subType: "currency",
      description: "Stores money as integer minor units (cents).",
      dataType: "long",
      attrs: [
        { name: "currency", valueType: "string", required: false, default: "USD",
          description: "ISO 4217 code; defaults to USD." },
      ],
    },
  ],
};

test("defineProviderFromData produces a registrable TypeDefinition with descriptions", () => {
  const reg = new TypeRegistry();
  const factories = { "field.currency": (id: TypeId, name: string) => new MetaField(id, name) };
  for (const def of defineProviderFromData(DATA, factories)) reg.register(def);
  const def = reg.get("field", "currency"); // adjust to the real getter
  expect(def.description).toBe("Stores money as integer minor units (cents).");
  expect(def.attributes[0]!.description).toBe("ISO 4217 code; defaults to USD.");
  expect(def.attributes[0]!.default).toBe("USD");
});

test("defineProviderFromData throws when a factory is missing for a declared type", () => {
  expect(() => defineProviderFromData(DATA, {})).toThrow(/no factory for "field.currency"/);
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd server/typescript && bun test packages/metadata/test/provider-data.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `provider-data.ts`** — the format + the builder. (`AttrDef`/`TypeDef` mirror the existing `AttrSchema`/`TypeDefinition` *declarative* fields; the `factory` is supplied separately — the data/code boundary.)

```ts
import type { AttrSchema, TypeDefinition, ChildRule, DataType } from "./registry.js";
import { TypeId } from "./shared/type-id.js"; // adjust to the real TypeId import
import type { MetaData } from "./shared/meta-data.js";

/** Declarative attribute definition — the AttrSchema fields that are pure data. */
export interface AttrDef {
  name: string;
  valueType?: string;
  isArray?: boolean;
  required: boolean;
  default?: unknown;
  allowedValues?: readonly unknown[];
  description: string;        // required — the gate enforces non-empty
  rules?: string;             // optional prose documenting enforced-in-code rules
  example?: string;
  whenToUse?: string;
}

/** Declarative type/subtype definition. `factory` is NOT here — it is code. */
export interface TypeDef {
  type: string;
  subType: string;
  description: string;        // required
  dataType?: DataType;
  attrs?: AttrDef[];
  rules?: string;
  example?: string;
  whenToUse?: string;
}

export interface ProviderDefinition {
  provider: string;           // owning provider id (groups doc pages)
  types: TypeDef[];
}

export type FactoryMap = Record<string, (typeId: TypeId, name: string) => MetaData>;

/**
 * Turn a declarative ProviderDefinition + a code-supplied factory map into the
 * TypeDefinitions a provider passes to registry.register(). The factory (a
 * function — behavior) stays code; everything else comes from the data.
 */
export function defineProviderFromData(data: ProviderDefinition, factories: FactoryMap): TypeDefinition[] {
  return data.types.map((t): TypeDefinition => {
    const key = `${t.type}.${t.subType}`;
    const factory = factories[key];
    if (factory === undefined) {
      throw new Error(`defineProviderFromData(${data.provider}): no factory for "${key}"`);
    }
    const attributes: AttrSchema[] = (t.attrs ?? []).map((a) => ({
      name: a.name,
      ...(a.valueType !== undefined ? { valueType: a.valueType as AttrSchema["valueType"] } : {}),
      ...(a.isArray !== undefined ? { isArray: a.isArray } : {}),
      required: a.required,
      ...(a.default !== undefined ? { default: a.default as AttrSchema["default"] } : {}),
      ...(a.allowedValues !== undefined ? { allowedValues: a.allowedValues as AttrSchema["allowedValues"] } : {}),
      description: a.description,
    }));
    return {
      typeId: new TypeId(t.type, t.subType),
      description: t.description,
      factory,
      childRules: [],            // child rules stay where they are today (Task 4 wires real ones if needed)
      attributes,
      ...(t.dataType !== undefined ? { dataType: t.dataType } : {}),
    };
  });
}
```

- [ ] **Step 4: Run it, verify it passes** — `bun test packages/metadata/test/provider-data.test.ts` → PASS. (If `TypeId`/`reg.get` import paths differ, fix to the real ones — grep `class TypeId` and the registry getter.)

- [ ] **Step 5: Commit** — `git add … && git commit -m "feat(fr-033): provider-data format + defineProviderFromData (declarative→registrable)"`

### Task 2: Carry the optional doc fields (`rules`/`example`/`whenToUse`) on the registry

**Files:**
- Modify: `server/typescript/packages/metadata/src/registry.ts` (the `AttrSchema` + `TypeDefinition` interfaces)
- Test: extend `provider-data.test.ts`

- [ ] **Step 1: Failing test** — add to `provider-data.test.ts`:

```ts
test("optional rules/example/whenToUse flow onto the registered def", () => {
  const data: ProviderDefinition = { provider: "t", types: [{
    type: "field", subType: "currency", description: "d", dataType: "long",
    rules: "Wire format is integer minor units; float money is forbidden.",
    attrs: [{ name: "currency", valueType: "string", required: false, description: "c", whenToUse: "Any money." }],
  }]};
  const reg = new TypeRegistry();
  const factories = { "field.currency": (id: TypeId, name: string) => new MetaField(id, name) };
  for (const d of defineProviderFromData(data, factories)) reg.register(d);
  const def = reg.get("field", "currency");
  expect(def.rules).toBe("Wire format is integer minor units; float money is forbidden.");
  expect(def.attributes[0]!.whenToUse).toBe("Any money.");
});
```

- [ ] **Step 2: Run, verify it fails** (TS error — `rules`/`whenToUse` not on the interfaces).
- [ ] **Step 3: Implement** — add optional `rules?: string; example?: string; whenToUse?: string;` to both `AttrSchema` and `TypeDefinition` in `registry.ts`; thread them through in `defineProviderFromData` (attr + type mapping).
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(fr-033): registry carries optional rules/example/whenToUse doc fields`.

### Task 3: Author the field provider's global definition file

**Files:**
- Create: `spec/metamodel/field.json`

- [ ] **Step 1:** Extract the field vocabulary + attrs from the current hand-coded source `server/typescript/packages/metadata/src/core/field/field-schema.ts` (the `commonFieldAttrs` array + the per-subtype attrs) and from `field-constants.ts` (the subtype list). Author `spec/metamodel/field.json` as a `ProviderDefinition` with **every field subtype** and its attrs, each carrying the existing `description` text verbatim, PLUS a one-line `description` per subtype (e.g. `field.currency` → "Stores money as integer minor units (cents)."), and `rules` prose where a complex rule applies (e.g. currency wire-format).

```jsonc
{
  "provider": "metaobjects-core-types",
  "types": [
    { "type": "field", "subType": "string", "dataType": "string",
      "description": "A text field.",
      "attrs": [ /* commonFieldAttrs + string-specific (maxLength, …) — copy name/valueType/required/default/allowedValues/description verbatim */ ] },
    { "type": "field", "subType": "currency", "dataType": "long",
      "description": "Stores money as integer minor units (cents).",
      "rules": "Wire format is integer minor units on the wire always; float arithmetic for money is forbidden. @currency is ISO 4217; @locale is BCP 47 (client-side formatting only).",
      "attrs": [ { "name": "currency", "valueType": "string", "required": false, "default": "USD",
                  "description": "ISO 4217 currency code on a currency-subtype field. Defaults to USD when omitted." } ] }
    /* … every other field subtype … */
  ]
}
```

- [ ] **Step 2: Verify completeness** — write a temporary check (or extend Task 4's gate) that the set of `type.subType` + attr names in `field.json` equals what the current `field-provider` registers. (This is the safety net: the file must be a faithful externalization, not a partial one.)
- [ ] **Step 3: Commit** — `feat(fr-033): spec/metamodel/field.json — field provider declarative definition`.

### Task 4: Convert the field provider to read its embedded file

**Files:**
- Create: `server/typescript/packages/metadata/src/core/field/field-definition.embedded.ts` (generated constant; add its generation to the existing template/asset embed build step)
- Modify: the field registration site (grep `commonFieldAttrs` / the provider that builds field `TypeDefinition`s — likely `core/field/field-provider.ts` or `registerCoreTypes`)
- Test: `server/typescript/packages/metadata/test/field-definition-embed.test.ts` (byte-identity, mirrors the existing template-embed gate)

- [ ] **Step 1: Failing test (embed integrity)** — assert the embedded constant equals the on-disk `spec/metamodel/field.json` (read both, `JSON.parse` + deep-equal), mirroring the existing template-embed byte-identity test. Run → FAIL (embedded module missing).
- [ ] **Step 2: Generate the embed** — add `field-definition.embedded.ts` to the build's asset-embed step (the same generator that emits the embedded templates string-module) so it exports `FIELD_DEFINITION: ProviderDefinition` parsed from `spec/metamodel/field.json`. Run the embed gen.
- [ ] **Step 3: Failing test (registration parity)** — a test that composes the registry via the field provider and asserts the registered `field.currency` def's `description` + attrs match `field.json` (i.e. the provider now sources from data). Run → FAIL (provider still hand-codes).
- [ ] **Step 4: Rewire the provider** — replace the hand-coded `commonFieldAttrs`/per-subtype attr arrays with: `defineProviderFromData(FIELD_DEFINITION, FIELD_FACTORIES)` where `FIELD_FACTORIES` is a code map `{ "field.string": (id,name)=>…, "field.currency": …, … }` (the factories that exist today, extracted). Keep `childRules` + any imperative validation exactly as-is. Delete the now-dead `description` strings from `field-schema.ts` (or delete the file if fully superseded).
- [ ] **Step 5: Run both tests + the full metadata suite** — `bun test packages/metadata/` → 0 fail (the registry is byte-equivalent for the gated facets; descriptions now sourced from the file).
- [ ] **Step 6: Commit** — `feat(fr-033): field provider reads spec/metamodel/field.json (embedded)`.

### Task 5: Emit descriptions in the registry manifest + regenerate the gate

**Files:**
- Modify: `server/typescript/packages/metadata/src/registry-manifest.ts` (`ManifestType`, `ManifestAttr`, `toManifestAttr`, the type emitter)
- Modify: `server/typescript/packages/metadata/src/registry-manifest-exclusions.ts` (note `description` is now IN)
- Modify: `fixtures/registry-conformance/expected-registry.json` (regenerate)
- Test: `server/typescript/packages/metadata/test/registry-conformance.test.ts`

- [ ] **Step 1: Failing test** — extend the conformance test to assert the manifest carries `description` per type/subtype and per attr (read the emitted manifest; assert `types[i].description` non-empty and `types[i].attrs[j].description` present). Run → FAIL.
- [ ] **Step 2: Implement** — add `description: string` (and optional `rules`/`example`/`whenToUse`) to `ManifestType` and `ManifestAttr`; populate from `TypeDefinition.description` / `AttrSchema.description` in the emitter; keep the canonical sort. Update `registry-manifest-exclusions.ts` comment/boundary so `description` is documented as included (it was explicitly excluded in v1).
- [ ] **Step 3: Regenerate `expected-registry.json`** — run the manifest emitter against the composed core registry (the conformance test or a small script) and write the result. Verify the diff is purely additive (new `description` fields; existing name/valueType/required unchanged).
- [ ] **Step 4: Add the coverage assertion** — in `registry-conformance.test.ts`, fail if ANY emitted type/subtype/attr has an empty/missing `description` (strict-provenance for docs).
- [ ] **Step 5: Run** — `bun test packages/metadata/test/registry-conformance.test.ts` → PASS (TS reference). Note: this RED-flags the other four ports until Phase 4 — expected and documented.
- [ ] **Step 6: Commit** — `feat(fr-033): registry manifest emits descriptions + coverage gate (TS)`.

> **Phase 1 done = working software:** the field provider is data-driven, descriptions flow from a single shared file into the registry and the gated manifest, and the coverage gate is live. Everything downstream (other providers, docs, ports) repeats this proven recipe.

---

## Phase 1b — The constraint model (children / parents / contradiction pass)

Implements spec §3.1. Adds the typesConfig-recovered structural constraints to the
provider-data format + a single additive merge + a contradiction validator. Do this
right after Phase 1 (the field provider proves the data path); apply to every
provider as Phase 2 converts them.

### Task 7: Constraint fields in the provider-data format

**Files:** Modify `server/typescript/packages/metadata/src/provider-data.ts`; Modify `registry.ts` (`ChildRule` → enriched); Test `provider-data.test.ts`.

- [ ] **Step 1: Failing test** — a `ProviderDefinition` whose type declares a unified `children` list (an `type:"attr"` entry with `subType`/`default` + a `type:"identity"` entry with `min:1,max:1` + a `type:"field"` entry `min:0,max:null`) and a `parents` list; assert `defineProviderFromData` produces a `TypeDefinition` whose `childRules` carry `{type, subType (value|list|"*"), name, min, max, named?}` and whose `parents` carry the declared list. Run → FAIL.
- [ ] **Step 2: Implement** — enrich `ChildRule` in `registry.ts` to `{ childType, childSubType: string | string[], childName, min: number, max: number | null, named?: boolean, default?, allowedValues?, isArray? }`; add `parents?: string[]` to `TypeDefinition`; in `provider-data.ts` map each `children[]` entry (attr or structural — `type:"attr"` carries the attr facets, max forced to 1 unless `isArray`) and pass `parents` through. Keep wildcard semantics (`*` matches any). Attr entries ALSO populate the existing `attributes: AttrSchema[]` (an attr child IS an AttrSchema) so the rest of the loader is unchanged — i.e. the unified `children` list is the authoring shape; internally an `type:"attr"` entry fans out to BOTH a `childRule` and an `AttrSchema`.
- [ ] **Step 3: Run, verify pass.** **Step 4: Commit** — `feat(fr-033): unified children/parents constraint fields in provider-data`.

### Task 8: Additive merge (provider union + extends inheritance)

**Files:** Create `server/typescript/packages/metadata/src/constraint-merge.ts`; Test `constraint-merge.test.ts`.

- [ ] **Step 1: Failing test** — given a base type with children `[field.*]` and an extension provider adding `parents: ["object.entity"]` on `source.rdb` + a subtype `field.currency extends field`, assert `mergeConstraints(registry)` yields: `object.entity` effective children = base ∪ any child that declares it a parent; `field.currency` effective children/attrs = `field`'s ∪ its own (purely additive — nothing removed). Run → FAIL.
- [ ] **Step 2: Implement** `mergeConstraints(registry)` — (a) horizontal: fold each type's `parents` into the named parents' effective allowed-children; (b) vertical: walk `extends`/`super`, union super's children/attrs into the subtype (additive only — assert no narrowing is attempted; a subtype re-declaring an inherited attr with a different `subType`/`required` is contradiction #6, surfaced in Task 9). Returns an `EffectiveConstraints` map keyed by `type.subType`.
- [ ] **Step 3: Run, verify pass.** **Step 4: Commit** — `feat(fr-033): additive constraint merge (provider union + extends)`.

### Task 9: The contradiction validator (the six checks)

**Files:** Create `server/typescript/packages/metadata/src/constraint-validate.ts`; Test `constraint-validate.test.ts`; new error code in `errors.ts` + `fixtures/conformance/ERROR-CODES.json`.

- [ ] **Step 1: Failing tests** — one per contradiction (spec §3.1): (1) dangling parent ref → error; (2) required child of an unregistered/unadmitted type → error; (3) `min>max` and `max:0,min:1` → error; (4) closed-set clash (C claims P; P's children closed without C) → error; (5) required-child cycle → error; (6) same attr name twice with conflicting subType → error. A fully-consistent fixture → no error. Run → FAIL.
- [ ] **Step 2: Implement** `validateConstraints(effective, registry): MetaModelError[]` returning one `ERR_INVALID_METAMODEL_CONSTRAINT` (new code; add to `errors.ts` + `ERROR-CODES.json` with a `which`-style detail) per contradiction. Wire it into the registry compose/seal path so a bad provider definition fails at bootstrap (mirrors ADR-0023 strictness).
- [ ] **Step 3: Run, verify pass + full metadata suite green.** **Step 4: Commit** — `feat(fr-033): metamodel constraint contradiction validator (6 checks)`.

> The manifest (Task 5) + doc-gen (Phase 3) additionally emit the `children`/`parents`/cardinality so the gate pins the constraint graph cross-port and the provider doc pages show "allowed children / parents / cardinality."

---

## Phase 2 — Convert the remaining TS core providers (recipe-driven)

For **each** core provider, repeat the Task 3 + Task 4 recipe: author `spec/metamodel/<provider>.json` (faithful externalization of its current hand-coded vocab/attrs + a subtype `description` + `rules` prose for its complex rules), generate the embedded constant, rewire the provider to `defineProviderFromData(... , <provider>_FACTORIES)`, regenerate `expected-registry.json`, keep the suite + coverage gate green. Providers to convert (grep `src/**/!(*.test).ts` for `registerTypes`/`TypeDefinition` arrays; the set the registry composes today):

- [ ] `object` (entity/value/projection) — `spec/metamodel/object.json`
- [ ] `field` — done in Phase 1
- [ ] `attr` — `spec/metamodel/attr.json`
- [ ] `validator` — `spec/metamodel/validator.json`
- [ ] `identity` (primary/secondary/reference) — `spec/metamodel/identity.json`
- [ ] `relationship` (association/aggregation/composition + M:N attrs) — `spec/metamodel/relationship.json` (rules prose: `@through` junction needs two `identity.reference`; `@symmetric` self-join only)
- [ ] `source` (rdb + `@kind`s) — `spec/metamodel/source.json`
- [ ] `origin` (passthrough/aggregate) — `spec/metamodel/origin.json`
- [ ] `template` (prompt/output) + the prompt/payload attrs — `spec/metamodel/template.json`
- [ ] `layout` (dataGrid), `view`, `documentation` common attrs — one file each
- [ ] any remaining registered provider surfaced by the coverage gate

Each provider is its own task with its own commit; after each, `bun test packages/metadata/` stays green. (This phase may be split into its own detailed plan when reached — the recipe is fixed by Phase 1; only the per-provider data differs.)

---

## Phase 3 — Tiered metamodel doc-gen + agent-context wiring

**Files:**
- Create `server/typescript/packages/metadata/src/metamodel-docs/` — the neutral renderer: consumes the registry manifest (with descriptions/rules/example/whenToUse + the owning `provider`) and emits `metamodel/INDEX.md` (every `type.subType`, one-liner, link) + `metamodel/providers/<provider>.md` (full attr + rule detail).
- Modify the CLI (`server/typescript/packages/cli/src/commands/docs.ts`) — add a `--metamodel` mode that runs the renderer.
- Wire into the agent-context assembler (`server/typescript/packages/sdk/src/agent-docs/…` / the `meta init` assembler) so `metaobjects-authoring` references `INDEX.md` always-on + pulls provider pages on-demand.
- Add a docs-conformance fixture (byte-gated like the other docs corpora) under `fixtures/` for a small representative registry → expected `INDEX.md` + a provider page.

- [ ] Renderer test: a fixed mini-manifest → expected `INDEX.md` + one provider page (byte match). Implement renderer to pass.
- [ ] CLI test: `meta docs --metamodel` emits the files to the target dir; assert files + the `@generated` header.
- [ ] Agent-context test: the assembled context references `INDEX.md`; provider pages are on-demand fragments (mirror the existing `metaobjects-*` skill `references/<token>.md` pattern + its gate).
- [ ] Optional (open item #3): validate each `example` snippet through the loader at render time; fail the render if a documented example is invalid metadata.
- [ ] Commit per sub-task.

---

## Phase 4 — Cross-port fan-out

For **each** of Java, C#, Python (Kotlin inherits the JVM metadata module): the port reads the SAME `spec/metamodel/*.json` global files (embedded at build, the existing per-port embed pattern), overlay-merges any local `server/<lang>/…/metamodel/<provider>.<lang>.json` language-specific file, registers descriptions onto its registry, and emits them in its registry manifest. Recipe per port:

- [ ] Add a `provider-data` reader (the port's `defineProviderFromData` equivalent: declarative data + the port's existing factory/registration, merge global+local).
- [ ] Embed the global `spec/metamodel/*.json` files (the port's asset-embed mechanism) + a byte-identity gate.
- [ ] Rewire the port's providers to register from the embedded data (keep factories + imperative validation + codegen as code).
- [ ] Grow the port's registry-manifest emitter to include `description` (it currently excludes it — the v1 boundary is shared across ports).
- [ ] Run `registry-conformance` for the port → byte-match the (now description-carrying) `expected-registry.json`; coverage gate green.
- [ ] Author any language-specific overlay descriptions (the port's excluded/per-port set) in its local file.
- [ ] Commit per port.

Sequencing: Java first (Kotlin free), then C#, then Python — mirroring the FR-032 fan-out. After Phase 4 all five ports are green against the description-carrying manifest, and the neutral doc engine renders identical core pages for every port.

---

## Testing strategy

- **Unit** — `provider-data.test.ts` (the builder), the embed byte-identity gates, the renderer byte tests.
- **Conformance** — `registry-conformance` is the cross-port oracle: it now also asserts description coverage + identity. Per the cross-language-porting skill, the corpus is the authority — fix the port, never the fixture.
- **Docs** — byte-gated metamodel-doc fixtures, like the existing docs corpora.
- **Green-at-each-step** — after every provider conversion and every port, the full metadata suite + `registry-conformance` stay green (the TS reference goes green at Phase 1; the other ports go green as Phase 4 reaches them — the intervening RED is documented + expected, exactly like the FR-032 sweep).

## Out of scope (per spec §8)

Instance-level docs (`commonAttrs`), an imperative-rule DSL, and any codegen/runtime behavior change. Factories, validation passes, and emitters stay code.

# FR-011 Recover Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. ALSO: superpowers:cross-language-porting for the port phases. The shared `fixtures/recover-conformance/` corpus is the ORACLE — never edit a fixture to make a port pass; escalate a suspected-wrong fixture.

**Goal:** Make FR-010's tolerant `recover()` good at enums — resolve casing/separator/spacing variants and hallucinations safely via a configurable normalization + alias + declared-default pipeline — and close the nested-object recovery gap, in place (no decouple), across all 5 ports.

**Architecture:** Extend the existing `recover` engine (stays in each port's render/recover module). Per enum field the coerce stage resolves: `exact → normalize(mode) → @enumAlias → @coerceDefault → MALFORMED`; absent fields fill from `@default`; the reserved `DEFAULTED` classification is finally emitted. Normalization mode is a new `@normalize` attr (`none|collapse|strip`, ASCII-only → byte-identical cross-port), per-field with an `object.value`-level default, baked into the `FieldSpec` by codegen. Nested `FieldSpec.Object` fields are descended into with dotted child paths. TypeScript pilots; C#/Java(+Kotlin)/Python follow against the shared corpus.

**Tech Stack:** TS/Bun (pilot), C#/.NET, Java/Kotlin (Maven), Python (pytest). Spec: `docs/superpowers/specs/2026-05-30-fr-011-recover-hardening-design.md`.

---

## File structure

**TS pilot** (`server/typescript/packages/`):
- `metadata/src/core/field/field-constants.ts` — add `FIELD_ATTR_COERCE_DEFAULT`, `FIELD_ATTR_NORMALIZE`, `NORMALIZE_MODES`.
- `metadata/src/core/field/field-schema.ts` — register `@coerceDefault` (string) + `@normalize` (closed enum) on `field.enum`.
- `metadata/src/object/object-schema.ts` (or wherever `object.value` attrs are declared) — register `@normalize` on `object.value` (the default-carrier).
- `metadata/test/fr011-coerce-default-normalize.test.ts` — new loader test.
- `render/src/recover/types.ts` — extend `FieldSpec` (+ `enumField` factory) with `coerceDefault?`, `defaultValue?`, `normalize`.
- `render/src/recover/normalize.ts` — **new**: `normalizeEnum(s, mode)`.
- `render/src/recover/coerce.ts` — rewrite `coerceEnum` to the new pipeline.
- `render/src/recover/recover.ts` — nested-object extract; absent-fill via `defaultValue`; classify `DEFAULTED`.
- `render/test/recover/normalize.test.ts`, `coerce.test.ts`, `recover.test.ts`, `recover/recover-conformance.test.ts` — tests.
- `codegen-ts/src/templates/fr010-field-mapping.ts` + `recover-schema-emitter.ts` — emit `coerceDefault`/`defaultValue`/resolved `normalize` into emitted `enumField(...)`; resolve `@normalize` field→object→`strip`.
- `codegen-ts/test/fr010-output-codegen.test.ts` — extend the import-and-run proof.

**Shared corpus** (repo root): `fixtures/recover-conformance/<new cases>/` (schema.json/input.txt/expected.json).

**Cross-port mirrors** (Phases 2–5): the analogous files in `server/csharp/MetaObjects[.Render]`, `server/java/{metadata,render,codegen-spring}` (+ `codegen-kotlin`), `server/python/src/metaobjects`.

---

## Phase 1 — TypeScript pilot

### Task 1: Metamodel attrs — `@coerceDefault` + `@normalize`

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/field/field-constants.ts`
- Modify: `server/typescript/packages/metadata/src/core/field/field-schema.ts`
- Modify: the `object.value` attr schema (find via `grep -rn "OBJECT_SUBTYPE_VALUE\|object.value" packages/metadata/src` — register `@normalize` there too)
- Test: `server/typescript/packages/metadata/test/fr011-coerce-default-normalize.test.ts`

- [ ] **Step 1: Write the failing loader test**

```ts
// fr011-coerce-default-normalize.test.ts
import { describe, expect, test } from "bun:test";
import { loadFromString } from "../src/index.js"; // match how fr010-loader-attrs.test.ts loads

const yaml = (norm: string, cd: string) => `
object.value:
  name: Answer
  "@normalize": ${norm}
  children:
    - field.enum:
        name: confidence
        "@values": [HIGH, OK, LOW]
        "@coerceDefault": ${cd}
`;

describe("FR-011 attrs", () => {
  test("@coerceDefault + @normalize load and round-trip", () => {
    const r = loadFromString(yaml("strip", "LOW"), "m.yml");
    expect(r.errors).toHaveLength(0);
    const f = /* navigate to field confidence */ findEnum(r.root, "confidence");
    expect(f.attr("coerceDefault")).toBe("LOW");
    expect(f.attr("normalize") ?? r.root.child("Answer").attr("normalize")).toBe("strip");
  });
  test("bad @coerceDefault (not a member) errors", () => {
    const r = loadFromString(yaml("strip", "BOGUS"), "m.yml");
    expect(r.errors.some(e => e.code === "ERR_BAD_ATTR_VALUE")).toBe(true);
  });
  test("bad @normalize value errors", () => {
    const r = loadFromString(yaml("nope", "LOW"), "m.yml");
    expect(r.errors.some(e => e.code === "ERR_BAD_ATTR_VALUE")).toBe(true);
  });
});
```

(Mirror the exact load/navigate helpers from the existing `metadata/test/fr010-loader-attrs.test.ts`.)

- [ ] **Step 2: Run — expect FAIL** (attrs unregistered): `cd server/typescript/packages/metadata && bun test test/fr011-coerce-default-normalize.test.ts`

- [ ] **Step 3: Add constants**

```ts
// field-constants.ts
export const FIELD_ATTR_COERCE_DEFAULT = "coerceDefault";
export const FIELD_ATTR_NORMALIZE = "normalize";
export const NORMALIZE_MODES = ["none", "collapse", "strip"] as const;
export const NORMALIZE_DEFAULT = "strip";
```

- [ ] **Step 4: Register the attrs**

```ts
// field-schema.ts — add to the field.enum attr list (alongside @values/@enumAlias):
{ name: FIELD_ATTR_COERCE_DEFAULT, valueType: ATTR_SUBTYPE_STRING },          // member-validated in a pass below
{ name: FIELD_ATTR_NORMALIZE, valueType: ATTR_SUBTYPE_STRING, allowedValues: [...NORMALIZE_MODES] },
// object.value attr schema — add the default-carrier:
{ name: FIELD_ATTR_NORMALIZE, valueType: ATTR_SUBTYPE_STRING, allowedValues: [...NORMALIZE_MODES] },
```

Add a validation check that `@coerceDefault`, when present, is one of the field's `@values` (mirror the existing enum-member validation; emit `ERR_BAD_ATTR_VALUE`).

- [ ] **Step 5: Run — expect PASS.** Same command. Then `bun test` (full metadata suite) — no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata
git commit -m "feat(ts-metadata): FR-011 @coerceDefault + @normalize attrs on field.enum"
```

### Task 2: Normalization function

**Files:** Create `server/typescript/packages/render/src/recover/normalize.ts`; Test `server/typescript/packages/render/test/recover/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { normalizeEnum } from "../../src/recover/normalize.js";

describe("normalizeEnum", () => {
  test("none = identity", () => expect(normalizeEnum("In Progress", "none")).toBe("In Progress"));
  test("collapse: case-fold + trim + [\\s_-]+ -> _", () => {
    expect(normalizeEnum("  In-Progress ", "collapse")).toBe("IN_PROGRESS");
    expect(normalizeEnum("in progress", "collapse")).toBe("IN_PROGRESS");
    expect(normalizeEnum("inprogress", "collapse")).toBe("INPROGRESS"); // stays distinct
  });
  test("strip: case-fold + keep [A-Z0-9] only", () => {
    expect(normalizeEnum("in progress!", "strip")).toBe("INPROGRESS");
    expect(normalizeEnum("IN_PROGRESS", "strip")).toBe("INPROGRESS");
  });
  test("ASCII-only case fold (no locale)", () => expect(normalizeEnum("café", "strip")).toBe("CAF")); // é dropped
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd server/typescript/packages/render && bun test test/recover/normalize.test.ts`

- [ ] **Step 3: Implement**

```ts
// normalize.ts
export type NormalizeMode = "none" | "collapse" | "strip";

/** ASCII-only enum normalization. Pure [A-Za-z0-9] transform → byte-identical cross-port. */
export function normalizeEnum(s: string, mode: NormalizeMode): string {
  if (mode === "none") return s;
  const up = asciiUpper(s.trim());
  if (mode === "collapse") return up.replace(/[\s_-]+/g, "_");
  return up.replace(/[^A-Z0-9]/g, ""); // strip
}

function asciiUpper(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `git commit -am "feat(ts-render): FR-011 ASCII enum normalization (none/collapse/strip)"`

### Task 3: Extend FieldSpec + rewrite the enum coercion pipeline

**Files:** Modify `render/src/recover/types.ts`, `render/src/recover/coerce.ts`; Test `render/test/recover/coerce.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// add to coerce.test.ts
import { enumField } from "../../src/recover/types.js";
import { coerceValue, MALFORMED } from "../../src/recover/coerce.js";

function ef(opts: { coerceDefault?: string; normalize?: "none"|"collapse"|"strip"; aliases?: Record<string,string> }) {
  return enumField("c", true, ["HIGH","OK","LOW"], opts.aliases ?? {}, opts.coerceDefault, opts.normalize ?? "strip");
}
const rep = () => new RecoveryReport();

test("exact", () => expect(coerceValue("OK", ef({}), defaults(), "c", rep())).toBe("OK"));
test("normalized strip", () => expect(coerceValue("o k!", ef({}), defaults(), "c", rep())).toBe("OK"));
test("alias (normalized key)", () => expect(coerceValue("medium", ef({ aliases: { MEDIUM: "OK" } }), defaults(), "c", rep())).toBe("OK"));
test("coerceDefault on unrecognized", () => {
  const r = rep();
  expect(coerceValue("frobbed", ef({ coerceDefault: "LOW" }), defaults(), "c", r)).toBe("LOW");
  expect(r.coercions().some(x => x.kind === "coerceDefault")).toBe(true); // drives DEFAULTED
});
test("no coerceDefault → MALFORMED", () => expect(coerceValue("frobbed", ef({}), defaults(), "c", rep())).toBe(MALFORMED));
test("coerceDefault not borrowed for absent — handled in recover.ts, not coerce", () => {});
```

- [ ] **Step 2: Run — expect FAIL** (factory signature + pipeline).

- [ ] **Step 3: Extend `FieldSpec` + `enumField`**

```ts
// types.ts — FieldSpec gains:
export interface FieldSpec {
  // ...existing: name, kind, required, array, enumValues, enumAlias, min, max, nested...
  coerceDefault?: string | null;   // present-but-uncoercible fallback member
  defaultValue?: string | null;    // absent-fill member (from @default)
  normalize: NormalizeMode;        // resolved mode (default "strip")
}
export function enumField(
  name: string, required: boolean, values: string[],
  aliases: Record<string, string>, coerceDefault?: string | null,
  normalize: NormalizeMode = "strip", defaultValue?: string | null,
): FieldSpec {
  return { name, kind: FieldKind.ENUM, required, array: false, enumValues: values,
           enumAlias: aliases, min: null, max: null, nested: null,
           coerceDefault: coerceDefault ?? null, defaultValue: defaultValue ?? null, normalize };
}
```

- [ ] **Step 4: Rewrite `coerceEnum`**

```ts
// coerce.ts
import { normalizeEnum } from "./normalize.js";

function coerceEnum(raw: string, spec: FieldSpec, opts: RecoverOptions, path: string, report: RecoveryReport): string | typeof MALFORMED {
  const values = spec.enumValues ?? [];
  // 1. exact
  if (values.includes(raw)) return raw;
  const M = spec.normalize;
  // 2. normalized
  if (M !== "none") {
    const nIn = normalizeEnum(raw, M);
    const hit = values.find(v => normalizeEnum(v, M) === nIn);
    if (hit !== undefined) { report.addCoercion({ fieldPath: path, from: raw, to: hit, kind: "normalize" }); return hit; }
    // 3. alias (runtime wins; keys normalized)
    const aliases = { ...(spec.enumAlias ?? {}), ...(opts.aliases ?? {}) };
    for (const [k, target] of Object.entries(aliases)) {
      if (normalizeEnum(k, M) === nIn && values.includes(target)) {
        report.addCoercion({ fieldPath: path, from: raw, to: target, kind: "alias" }); return target;
      }
    }
  }
  // 4. (fuzzy slot — deferred)
  // 5. coerceDefault
  if (spec.coerceDefault != null && values.includes(spec.coerceDefault)) {
    report.addCoercion({ fieldPath: path, from: raw, to: spec.coerceDefault, kind: "coerceDefault" });
    return spec.coerceDefault;
  }
  return MALFORMED; // 6
}
```

- [ ] **Step 5: Run — expect PASS.** Then full `bun test test/recover` (existing recover tests must stay green; the old case-insensitive behavior is now `normalize="strip"` default — verify the FR-010 corpus case `json-off-vocab-alias` still passes).

- [ ] **Step 6: Commit** `git commit -am "feat(ts-render): FR-011 enum coercion pipeline (normalize/alias/coerceDefault)"`

### Task 4: classify `DEFAULTED`; absent-fill via `@default`; nested-object recovery

**Files:** Modify `render/src/recover/recover.ts`; Test `render/test/recover/recover.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("present-but-garbage enum with coerceDefault → DEFAULTED", () => {
  const schema = new RecoverSchema(Format.JSON, "R", [enumField("c", true, ["HIGH","LOW"], {}, "LOW")]);
  const o = recover('{"c":"frobbed"}', schema);
  expect(o.data.c).toBe("LOW");
  expect(o.report.states()["c"]).toBe(FieldRecovery.DEFAULTED);
  expect(o.report.hasLostRequired()).toBe(false); // DEFAULTED satisfies required
});
test("absent enum with @default → DEFAULTED", () => {
  const schema = new RecoverSchema(Format.JSON, "R", [enumField("c", true, ["HIGH","LOW"], {}, null, "strip", "HIGH")]);
  const o = recover('{}', schema);
  expect(o.data.c).toBe("HIGH");
  expect(o.report.states()["c"]).toBe(FieldRecovery.DEFAULTED);
});
test("absent enum, no @default → LOST_REQUIRED", () => {
  const schema = new RecoverSchema(Format.JSON, "R", [enumField("c", true, ["HIGH","LOW"], {})]);
  expect(recover('{}', schema).report.states()["c"]).toBe(FieldRecovery.LOST_REQUIRED);
});
test("nested object recovers with dotted paths", () => {
  const inner = new RecoverSchema(Format.JSON, "meta", [scalar("score", FieldKind.INT, true)]);
  const schema = new RecoverSchema(Format.JSON, "R", [objectField("meta", true, false, inner)]);
  const o = recover('{"meta":{"score":7}}', schema);
  expect((o.data.meta as any).score).toBe(7);
  expect(o.report.states()["meta.score"]).toBe(FieldRecovery.RECOVERED);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — in the extract/classify path of `recover.ts`:
  - **Absent enum:** if the key is absent and `spec.defaultValue != null` → set value, `report.set(path, DEFAULTED)`; else existing LOST logic.
  - **DEFAULTED on coerce:** after coerce returns a value, if the field's last coercion for `path` has `kind ∈ {"coerceDefault","default"}` → `report.set(path, DEFAULTED)`, else `RECOVERED`. (Read the coercion log, or have coerce return a `{value, defaulted}` — pick one and keep it; recommended: a small `terminalKind` lookup over `report.coercions()` filtered by `fieldPath`.)
  - **Nested object:** when `spec.kind === Object && spec.nested`, recurse: extract the sub-map, run the same per-field extract/classify/coerce against `spec.nested.fields`, prefix child paths with `${path}.`; merge child states into the report; array-of-objects iterates with `${path}[i].`.

```ts
// sketch of the nested branch inside the per-field loop
if (spec.kind === FieldKind.OBJECT && spec.nested) {
  const childRaw = rawMap[spec.name];
  if (childRaw == null) { setAbsent(spec, path, report); continue; }
  if (typeof childRaw !== "object" || Array.isArray(childRaw) !== spec.array) { report.set(path, MALFORMED_STATE); continue; }
  const items = spec.array ? (childRaw as unknown[]) : [childRaw];
  const out = items.map((item, i) =>
    extractInto(item as Record<string, unknown>, spec.nested!.fields, spec.array ? `${path}[${i}]` : path, report));
  data[spec.name] = spec.array ? out : out[0];
  continue;
}
```

- [ ] **Step 4: Run — expect PASS.** Full `bun test test/recover` green.

- [ ] **Step 5: Commit** `git commit -am "feat(ts-render): FR-011 DEFAULTED classification, @default absent-fill, nested-object recovery"`

### Task 5: Shared conformance corpus

**Files:** Create under `fixtures/recover-conformance/`: `enum-normalize-strip/`, `enum-normalize-collapse/`, `enum-alias-synonym/`, `enum-coerce-default/`, `enum-default-absent/`, `nested-object-clean/`, `nested-object-partial/`, `array-of-objects/`, `xml-nested/`, `multi-malformation/` (each `schema.json` + `input.txt` + `expected.json`). Test: the existing `render/test/recover/recover-conformance.test.ts` auto-discovers them.

- [ ] **Step 1: Author each fixture.** Example `enum-coerce-default/`:

```json
// schema.json
{ "format": "JSON", "rootName": "R",
  "fields": [{ "name": "c", "kind": "ENUM", "required": true, "values": ["HIGH","OK","LOW"], "coerceDefault": "LOW", "normalize": "strip" }] }
```
```
// input.txt
Here you go: {"c": "kind of medium-ish"}
```
```json
// expected.json
{ "empty": false, "states": { "c": "DEFAULTED" }, "data": { "c": "LOW" } }
```

Author the rest analogously (cover: strip vs collapse distinction, alias, absent-default→DEFAULTED, nested clean/partial, array-of-objects, an XML-nested case, and one multi-malformation input). The conformance runner's `parseField` must learn the new `coerceDefault`/`normalize`/nested keys — extend it (Step 2).

- [ ] **Step 2: Extend the conformance runner's schema parser** (`recover-conformance.test.ts`) to read `coerceDefault`, `normalize`, and nested `fields` into the `FieldSpec` factories.

- [ ] **Step 3: Run — expect PASS** for all (old 10 + new): `cd server/typescript/packages/render && bun test test/recover/recover-conformance.test.ts`. If a new fixture is red, fix the engine or the fixture-as-authored — but the fixture must express the spec, not the impl.

- [ ] **Step 4: Commit** `git add fixtures/recover-conformance && git commit -m "test: FR-011 recover-conformance fixtures (normalize/coerceDefault/nested/xml/multi)"`

### Task 6: Codegen — emit the new FieldSpec args + resolve `@normalize`

**Files:** Modify `codegen-ts/src/templates/fr010-field-mapping.ts`, `recover-schema-emitter.ts`; Test `codegen-ts/test/fr010-output-codegen.test.ts`

- [ ] **Step 1: Extend the import-and-run proof test** — hand-built model: enum field with `@values`/`@enumAlias`/`@coerceDefault`, object-level `@normalize: strip`. Generate, import under bun, call `recover<Name>()` on `{"priority":"kinda high!!"}` (off-vocab) asserting the `@coerceDefault` fallback → the recovered mirror value + (via the report, if exposed) DEFAULTED. Assert the emitted `enumField(...)` literal carries the coerceDefault + resolved normalize args.

- [ ] **Step 2: Run — expect FAIL** (emitter doesn't emit new args).

- [ ] **Step 3: Implement** — `recover-schema-emitter.ts`: when emitting an enum field, read `@coerceDefault`, `@default`, and the resolved `@normalize` (field `@normalize` → owning object.value `@normalize` → `"strip"`), and emit `enumField("c", true, [...], {...aliases}, "LOW", "strip", "HIGH")`. Add a `resolveNormalize(field, ownerObject)` helper in `fr010-field-mapping.ts`.

- [ ] **Step 4: Run — expect PASS.** Then `cd server/typescript/packages/codegen-ts && bun test` (full suite; the golden `NpcResponseOutput.output.ts` may need regen — regen via the project's mechanism and verify the golden test passes).

- [ ] **Step 5: Commit** `git commit -am "feat(ts-codegen): FR-011 emit @coerceDefault/@default/resolved @normalize into recover schema"`

### Task 7: TS pilot — gates + merge

- [ ] **Step 1:** Full pilot verification:

```
cd server/typescript && bun test                                  # whole server suite
bun run --filter @metaobjectsdev/render typecheck
bun run --filter @metaobjectsdev/metadata typecheck
bun run --filter @metaobjectsdev/codegen-ts typecheck
```
Expected: all green, typecheck exit 0.

- [ ] **Step 2: Pre-merge gates (hard requirement)** — run a code-reviewer subagent AND a code-simplifier subagent on the FR-011 TS diff; fix findings (regression-covered).

- [ ] **Step 3:** Hygiene scan the diff (no home paths; no private-project names — and do NOT `grep -v` away any match).

- [ ] **Step 4: Merge** the pilot forward onto current `main` (`--no-ff`), verify tests on the merged result, push origin, FF the worktree. (Per the established cross-port workflow.)

---

## Phase 2 — C# port

Mirror Phase 1 into `MetaObjects` + `MetaObjects.Render` + `MetaObjects.Codegen`, against the **same shared corpus** (the oracle). The corpus + the TS pilot are the spec.

### Task 8: C# attrs + engine + codegen
- [ ] **Step 1:** Attrs — `MetaObjects/Core/Field/FieldConstants.cs` + `FieldSchema.cs` (`@coerceDefault` string + member-validated, `@normalize` closed enum) + `object.value` `@normalize` default; loader test `Fr011*Tests.cs`. Run `dotnet test MetaObjects.Conformance.Tests`.
- [ ] **Step 2:** Engine — `MetaObjects.Render/Recover/`: `FieldKind`/`FieldSpec` gain `CoerceDefault`/`DefaultValue`/`Normalize`; add `Normalize.cs` (`NormalizeEnum(s, mode)` — ASCII, mirrors the TS rule exactly); rewrite `Coerce.CoerceEnum`; `Recover` classify `DEFAULTED` + `@default` absent-fill + nested-object descent. Unit tests mirror the TS coerce/recover tests.
- [ ] **Step 3:** Codegen — `MetaObjects.Codegen/Generators/{Fr010FieldMapping,RecoverSchemaEmitter}.cs` emit the new args + resolve `@normalize`; extend the compile-and-run proof in `Fr010CodegenTests.cs`.
- [ ] **Step 4: Gate** — `dotnet test` (Render + Conformance + Codegen), `TreatWarningsAsErrors` clean; **recover-conformance corpus green (all old + new)**; review+simplify subagents; hygiene; merge forward + push + FF.

(Tier-1: the C# `NormalizeEnum` must produce byte-identical output to the TS rule; the conformance corpus enforces it.)

---

## Phase 3 — Java port (Kotlin inherits the JVM engine)

### Task 9: Java attrs + engine + codegen
- [ ] **Step 1:** Attrs — register `@coerceDefault` + `@normalize` on `field.enum` (+ `object.value` default) in the Java metadata registration; loader test. Run the Java conformance suite.
- [ ] **Step 2:** Engine — `server/java/render/.../recover/`: `FieldSpec` gains the three fields; add `Normalize.java`; rewrite `Coerce.coerceEnum`; `Recover` classify `DEFAULTED` + absent-fill + nested descent. Unit tests mirror TS.
- [ ] **Step 3:** Codegen — `codegen-spring/.../RecoverSchemaEmitter.java` emits the new args + resolves `@normalize`; **Kotlin `KotlinRecoverSchemaEmitter` mirrors it** (Kotlin reuses the JVM engine, so only the emitter changes); extend the compile-and-run proofs (`GeneratedRecoverCompileRunTest` Java + the codegen-kotlin proof).
- [ ] **Step 4: Gate** — `mvn test` (render + codegen-spring + codegen-kotlin + conformance); recover-conformance corpus green; review+simplify; hygiene; merge forward + push + FF.

---

## Phase 4 — Python port

### Task 10: Python attrs + engine + codegen
- [ ] **Step 1:** Attrs — `meta/core/field/field_constants.py` + `core_types.py` (`@coerceDefault` + `@normalize` on `field.enum`; `@normalize` default on `object.value`); loader test `tests/conformance/test_fr011_attrs.py`. Run `pytest tests/conformance/test_conformance.py`.
- [ ] **Step 2:** Engine — `metaobjects/render/recover/`: `FieldSpec` (dataclass) gains `coerce_default`/`default_value`/`normalize`; add `normalize.py` (`normalize_enum(s, mode)` — ASCII, mirrors TS); rewrite `coerce` enum path; `recover` classify `DEFAULTED` + absent-fill + nested descent. Unit tests mirror TS; `mypy --strict` + `ruff` clean.
- [ ] **Step 3:** Codegen — `codegen/recover_schema_emitter.py` + `fr010_field_mapping.py` emit the new args + resolve `@normalize`; extend the importlib-and-run proof in `tests/codegen/test_fr010_output_codegen.py`.
- [ ] **Step 4: Gate** — `pytest tests/{render,conformance,codegen}`; recover-conformance corpus green; `mypy --strict` + `ruff`; review+simplify; hygiene; merge forward + push + FF.

---

## Phase 5 — Close-out

### Task 11: KNOWN_GAPS + roadmap + memory
- [ ] Update each port's recover `KNOWN_GAPS` (fuzzy deferred = reserved slot; `unicode` mode intentionally absent; nested-object now supported uniformly).
- [ ] Roadmap: move FR-011 from Planned → Shipped (note all 5 ports + the new corpus cases).
- [ ] Memory: mark FR-011 shipped in `fr-010-plan-decisions`.

---

## Self-review

**Spec coverage:** ✅ `@coerceDefault` (Tasks 1/3/6 + ports), ✅ `@normalize` none/collapse/strip + object-default resolution (Tasks 1/2/6 + ports), ✅ pipeline exact→normalize→alias→coerceDefault→MALFORMED (Task 3), ✅ `@default` absent-fill + `DEFAULTED` (Task 4), ✅ nested-object recovery (Task 4), ✅ corpus expansion (Task 5), ✅ cross-port rollout (Phases 2–4), ✅ no decouple / no unicode / no fuzzy (reserved slot noted in Task 3 comment + KNOWN_GAPS). Fuzzy is correctly absent.

**Placeholder scan:** the cross-port phases (8–10) intentionally reference the pilot + shared corpus as the spec rather than repeating ~2,000 lines of per-port code — this matches the established cross-language-porting workflow (the corpus is the complete behavioral spec for ports) and the cross-language-porting sub-skill. The pilot (Tasks 1–7) carries real code/tests for every new behavior.

**Type consistency:** `enumField(name, required, values, aliases, coerceDefault?, normalize?, defaultValue?)` and the `FieldSpec` fields `coerceDefault`/`defaultValue`/`normalize` are used consistently across Tasks 3/4/6; coercion `kind` values `"normalize"|"alias"|"coerceDefault"|"default"` drive the `DEFAULTED` classification consistently in Tasks 3/4. `normalizeEnum(s, mode)` signature consistent Tasks 2/3.

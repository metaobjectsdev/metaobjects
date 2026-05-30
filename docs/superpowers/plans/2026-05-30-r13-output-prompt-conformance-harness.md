# R13 — Output-Format Prompt-Fragment Conformance Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the FR-010 output-format prompt fragment byte-identically across all five ports with a shared descriptor-driven conformance corpus + a render→recover round-trip property, and bundle FR-011 enum-coercion attribute-validation negative fixtures.

**Architecture:** A new shared corpus `fixtures/output-prompt-conformance/` holds one `spec.json` (a unified field descriptor) + three `expected.<style>.txt` per case. Each port's runner parses `spec.json`, builds its native `OutputFormatSpec`, renders all three styles, and asserts byte-equality against the checked-in expected files (zero-drift, no ledger). For cases marked `roundTrip:true`, the runner also builds a `RecoverSchema` from the same descriptor and asserts the `exampleOnly` fragment recovers all-RECOVERED. The renderer is hand-written and comment-free (no Mustache engine in the path), so byte-identity is achievable. TS is the pilot (authors corpus + reference runner via snapshot-generation); C#/Java/Python/Kotlin then reproduce. Three FR-011 `error-enum-*` fixtures drop into the existing metamodel `fixtures/conformance/` and run on the existing loader runners with no runner change.

**Tech Stack:** TS/Bun (pilot), C#/.NET xUnit, Java/Maven JUnit, Python/pytest+uv, Kotlin/JUnit (drives the shared JVM `render` engine). Spec at `docs/superpowers/specs/2026-05-30-r13-output-prompt-conformance-harness-design.md`.

---

## Cross-port API reference (entry points already shipped by FR-010/FR-011)

The runner in each port uses these. Field/record member names not shown here MUST be read from the native type by the implementer.

| Concept | TypeScript | C# | Java | Python | Kotlin (uses JVM) |
|---|---|---|---|---|---|
| Render entry | `renderOutputFormat(spec, overrides)` | `OutputFormatRenderer.Render(spec, overrides)` | `OutputFormatRenderer.render(spec, overrides)` | `render_output_format(spec, overrides)` | `OutputFormatRenderer.render(spec, overrides)` |
| Recover entry | `recover(text, schema, opts?)` | `Recover.Run(text, schema, opts?)` | `Recover.recover(text, schema, opts)` | `recover(text, schema, opts?)` | `Recover.recover(text, schema, opts)` |
| Spec type | `OutputFormatSpec {format, rootName, style, fields}` | `OutputFormatSpec` record | `OutputFormatSpec` | `OutputFormatSpec` dataclass | `OutputFormatSpec` (Java) |
| Field type | `PromptField {name,kind,required,array,enumValues,enumDoc,example,instruction,nested}` | `PromptField(...)` record | `PromptField(...)` record | `PromptField` dataclass | `PromptField` (Java) |
| Style enum | `PromptStyle.GUIDE/INLINE/EXAMPLE_ONLY` (`"guide"`/`"inline"`/`"exampleOnly"`) | `PromptStyle.Guide/Inline/ExampleOnly` | `PromptStyle.GUIDE/INLINE/EXAMPLE_ONLY` | `PromptStyle.GUIDE/INLINE/EXAMPLE_ONLY` | `PromptStyle.*` (Java) |
| Overrides (style only) | `{ style }` / `noOverrides()` | `new PromptOverrides(...)` | `PromptOverrides` | `PromptOverrides(...)` | `PromptOverrides` (Java) |
| Schema builder | `recoverSchema(fmt, root, fields)` | `new RecoverSchema(fmt, root, fields)` | `new RecoverSchema(...)` | `RecoverSchema(...)` | `RecoverSchema` (Java) |
| FieldSpec scalar | `scalar(name, kind, required)` | `FieldSpec.Scalar(name, kind, required)` | `FieldSpec.scalar(...)` | `FieldSpec.scalar(...)` | `FieldSpec.scalar(...)` |
| FieldSpec enum | `enumField(name, required, values, {})` | `FieldSpec.EnumField(...)` | `FieldSpec.enumField(...)` | `FieldSpec.enum_field(...)` | `FieldSpec.enumField(...)` |
| FieldSpec object | `object(name, required, array, nested)` | `FieldSpec.Object(...)` | `FieldSpec.object(...)` | `FieldSpec.object(...)` | `FieldSpec.object(...)` |
| Recovery states | `outcome.report.states()` → `Map<string,FieldRecovery>` | `outcome.Report.States` | `outcome.report().states()` | `outcome.report.states` | (Java) |
| Format values | `Format.JSON` / `Format.XML` (`"JSON"`/`"XML"`) | `Format.Json`/`Format.Xml` | `Format.JSON`/`Format.XML` | `Format.JSON`/`Format.XML` | (Java) |
| FieldKind values | `"STRING"|"INT"|"LONG"|"DOUBLE"|"BOOLEAN"|"ENUM"|"OBJECT"` | `FieldKind.String` etc | `FieldKind.STRING` etc | `FieldKind.STRING` etc | (Java) |

**Corpus path resolution:** each port already has a working `recover-conformance` runner that resolves `fixtures/recover-conformance/`. The new runner resolves the sibling `fixtures/output-prompt-conformance/` **identically** — copy that port's path-resolution idiom verbatim.

**`spec.json` descriptor schema** (the cross-port oracle input, authored once in Task 1):

```jsonc
{
  "format": "json",            // "json" | "xml"
  "rootName": "SupportAnswer",
  "roundTrip": true,           // optional (default false); true only when EVERY field has an "example"
  "fields": [
    { "name": "text", "kind": "STRING", "required": true, "array": false,
      "example": "Your refund will appear in 3-5 days.",
      "instruction": "One or two sentences to the customer.",
      "enumValues": null, "enumDoc": null, "nested": null }
  ]
}
```

`kind` strings equal the `FieldKind` member values verbatim in every port. `format` is lowercase in the descriptor and maps to the port's `Format` enum. `nested` (for `kind:"OBJECT"`) is a recursively-nested descriptor with its own `rootName`/`fields`.

---

## File Structure

- `fixtures/output-prompt-conformance/README.md` — descriptor schema + the no-raw-float rule.
- `fixtures/output-prompt-conformance/<case>/spec.json` — descriptor (10 cases).
- `fixtures/output-prompt-conformance/<case>/expected.{guide,inline,exampleOnly}.txt` — byte-exact reference (snapshot-generated by the TS pilot, then committed and reviewed).
- `fixtures/output-prompt-conformance/<case>/README.md` — one paragraph per case.
- `server/typescript/packages/render/test/output-prompt-conformance.test.ts` — pilot runner + descriptor→spec/schema helpers (test-only).
- `server/csharp/MetaObjects.Render.Tests/OutputPromptConformanceTests.cs` — C# runner.
- `server/java/render/src/test/java/com/metaobjects/render/prompt/OutputPromptConformanceTest.java` — Java runner.
- `server/python/tests/render/test_output_prompt_conformance.py` — Python runner.
- `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/OutputPromptConformanceTest.kt` — Kotlin runner (drives the JVM `render` engine; `render` is already on codegen-kotlin's classpath).
- `fixtures/conformance/error-enum-coerce-default-non-member/{expected-errors.json, input/meta.enums.json}` — FR-011 fixture.
- `fixtures/conformance/error-enum-default-non-member/{expected-errors.json, input/meta.enums.json}` — FR-011 fixture.
- `fixtures/conformance/error-enum-normalize-bad-mode/{expected-errors.json, input/meta.enums.json}` — FR-011 fixture.
- `server/java/render/KNOWN_GAPS.md` (or the existing render KNOWN_GAPS) + `spec/roadmap.md` + memory — closeout.

---

## Worktree setup (before Task 1)

This is feature work; per project convention it runs in a `.claude/worktrees/` worktree while the main checkout stays on `main`. Create it with the `superpowers:using-git-worktrees` skill (branch `r13-output-prompt-conformance`). All tasks below run inside that worktree, using **absolute worktree paths** (a bare `cd server/...` resolves to the MAIN checkout, not the worktree). All work stays on the one branch; a single final merge lands it (the shared corpus would red the other ports if the pilot merged alone).

---

## Task 1: Corpus scaffolding — descriptor schema + first case (`json-scalars`)

**Files:**
- Create: `fixtures/output-prompt-conformance/README.md`
- Create: `fixtures/output-prompt-conformance/json-scalars/spec.json`
- Create: `fixtures/output-prompt-conformance/json-scalars/README.md`

- [ ] **Step 1: Write the corpus README**

Create `fixtures/output-prompt-conformance/README.md`:

```markdown
# output-prompt-conformance

Pins the FR-010 output-format prompt fragment (`OutputFormatRenderer`) byte-identically
across all five ports. Each case directory holds:

- `spec.json` — a unified field descriptor (the cross-port oracle input).
- `expected.guide.txt`, `expected.inline.txt`, `expected.exampleOnly.txt` — byte-exact
  rendered fragments for the three `@promptStyle` values.
- `README.md` — what the case exercises.

Every port: parse `spec.json` → build native `OutputFormatSpec` → `render(spec, style)` for
each style → assert byte-equal to `expected.<style>.txt`. Zero-drift: no ledger; any
divergence fails the build. For `spec.json` with `"roundTrip": true`, also build a
`RecoverSchema` from the same descriptor and assert `recover(expected.exampleOnly.txt)`
classifies every field RECOVERED (no MALFORMED / LOST_*).

## `spec.json` schema

{ format: "json"|"xml", rootName: string, roundTrip?: boolean,
  fields: [ { name, kind: "STRING"|"INT"|"LONG"|"DOUBLE"|"BOOLEAN"|"ENUM"|"OBJECT",
              required: bool, array?: bool, example?: string|null,
              instruction?: string|null, enumValues?: string[]|null,
              enumDoc?: {member:doc}|null, nested?: <spec.json>|null } ] }

## No raw floats

Example values are restricted to strings, integers, booleans, and dyadic decimals
(e.g. 1.5, 0.125) only — never a raw float whose textual form differs across runtimes.
This keeps zero-drift robust against cross-runtime float formatting.
```

- [ ] **Step 2: Write the first case descriptor**

Create `fixtures/output-prompt-conformance/json-scalars/spec.json`:

```json
{
  "format": "json",
  "rootName": "SupportAnswer",
  "roundTrip": true,
  "fields": [
    { "name": "text", "kind": "STRING", "required": true, "array": false,
      "example": "Your refund will appear in 3-5 days.",
      "instruction": "One or two sentences to the customer." },
    { "name": "confidence", "kind": "INT", "required": true, "array": false,
      "example": "4", "instruction": "Integer 1-5." },
    { "name": "resolved", "kind": "BOOLEAN", "required": true, "array": false,
      "example": "true", "instruction": "Whether the issue is fully resolved." }
  ]
}
```

- [ ] **Step 3: Write the case README**

Create `fixtures/output-prompt-conformance/json-scalars/README.md`:

```markdown
# json-scalars

JSON, all-required string/int/boolean scalars, each with `@example` + `@instruction`.
`roundTrip: true` — the exampleOnly fragment must recover all-RECOVERED.
```

- [ ] **Step 4: Commit**

```bash
git add fixtures/output-prompt-conformance/README.md fixtures/output-prompt-conformance/json-scalars
git commit -m "test(output-prompt-conformance): R13 corpus scaffold + json-scalars descriptor"
```

(No expected files yet — Task 2's runner snapshot-generates them.)

---

## Task 2: TS pilot runner — descriptor→spec, render, snapshot-generate + byte-assert

**Files:**
- Create: `server/typescript/packages/render/test/output-prompt-conformance.test.ts`
- Generates: `fixtures/output-prompt-conformance/json-scalars/expected.{guide,inline,exampleOnly}.txt`

- [ ] **Step 1: Write the runner with descriptor→spec helper + snapshot-generate**

Create `server/typescript/packages/render/test/output-prompt-conformance.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  renderOutputFormat,
  Format,
  FieldKind,
  PromptStyle,
  type OutputFormatSpec,
  type PromptField,
  type PromptOverrides,
} from "../src/index.js";

// The shared corpus lives at the repo root. This file is at
// server/typescript/packages/render/test/, so the repo root is five levels up.
const CORPUS = join(import.meta.dir, "../../../../../fixtures/output-prompt-conformance");

// ----- descriptor types (the spec.json shape) -----
interface CaseField {
  name: string;
  kind: keyof typeof FieldKind;
  required: boolean;
  array?: boolean;
  example?: string | null;
  instruction?: string | null;
  enumValues?: string[] | null;
  enumDoc?: Record<string, string> | null;
  nested?: CaseSpec | null;
}
interface CaseSpec {
  format: "json" | "xml";
  rootName: string;
  roundTrip?: boolean;
  fields: CaseField[];
}

const STYLES: ReadonlyArray<{ key: string; style: PromptStyle }> = [
  { key: "guide", style: PromptStyle.GUIDE },
  { key: "inline", style: PromptStyle.INLINE },
  { key: "exampleOnly", style: PromptStyle.EXAMPLE_ONLY },
];

function toFormat(f: "json" | "xml"): Format {
  return f === "json" ? Format.JSON : Format.XML;
}

function buildOutputSpec(c: CaseSpec): OutputFormatSpec {
  const fields: PromptField[] = c.fields.map((f) => ({
    name: f.name,
    kind: FieldKind[f.kind],
    required: f.required,
    array: f.array ?? false,
    enumValues: f.enumValues ?? null,
    enumDoc: f.enumDoc ?? null,
    example: f.example ?? null,
    instruction: f.instruction ?? null,
    nested: f.nested ? buildOutputSpec(f.nested) : null,
  }));
  // style here is a placeholder; each render overrides it per style.
  return { format: toFormat(c.format), rootName: c.rootName, style: PromptStyle.GUIDE, fields };
}

describe("output-prompt-conformance corpus", () => {
  const names = existsSync(CORPUS)
    ? readdirSync(CORPUS)
        .filter((n) => statSync(join(CORPUS, n)).isDirectory())
        .filter((n) => existsSync(join(CORPUS, n, "spec.json")))
        .sort()
    : [];
  expect(names.length).toBeGreaterThan(0);

  for (const name of names) {
    test(name, () => {
      const dir = join(CORPUS, name);
      const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) as CaseSpec;
      const ofs = buildOutputSpec(spec);

      for (const { key, style } of STYLES) {
        const overrides: PromptOverrides = { style };
        const actual = renderOutputFormat(ofs, overrides);
        const expectedPath = join(dir, `expected.${key}.txt`);
        if (!existsSync(expectedPath)) {
          // Snapshot-generate on first run; commit + review the output, then it becomes the gate.
          writeFileSync(expectedPath, actual, "utf8");
          throw new Error(`snapshot created: ${expectedPath} — review and re-run`);
        }
        const expected = readFileSync(expectedPath, "utf8");
        expect(actual).toBe(expected); // zero-drift, byte-exact
        // determinism: identical across runs
        expect(renderOutputFormat(ofs, overrides)).toBe(actual);
      }
    });
  }
});
```

- [ ] **Step 2: Run to snapshot-generate the first case's expected files**

Run: `cd server/typescript/packages/render && bun test test/output-prompt-conformance.test.ts`
Expected: FAIL with three "snapshot created" errors; `expected.guide.txt` / `expected.inline.txt` / `expected.exampleOnly.txt` now exist under `json-scalars/`.

- [ ] **Step 3: Eyeball the generated fragments**

Read the three new `expected.*.txt`. Confirm: `guide` is a prose field list + skeleton; `inline` is one skeleton with placeholders; `exampleOnly` is a filled JSON skeleton with the declared example values (`"Your refund will appear in 3-5 days."`, `4`, `true`) and is valid JSON. If any look wrong, the renderer is not the problem to fix here — stop and report (the FR-010 renderer is the shipped reference).

- [ ] **Step 4: Re-run to confirm the gate is now green**

Run: `cd server/typescript/packages/render && bun test test/output-prompt-conformance.test.ts`
Expected: PASS (1 test: `json-scalars`).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/render/test/output-prompt-conformance.test.ts fixtures/output-prompt-conformance/json-scalars/expected.guide.txt fixtures/output-prompt-conformance/json-scalars/expected.inline.txt fixtures/output-prompt-conformance/json-scalars/expected.exampleOnly.txt
git commit -m "test(output-prompt-conformance): TS runner + json-scalars expected (snapshot-pinned)"
```

---

## Task 3: TS round-trip property (render→recover skew guard)

**Files:**
- Modify: `server/typescript/packages/render/test/output-prompt-conformance.test.ts`

- [ ] **Step 1: Add the recover imports + a descriptor→RecoverSchema helper**

At the top of the test, extend the `@metaobjectsdev/render` import (from `../src/index.js`) to add:
`recover`, `recoverSchema`, `scalar`, `enumField`, `object`, `FieldRecovery`, and the types `RecoverSchema`, `FieldSpec`. Then add this helper beside `buildOutputSpec`:

```ts
function buildRecoverSchema(c: CaseSpec): RecoverSchema {
  const fields: FieldSpec[] = c.fields.map((f) => {
    if (f.kind === "ENUM") return enumField(f.name, f.required, f.enumValues ?? null, {});
    if (f.kind === "OBJECT") return object(f.name, f.required, f.array ?? false, f.nested ? buildRecoverSchema(f.nested) : null);
    return scalar(f.name, FieldKind[f.kind], f.required);
  });
  return recoverSchema(toFormat(c.format), c.rootName, fields);
}
```

- [ ] **Step 2: Write the failing round-trip assertion**

Inside the `test(name, ...)` body, after the per-style loop, add:

```ts
      if (spec.roundTrip) {
        const exampleFragment = readFileSync(join(dir, "expected.exampleOnly.txt"), "utf8");
        const outcome = recover(exampleFragment, buildRecoverSchema(spec));
        // Skew guard: a field the renderer emitted must read back cleanly. We assert
        // NO state is MALFORMED or LOST_* (robust to DEFAULTED and to how a nested
        // OBJECT-container path classifies); any such state means the renderer emitted
        // an example the recover parser cannot read.
        const bad = [FieldRecovery.MALFORMED, FieldRecovery.LOST_REQUIRED, FieldRecovery.LOST_OPTIONAL] as const;
        for (const [field, state] of outcome.report.states()) {
          expect([field, bad.includes(state as (typeof bad)[number])]).toEqual([field, false]);
        }
      }
```

- [ ] **Step 3: Run — verify it passes for `json-scalars`**

Run: `cd server/typescript/packages/render && bun test test/output-prompt-conformance.test.ts`
Expected: PASS. (If a field comes back MALFORMED or LOST_*, that is a real example↔recover skew — report it; do not weaken the assertion.)

- [ ] **Step 4: Commit**

```bash
git add server/typescript/packages/render/test/output-prompt-conformance.test.ts
git commit -m "test(output-prompt-conformance): add render->recover round-trip skew guard"
```

---

## Task 4: Author the full case matrix + corpus-count guard

**Files:**
- Create (per case): `fixtures/output-prompt-conformance/<case>/{spec.json, README.md, expected.*.txt}`
- Modify: `server/typescript/packages/render/test/output-prompt-conformance.test.ts`

Author the remaining nine cases. For each: write `spec.json` + `README.md`, run the runner to snapshot-generate `expected.*.txt`, eyeball them, re-run to green, commit. The descriptors:

- [ ] **Step 1: `xml-scalars`** — copy `json-scalars/spec.json`, change `"format": "xml"`. README: "XML, same scalar field set as json-scalars."

- [ ] **Step 2: `json-enum`** — `spec.json`:

```json
{ "format": "json", "rootName": "Triage", "roundTrip": true,
  "fields": [
    { "name": "priority", "kind": "ENUM", "required": true,
      "enumValues": ["LOW", "MEDIUM", "HIGH"],
      "enumDoc": { "LOW": "no urgency", "HIGH": "page on-call" },
      "example": "HIGH", "instruction": "Pick one severity." } ] }
```
README: "JSON enum with @enumValues + @enumDoc + @example."

- [ ] **Step 3: `xml-enum`** — copy `json-enum`, change `"format": "xml"`. README: "XML enum."

- [ ] **Step 4: `json-array`** — `spec.json`:

```json
{ "format": "json", "rootName": "Tagging", "roundTrip": false,
  "fields": [
    { "name": "tags", "kind": "STRING", "required": true, "array": true,
      "instruction": "Zero or more short labels." } ] }
```
README: "JSON scalar array field (roundTrip off — array example shape not asserted here)."

- [ ] **Step 5: `json-nested`** — `spec.json`:

```json
{ "format": "json", "rootName": "Review", "roundTrip": true,
  "fields": [
    { "name": "summary", "kind": "STRING", "required": true,
      "example": "Solid work overall.", "instruction": "One sentence." },
    { "name": "meta", "kind": "OBJECT", "required": true, "array": false,
      "nested": { "format": "json", "rootName": "Meta",
        "fields": [
          { "name": "score", "kind": "INT", "required": true, "example": "5", "instruction": "1-5." } ] } } ] }
```
README: "JSON nested OBJECT field; round-trip exercises FR-011 dotted-path nested recovery."

- [ ] **Step 6: `xml-nested`** — copy `json-nested`, change every `"format": "json"` to `"xml"`. README: "XML nested object."

- [ ] **Step 7: `optional-absent`** — `spec.json`:

```json
{ "format": "json", "rootName": "Partial", "roundTrip": false,
  "fields": [
    { "name": "title", "kind": "STRING", "required": true, "example": "Hello", "instruction": "Required." },
    { "name": "subtitle", "kind": "STRING", "required": false } ] }
```
README: "Optional field with no @example/@instruction — skeleton/sparsity behavior."

- [ ] **Step 8: `instruction-fallback`** — `spec.json`:

```json
{ "format": "json", "rootName": "Bare", "roundTrip": false,
  "fields": [
    { "name": "value", "kind": "STRING", "required": true } ] }
```
README: "A field with neither @example nor @instruction — guide-style fallback text."

- [ ] **Step 9: `unicode-example`** — `spec.json`:

```json
{ "format": "json", "rootName": "I18n", "roundTrip": true,
  "fields": [
    { "name": "greeting", "kind": "STRING", "required": true,
      "example": "こんにちは — café — 🚀", "instruction": "A localized greeting." } ] }
```
README: "Multibyte @example value — byte-identity under UTF-8."

- [ ] **Step 10: Generate + eyeball + green for all nine**

Run: `cd server/typescript/packages/render && bun test test/output-prompt-conformance.test.ts`
First run: FAILs with "snapshot created" for the new cases. Eyeball each generated `expected.*.txt` (especially `unicode-example` — confirm the multibyte value is preserved exactly, and `json-nested`/`xml-nested` round-trip clean). Re-run.
Expected: PASS (10 tests).

- [ ] **Step 11: Add the corpus-count guard**

In the test file, replace `expect(names.length).toBeGreaterThan(0);` with:

```ts
  // Count guard: a port silently skipping cases must fail. Bump when adding cases.
  const EXPECTED_CASE_COUNT = 10;
  expect(names.length).toBe(EXPECTED_CASE_COUNT);
```

- [ ] **Step 12: Run + commit**

Run: `cd server/typescript/packages/render && bun test test/output-prompt-conformance.test.ts` → PASS (10).

```bash
git add fixtures/output-prompt-conformance server/typescript/packages/render/test/output-prompt-conformance.test.ts
git commit -m "test(output-prompt-conformance): full 10-case matrix + count guard (TS pilot complete)"
```

---

## Task 5: TS pilot gate

- [ ] **Step 1: Typecheck the render package**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/render' typecheck`
Expected: no errors.

- [ ] **Step 2: Full render package test**

Run: `cd server/typescript/packages/render && bun test`
Expected: all green, including the new 10-case `output-prompt-conformance` suite.

- [ ] **Step 3: Spec + quality review of the TS pilot, fix findings, commit any fixes.** (Per `superpowers:subagent-driven-development` two-stage review.)

---

## Task 6: C# port runner

**Files:**
- Create: `server/csharp/MetaObjects.Render.Tests/OutputPromptConformanceTests.cs`

Mirror the TS runner against the C# API (table above). The C# runner:
1. Resolves `fixtures/output-prompt-conformance/` exactly as `MetaObjects.Render.Tests/Recover/RecoverConformanceTests.cs` resolves `recover-conformance` (copy that idiom).
2. Deserializes `spec.json` into a small `CaseSpec`/`CaseField` DTO (System.Text.Json).
3. `BuildOutputSpec(case)` → `OutputFormatSpec`; renders each style via `OutputFormatRenderer.Render(spec, new PromptOverrides(style: …))` — read `PromptOverrides`'s constructor/`With` shape and `PromptStyle` member names from the native types.
4. Byte-asserts against `expected.<style>.txt` (read with the same UTF-8/newline handling the recover runner uses — do NOT normalize newlines; the bytes must match).
5. Count guard `== 10`.
6. For `roundTrip` cases, `BuildRecoverSchema(case)` → `Recover.Run(exampleOnlyText, schema)` → assert no entry in `outcome.Report.States` is `MALFORMED`/`LOST_REQUIRED`/`LOST_OPTIONAL` (same skew guard as the TS runner).

- [ ] **Step 1: Write the runner** (read native `OutputFormatSpec`, `PromptField`, `PromptStyle`, `PromptOverrides`, `RecoverSchema`, `FieldSpec` member shapes first).
- [ ] **Step 2: Run.** `dotnet test server/csharp/MetaObjects.Render.Tests --filter FullyQualifiedName~OutputPromptConformance`
  Expected: 10 cases PASS, reproducing the TS-authored expected bytes exactly. **If any case diverges, it is a real C#-vs-TS renderer drift — fix the C# renderer to match the reference; do NOT edit the corpus or add a ledger.**
- [ ] **Step 3: Spec + quality review; fix; commit.**

```bash
git add server/csharp/MetaObjects.Render.Tests/OutputPromptConformanceTests.cs
git commit -m "test(output-prompt-conformance): C# runner reproduces corpus (10/10)"
```

---

## Task 7: Java port runner

**Files:**
- Create: `server/java/render/src/test/java/com/metaobjects/render/prompt/OutputPromptConformanceTest.java`

Mirror the runner against the Java API. Resolve the corpus exactly as `render/src/test/java/com/metaobjects/render/recover/RecoverConformanceTest.java` resolves `recover-conformance`. Parse `spec.json` with whatever JSON facility that test uses. Render via `OutputFormatRenderer.render(spec, overrides)` per `PromptStyle`; byte-assert vs `expected.<style>.txt`; count guard `== 10`; round-trip via `Recover.recover(text, schema, opts)` asserting no `outcome.report().states()` value is `MALFORMED`/`LOST_REQUIRED`/`LOST_OPTIONAL` (same skew guard as the TS runner).

- [ ] **Step 1: Write the runner** (read `PromptField`/`OutputFormatSpec`/`PromptOverrides`/`RecoverSchema`/`FieldSpec` ctors first).
- [ ] **Step 2: Run.** `cd server/java && mvn -q -pl render test -Dtest=OutputPromptConformanceTest -DfailIfNoTests=false`
  Expected: 10 PASS. Divergence → fix the Java renderer, not the corpus.
- [ ] **Step 3: Spec + quality review; fix; commit.**

```bash
git add server/java/render/src/test/java/com/metaobjects/render/prompt/OutputPromptConformanceTest.java
git commit -m "test(output-prompt-conformance): Java runner reproduces corpus (10/10)"
```

---

## Task 8: Python port runner

**Files:**
- Create: `server/python/tests/render/test_output_prompt_conformance.py`

Mirror against the Python API. Resolve the corpus exactly as `server/python/tests/conformance/test_recover_conformance.py` resolves `recover-conformance`. Parse `spec.json` with `json`. `build_output_spec(case)` → `OutputFormatSpec`; render each style via `render_output_format(spec, PromptOverrides(style=…))`; byte-assert vs `expected.<style>.txt` (open with `encoding="utf-8"`, `newline=""` — no newline translation); count guard `== 10`; round-trip via `recover(text, schema)` asserting no value in `outcome.report.states` is `MALFORMED`/`LOST_REQUIRED`/`LOST_OPTIONAL` (same skew guard as the TS runner).

- [ ] **Step 1: Write the runner** (read the native dataclass field names + `PromptStyle` members + `FieldSpec.scalar/enum_field/object` signatures first).
- [ ] **Step 2: Run.** `cd server/python && uv run pytest tests/render/test_output_prompt_conformance.py -q`
  Expected: 10 PASS. Divergence → fix the Python renderer, not the corpus.
- [ ] **Step 3: `uv run mypy --strict` (per the package's mypy scope) + `ruff check` the new file; fix.**
- [ ] **Step 4: Spec + quality review; fix; commit.**

```bash
git add server/python/tests/render/test_output_prompt_conformance.py
git commit -m "test(output-prompt-conformance): Python runner reproduces corpus (10/10)"
```

---

## Task 9: Kotlin port runner (drives the shared JVM engine)

**Files:**
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/OutputPromptConformanceTest.kt`

Kotlin reuses the Java `render` engine. First confirm `render` is on `codegen-kotlin`'s **test** classpath (it is a dependency for output-parser codegen; if test-scope is missing, add it in `codegen-kotlin/pom.xml`). The runner imports `com.metaobjects.render.prompt.*` + `com.metaobjects.render.recover.*` and the `Format`/`FieldKind`/`FieldRecovery` enums, resolves `fixtures/output-prompt-conformance/` exactly as `KotlinAbstractConformanceTest.kt` resolves `codegen-conformance`, parses `spec.json`, builds the Java `OutputFormatSpec`/`RecoverSchema`, renders + byte-asserts + count-guards + round-trips identically to the other runners.

- [ ] **Step 1: Confirm/add `render` test-classpath dep; write the runner.**
- [ ] **Step 2: Run.** `cd server/java && mvn -q -pl codegen-kotlin test -Dtest=OutputPromptConformanceTest -DfailIfNoTests=false`
  Expected: 10 PASS (byte-identical to Java by construction — proves the corpus loads + runs in the Kotlin module).
- [ ] **Step 3: Spec + quality review; fix; commit.**

```bash
git add server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/OutputPromptConformanceTest.kt server/java/codegen-kotlin/pom.xml
git commit -m "test(output-prompt-conformance): Kotlin runner over shared JVM engine (10/10)"
```

---

## Task 10: FR-011 enum-coercion attr-validation negative fixtures

**Files:**
- Create: `fixtures/conformance/error-enum-coerce-default-non-member/{expected-errors.json, input/meta.enums.json}`
- Create: `fixtures/conformance/error-enum-default-non-member/{expected-errors.json, input/meta.enums.json}`
- Create: `fixtures/conformance/error-enum-normalize-bad-mode/{expected-errors.json, input/meta.enums.json}`

These exercise FR-011 validation that already ships in the loader ports; the fixtures should pass on first run. Follow the exact shape of `fixtures/conformance/error-enum-empty-values/` (an `input/meta.enums.json` + an `expected-errors.json` with `code` + `source.jsonPath`).

- [ ] **Step 1: `error-enum-coerce-default-non-member`** — `input/meta.enums.json` declares an entity with a `field.enum` whose `@coerceDefault` is not in `@values`:

```json
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "status", "@values": ["NEW", "DONE"], "@coerceDefault": "BOGUS" } },
    { "identity.primary": { "@fields": "id" } } ] } } ] } }
```
`expected-errors.json`:

```json
{ "errors": [ { "code": "ERR_BAD_ATTR_VALUE",
  "source": { "format": "json", "files": ["meta.enums.json"],
    "jsonPath": "$['metadata.root'].children[0]['object.entity'].children[1]['field.enum']" } } ],
  "warnings": [] }
```

- [ ] **Step 2: `error-enum-default-non-member`** — same shape; `field.enum` has `"@default": "BOGUS"` (not in `@values`); same `expected-errors.json` (code `ERR_BAD_ATTR_VALUE`, same jsonPath).

- [ ] **Step 3: `error-enum-normalize-bad-mode`** — same shape; `field.enum` has `"@normalize": "fuzzy"` (not `none`/`collapse`/`strip`); same `expected-errors.json`.

- [ ] **Step 4: Run the metamodel conformance on all four loader ports.**

Run each and expect the three new fixtures GREEN:
- TS: `cd server/typescript && bun test` (metamodel conformance suite)
- C#: `dotnet test server/csharp/MetaObjects.Tests --filter FullyQualifiedName~Conformance`
- Java: `cd server/java && mvn -q -pl metadata test -Dtest=*ConformanceTest -DfailIfNoTests=false`
- Python: `cd server/python && uv run pytest tests/conformance -q`

**If a port does NOT raise `ERR_BAD_ATTR_VALUE` for one of these, that is a real FR-011 validation gap in that port — fix the loader validation (enum-only gated) to match, then re-run.** (Per CLAUDE.md, member-validation of `@coerceDefault`/`@default`/`@normalize` on `field.enum` is a shipped FR-011 contract.)

- [ ] **Step 5: Commit**

```bash
git add fixtures/conformance/error-enum-coerce-default-non-member fixtures/conformance/error-enum-default-non-member fixtures/conformance/error-enum-normalize-bad-mode
git commit -m "test(conformance): FR-011 enum-coercion attr-validation negative fixtures (4 loader ports)"
```

---

## Task 11: Close-out

**Files:**
- Modify: a render `KNOWN_GAPS.md` note (or the spec) recording R13 closed.
- Modify: `spec/roadmap.md`
- Modify: memory (`conformance-suite-gaps.md`, `MEMORY.md`)

- [ ] **Step 1: Final whole-implementation review.** Dispatch a final code reviewer over the full branch diff (corpus + 5 runners + 3 fixtures). Fix any findings.

- [ ] **Step 2: Roadmap.** In `spec/roadmap.md`, add an `output-prompt-conformance` line under "Cross-port conformance corpora" (10 cases × 3 styles; TS/C#/Java/Python run it; Kotlin over the shared JVM engine) and note the three new FR-011 `error-enum-*` fixtures. Remove R13 from any "open gaps" framing.

- [ ] **Step 3: Memory.** Update `conformance-suite-gaps.md`: mark R13 resolved (output-prompt fragment now byte-pinned cross-port + round-trip; FR-011 attr-validation now corpus-pinned on 4 loader ports). Update the `MEMORY.md` pointer line.

- [ ] **Step 4: Commit the closeout.**

```bash
git add spec/roadmap.md
git commit -m "docs(roadmap): R13 output-prompt-conformance corpus shipped (5 ports) + FR-011 attr fixtures"
```

- [ ] **Step 5: Merge.** Verify the full suite is green on the branch, then use `superpowers:finishing-a-development-branch` to merge forward onto the current `main` tip (single final merge), push to origin, and remove the worktree. Forward-only: FF/merge onto the current tip, never rebase/reset/force `main`.

---

## Notes for the executor

- **Zero-drift, no ledger.** A cross-port byte divergence is a renderer bug to fix in the diverging port, never a corpus edit or a ledger entry. The corpus is the oracle.
- **Single branch, single merge.** Do not merge the TS pilot alone — the shared corpus would red the other four ports until they land. Everything merges together at Task 11.
- **Absolute worktree paths.** A bare `cd server/...` resolves to the MAIN checkout; always use the worktree-absolute path.
- **Subagents must not `git checkout` SHAs** (detaches the worktree HEAD) — inspect with `git show`/`git diff`, and confirm the branch is attached before committing.
- **Newlines/encoding.** Read expected files as raw UTF-8 with no newline translation in every port; the bytes must match exactly.
- **The TS byte-assert is near-tautological for TS alone** (it renders then compares to its own snapshot); the real cross-port gate is Tasks 6–9 reproducing those bytes, plus the round-trip + determinism checks on every port.

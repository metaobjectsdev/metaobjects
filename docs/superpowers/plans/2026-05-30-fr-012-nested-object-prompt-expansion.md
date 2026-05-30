# FR-012 Nested-Object Prompt Expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FR-010 `OutputFormatRenderer` expand nested OBJECT fields, arrays-of-objects, and scalar arrays (instead of a flat `{name}` placeholder) across all 3 styles × json/xml, byte-identical in all 5 ports, with a depth/cycle guard.

**Architecture:** Thread an indent string + a depth/cycle guard through the JSON/XML skeleton builders and the guide prose list; dispatch on `field.kind === OBJECT` / `field.array`. The skeleton and inline renderers unify into one mode-parameterized recursion. The R13 `output-prompt-conformance` corpus is the cross-port byte-identity gate: the TS pilot regenerates the affected expected files (the oracle), and the other four ports must reproduce them.

**Tech Stack:** TS/Bun (pilot), Java/Maven (shared JVM engine — Kotlin inherits), C#/.NET xUnit, Python/pytest+uv. Spec: `docs/superpowers/specs/2026-05-30-fr-012-nested-object-prompt-expansion-design.md`.

---

## Worktree

Already created: `.claude/worktrees/fr-012-nested-prompt-expansion`, branch `worktree-fr-012-nested-prompt-expansion` (branched from `origin/main`, includes the R13 harness). **All tasks run inside this worktree using ABSOLUTE worktree paths** — a bare `cd server/...` resolves to the MAIN checkout, not the worktree. Subagents must NOT `git checkout` SHAs (detaches worktree HEAD) — inspect with `git show`/`git diff`, and confirm `git rev-parse --abbrev-ref HEAD` is `worktree-fr-012-nested-prompt-expansion` before committing. Single branch, single final merge (the shared corpus would red the other ports if the pilot merged alone).

Worktree absolute root (referred to below as `$WT`): `<repo-root>/.claude/worktrees/fr-012-nested-prompt-expansion` — the executor substitutes the real absolute worktree path (provided at dispatch).

---

## Byte-format contract (the oracle the pilot defines and all ports reproduce)

Indent unit = **2 spaces**; each nesting level adds one unit. `MAX_NEST_DEPTH = 8`. At a cycle (a nested spec already on the recursion path, by object identity) or beyond `MAX_NEST_DEPTH`, fall back to the pre-FR-012 flat leaf (`"{name}"` in JSON / `<name>{name}</name>` in XML). The 7 purely-scalar R13 cases are unchanged (no OBJECT/array fields → byte-identical to today).

Worked examples (these are the exact unit-test expectations in Task 1):

**Nested object** — spec `Review { summary:STRING ex "Solid work overall." instr "One sentence.", meta:OBJECT { score:INT ex "5" instr "1-5." } }`:

```
exampleOnly (json)                inline (json)                    guide
{                                 {                                Fill in each field as described below:
  "summary": "Solid work...",       "summary": "{One sentence.}",  - summary (required): One sentence.
  "meta": {                         "meta": {                          e.g. Solid work overall.
    "score": 5                        "score": "{1-5.}"            - meta (required)
  }                                 }                              - meta.score (required): 1-5.
}                                 }                                    e.g. 5
                                                                   
                                                                   Respond exactly like this:
                                                                   <exampleOnly json above>
exampleOnly (xml)
<Review>
  <summary>Solid work overall.</summary>
  <meta>
    <score>5</score>
  </meta>
</Review>
```

**Array of objects** — `Bundle { items:OBJECT[] { label:STRING ex "spec" } }`, exampleOnly json:
```
{
  "items": [
    {
      "label": "spec"
    }
  ]
}
```
**Scalar array** — `Tagging { tags:STRING[] (no example) }`, exampleOnly json:
```
{
  "tags": [
    "{tags}"
  ]
}
```
**XML arrays** render one representative element (XML can't signal repeat-count): an object-array element expands once as `<name>…</name>`; a scalar-array element is one `<name>value</name>` line.

**Guide prose rule:** recurse with a dotted-path prefix — nested object leaves are `parent.child`, array-of-object element leaves are `parent[].child`; the OBJECT container field emits its own `- name (req)` line (plus its instruction if any) before its leaves; scalar arrays are a single leaf entry. The appended skeleton shows the full structure.

---

## Task 1: TS renderer recursion + depth/cycle guard (the pilot — defines the oracle)

**Files:**
- Modify: `server/typescript/packages/render/src/prompt/output-format-renderer.ts`
- Create: `server/typescript/packages/render/test/output-format-renderer-nested.test.ts`
- Modify (regenerate): `fixtures/output-prompt-conformance/{json-nested,xml-nested,json-array}/expected.*.txt` and `{json-nested,xml-nested}/spec.json`

- [ ] **Step 1: Write the failing unit tests** (`$WT/server/typescript/packages/render/test/output-format-renderer-nested.test.ts`)

```ts
import { describe, test, expect } from "bun:test";
import { renderOutputFormat, Format, FieldKind, PromptStyle } from "../src/index.js";
import type { OutputFormatSpec, PromptField } from "../src/index.js";

function f(p: Partial<PromptField> & { name: string; kind: FieldKind }): PromptField {
  return {
    name: p.name, kind: p.kind, required: p.required ?? true, array: p.array ?? false,
    enumValues: p.enumValues ?? null, enumDoc: p.enumDoc ?? null,
    example: p.example ?? null, instruction: p.instruction ?? null, nested: p.nested ?? null,
  };
}
const spec = (format: Format, rootName: string, fields: PromptField[]): OutputFormatSpec =>
  ({ format, rootName, style: PromptStyle.GUIDE, fields });
const NONE = { examples: {}, instructions: {} };

const review = (fmt: Format) =>
  spec(fmt, "Review", [
    f({ name: "summary", kind: FieldKind.STRING, example: "Solid work overall.", instruction: "One sentence." }),
    f({ name: "meta", kind: FieldKind.OBJECT, nested: spec(fmt, "Meta", [
      f({ name: "score", kind: FieldKind.INT, example: "5", instruction: "1-5." }),
    ]) }),
  ]);

describe("FR-012 nested expansion", () => {
  test("nested object — exampleOnly json", () => {
    expect(renderOutputFormat(review(Format.JSON), { ...NONE, style: PromptStyle.EXAMPLE_ONLY })).toBe(
      `{\n  "summary": "Solid work overall.",\n  "meta": {\n    "score": 5\n  }\n}`,
    );
  });

  test("nested object — exampleOnly xml", () => {
    expect(renderOutputFormat(review(Format.XML), { ...NONE, style: PromptStyle.EXAMPLE_ONLY })).toBe(
      `<Review>\n  <summary>Solid work overall.</summary>\n  <meta>\n    <score>5</score>\n  </meta>\n</Review>`,
    );
  });

  test("nested object — inline json", () => {
    expect(renderOutputFormat(review(Format.JSON), { ...NONE, style: PromptStyle.INLINE })).toBe(
      `{\n  "summary": "{One sentence.}",\n  "meta": {\n    "score": "{1-5.}"\n  }\n}`,
    );
  });

  test("nested object — guide json", () => {
    expect(renderOutputFormat(review(Format.JSON), { ...NONE, style: PromptStyle.GUIDE })).toBe(
      `Fill in each field as described below:\n` +
      `- summary (required): One sentence.\n    e.g. Solid work overall.\n` +
      `- meta (required)\n` +
      `- meta.score (required): 1-5.\n    e.g. 5\n` +
      `\nRespond exactly like this:\n` +
      `{\n  "summary": "Solid work overall.",\n  "meta": {\n    "score": 5\n  }\n}`,
    );
  });

  test("array of objects — exampleOnly json", () => {
    const s = spec(Format.JSON, "Bundle", [
      f({ name: "items", kind: FieldKind.OBJECT, array: true, nested: spec(Format.JSON, "Item", [
        f({ name: "label", kind: FieldKind.STRING, example: "spec" }),
      ]) }),
    ]);
    expect(renderOutputFormat(s, { ...NONE, style: PromptStyle.EXAMPLE_ONLY })).toBe(
      `{\n  "items": [\n    {\n      "label": "spec"\n    }\n  ]\n}`,
    );
  });

  test("scalar array — exampleOnly json", () => {
    const s = spec(Format.JSON, "Tagging", [f({ name: "tags", kind: FieldKind.STRING, array: true })]);
    expect(renderOutputFormat(s, { ...NONE, style: PromptStyle.EXAMPLE_ONLY })).toBe(
      `{\n  "tags": [\n    "{tags}"\n  ]\n}`,
    );
  });

  test("depth guard — over-deep chain falls back to flat placeholder, never throws", () => {
    // Build a chain deeper than MAX_NEST_DEPTH (8): root -> n0 -> n1 -> ... 12 levels.
    let leaf: OutputFormatSpec = spec(Format.JSON, "L", [f({ name: "v", kind: FieldKind.STRING, example: "x" })]);
    for (let i = 0; i < 12; i++) {
      leaf = spec(Format.JSON, `N${i}`, [f({ name: "child", kind: FieldKind.OBJECT, nested: leaf })]);
    }
    const out = renderOutputFormat(leaf, { ...NONE, style: PromptStyle.EXAMPLE_ONLY });
    // Past the cap, the deepest still-rendered object's child is the flat placeholder.
    expect(out).toContain(`"child": "{child}"`);
    expect(typeof out).toBe("string"); // did not throw / infinite-loop
  });
});
```

- [ ] **Step 2: Run — verify the new tests fail**

Run: `cd $WT/server/typescript/packages/render && bun test test/output-format-renderer-nested.test.ts`
(If `mustache` missing: `bun install` once at `$WT`.) Expected: FAIL (nested fields still render `"meta": "{meta}"`).

- [ ] **Step 3: Implement the recursion** — replace the body of `server/typescript/packages/render/src/prompt/output-format-renderer.ts` from the `// ---- INLINE ----` section through `renderJsonSkeleton` with the unified recursion below. KEEP the existing top-of-file imports, `NUMERIC_KINDS`, `escapeXml`/`escapeJson`, `renderOutputFormat` dispatch, and the leaf helpers `resolveInstruction`/`exampleValueIfDeclared`/`exampleValue`/`inlineContent`/`isNumericOrBoolean` unchanged. Add the two constants and the recursion:

```ts
const INDENT = "  ";
const MAX_NEST_DEPTH = 8;

type SkelMode = "example" | "inline";

// ---- INLINE & EXAMPLE-ONLY share one mode-parameterized skeleton recursion ----

function renderInline(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  return spec.format === Format.XML
    ? renderXmlSkeleton(spec, overrides, "inline")
    : renderJsonSkeleton(spec, overrides, "inline");
}

function renderExampleOnly(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  return spec.format === Format.XML
    ? renderXmlSkeleton(spec, overrides, "example")
    : renderJsonSkeleton(spec, overrides, "example");
}

// ---- JSON ----

function renderJsonSkeleton(spec: OutputFormatSpec, overrides: PromptOverrides, mode: SkelMode): string {
  return jsonObject(spec, overrides, "", mode, new Set<OutputFormatSpec>([spec]), 0);
}

function jsonObject(
  spec: OutputFormatSpec, overrides: PromptOverrides, braceIndent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  // Empty object is `{\n}` (Java/C# parity).
  if (spec.fields.length === 0) return `{\n${braceIndent}}`;
  const fieldIndent = braceIndent + INDENT;
  const lines = spec.fields.map(
    (field) => `${fieldIndent}"${field.name}": ${jsonValue(field, overrides, fieldIndent, mode, path, depth)}`,
  );
  return `{\n${lines.join(",\n")}\n${braceIndent}}`;
}

function jsonValue(
  field: PromptField, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  if (field.array) return jsonArray(field, overrides, indent, mode, path, depth);
  if (field.kind === FieldKind.OBJECT) return jsonObjectField(field, overrides, indent, mode, path, depth);
  return jsonLeaf(field, overrides, mode);
}

function jsonLeaf(field: PromptField, overrides: PromptOverrides, mode: SkelMode): string {
  if (mode === "inline") return `"${escapeJson(inlineContent(field, overrides))}"`;
  const value = exampleValue(field, overrides);
  return isNumericOrBoolean(field.kind, value) ? value : `"${escapeJson(value)}"`;
}

function canExpand(field: PromptField, path: Set<OutputFormatSpec>, depth: number): boolean {
  return field.kind === FieldKind.OBJECT && field.nested != null
    && depth < MAX_NEST_DEPTH && !path.has(field.nested);
}

function jsonObjectField(
  field: PromptField, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  if (!canExpand(field, path, depth)) return jsonLeaf(field, overrides, mode);
  const nested = field.nested!;
  path.add(nested);
  const out = jsonObject(nested, overrides, indent, mode, path, depth + 1);
  path.delete(nested);
  return out;
}

function jsonArray(
  field: PromptField, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  const elemIndent = indent + INDENT;
  let elem: string;
  if (canExpand(field, path, depth)) {
    const nested = field.nested!;
    path.add(nested);
    elem = jsonObject(nested, overrides, elemIndent, mode, path, depth + 1);
    path.delete(nested);
  } else {
    elem = jsonLeaf(field, overrides, mode);
  }
  return `[\n${elemIndent}${elem}\n${indent}]`;
}

// ---- XML ----

function renderXmlSkeleton(spec: OutputFormatSpec, overrides: PromptOverrides, mode: SkelMode): string {
  return `<${spec.rootName}>\n${xmlBody(spec, overrides, INDENT, mode, new Set<OutputFormatSpec>([spec]), 0)}</${spec.rootName}>`;
}

function xmlBody(
  spec: OutputFormatSpec, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  return spec.fields.map((field) => xmlField(field, overrides, indent, mode, path, depth)).join("");
}

function xmlField(
  field: PromptField, overrides: PromptOverrides, indent: string,
  mode: SkelMode, path: Set<OutputFormatSpec>, depth: number,
): string {
  // Object (or object-array): expand the nested element once.
  if (canExpand(field, path, depth)) {
    const nested = field.nested!;
    path.add(nested);
    const body = xmlBody(nested, overrides, indent + INDENT, mode, path, depth + 1);
    path.delete(nested);
    return `${indent}<${field.name}>\n${body}${indent}</${field.name}>\n`;
  }
  // Scalar / scalar-array / guarded object: one element line.
  const content = mode === "inline" ? inlineContent(field, overrides) : exampleValue(field, overrides);
  return `${indent}<${field.name}>${escapeXml(content)}</${field.name}>\n`;
}

// ---- GUIDE ----

function renderGuide(spec: OutputFormatSpec, overrides: PromptOverrides): string {
  let sb = "Fill in each field as described below:\n";
  sb += guideFields(spec, overrides, "", new Set<OutputFormatSpec>([spec]), 0);
  sb += "\nRespond exactly like this:\n";
  sb += renderExampleOnly(spec, overrides);
  return sb;
}

function guideFields(
  spec: OutputFormatSpec, overrides: PromptOverrides, prefix: string,
  path: Set<OutputFormatSpec>, depth: number,
): string {
  let sb = "";
  for (const field of spec.fields) {
    const displayName = prefix + field.name;
    sb += guideEntry(field, overrides, displayName);
    if (canExpand(field, path, depth)) {
      const nested = field.nested!;
      const childPrefix = field.array ? `${displayName}[].` : `${displayName}.`;
      path.add(nested);
      sb += guideFields(nested, overrides, childPrefix, path, depth + 1);
      path.delete(nested);
    }
  }
  return sb;
}

function guideEntry(field: PromptField, overrides: PromptOverrides, displayName: string): string {
  const req = field.required ? "required" : "optional";
  let sb = `- ${displayName} (${req})`;
  const instruction = resolveInstruction(field, overrides);
  if (instruction != null) sb += `: ${instruction}`;
  sb += "\n";
  if (field.kind === FieldKind.ENUM && field.enumValues != null && field.enumValues.length > 0) {
    sb += `    one of ${field.enumValues.join(", ")}\n`;
    const enumDoc = field.enumDoc;
    if (enumDoc != null) {
      for (const val of field.enumValues) {
        const doc = enumDoc[val];
        if (doc != null) sb += `      ${val} = ${doc}\n`;
      }
    }
  }
  const eg = exampleValueIfDeclared(field, overrides);
  if (eg != null) sb += `    e.g. ${eg}\n`;
  return sb;
}
```

Also update the file's top comment: replace the "Nested-object expansion is a bounded deferral" note (the old comment lived in `renderJsonSkeleton`) — it's gone now. Remove the obsolete `renderXmlInline`/`renderJsonInline` (folded into the mode-parameterized skeleton).

- [ ] **Step 4: Run — verify the unit tests pass + existing render suite stays green**

Run: `cd $WT/server/typescript/packages/render && bun test test/output-format-renderer-nested.test.ts` → PASS (8 tests).
Run: `cd $WT/server/typescript/packages/render && bun test test/output-format-renderer.test.ts` → PASS (existing scalar/enum tests unchanged — proves byte-identity preserved for non-nested).
Run: `cd $WT/server/typescript && bun run --filter '@metaobjectsdev/render' typecheck` → code 0.

- [ ] **Step 5: Regenerate the affected R13 corpus expecteds + flip roundTrip**

Delete the now-stale expected files and the snapshot-generate flow rewrites them:
```bash
cd $WT
rm fixtures/output-prompt-conformance/json-nested/expected.*.txt
rm fixtures/output-prompt-conformance/xml-nested/expected.*.txt
rm fixtures/output-prompt-conformance/json-array/expected.*.txt
```
In `fixtures/output-prompt-conformance/json-nested/spec.json` and `xml-nested/spec.json`, change `"roundTrip": false` to `"roundTrip": true` (the exampleOnly fragment is now a real nested object that must recover clean). Leave `json-array/spec.json` at `roundTrip:false` (its `tags` has no example).
Run the R13 runner to regenerate: `cd $WT/server/typescript/packages/render && bun test test/output-prompt-conformance.test.ts` → first run FAILS with "snapshot created" for the 9 deleted files; it regenerates them.

- [ ] **Step 6: Eyeball the regenerated expecteds**

Read `json-nested/expected.{guide,inline,exampleOnly}.txt`, `xml-nested/expected.*.txt`, `json-array/expected.*.txt`. Confirm: nested `meta`/`score` is expanded (not `{meta}`); xml shows `<meta>\n    <score>5</score>\n  </meta>`; `json-array` shows `"tags": [\n    "{tags}"\n  ]`; guide shows the dotted `- meta.score (required): 1-5.` entry. If anything looks wrong, the renderer is the problem — fix Step 3, not the corpus.

- [ ] **Step 7: Re-run R13 → green, and update the corpus README**

Run: `cd $WT/server/typescript/packages/render && bun test test/output-prompt-conformance.test.ts` → PASS (10 tests, with json-nested/xml-nested now exercising the round-trip).
Edit `fixtures/output-prompt-conformance/README.md`: replace the "## Nested objects" section's "renders as a flat `{name}` placeholder" wording with a description of expansion (nested objects recurse; JSON arrays render `[ one element ]`; XML arrays show one representative element; depth/cycle guard falls back to the flat placeholder beyond `MAX_NEST_DEPTH`).

- [ ] **Step 8: Commit**

```bash
cd $WT && git rev-parse --abbrev-ref HEAD   # must be worktree-fr-012-nested-prompt-expansion
git add server/typescript/packages/render/src/prompt/output-format-renderer.ts \
  server/typescript/packages/render/test/output-format-renderer-nested.test.ts \
  fixtures/output-prompt-conformance
git commit -m "feat(render): TS nested-object + array prompt expansion (FR-012 pilot)

Renderer recurses into nested OBJECT fields + arrays (objects + scalars) across
all 3 styles x json/xml, with a depth/cycle guard. Regenerates R13 nested/array
corpus expecteds (now the oracle) and flips json-nested/xml-nested to roundTrip."
```

---

## Task 2: TS — add deep-nest + array-of-objects corpus cases, bump count guard to 12

**Files:**
- Create: `fixtures/output-prompt-conformance/json-deep-nest/{spec.json,README.md,expected.*.txt}`
- Create: `fixtures/output-prompt-conformance/json-array-of-objects/{spec.json,README.md,expected.*.txt}`
- Modify: `server/typescript/packages/render/test/output-prompt-conformance.test.ts`

- [ ] **Step 1: Author `json-deep-nest`** — `fixtures/output-prompt-conformance/json-deep-nest/spec.json`:
```json
{
  "format": "json", "rootName": "Outer", "roundTrip": true,
  "fields": [
    { "name": "level1", "kind": "OBJECT", "required": true, "nested": {
      "format": "json", "rootName": "L1",
      "fields": [
        { "name": "level2", "kind": "OBJECT", "required": true, "nested": {
          "format": "json", "rootName": "L2",
          "fields": [
            { "name": "value", "kind": "STRING", "required": true, "example": "deep", "instruction": "the deep value" }
          ] } } ] } } ]
}
```
`README.md`: "Three-level nested object — exercises indentation depth + guide dotted-path recursion (`level1.level2.value`)."

- [ ] **Step 2: Author `json-array-of-objects`** — `spec.json`:
```json
{
  "format": "json", "rootName": "Cart", "roundTrip": true,
  "fields": [
    { "name": "lines", "kind": "OBJECT", "required": true, "array": true, "nested": {
      "format": "json", "rootName": "Line",
      "fields": [
        { "name": "sku", "kind": "STRING", "required": true, "example": "A-100", "instruction": "product code" },
        { "name": "qty", "kind": "INT", "required": true, "example": "2", "instruction": "quantity" }
      ] } } ]
}
```
`README.md`: "Array-of-objects — exercises `[ {…} ]` element expansion + guide `lines[].sku` dotted paths; round-trips through nested array recovery."

- [ ] **Step 3: Bump the count guard** in `server/typescript/packages/render/test/output-prompt-conformance.test.ts`: change `const EXPECTED_CASE_COUNT = 10;` to `const EXPECTED_CASE_COUNT = 12;`.

- [ ] **Step 4: Generate + eyeball + green**

Run: `cd $WT/server/typescript/packages/render && bun test test/output-prompt-conformance.test.ts`
First run FAILS ("snapshot created" for the 2 new cases × 3 styles). Eyeball the 6 new expecteds: deep-nest shows 3 levels of indentation in exampleOnly + `- level1.level2.value (required): the deep value` in guide; array-of-objects shows `"lines": [ { "sku": ..., "qty": 2 } ]` and `- lines[].sku` / `- lines[].qty` in guide, and both round-trip clean. Re-run → PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add fixtures/output-prompt-conformance server/typescript/packages/render/test/output-prompt-conformance.test.ts
git commit -m "test(output-prompt-conformance): add deep-nest + array-of-objects cases, count guard 10->12 (TS)"
```

---

## Task 3: Java renderer recursion + guard (shared JVM engine — Kotlin inherits)

**Files:**
- Modify: `server/java/render/src/main/java/com/metaobjects/render/prompt/OutputFormatRenderer.java`
- Create: a guard unit test under `server/java/render/src/test/java/com/metaobjects/render/prompt/` (e.g. `OutputFormatRendererNestedTest.java`)
- Modify: `server/java/render/src/test/java/com/metaobjects/render/prompt/OutputPromptConformanceTest.java` (count guard 10 → 12)

The TS reference is `server/typescript/packages/render/src/prompt/output-format-renderer.ts` on this branch — port it function-for-function.

- [ ] **Step 1: Port the recursion.** Mirror the TS reference: `INDENT="  "`, `MAX_NEST_DEPTH=8`; a `SkelMode` (enum or boolean) distinguishing example vs inline; `jsonObject/jsonValue/jsonLeaf/jsonArray` + `xmlBody/xmlField` + `guideFields/guideEntry` + a `canExpand` helper. The cycle guard is an **identity set** of `OutputFormatSpec` (`Collections.newSetFromMap(new IdentityHashMap<>())`), seeded with the root spec; depth is an int. Keep the existing leaf helpers (`exampleValue`/`inlineContent`/`resolveInstruction`/`exampleValueIfDeclared`/`isNumericOrBoolean`) and the `render(spec, overrides)` dispatch. Read `PromptField`/`OutputFormatSpec`/`PromptStyle` for exact accessors (record getters).

- [ ] **Step 2: Add the guard unit test** asserting an over-`MAX_NEST_DEPTH` chain (build 12 nested specs in a loop) renders the flat `"{child}"` placeholder at the boundary and does not throw/loop. Match the test framework of the sibling render tests (JUnit 4).

- [ ] **Step 3: Bump the conformance count guard** in `OutputPromptConformanceTest.java`: `EXPECTED_CASE_COUNT` 10 → 12.

- [ ] **Step 4: Run**

`cd $WT/server/java && mvn -q -pl render test -Dtest=OutputPromptConformanceTest,OutputFormatRendererNestedTest -DfailIfNoTests=false`
Expected: conformance 12/12 reproducing the TS-regenerated bytes byte-for-byte + the guard test green. **Any byte divergence is a Java renderer bug to fix to match the reference — never edit the corpus or add a ledger.**

- [ ] **Step 5: Commit**

```bash
cd $WT && git add server/java/render/src/main/java/com/metaobjects/render/prompt/OutputFormatRenderer.java \
  server/java/render/src/test/java/com/metaobjects/render/prompt/OutputFormatRendererNestedTest.java \
  server/java/render/src/test/java/com/metaobjects/render/prompt/OutputPromptConformanceTest.java
git commit -m "feat(render): Java nested-object + array prompt expansion (FR-012); count guard 12"
```

---

## Task 4: Kotlin — verify the inherited engine + bump count guard

Kotlin reuses the Java `OutputFormatRenderer` (shared JVM engine), so the expansion is inherited with no Kotlin source change. Only its R13 runner's count guard must move to 12.

**Files:**
- Modify: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/OutputPromptConformanceTest.kt`

- [ ] **Step 1: Bump the count guard** in the Kotlin runner from 10 to 12 (find the `expectedCaseCount`/`EXPECTED_CASE_COUNT` constant).
- [ ] **Step 2: Run** `cd $WT/server/java && mvn -q -pl codegen-kotlin test -Dtest=OutputPromptConformanceTest -DfailIfNoTests=false` → 12 cases reproduce byte-for-byte (via the inherited Java engine).
- [ ] **Step 3: Commit**
```bash
cd $WT && git add server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/OutputPromptConformanceTest.kt
git commit -m "test(output-prompt-conformance): Kotlin count guard 12 (inherits Java FR-012 engine)"
```

---

## Task 5: C# renderer recursion + guard

**Files:**
- Modify: `server/csharp/MetaObjects.Render/Prompt/OutputFormatRenderer.cs`
- Create: a guard unit test under `server/csharp/MetaObjects.Render.Tests/` (e.g. `OutputFormatRendererNestedTests.cs`)
- Modify: `server/csharp/MetaObjects.Render.Tests/OutputPromptConformanceTests.cs` (count guard 10 → 12)

Port the TS reference function-for-function (same INDENT/`MAX_NEST_DEPTH`/mode/`canExpand`/recursion shape). Cycle set = `new HashSet<OutputFormatSpec>(ReferenceEqualityComparer.Instance)` (reference identity) seeded with the root. Keep the existing leaf helpers + `Render(spec, overrides)` dispatch.

- [ ] **Step 1: Port the recursion** (read `PromptField`/`OutputFormatSpec`/`PromptStyle` records for accessors).
- [ ] **Step 2: Add the depth-guard unit test** (over-deep chain → flat `"{child}"` fallback, no throw).
- [ ] **Step 3: Bump count guard** in `OutputPromptConformanceTests.cs` to 12.
- [ ] **Step 4: Run** `cd $WT && dotnet test server/csharp/MetaObjects.Render.Tests --filter "FullyQualifiedName~OutputPrompt|FullyQualifiedName~OutputFormatRendererNested"` → conformance 12/12 byte-for-byte + guard green. Divergence → fix the C# renderer, not the corpus.
- [ ] **Step 5: Commit**
```bash
cd $WT && git add server/csharp/MetaObjects.Render/Prompt/OutputFormatRenderer.cs \
  server/csharp/MetaObjects.Render.Tests/OutputFormatRendererNestedTests.cs \
  server/csharp/MetaObjects.Render.Tests/OutputPromptConformanceTests.cs
git commit -m "feat(render): C# nested-object + array prompt expansion (FR-012); count guard 12"
```

---

## Task 6: Python renderer recursion + guard

**Files:**
- Modify: `server/python/src/metaobjects/render/prompt/output_format_renderer.py`
- Create: a guard unit test under `server/python/tests/render/` (e.g. `test_output_format_renderer_nested.py`)
- Modify: `server/python/tests/render/test_output_prompt_conformance.py` (count guard 10 → 12)

Port the TS reference function-for-function (snake_case). Cycle set = a set of `id(spec)` (identity), seeded with the root; depth is an int. Keep the existing leaf helpers + `render_output_format(spec, overrides)` dispatch.

- [ ] **Step 1: Port the recursion** (read the dataclass field names + `PromptStyle` members).
- [ ] **Step 2: Add the depth-guard unit test** (over-deep chain → flat `"{child}"` fallback, no exception).
- [ ] **Step 3: Bump count guard** in `test_output_prompt_conformance.py` to 12.
- [ ] **Step 4: Run** `cd $WT/server/python && uv run pytest tests/render/test_output_prompt_conformance.py tests/render/test_output_format_renderer_nested.py -q` → 12 conformance + guard green. Then `uv run ruff check src/metaobjects/render/prompt/output_format_renderer.py` and `uv run mypy` (no new errors). Divergence → fix the Python renderer, not the corpus.
- [ ] **Step 5: Commit**
```bash
cd $WT && git add server/python/src/metaobjects/render/prompt/output_format_renderer.py \
  server/python/tests/render/test_output_format_renderer_nested.py \
  server/python/tests/render/test_output_prompt_conformance.py
git commit -m "feat(render): Python nested-object + array prompt expansion (FR-012); count guard 12"
```

---

## Task 7: Close-out

**Files:**
- Modify: `spec/roadmap.md`
- Modify: memory (`conformance-suite-gaps.md`, `MEMORY.md`) — controller does this (memory lives outside the repo)

- [ ] **Step 1: Final whole-branch review.** Dispatch a final reviewer over `git diff origin/main..HEAD`: confirm all 5 ports expand nested/arrays byte-identically (12/12 each, Kotlin via inherited engine), the 7 scalar cases are byte-unchanged, the guard is unit-tested per native port, only the 4 renderer files + tests + corpus changed (no metadata/codegen/recover source touched), and hygiene is clean. Fix any findings.

- [ ] **Step 2: Roadmap.** In `spec/roadmap.md`, update the "Output-prompt conformance" line: corpus is now **12 cases**, fragments expand nested objects + arrays-of-objects + scalar arrays; note FR-012 closed the FR-010 nested-prompt-expansion deferral / request-response asymmetry. Add an FR-012 entry under "Key cross-language features" if that section lists FRs.

- [ ] **Step 3: Commit the roadmap.**
```bash
cd $WT && git add spec/roadmap.md
git commit -m "docs(roadmap): FR-012 nested-object prompt expansion shipped (5 ports), corpus 12 cases"
```

- [ ] **Step 4: Merge.** Verify the suite is green, then merge forward onto the current `origin/main` tip (the controller does this with the worktree FF-push pattern: `git merge --no-edit origin/main` in the worktree → resolve any conflict → `git push origin HEAD:main` as a fast-forward), then remove the worktree. Forward-only: never rebase/reset/force `main`. (The local main checkout may belong to another agent — do not disturb it; advance `origin/main` via FF-push from the worktree.)

- [ ] **Step 5: Memory (controller).** Mark FR-012 shipped in `conformance-suite-gaps.md` (nested-prompt-expansion gap closed; corpus 12; request/response now symmetric on nesting) and update the `MEMORY.md` pointer.

---

## Notes for the executor

- **Zero-drift, no ledger.** A cross-port byte divergence is a renderer bug to fix in the diverging port — never a corpus edit or ledger entry. The TS pilot's regenerated/new expecteds are the oracle.
- **Single branch, single merge.** Don't merge the pilot alone — the shared corpus would red the other ports until they land.
- **The 7 scalar cases must stay byte-identical.** If `bun test test/output-format-renderer.test.ts` (existing scalar tests) or any scalar conformance case changes, the recursion broke a non-nested path — fix it.
- **Identity-based cycle set, not value-equality.** Use reference identity (TS `Set` of objects, Java `IdentityHashMap`-set, C# `ReferenceEqualityComparer`, Python `id()`), so two structurally-equal sibling specs are not mistaken for a cycle.
- **Absolute worktree paths; subagents never `git checkout` SHAs; confirm branch before each commit.**
- **Tamper-test each port's runner** during review (append a byte to a regenerated expected, confirm the case fails, revert) — proves the gate still has teeth after the count-guard bump.

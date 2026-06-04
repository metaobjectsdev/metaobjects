# AI LLM-Call Trace #1b — Prompt-Derived Typed Traces — Implementation Plan (TS)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A trace entity that nests a `template.prompt` (carrying `@payloadRef` + new `@responseRef`) gets typed `voRequest`/`voResponse` jsonb columns + a typed `record<Name>Call` helper auto-derived — you name each VO once, on the prompt.

**Architecture:** Add `@responseRef` to `template.prompt` (peer of `@payloadRef`). Allow `template.prompt` as a child of `object.entity`, and make template discovery recursive so nested prompts are still first-class. A **pre-codegen pass in the ai-codegen layer** walks `LlmCallBase`-derived entities that nest a prompt and injects `voRequest`/`voResponse` `field.object`+`@objectRef`+`@storage:jsonb` nodes (the loaded root is not frozen; `addChild` works) — standard entity codegen then emits the columns (proven by the merged vertical). A generated `record<Name>Call` wraps the merged `recordLlmCall`.

**Tech Stack:** TS, Bun test, `@metaobjectsdev/metadata` (template schema/constants, loader validation passes, core-types child rules, MetaField/addChild), `@metaobjectsdev/codegen-ts` (runner pre-codegen pass, generators), `@metaobjectsdev/runtime-ts` (`recordLlmCall`, `LlmCallDbRecorder`).

**Scope:** TS pilot. STI/shared-table → #1c. Cross-port → later. Design: `docs/superpowers/specs/2026-06-04-ai-trace-1b-prompt-derived-design.md`.

**Injection-mechanism decision (recorded):** derivation is a **codegen-layer pre-pass** (not a core-loader pass), so core `metadata` stays uncoupled from `ai`. Consequence: the metamodel conformance fixture (Task 5) gates the `@responseRef` + nested-prompt *input* shape; the *derived columns* are gated by a TS codegen test (Task 3). Cross-port derivation gating comes with the port.

---

## File Structure

**Modify:**
- `server/typescript/packages/metadata/src/template/template-constants.ts` — add `TEMPLATE_ATTR_RESPONSE_REF`.
- `server/typescript/packages/metadata/src/template/template-schema.ts` — declare `@responseRef` in `promptOverlayAttrs`.
- `server/typescript/packages/metadata/src/loader/validation-passes.ts` — resolve `@responseRef` in `validateTemplatePayloadRefs()`.
- `server/typescript/packages/metadata/src/core-types.ts` — allow `template.prompt` under `object.entity`.
- `server/typescript/packages/codegen-ts/src/generators/prompt-render-file.ts` + `output-parser-file.ts` — use a recursive template-finder.
- `server/typescript/packages/codegen-ts/src/runner.ts` — invoke the derivation pre-pass before the generator loop.

**Create:**
- `server/typescript/packages/codegen-ts/src/templates/find-templates.ts` — recursive `findTemplates(root, subType)` helper.
- `server/typescript/packages/codegen-ts/src/ai/derive-trace-fields.ts` — the pre-codegen derivation pass + the `record<Name>Call` emitter.
- Tests: `metadata/test/template-response-ref.test.ts`, `codegen-ts/test/derive-trace-fields.test.ts`.
- `fixtures/conformance/ai-trace-prompt-nested/` — conformance fixture.

---

## Task 1: `@responseRef` attribute on `template.prompt`

**Files:** Modify `template-constants.ts`, `template-schema.ts`, `loader/validation-passes.ts`. Test: `metadata/test/template-response-ref.test.ts`.

- [ ] **Step 1: Write the failing loader test**

```typescript
// server/typescript/packages/metadata/test/template-response-ref.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/index.ts";

function meta(responseRef: string) {
  return JSON.stringify({
    "metadata.root": {
      package: "t::ai",
      children: [
        { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
        { "object.value": { name: "ResVO", children: [{ "field.string": { name: "a" } }] } },
        { "template.prompt": { name: "P", "@payloadRef": "ReqVO", "@responseRef": responseRef, "@textRef": "p/x", "@format": "xml" } },
      ],
    },
  });
}

describe("template.prompt @responseRef", () => {
  test("resolves to an object.value", async () => {
    const r = await MetaDataLoader.fromString(meta("ResVO"), "json");
    expect(r.errors).toEqual([]);
    const p = r.root.objects?.() ? undefined : undefined; // see assertion below
    // The prompt carries @responseRef as a string attr:
    const prompt = r.root.ownChildren().find((c: { name: string }) => c.name === "P")!;
    expect(prompt.ownAttr("responseRef")).toBe("ResVO");
  });

  test("unresolved @responseRef is a loader error", async () => {
    const r = await MetaDataLoader.fromString(meta("NoSuchVO"), "json");
    expect(r.errors.some((e: { code?: string }) => e.code === "ERR_INVALID_TEMPLATE")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/template-response-ref.test.ts`
Expected: FAIL — `@responseRef` not a known attr (schema rejects it) and/or no resolution.

- [ ] **Step 3: Add the constant**

In `template-constants.ts`, after `export const TEMPLATE_ATTR_PAYLOAD_REF = "payloadRef";` (line ~33) add:
```typescript
// template.prompt-only: optional ref to the response VO (peer of @payloadRef, the request VO).
export const TEMPLATE_ATTR_RESPONSE_REF = "responseRef";
```

- [ ] **Step 4: Declare it in the prompt schema**

In `template-schema.ts`: add `TEMPLATE_ATTR_RESPONSE_REF` to the imports, and append to the `promptOverlayAttrs` array (after the `TEMPLATE_ATTR_MODEL` entry):
```typescript
  {
    name: TEMPLATE_ATTR_RESPONSE_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Optional ref to the response value-object this prompt expects (peer of @payloadRef; drives typed LLM-call trace derivation).",
  },
```
(`promptOverlayAttrs` is only in the `TEMPLATE_SUBTYPE_PROMPT` entry of `TEMPLATE_ATTRS_MAP`, so this stays prompt-only — no change to the map.)

- [ ] **Step 5: Resolve it in the loader**

In `loader/validation-passes.ts`, inside `validateTemplatePayloadRefs()`, immediately after the existing `@payloadRef` resolution block (the one ending near line 182), add — using the exact same `resolvedSource(...)` + `ERR_INVALID_TEMPLATE` pattern:
```typescript
const responseRef = tmpl.ownAttr(TEMPLATE_ATTR_RESPONSE_REF);
if (typeof responseRef === "string") {
  const resVo = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === responseRef);
  if (!resVo || resVo.subType !== OBJECT_SUBTYPE_VALUE) {
    errors.push(
      new ParseError(
        `template "${tmpl.name}" @responseRef "${responseRef}" does not resolve to an object.value at root`,
        { code: "ERR_INVALID_TEMPLATE", source: resolvedSource(tmpl.source, tmpl.fqn(), responseRef) },
      ),
    );
  }
}
```
Add `TEMPLATE_ATTR_RESPONSE_REF` to that file's imports from `template-constants.js`.

- [ ] **Step 6: Run to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/template-response-ref.test.ts`
Expected: PASS (both tests). Then `bun test 2>&1 | tail -6` — no new failures (the 3 known pre-existing only, if present on this branch).

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/metadata/src/template/template-constants.ts server/typescript/packages/metadata/src/template/template-schema.ts server/typescript/packages/metadata/src/loader/validation-passes.ts server/typescript/packages/metadata/test/template-response-ref.test.ts
git commit -m "feat(ai): @responseRef on template.prompt (peer of @payloadRef)"
```

---

## Task 2: Allow `template.prompt` under `object.entity` + recursive template discovery

**Files:** Modify `core-types.ts`, create `codegen-ts/src/templates/find-templates.ts`, modify `prompt-render-file.ts` + `output-parser-file.ts`. Test: extend `metadata/test/template-response-ref.test.ts` + a codegen finder test.

- [ ] **Step 1: Write the failing test (nested prompt loads + is findable)**

```typescript
// append to metadata/test/template-response-ref.test.ts
test("template.prompt is allowed as a child of object.entity", async () => {
  const m = JSON.stringify({
    "metadata.root": { package: "t::ai", children: [
      { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
      { "object.value": { name: "ResVO", children: [{ "field.string": { name: "a" } }] } },
      { "object.entity": { name: "Call", children: [
        { "source.rdb": { "@table": "call", "@role": "primary" } },
        { "field.uuid": { name: "spanId" } },
        { "identity.primary": { "@fields": ["spanId"] } },
        { "template.prompt": { name: "CallPrompt", "@payloadRef": "ReqVO", "@responseRef": "ResVO", "@textRef": "p/x", "@format": "xml" } },
      ] } },
    ] },
  });
  const r = await MetaDataLoader.fromString(m, "json");
  expect(r.errors).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/template-response-ref.test.ts -t "child of object.entity"`
Expected: FAIL — `object.entity` rejects a `template` child (child-rule violation).

- [ ] **Step 3: Allow the child in core-types.ts**

In `core-types.ts`, in the `OBJECT_SUBTYPES` registration loop (around lines 186–196), allow templates only under `object.entity`:
```typescript
import { TYPE_TEMPLATE } from "./template/template-constants.js"; // if not already importable; else use the existing TYPE_TEMPLATE constant import
// ...
for (const subType of OBJECT_SUBTYPES) {
  const subTypeObjectAttrs =
    subType === OBJECT_SUBTYPE_VALUE ? [...objectAttrs, { ...normalizeAttr }] : [...objectAttrs];
  const rules = subType === OBJECT_SUBTYPE_ENTITY ? [...objectRules, wildcard(TYPE_TEMPLATE)] : objectRules;
  registry.register(def(TYPE_OBJECT, subType, `Object/entity (${subType})`, rules, MetaObject, subTypeObjectAttrs));
}
```
(Confirm the real `TYPE_TEMPLATE` constant + `wildcard`/`def` imports already in the file.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/template-response-ref.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Recursive template finder + use it in the prompt generators**

Create `server/typescript/packages/codegen-ts/src/templates/find-templates.ts`:
```typescript
import type { MetaData } from "@metaobjectsdev/metadata";
import { TYPE_TEMPLATE } from "@metaobjectsdev/metadata";

/** All template nodes of `subType` anywhere in the tree (top-level OR nested in entities). */
export function findTemplates(root: MetaData, subType: string): MetaData[] {
  const out: MetaData[] = [];
  const visit = (node: MetaData) => {
    for (const child of node.ownChildren()) {
      if (child.type === TYPE_TEMPLATE && child.subType === subType) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}
```
Then in `prompt-render-file.ts` (line ~48) and `output-parser-file.ts` (line ~33), replace the root-only `ctx.loadedRoot.ownChildren().filter((c) => c.type === TYPE_TEMPLATE && c.subType === <SUB>)` with `findTemplates(ctx.loadedRoot, <SUB>)`. (Import the helper.)

- [ ] **Step 6: Test the finder + run the codegen suite**

Add `server/typescript/packages/codegen-ts/test/find-templates.test.ts` asserting a prompt nested in an entity is returned by `findTemplates(root, TEMPLATE_SUBTYPE_PROMPT)` (build the root via `MetaDataLoader.fromString` with the nested-prompt entity from Step 1). Run:
```
cd server/typescript/packages/codegen-ts && bun test test/find-templates.test.ts && bun test 2>&1 | tail -6
```
Expected: PASS; no regressions.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/metadata/src/core-types.ts server/typescript/packages/codegen-ts/src/templates/find-templates.ts server/typescript/packages/codegen-ts/src/generators/prompt-render-file.ts server/typescript/packages/codegen-ts/src/generators/output-parser-file.ts server/typescript/packages/codegen-ts/test/find-templates.test.ts server/typescript/packages/metadata/test/template-response-ref.test.ts
git commit -m "feat(ai): allow template.prompt under object.entity + recursive template discovery"
```

---

## Task 3: Derivation pre-pass — inject typed voRequest/voResponse columns

**Files:** Create `codegen-ts/src/ai/derive-trace-fields.ts`; modify `codegen-ts/src/runner.ts`. Test: `codegen-ts/test/derive-trace-fields.test.ts`.

- [ ] **Step 1: Write the failing codegen test**

```typescript
// server/typescript/packages/codegen-ts/test/derive-trace-fields.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile, queriesFile, barrel } from "../src/generators/index.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "ai1b-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const MODEL = JSON.stringify({ "metadata.root": { package: "t::ai", children: [
  { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
  { "object.value": { name: "ResVO", children: [{ "field.string": { name: "a" } }] } },
  { "object.entity": { name: "LlmCallBase", abstract: true, children: [
    { "field.uuid": { name: "spanId" } }, { "field.string": { name: "status" } },
  ] } },
  { "object.entity": { name: "ClassifyCall", extends: "LlmCallBase", children: [
    { "source.rdb": { "@table": "classify_call", "@role": "primary" } },
    { "identity.primary": { "@fields": ["spanId"] } },
    { "template.prompt": { name: "ClassifyPrompt", "@payloadRef": "ReqVO", "@responseRef": "ResVO", "@textRef": "p/x", "@format": "xml" } },
  ] } },
] } });

describe("derive trace fields", () => {
  test("nested prompt → voRequest/voResponse jsonb columns on the table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai1b-model-"));
    writeFileSync(join(dir, "m.json"), MODEL);
    const loaded = await MetaDataLoader.fromDirectory(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(loaded.errors).toEqual([]);
    const out = await runGen({
      config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres", generators: [entityFile(), queriesFile(), barrel()] }),
      metadata: loaded.root,
    });
    expect(out.warnings).toEqual([]);
    const t = readFileSync(join(tmp, "ClassifyCall.ts"), "utf-8");
    expect(t).toContain("classify_call");
    expect(t).toContain("voRequest");
    expect(t).toContain("voResponse");
    expect(t).toContain("jsonb");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/derive-trace-fields.test.ts`
Expected: FAIL — generated table lacks `voRequest`/`voResponse` (no derivation yet).

- [ ] **Step 3: Implement the derivation pass**

Create `server/typescript/packages/codegen-ts/src/ai/derive-trace-fields.ts`. It mutates the (unfrozen) run root: for each `object.entity` whose `extends` chain includes `LlmCallBase` AND that has a child `template.prompt`, inject `voRequest`/`voResponse` `field.object` nodes (idempotent — skip if already present). Construct nodes via the real `MetaField` + `TypeId` + `addChild` API (confirm signatures in `meta-field.ts`/`meta-data.ts`):
```typescript
import type { MetaData } from "@metaobjectsdev/metadata";
import { MetaField, TypeId, TYPE_FIELD, TYPE_TEMPLATE, TYPE_OBJECT, FIELD_SUBTYPE_OBJECT,
         FIELD_ATTR_OBJECT_REF, FIELD_ATTR_STORAGE, STORAGE_JSONB,
         TEMPLATE_SUBTYPE_PROMPT, TEMPLATE_ATTR_PAYLOAD_REF, TEMPLATE_ATTR_RESPONSE_REF } from "@metaobjectsdev/metadata";

const LLM_CALL_BASE = "LlmCallBase";

function extendsBase(obj: MetaData, baseName: string): boolean {
  let cur: MetaData | undefined = obj.superResolved ?? undefined;
  while (cur) { if (cur.name === baseName) return true; cur = cur.superResolved ?? undefined; }
  return false;
}

function injectObjField(entity: MetaData, name: string, objectRef: string): void {
  if (entity.ownChildren().some((c) => c.type === TYPE_FIELD && c.name === name)) return; // idempotent
  const f = new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_OBJECT), name);
  f.setAttr(FIELD_ATTR_OBJECT_REF, objectRef);
  f.setAttr(FIELD_ATTR_STORAGE, STORAGE_JSONB);
  entity.addChild(f);
}

/** Inject typed voRequest/voResponse columns onto LlmCallBase-derived entities that nest a prompt. */
export function deriveTraceFields(root: MetaData): void {
  for (const obj of root.ownChildren()) {
    if (obj.type !== TYPE_OBJECT) continue;
    if (!extendsBase(obj, LLM_CALL_BASE)) continue;
    const prompt = obj.ownChildren().find((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_PROMPT);
    if (!prompt) continue;
    const payloadRef = prompt.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
    const responseRef = prompt.ownAttr(TEMPLATE_ATTR_RESPONSE_REF);
    if (typeof payloadRef === "string") injectObjField(obj, "voRequest", payloadRef);
    if (typeof responseRef === "string") injectObjField(obj, "voResponse", responseRef);
  }
}
```
Confirm the real API: `MetaField` constructor, `TypeId`, `setAttr`, `addChild`, `superResolved`, and the exported constants (`FIELD_SUBTYPE_OBJECT`, `FIELD_ATTR_OBJECT_REF`, `FIELD_ATTR_STORAGE`, `STORAGE_JSONB`). Adjust names to the real exports (e.g. `STORAGE_JSONB` may be `"jsonb"` literal via a constant — use the real one from `field-constants.ts`). If `obj.fields()` is cached, call `deriveTraceFields` BEFORE any `.fields()` cache is populated (the pass runs before codegen reads fields), or clear the relevant cache after injection — verify whether `addChild` invalidates the `fields` cache; if not, inject before first `.fields()` call (the runner pass runs before generators, which is before `.fields()`).

- [ ] **Step 4: Wire into the runner**

In `runner.ts`, after `const root = opts.metadata;` (line ~78) and before the shared render-state precompute / generator loop, call:
```typescript
const { deriveTraceFields } = await import("./ai/derive-trace-fields.js");
deriveTraceFields(root);
```
(Dynamic import keeps the ai derivation out of any browser-safe path, consistent with the loader's pattern. Confirm `runner.ts` isn't on a browser-safe boundary; if it's already server-only, a static import is fine.)

- [ ] **Step 5: Run to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/derive-trace-fields.test.ts`
Expected: PASS — `ClassifyCall.ts` table has `voRequest`/`voResponse` `jsonb` columns. If the columns appear but not as `jsonb`, confirm `FIELD_ATTR_STORAGE`+jsonb maps to a `jsonb()` Postgres column in `column-mapper.ts` (the merged vertical proved `field.object`+`@objectRef`+`@storage:jsonb` → jsonb). If `.fields()` cache hid the injection, move `deriveTraceFields` earlier or invalidate the cache (Step 3 note).

- [ ] **Step 6: Run the codegen suite (no regressions)**

Run: `cd server/typescript/packages/codegen-ts && bun test 2>&1 | tail -6`
Expected: PASS — entities without a nested prompt are untouched (the pass no-ops on them).

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/ai/derive-trace-fields.ts server/typescript/packages/codegen-ts/src/runner.ts server/typescript/packages/codegen-ts/test/derive-trace-fields.test.ts
git commit -m "feat(ai): derive typed voRequest/voResponse columns from a nested prompt"
```

---

## Task 4: Generated typed `record<Name>Call` helper

**Files:** extend `codegen-ts/src/ai/derive-trace-fields.ts` (or a sibling `ai/record-helper.ts`) with an emitter; add a generator that emits a `<Entity>.trace.ts` file. Test: `codegen-ts/test/derive-trace-fields.test.ts` (extend).

- [ ] **Step 1: Write the failing test**

```typescript
// append to derive-trace-fields.test.ts — assert a typed record helper file is emitted
test("emits a typed record helper for a derived trace entity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai1b-h-"));
  writeFileSync(join(dir, "m.json"), MODEL);
  const loaded = await MetaDataLoader.fromDirectory(dir);
  rmSync(dir, { recursive: true, force: true });
  const out = await runGen({
    config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres",
      generators: [entityFile(), queriesFile(), /* traceHelperFile(), */ barrel()] }),
    metadata: loaded.root,
  });
  const files = readdirSync(tmp);
  expect(files).toContain("ClassifyCall.trace.ts");
  const h = readFileSync(join(tmp, "ClassifyCall.trace.ts"), "utf-8");
  expect(h).toContain("recordClassifyCallCall"); // or recordClassifyCall — pick one naming (see Step 3)
  expect(h).toContain("recordLlmCall");          // delegates to the merged runtime fn
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/derive-trace-fields.test.ts -t "record helper"`
Expected: FAIL — no helper file / generator.

- [ ] **Step 3: Implement the helper generator**

Add a `traceHelperFile()` generator (factory in `generators/`, registered like the others) that, for each `LlmCallBase`-derived entity with a nested prompt, emits `<Entity>.trace.ts`:
- Naming: `record<Entity>` (e.g. `recordClassifyCall`) — drop the doubled "Call".
- It imports `recordLlmCall` + `LlmCallDbRecorder` from `@metaobjectsdev/runtime-ts`, takes `(om, input, responseText)`, resolves the response VO `MetaObject` from `om` metadata by the prompt's `@responseRef` name (static string at codegen) + the entity name (static), and calls `recordLlmCall(input, { recorder: new LlmCallDbRecorder(om, "<Entity>"), responseMo, format })`. Type the `input`/result using the generated payload interfaces (`generatePayloadInterfaces` in `payload-codegen.ts`) for the request/response VOs.
- Emit the file via the standard `EmittedFile[]` return + register the factory.

Wire `traceHelperFile()` into the test config (uncomment in Step 1). Confirm the exact `recordLlmCall`/`LlmCallDbRecorder` import path + signatures (in `runtime-ts/src/llm-recorder.ts`) and how a generator resolves a `MetaObject` from `om` at runtime (`om` exposes its metadata root; `root.findObject(name)`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/derive-trace-fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/ai/ server/typescript/packages/codegen-ts/src/generators/ server/typescript/packages/codegen-ts/test/derive-trace-fields.test.ts
git commit -m "feat(ai): generated typed record<Entity> helper wrapping recordLlmCall"
```

---

## Task 5: Conformance fixture + full verify

**Files:** Create `fixtures/conformance/ai-trace-prompt-nested/`.

- [ ] **Step 1: Add the fixture input**

`fixtures/conformance/ai-trace-prompt-nested/input/meta.ai.json` — a trace entity nesting a `template.prompt` with `@payloadRef` + `@responseRef`, plus the two `object.value`s and an abstract `LlmCallBase`. (Mirror the Task 3 `MODEL` shape, canonical JSON, with `identity.primary` on the concrete entity.)

- [ ] **Step 2: Generate expected.json + verify**

```
mkdir -p fixtures/conformance/ai-trace-prompt-nested
printf '{}' > fixtures/conformance/ai-trace-prompt-nested/expected.json
cd server/typescript/packages/metadata
bun -e 'import {MetaDataLoader} from "./src/index.ts"; import {canonicalSerialize} from "./src/serializer-json.ts"; const r=await MetaDataLoader.fromDirectory("../../../../fixtures/conformance/ai-trace-prompt-nested/input"); if(r.errors.length){console.error(JSON.stringify(r.errors,null,2));process.exit(1);} process.stdout.write(canonicalSerialize(r.root));' > ../../../../fixtures/conformance/ai-trace-prompt-nested/expected.json
bun test test/conformance.test.ts -t "ai-trace-prompt-nested" 2>&1 | tail -6
```
Expected: PASS (both lint + conformance). The canonical output asserts the `@responseRef` + nested-`template.prompt` *input* shape (derivation is codegen-only, so it does NOT appear here — that's intended; the derived columns are gated by Task 3's codegen test).

- [ ] **Step 3: Full verify**

```
cd server/typescript/packages/metadata && bun test 2>&1 | tail -6
cd ../codegen-ts && bun test 2>&1 | tail -6
```
Expected: only the known pre-existing failures (if any on this branch); all new tests green.

- [ ] **Step 4: Commit**

```bash
git add fixtures/conformance/ai-trace-prompt-nested/
git commit -m "test(ai): conformance fixture for nested template.prompt + @responseRef"
```

---

## Self-Review

**Spec coverage:** §4.1 `@responseRef` → Task 1; §4.2 nested-prompt loader + discovery → Task 2; §4.3 derivation codegen → Task 3; §4.4 typed record helper → Task 4; §5 testing/conformance → Tasks 1–5. `PromptLlmCallBase` dropped (no library-file task — correct). STI deferred to #1c (not in plan — correct).

**Placeholder scan:** none. The "confirm the real API/import" notes are explicit verification steps with the file to read (MetaField/TypeId/addChild, FIELD_ATTR_STORAGE/STORAGE_JSONB, recordLlmCall signature), not hand-waves.

**Type consistency:** `deriveTraceFields(root)` defined in Task 3, invoked in runner Task 3; `findTemplates(root, subType)` defined Task 2, used in Task 2 generators; injected field names `voRequest`/`voResponse` consistent Task 3↔4↔5; `recordLlmCall`/`LlmCallDbRecorder` consumed in Task 4 per the merged vertical signatures.

**Risks to verify during execution:** (1) `.fields()` cache vs post-load injection timing (Task 3 Step 3/5 note); (2) exact `MetaField`/`TypeId`/`setAttr` construction API; (3) `FIELD_ATTR_STORAGE` + jsonb constant name; (4) `TYPE_TEMPLATE` import in core-types.ts; (5) generator registration/factory pattern for `traceHelperFile()`.

---

## Follow-on (not in this plan)
- **#1c:** STI / shared-table (`source.rdb` on a base → N derived traces share one table; one DDL + per-subtype repos stamping `callType`).
- **Cross-port:** port `@responseRef` + nested-prompt + derivation to Java/Python/C#/Kotlin (the conformance fixture from Task 5 gates the input shape).
- **#2/#3:** `ai-runtime` `callXxx` loop + Langfuse/OTel adapters.

# AI LLM-Call Trace Persistence — Spec #1 Implementation Plan (TS pilot)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation of the LLM-call trace store in the TypeScript reference port: a `library/` area for MetaObjects-shipped metadata, the canonical `library/ai/llm-call.yaml` (`LlmCallBase` abstract + `LlmCall` concrete), an opt-in loader "library-load" capability, proof that an app entity extending the base generates a table/repo through the existing codegen, and a cross-port conformance fixture.

**Architecture:** Mirror the existing `templates/` shipping mechanism (canonical-at-root → generated embedded string module → on-disk-first-with-embedded-fallback resolver → 3-way byte-identity gate) for a new `library/` area. The loader gains an opt-in option that prepends library metadata sources; because `extends` resolution is deferred and order-independent (`resolveDeferredSupers` keys on `resolutionKey`), app metadata can `extends metaobjects::ai::LlmCallBase`. Generic jsonb columns use `field.string` + `@dbColumnType: jsonb` (NOT `field.object` without `@objectRef`, which the loader rejects). No codegen changes are required — an entity extending an abstract base flows through the existing entity-file path unchanged.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/metadata` (loader + canonical serializer), `@metaobjectsdev/codegen-ts` (entity codegen), the shared `fixtures/conformance/` corpus.

**Scope:** This plan is the TS pilot + the port-agnostic canonical artifacts only. The Java/Python/C#/Kotlin ports of the loader library-load mechanism are **follow-on port-plans** (via `cross-language-porting`). Spec #1b (`prompt-llm-call.yaml`, prompt-derived typed traces, STI) and #2/#3 (runtime) are separate plans.

**Spec:** `docs/superpowers/specs/2026-06-02-ai-llm-call-trace-persistence-design.md`

---

## File Structure

**Create:**
- `library/ai/llm-call.yaml` — canonical shipped metadata: `LlmCallBase` (abstract) + `LlmCall` (concrete).
- `scripts/generate-embedded-library.ts` — reads `library/**/*.yaml`, emits the embedded TS string module (mirrors `scripts/generate-embedded-templates.ts`).
- `server/typescript/packages/metadata/src/library/embedded-library.generated.ts` — generated; `EMBEDDED_LIBRARY: Record<string, string>` (ref → YAML text).
- `server/typescript/packages/metadata/src/library/library-sources.ts` — `librarySources(packages: string[])`: on-disk-first, embedded fallback; returns `MetaDataSource[]`.
- `server/typescript/packages/metadata/test/embedded-library.test.ts` — 3-way byte-identity gate.
- `server/typescript/packages/metadata/test/library-load.test.ts` — loader option behavior.
- `server/typescript/packages/codegen-ts/test/ai-llm-call-codegen.test.ts` — codegen proof for an entity extending `LlmCallBase`.
- `fixtures/conformance/ai-llm-call-extends/input/meta.ai.yaml` — copy of the library model (the fixture is self-contained).
- `fixtures/conformance/ai-llm-call-extends/input/meta.app.yaml` — an app entity (`ApiCall`) extending `LlmCallBase`.
- `fixtures/conformance/ai-llm-call-extends/expected.json` — canonical serialized output.

**Modify:**
- `server/typescript/packages/metadata/src/loader/meta-data-loader.ts` — add an opt-in `libraries?: string[]` option to `fromDirectory`/`load` that prepends `librarySources(...)`.
- `server/typescript/packages/metadata/src/index.ts` (or the package's public export barrel) — export `librarySources` and the new option type.
- `.github/workflows/conformance.yml` — add an embedded-library drift check (mirrors `doc-template-drift`).

---

## Task 1: Canonical `library/ai/llm-call.yaml`

**Files:**
- Create: `library/ai/llm-call.yaml`

- [ ] **Step 1: Write the canonical library metadata**

```yaml
# library/ai/llm-call.yaml
# MetaObjects-shipped standard metadata. Adopters opt in via the loader's
# `libraries: ["ai"]` option, then `extends: "metaobjects::ai::LlmCallBase"`.
package: metaobjects::ai
objects:
  - object.entity:
      name: LlmCallBase
      abstract: true
      children:
        - field.uuid:      { name: traceId }
        - field.uuid:      { name: spanId }
        - field.uuid:      { name: parentSpanId }
        - field.string:    { name: sessionId }
        - field.string:    { name: callType }
        - field.string:    { name: system }
        - field.string:    { name: requestModel }
        - field.string:    { name: responseModel }
        - field.int:       { name: inputTokens }
        - field.int:       { name: outputTokens }
        - field.currency:  { name: costMinor, currency: USD }
        - field.int:       { name: latencyMs }
        - field.string:    { name: finishReason }
        - field.string:    { name: status }
        - field.string:    { name: errorDetail }
        - field.string:    { name: startedAt }
        - field.string:    { name: llmRequest,  dbColumnType: jsonb }   # generic jsonb (no objectRef)
        - field.string:    { name: llmResponse, dbColumnType: jsonb }
  - object.entity:
      name: LlmCall
      extends: metaobjects::ai::LlmCallBase
      children:
        - source.rdb: { table: llm_call, role: primary }
```

Notes for the implementer:
- `startedAt` is a `field.string` (the codebase carries timestamps as ISO-8601
  strings on the wire; `field.timestamp` is also acceptable and maps to a
  `timestamp({mode:"string"})` column — either is fine, but keep it consistent
  with the fixture in Task 6).
- `llmRequest`/`llmResponse` MUST be `field.string` + `dbColumnType: jsonb`, NOT
  `field.object`, because the loader rejects `@storage` without `@objectRef`.

- [ ] **Step 2: Verify it loads without errors**

Run:
```bash
cd server/typescript/packages/metadata
bun -e 'import {MetaDataLoader} from "./src/index.ts"; const r = await MetaDataLoader.fromDirectory("../../../../library/ai"); console.log("errors:", r.errors.length, "warnings:", r.warnings.length); if(r.errors.length) console.log(JSON.stringify(r.errors,null,2));'
```
Expected: `errors: 0 warnings: 0`. If `ERR_STORAGE_WITHOUT_OBJECT_REF` appears, a jsonb field is wrongly modeled as `field.object` — fix to `field.string` + `dbColumnType: jsonb`.

- [ ] **Step 3: Commit**

```bash
git add library/ai/llm-call.yaml
git commit -m "feat(ai): canonical library/ai/llm-call.yaml (LlmCallBase + LlmCall)"
```

---

## Task 2: Embedded-library generator + generated module

**Files:**
- Create: `scripts/generate-embedded-library.ts`
- Create: `server/typescript/packages/metadata/src/library/embedded-library.generated.ts` (produced by the script)
- Reference: `scripts/generate-embedded-templates.ts` (the pattern to mirror)

- [ ] **Step 1: Write the generator script**

```typescript
// scripts/generate-embedded-library.ts
// Reads canonical library/**/*.yaml and emits a plain TS string module embedding
// each file by its ref (path under library/ without extension). Mirrors
// scripts/generate-embedded-templates.ts. Run: bun run scripts/generate-embedded-library.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const libDir = join(repoRoot, "library");
const outFile = join(
  repoRoot,
  "server/typescript/packages/metadata/src/library/embedded-library.generated.ts",
);

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith(".yaml")) out.push(p);
  }
  return out;
}

const entries = collect(libDir)
  .map((abs) => {
    // ref = path under library/ WITHOUT the .yaml suffix, e.g. "ai/llm-call".
    const ref = relative(libDir, abs).replace(/\.yaml$/, "").split("\\").join("/");
    return { ref, content: readFileSync(abs, "utf-8") };
  })
  .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

const body = entries
  .map((e) => `  ${JSON.stringify(e.ref)}: ${JSON.stringify(e.content)},`)
  .join("\n");

const out = `// AUTO-GENERATED by scripts/generate-embedded-library.ts — DO NOT EDIT.
// Canonical source: repo-root library/**/*.yaml
export const EMBEDDED_LIBRARY: Record<string, string> = {
${body}
};
`;
writeFileSync(outFile, out, "utf-8");
console.log(\`wrote \${entries.length} embedded library file(s) to \${relative(repoRoot, outFile)}\`);
```

- [ ] **Step 2: Run the generator**

Run:
```bash
cd <repo-root>   # the metaobjects repo root
bun run scripts/generate-embedded-library.ts
```
Expected: `wrote 1 embedded library file(s) to server/typescript/packages/metadata/src/library/embedded-library.generated.ts`

- [ ] **Step 3: Verify the generated module exports the ref**

Run:
```bash
cd server/typescript/packages/metadata
bun -e 'import {EMBEDDED_LIBRARY} from "./src/library/embedded-library.generated.ts"; console.log(Object.keys(EMBEDDED_LIBRARY)); console.log(EMBEDDED_LIBRARY["ai/llm-call"]?.includes("LlmCallBase"));'
```
Expected: `[ "ai/llm-call" ]` then `true`.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-embedded-library.ts server/typescript/packages/metadata/src/library/embedded-library.generated.ts
git commit -m "feat(ai): embed library/ metadata as a generated string module"
```

---

## Task 3: 3-way byte-identity gate test

**Files:**
- Create: `server/typescript/packages/metadata/test/embedded-library.test.ts`
- Reference: `server/typescript/packages/codegen-ts/test/embedded-templates.test.ts`

- [ ] **Step 1: Write the failing gate test**

```typescript
// server/typescript/packages/metadata/test/embedded-library.test.ts
import { describe, test, it, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { EMBEDDED_LIBRARY } from "../src/library/embedded-library.generated.ts";

// Walk up until we find a dir containing both library/ and server/.
function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "library")) && existsSync(join(dir, "server"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const root = repoRoot();
const libDir = join(root, "library");

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith(".yaml")) out.push(p);
  }
  return out;
}
const canonical = collect(libDir).map((abs) => ({
  ref: relative(libDir, abs).replace(/\.yaml$/, "").split("\\").join("/"),
  content: readFileSync(abs, "utf-8"),
}));

describe("EMBEDDED_LIBRARY — drift gate", () => {
  for (const { ref, content } of canonical) {
    it(`${ref} is byte-identical to canonical library/${ref}.yaml`, () => {
      expect(EMBEDDED_LIBRARY[ref]).toBeDefined();
      expect(EMBEDDED_LIBRARY[ref]).toBe(content);
    });
  }
});

describe("EMBEDDED_LIBRARY — exact coverage", () => {
  test("keys are exactly the canonical set", () => {
    expect(Object.keys(EMBEDDED_LIBRARY).sort()).toEqual(canonical.map((c) => c.ref).sort());
  });
});
```

- [ ] **Step 2: Run it to verify it passes (generator already ran in Task 2)**

Run:
```bash
cd server/typescript/packages/metadata
bun test test/embedded-library.test.ts
```
Expected: PASS (drift gate + exact coverage green). If it FAILS with a byte mismatch, re-run `bun run scripts/generate-embedded-library.ts` and re-test — the generated module is stale.

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/metadata/test/embedded-library.test.ts
git commit -m "test(ai): 3-way byte-identity gate for embedded library metadata"
```

---

## Task 4: Library-sources resolver (on-disk-first, embedded fallback)

**Files:**
- Create: `server/typescript/packages/metadata/src/library/library-sources.ts`
- Reference: `server/typescript/packages/codegen-ts/src/render-engine/framework-provider.ts` (the on-disk-first + embedded-fallback pattern), `server/typescript/packages/metadata/src/loader/sources/` (the `MetaDataSource`/`FileSource`/string-source shapes)

- [ ] **Step 1: Write the failing test**

```typescript
// add to server/typescript/packages/metadata/test/library-load.test.ts
import { describe, test, expect } from "bun:test";
import { librarySources } from "../src/library/library-sources.ts";

describe("librarySources", () => {
  test("returns a source for the ai package", async () => {
    const sources = librarySources(["ai"]);
    expect(sources.length).toBe(1);
    const content = await sources[0]!.read();
    expect(content.text).toContain("LlmCallBase");
  });

  test("unknown package yields no sources", () => {
    expect(librarySources(["does-not-exist"]).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
cd server/typescript/packages/metadata
bun test test/library-load.test.ts -t librarySources
```
Expected: FAIL — `Cannot find module ".../library-sources.ts"`.

- [ ] **Step 3: Implement the resolver**

First confirm the `MetaDataSource` interface and how an in-memory source is constructed (a `FileSource` reads from disk; for the embedded case we need a string-backed source). Inspect:
```bash
cat server/typescript/packages/metadata/src/loader/sources/*.ts | head -120
```
Then implement, matching the actual `MetaDataSource` shape (this is the expected shape — adjust field names to the real interface if they differ):

```typescript
// server/typescript/packages/metadata/src/library/library-sources.ts
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MetaDataSource } from "../loader/sources/index.js";
import { FileSource } from "../loader/sources/index.js";
import { EMBEDDED_LIBRARY } from "./embedded-library.generated.js";

// One ref per shipped library file for a package. Extend as more land.
const REFS_BY_PACKAGE: Record<string, string[]> = {
  ai: ["ai/llm-call"],
};

// Locate repo-root library/ for the on-disk (dev/install) path; undefined in
// the compiled binary (no real fs), where the embedded map is used.
function libraryDirOnDisk(): string | undefined {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "library");
    if (existsSync(join(candidate, "ai", "llm-call.yaml"))) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}

// Minimal string-backed source (mirrors FileSource's MetaDataSource contract).
class EmbeddedSource implements MetaDataSource {
  constructor(private readonly _id: string, private readonly _text: string) {}
  get id(): string { return this._id; }
  async read(): Promise<{ text: string; format: "yaml" }> {
    return { text: this._text, format: "yaml" };
  }
}

export function librarySources(packages: string[]): MetaDataSource[] {
  const dir = libraryDirOnDisk();
  const out: MetaDataSource[] = [];
  for (const pkg of packages) {
    for (const ref of REFS_BY_PACKAGE[pkg] ?? []) {
      if (dir !== undefined) {
        const path = join(dir, `${ref}.yaml`);
        if (existsSync(path)) { out.push(new FileSource(path)); continue; }
      }
      const embedded = EMBEDDED_LIBRARY[ref];
      if (embedded !== undefined) out.push(new EmbeddedSource(`library:${ref}.yaml`, embedded));
    }
  }
  return out;
}
```

Implementer note: the exact `MetaDataSource` interface (the `read()` return shape, whether `id` is a getter or field, and the `FileSource` constructor) MUST be confirmed against `src/loader/sources/` and matched exactly — the loader pipeline (`meta-data-loader.ts` `parseSource`) consumes `source.read()` and `source.id`.

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
cd server/typescript/packages/metadata
bun test test/library-load.test.ts -t librarySources
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/library/library-sources.ts server/typescript/packages/metadata/test/library-load.test.ts
git commit -m "feat(ai): library-sources resolver (on-disk-first, embedded fallback)"
```

---

## Task 5: Opt-in loader `libraries` option

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/meta-data-loader.ts` (the `fromDirectory` factory, ~lines 123-150, and `load`, ~lines 316-509)
- Modify: the package public export (`src/index.ts`) to export `librarySources`
- Test: `server/typescript/packages/metadata/test/library-load.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to server/typescript/packages/metadata/test/library-load.test.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader } from "../src/index.ts";

describe("loader libraries option", () => {
  test("app entity extends a library-shipped abstract base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-libload-"));
    writeFileSync(
      join(dir, "meta.app.yaml"),
      [
        "package: app::ops",
        "objects:",
        "  - object.entity:",
        "      name: ApiCall",
        "      extends: metaobjects::ai::LlmCallBase",
        "      children:",
        "        - source.rdb: { table: api_call, role: primary }",
      ].join("\n"),
    );
    const result = await MetaDataLoader.fromDirectory(dir, { libraries: ["ai"] });
    rmSync(dir, { recursive: true, force: true });

    expect(result.errors).toEqual([]);
    // The extends must resolve to the library base (no unresolved-super error).
    const apiCall = result.root
      .objects()
      .find((o: { name: string }) => o.name === "ApiCall");
    expect(apiCall).toBeDefined();
    // Inherited field is visible on the concrete entity.
    expect(apiCall!.fields().some((f: { name: string }) => f.name === "llmRequest")).toBe(true);
  });

  test("without the libraries option, the same extends is unresolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-libload-no-"));
    writeFileSync(
      join(dir, "meta.app.yaml"),
      [
        "package: app::ops",
        "objects:",
        "  - object.entity:",
        "      name: ApiCall",
        "      extends: metaobjects::ai::LlmCallBase",
        "      children:",
        "        - source.rdb: { table: api_call, role: primary }",
      ].join("\n"),
    );
    const result = await MetaDataLoader.fromDirectory(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(result.errors.length).toBeGreaterThan(0); // unresolved super
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
cd server/typescript/packages/metadata
bun test test/library-load.test.ts -t "libraries option"
```
Expected: FAIL — `fromDirectory` doesn't accept `libraries`; the first test errors on unresolved super.

- [ ] **Step 3: Implement the option**

In `meta-data-loader.ts`, extend the options type used by `fromDirectory` with `libraries?: string[]`, and when present prepend `librarySources(libraries)` to the source list passed to `load(...)`. Library sources go FIRST so they parse before app sources (extends resolution is order-independent, but library-first keeps the merged root deterministic). Sketch:

```typescript
// near the top of meta-data-loader.ts
import { librarySources } from "../library/library-sources.js";

// in the fromDirectory factory (after building the DirectorySource expansion):
static async fromDirectory(dir: string, opts?: LoaderOptions & { libraries?: string[] }): Promise<LoadResult> {
  const loader = new MetaDataLoader(opts);
  const dirSources = await new DirectorySource(dir, opts).expand();
  const libs = opts?.libraries?.length ? librarySources(opts.libraries) : [];
  return loader.load([...libs, ...dirSources]);
}
```

Match the real factory signature/return shape exactly (confirm `LoaderOptions` name and the `load` return type from the current file). Export `librarySources` from `src/index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
cd server/typescript/packages/metadata
bun test test/library-load.test.ts
```
Expected: PASS (all four tests in the file).

- [ ] **Step 5: Run the full metadata suite (no regressions)**

Run:
```bash
cd server/typescript/packages/metadata
bun test
```
Expected: PASS (existing suite unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/loader/meta-data-loader.ts server/typescript/packages/metadata/src/index.ts server/typescript/packages/metadata/test/library-load.test.ts
git commit -m "feat(ai): opt-in loader libraries option prepends shipped library metadata"
```

---

## Task 6: Cross-port conformance fixture

**Files:**
- Create: `fixtures/conformance/ai-llm-call-extends/input/meta.ai.yaml`
- Create: `fixtures/conformance/ai-llm-call-extends/input/meta.app.yaml`
- Create: `fixtures/conformance/ai-llm-call-extends/expected.json`
- Reference: `fixtures/conformance/extends-cross-file/`, `spec/conformance-tests.md`

The fixture is self-contained (it carries its own copy of the AI model in
`input/`, loaded as ordinary files — this validates the MODEL semantics
cross-port without depending on each port's library-load mechanism, which is
piloted in TS here and ported later).

- [ ] **Step 1: Add the AI model input file**

```yaml
# fixtures/conformance/ai-llm-call-extends/input/meta.ai.yaml
package: metaobjects::ai
objects:
  - object.entity:
      name: LlmCallBase
      abstract: true
      children:
        - field.uuid:   { name: traceId }
        - field.string: { name: callType }
        - field.int:    { name: inputTokens }
        - field.currency: { name: costMinor, currency: USD }
        - field.string: { name: status }
        - field.string: { name: llmRequest,  dbColumnType: jsonb }
        - field.string: { name: llmResponse, dbColumnType: jsonb }
  - object.entity:
      name: LlmCall
      extends: metaobjects::ai::LlmCallBase
      children:
        - source.rdb: { table: llm_call, role: primary }
```

(Trimmed envelope vs. Task 1 — a fixture only needs enough fields to exercise
extends + jsonb + currency + source.rdb canonical serialization.)

- [ ] **Step 2: Add the app input file (extends the base)**

```yaml
# fixtures/conformance/ai-llm-call-extends/input/meta.app.yaml
package: app::ops
objects:
  - object.entity:
      name: ApiCall
      extends: metaobjects::ai::LlmCallBase
      children:
        - source.rdb: { table: api_call, role: primary }
```

- [ ] **Step 3: Generate the expected canonical output**

Create an empty placeholder then let the runner produce the diff:
```bash
mkdir -p fixtures/conformance/ai-llm-call-extends
printf '{}' > fixtures/conformance/ai-llm-call-extends/expected.json
cd server/typescript/packages/metadata
bun test test/conformance.test.ts -t "ai-llm-call-extends"
```
Expected: FAIL with an actual-vs-expected diff. Copy the **actual** canonical
serialization into `expected.json` (preserve 2-space indent + trailing newline;
follow the body-key order documented in `spec/conformance-tests.md`:
`name, package, extends, abstract, overlay, isArray, @-attrs (alpha), children`).

- [ ] **Step 4: Run to verify the fixture passes**

Run:
```bash
cd server/typescript/packages/metadata
bun test test/conformance.test.ts -t "ai-llm-call-extends"
```
Expected: PASS (both `lint: ai-llm-call-extends` and `conformance: ai-llm-call-extends`).

- [ ] **Step 5: Commit**

```bash
git add fixtures/conformance/ai-llm-call-extends/
git commit -m "test(ai): cross-port conformance fixture for LlmCall extends"
```

---

## Task 7: Codegen proof — entity extending `LlmCallBase` emits a table

**Files:**
- Create: `server/typescript/packages/codegen-ts/test/ai-llm-call-codegen.test.ts`
- Reference: `server/typescript/packages/codegen-ts/test/run-gen.test.ts` (the `runGen` + temp-dir + `expect(content).toContain(...)` pattern), `src/column-mapper.ts` (jsonb mapping)

No codegen source changes are expected — this task proves the existing entity
path handles the new shape, and locks it with a test.

- [ ] **Step 1: Write the failing test**

```typescript
// server/typescript/packages/codegen-ts/test/ai-llm-call-codegen.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile, queriesFile, barrel } from "../src/generators/index.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "ai-codegen-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const MODEL = [
  "package: app::ops",
  "objects:",
  "  - object.entity:",
  "      name: LlmCallBase",
  "      abstract: true",
  "      children:",
  "        - field.uuid:   { name: traceId }",
  "        - field.string: { name: callType }",
  "        - field.int:    { name: inputTokens }",
  "        - field.currency: { name: costMinor, currency: USD }",
  "        - field.string: { name: llmRequest, dbColumnType: jsonb }",
  "  - object.entity:",
  "      name: ApiCall",
  "      extends: LlmCallBase",
  "      children:",
  "        - source.rdb: { table: api_call, role: primary }",
].join("\n");

describe("ai LlmCall codegen", () => {
  test("concrete entity extending an abstract base emits a table with inherited jsonb column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-model-"));
    writeFileSync(join(dir, "meta.app.yaml"), MODEL);
    const loaded = await MetaDataLoader.fromDirectory(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(loaded.errors).toEqual([]);

    const out = await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "~/server/db",
        dialect: "postgres",
        generators: [entityFile(), queriesFile(), barrel()],
      }),
      metadata: loaded.root,
    });
    expect(out.warnings).toEqual([]);

    const files = readdirSync(tmp);
    expect(files).toContain("ApiCall.ts");          // concrete → emitted
    expect(files).not.toContain("LlmCallBase.ts");  // abstract → no table file
    const apiCall = readFileSync(join(tmp, "ApiCall.ts"), "utf-8");
    expect(apiCall).toContain("api_call");          // table name
    expect(apiCall).toContain("jsonb");             // inherited llmRequest → jsonb column
    expect(apiCall).toContain("traceId");           // inherited uuid column
  });
});
```

- [ ] **Step 2: Run the test**

Run:
```bash
cd server/typescript/packages/codegen-ts
bun test test/ai-llm-call-codegen.test.ts
```
Expected: PASS. If `jsonb` is absent, confirm the dialect is `postgres` (jsonb is PG-only) and that `field.string` + `dbColumnType: jsonb` maps via `pgColumnTypeOverride` in `src/column-mapper.ts`. If abstract emission differs (e.g. a value-object shape file appears), adjust the assertion to the real abstract behavior in `src/templates/entity-file.ts` — do not change source to satisfy the test unless a real defect is found.

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/codegen-ts/test/ai-llm-call-codegen.test.ts
git commit -m "test(ai): codegen emits table+repo for an entity extending LlmCallBase"
```

---

## Task 8: CI drift gate for the embedded library

**Files:**
- Modify: `.github/workflows/conformance.yml` (add a job/step mirroring `doc-template-drift`, ~lines 137-151)

- [ ] **Step 1: Add the drift-check step**

Add a step that regenerates the embedded module and fails on a stale diff:

```yaml
  embedded-library-drift:
    needs: fixture-lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Regenerate embedded library metadata from canonical
        run: bun run scripts/generate-embedded-library.ts
      - name: Fail if the embedded library module is stale
        run: git diff --exit-code -- server/typescript/packages/metadata/src/library/embedded-library.generated.ts
```

- [ ] **Step 2: Validate the workflow locally (syntax)**

Run:
```bash
bun run scripts/generate-embedded-library.ts
git diff --exit-code -- server/typescript/packages/metadata/src/library/embedded-library.generated.ts && echo "no drift"
```
Expected: `no drift` (the module already matches canonical from Task 2).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/conformance.yml
git commit -m "ci(ai): drift gate for embedded library metadata"
```

---

## Task 9: Full-suite verification + spec correction note

**Files:**
- Modify: `docs/superpowers/specs/2026-06-02-ai-llm-call-trace-persistence-design.md` (§4.1 jsonb-field correction)

- [ ] **Step 1: Run the relevant suites**

Run:
```bash
cd server/typescript/packages/metadata && bun test
cd ../codegen-ts && bun test
```
Expected: PASS in both (no regressions; new tests green).

- [ ] **Step 2: Correct the spec's jsonb-field idiom**

In §4.1, change the generic jsonb fields from `field.object { ... storage: jsonb }`
(invalid without `@objectRef`) to `field.string { ... dbColumnType: jsonb }`, and
add a one-line note: "Generic (untyped) jsonb columns use `field.string` +
`@dbColumnType: jsonb`; `field.object` + `@storage: jsonb` is only valid WITH an
`@objectRef` (loader rule `ERR_STORAGE_WITHOUT_OBJECT_REF`)." Leave the typed
`voRequest`/`voResponse` discussion (#1b) noting they gain `@objectRef` when
prompt-derived.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-02-ai-llm-call-trace-persistence-design.md
git commit -m "docs(ai): correct generic-jsonb field idiom (field.string + dbColumnType)"
```

---

## Self-Review

**Spec coverage (spec §2 "in scope" for #1):**
- `library/` area + `llm-call.yaml` → Task 1; `library/templates/` move and `template.*` relocation are out of #1 (spec §10 structural task) — correctly excluded.
- Loader library-load → Tasks 4–5.
- Codegen for concretes (forms 1 & 2) → Task 7 (form 1 generic; form 2 with `@objectRef` is the same path with an objectRef present — covered by the existing `field.object` jsonb mapping, no new work).
- Cross-port conformance fixture → Task 6.
- Shipping mechanism / byte-identity gate (spec §3.4) → Tasks 2, 3, 8.
- `PromptLlmCallBase`/`prompt-llm-call.yaml`, prompt-derivation, STI, runtime → **#1b/#2/#3**, correctly excluded.

**Placeholder scan:** No TBD/TODO. The two "confirm the exact interface" notes (Task 4 `MetaDataSource`, Task 5 factory signature) are explicit verification steps with the file to read, not hand-waves — the real interface must be matched, and the surrounding code is given.

**Type consistency:** `librarySources(packages: string[]): MetaDataSource[]` is defined in Task 4 and consumed identically in Task 5. `EMBEDDED_LIBRARY: Record<string,string>` defined in Task 2, consumed in Tasks 3–4. The ref `"ai/llm-call"` is consistent across Tasks 2–4. Loader option `libraries?: string[]` consistent in Task 5 test + impl.

**Known risk to verify during execution:** the exact `MetaDataSource` contract (`read()` return shape, `id`) — Task 4 Step 3 reads `src/loader/sources/` first and matches it. If the real source interface differs from the `{text, format}` sketch, adjust `EmbeddedSource` accordingly; the loader's `parseSource` is the consumer of record.

---

## Follow-on plans (not in this plan)

- **Per-port library-load** (Java/Python/C#/Kotlin): port Tasks 2–5 + run the Task 6 fixture in each port's conformance runner (`cross-language-porting` skill).
- **Spec #1b:** `prompt-llm-call.yaml` (`PromptLlmCallBase`), nested/standalone-prompt collection in the loader, prompt-derived `voRequest`/`voResponse` typing, STI (multiple subtypes → one table), the `recordXxxCall` parse-and-persist half.
- **Spec #2/#3:** `ai-runtime` — `callXxx` full loop, recorder seam (`LlmCallDbRecorder` default + `Composite`/`Null`), cost catalog, Langfuse/OTel optional adapters.
- **Structural task:** move `template.*` out of core `metadata` (output → `render`, prompt/toolcall → `ai-prompt`); move `templates/` → `library/templates/`.

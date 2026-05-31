# Cross-Port Extractor Codegen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated, idiomatic `<Name>Extractor` to TS, Python, C#, and Kotlin that recovers dirty LLM text into the port's **strict typed payload** (nested objects + arrays-of-objects populated), reaching capability parity with the just-shipped Java work.

**Architecture:** Each port already emits a self-contained tolerant `recover<Name>(text) → RecoveryResult<<Name>Recovered>` (baked `RecoverSchema`, no runtime loader) and a strict `parse<Name>(text) → <Name>Payload`. The Extractor adds a third tier — **`extract`** — that runs `recover`, throws if `report.hasLostRequired()`, and otherwise maps the all-nullable `<Name>Recovered` mirror onto the **strict** payload type via a generated recursive mirror→strict mapper (recursing nested/arrays, one-shot constructing immutable types). No registry, no binding provider, no factory — codegen knows the whole type graph statically. `recover` is re-exposed unchanged.

**Tech Stack:** Per-port codegen (TS ts-poet, Python str templates + ruff, C# string emit + Roslyn tests, Kotlin KotlinPoet) + each port's existing recover engine + `RecoverSchema`/`FieldSpec` types. Spec: `docs/superpowers/specs/2026-05-31-cross-port-extractor-codegen-design.md`. Builds on Phase A/B + FR-010/FR-011.

---

## Scope, worktree & conventions

- Worktree (already created): `worktree-cross-port-flavored-objects` at `<repo-root>/.claude/worktrees/cross-port-flavored-objects`, branch `worktree-cross-port-flavored-objects`, off `origin/main`. Absolute paths only; never `git checkout` SHAs; confirm branch before commit. Single branch → single merge.
- **Scope = `template.output` payloads** (where `recover`/`parse`/the `<Name>Recovered` mirror + the strict payload type already exist in all four ports). This is the prompt-pillar extraction use case. Arbitrary-entity extraction is an explicit follow-up, not this plan.
- **Three-tier API per template.output:** `parse<Name>` (strict, throws on any malformation) · **`extract<Name>` (tolerant recovery → strict typed payload, throws only on lost-required)** · `recover<Name>` (never-throws, nullable mirror). The Extractor adds `extract` + idiomatic packaging; `recover`/`parse` are unchanged.
- **Names stay `extract`/`recover`.** The queued cross-port `recover → extract` rename (#87) sweeps all five ports afterward.
- **Gold-standard gate:** each port's task ships a compile-and-run proof (generate → compile/import → run `extract` on dirty input with a nested object + a 2-element array-of-objects → assert the strict typed graph is populated; run `extract` on lost-required input → assert it throws; run `recover` → assert never-throws result). Plus the cross-port value-oracle cross-check in the closeout.
- **No registry / binding-provider / factory** anywhere. **No new flavored object-class generation.** (Out of scope per the spec.)

## The mirror→strict mapping (the one new idea, shared shape)

Given the existing all-nullable `<Name>Recovered` mirror (every field `T?`/`T|null`, nested as `<Nested>Recovered?`, arrays as `(<Item>Recovered?)[]?`) and the existing strict payload type `<Name>Payload` (required fields non-null, optional nullable, nested as `<Nested>Payload`, arrays as `<Item>Payload[]`), `extract` does:

```
extract(text):
  result = recover(text)                        # existing, never-throws
  if result.report.hasLostRequired():           # existing report API
      throw ExtractException(result.report)     # message lists lostRequired()
  return toStrict_<Name>(result.data)           # generated recursive mapper, one-shot construct

toStrict_<Name>(m: <Name>Recovered) -> <Name>Payload:
  # construct the strict payload in ONE shot from the mirror's values:
  #   scalar/enum field      -> m.field            (required: assert non-null per hasLostRequired)
  #   single nested object   -> toStrict_<Nested>(m.nested)   (or null if optional & null)
  #   array-of-objects       -> m.items.map(toStrict_<Item>)  (or [] / null per optionality)
```

The mapper is generated for the whole statically-known type graph (one `toStrict_*` per nested type), reusing the same nested-type discovery the existing recover-schema/payload emitters already do. There is no runtime metadata lookup — the recover engine already did the metadata traversal via the baked `RecoverSchema`.

---

## Task 1: TypeScript `<Name>Extractor`

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/templates/extractor.ts` (renderExtractor + the mirror→strict mapper emitter)
- Create: `server/typescript/packages/codegen-ts/src/generators/extractor-file.ts` (the `extractor()` generator factory)
- Modify: `server/typescript/packages/codegen-ts/src/generators/index.ts` (export `extractor`, `ExtractorOpts`)
- Test: `server/typescript/packages/codegen-ts/test/extractor-codegen.test.ts`

**Reference (study, mirror the structure):** `templates/output-parser.ts`, `templates/recover-schema-emitter.ts` (mirror interface + `RecoverSchema`), `generators/output-parser-file.ts` (factory), `test/fr010-output-codegen.test.ts` (compile-and-run via dynamic `import()`). The strict payload interface comes from `payload-codegen.ts` (`<Name>Payload`). `RecoveryResult<T>` is `{ data: T|null; report: RecoveryReport }` with `report.hasLostRequired()` / `report.lostRequired()` (`render/src/recover/types.ts`).

- [ ] **Step 1: Write the failing compile-and-run test.**

```ts
// extractor-codegen.test.ts — mirrors fr010-output-codegen.test.ts harness
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadRoot } from "./helpers"; // same helper fr010 test uses to build a MetaRoot
import { renderExtractor } from "../src/templates/extractor.js";
import { renderOutputParser } from "../src/templates/output-parser.js";
import { renderPayloads } from "../src/payload-codegen.js"; // emits <Name>Payload + nested

// Model: template.output "Order" with payload {customer: Customer (nested obj, required),
// lines: Line[] (array-of-objects, required), note: string (optional)}.
const MODEL = /* canonical JSON: Order template.output + Customer + Line value objects */;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("extractOrder recovers dirty JSON into the strict Order payload (nested + array populated)", async () => {
  const root = await loadRoot(MODEL);
  const src = renderExtractor(root, "Order");
  // source-shape assertions
  expect(src).toContain("export function extractOrder(");
  expect(src).toContain(": OrderPayload");        // returns the STRICT type
  expect(src).toContain("hasLostRequired()");

  const dir = mkdtempSync(join(import.meta.dir, "extract-emit-")); dirs.push(dir);
  writeFileSync(join(dir, "payloads.ts"), renderPayloads(root, "Order"));
  writeFileSync(join(dir, "Order.output.ts"), renderOutputParser(root, "Order"));
  writeFileSync(join(dir, "Order.extractor.ts"), src);
  const mod = await import(join(dir, "Order.extractor.ts"));

  const dirty = 'Sure! ```json\n{ "customer": { "name": "Ada" }, "lines": [ {"sku":"A","qty":2}, {"sku":"B","qty":1} ], }\n```';
  const order = mod.extractOrder(dirty);
  expect(order.customer.name).toBe("Ada");        // nested populated, typed
  expect(order.lines).toHaveLength(2);            // array-of-objects populated
  expect(order.lines[0].sku).toBe("A");

  // lost-required -> throws
  expect(() => mod.extractOrder('{ "lines": [] }')).toThrow();
  // recover never-throws
  const r = mod.recoverOrder('{ "customer": {"name":"Ada"}, "lines": [{"sku":"A","qty":2}] }');
  expect(r.report.hasLostRequired()).toBe(false);
});
```

- [ ] **Step 2: Run → FAIL.** `cd server/typescript && bun test packages/codegen-ts/test/extractor-codegen.test.ts` → fails (`renderExtractor` missing).

- [ ] **Step 3: Implement `renderExtractor` + the generator.** `extractor.ts` emits a `<Name>.extractor.ts` module that: re-exports/imports `recover<Name>` from `./<Name>.output.js` and the strict types from `./payloads.js`; emits `export function extract<Name>(text: string): <Name>Payload { const r = recover<Name>(text); if (r.report.hasLostRequired()) throw new Error("extract<Name>: lost required: " + r.report.lostRequired().join(", ")); return toStrict<Name>(r.data!); }`; emits a `toStrict<Type>` function per type in the graph (scalar → `m.field`, single nested → `toStrict<Nested>(m.nested!)` guarded by optionality, array → `m.items!.map((e) => toStrict<Item>(e!))`); re-exports `recover<Name>`. `extractor-file.ts` is a `oncePerRun` generator (mirror `output-parser-file.ts`) emitting `<Name>.extractor.ts` per `template.output`. Export from `generators/index.ts`.

- [ ] **Step 4: Run → PASS** + `cd server/typescript && bun test packages/codegen-ts` (package green, no regression).
- [ ] **Step 5: Commit** (`feat(codegen-ts): <Name>Extractor — tolerant extract into strict payload (nested + arrays)`).

---

## Task 2: Python `<Name>Extractor`

**Files:**
- Create: `server/python/src/metaobjects/codegen/generators/extractor_generator.py` (`ExtractorGenerator` + `extractor_generator()` factory + the mapper emitter)
- Modify: the codegen generator barrel/exports if generators are re-exported (check `server/python/src/metaobjects/codegen/__init__.py` / `generators/__init__.py`)
- Test: `server/python/tests/codegen/test_extractor_generator.py`

**Reference:** `generators/output_parser_generator.py` (`render_output_parser`, `recover_<snake>`, the `RecoveryResult`), `recover_schema_emitter.py` (`<Name>Recovered` dataclass), `generators/payload_vo_generator.py` (`<Name>Payload` Pydantic, **mutable**, nested in same file). Generator protocol in `codegen/generator.py`. Test harness: `tests/codegen/test_output_parser_generator.py` (materialize package on disk → import → invoke). `RecoveryResult` fields: `.data`, `.report`; `report.has_lost_required()` / `report.lost_required()`.

- [ ] **Step 1: Write the failing compile-and-run test.**

```python
# test_extractor_generator.py — mirrors test_output_parser_generator.py harness
import json, pytest
from metaobjects.codegen.generators.extractor_generator import ExtractorGenerator
from metaobjects.codegen.generators.output_parser_generator import OutputParserGenerator
from metaobjects.codegen.generators.payload_vo_generator import PayloadVoGenerator
# reuse _order_root / _ctx / _materialize_package / _import_package helpers (copy from the parser test)

def test_extract_recovers_dirty_into_strict_payload(tmp_path, monkeypatch):
    root = _order_root()  # template.output Order {customer: Customer (req), lines: Line[] (req), note: str?}
    files = (ExtractorGenerator().generate(_ctx(root))
             + OutputParserGenerator().generate(_ctx(root))
             + PayloadVoGenerator().generate(_ctx(root)))
    pkg_dir, _ = _materialize_package(files, tmp_path)
    _import_package(pkg_dir, monkeypatch)
    ex = __import__("_gen_pkg.order_extractor", fromlist=["extract_order"])

    dirty = 'ok! ```json\n{ "customer": {"name":"Ada"}, "lines": [{"sku":"A","qty":2},{"sku":"B","qty":1}], }\n```'
    order = ex.extract_order(dirty)
    assert order.customer.name == "Ada"          # nested populated, typed Pydantic
    assert len(order.lines) == 2                 # array-of-objects populated
    assert order.lines[0].sku == "A"

    with pytest.raises(Exception):               # lost-required -> raises
        ex.extract_order('{ "lines": [] }')

def test_recover_never_raises(tmp_path, monkeypatch):
    # ... materialize + import the parser module; recover_order(garbage) returns a result, no raise
```

- [ ] **Step 2: Run → FAIL.** `cd server/python && pytest tests/codegen/test_extractor_generator.py -v` → import error (`extractor_generator` missing).

- [ ] **Step 3: Implement `ExtractorGenerator`.** `render_extractor(template, root) -> str | None` emits `<snake>_extractor.py`: imports `recover_<snake>` from `.<snake>_output_parser` and the strict `<Name>Payload` (+ nested) from `.<snake>_payload`; emits `def extract_<snake>(text: str) -> <Name>Payload: r = recover_<snake>(text); if r.report.has_lost_required(): raise ValueError(f"extract_<snake>: lost required: {', '.join(r.report.lost_required())}"); return _to_strict_<Name>(r.data)`; emits a `_to_strict_<Type>(m) -> <Type>Payload` per type (scalar → `m.field`; single nested → `_to_strict_<Nested>(m.nested)` (None-guard if optional); array → `[_to_strict_<Item>(e) for e in (m.items or [])]`); constructs the Pydantic payload one-shot via `<Name>Payload(field=..., nested=..., items=[...])`. `ExtractorGenerator.generate` mirrors `OutputParserGenerator.generate` (iterate `template.output`, `ruff_format`, `EmittedFile`). Add `extractor_generator()` factory + export.

- [ ] **Step 4: Run → PASS** + `cd server/python && pytest tests/codegen -q` (no regression).
- [ ] **Step 5: Commit** (`feat(codegen-python): <Name>Extractor — tolerant extract into strict Pydantic payload`).

---

## Task 3: C# `<Name>Extractor`

**Files:**
- Create: `server/csharp/MetaObjects.Codegen/Generators/ExtractorGenerator.cs` (`IGenerator`, emits `<Name>Extractor.cs`, + the mapper emitter)
- Create: `server/csharp/MetaObjects.Render/Recover/ExtractException.cs` (thrown on lost-required) — OR reuse an existing recover exception if present (check `MetaObjects.Render/Recover/`)
- Test: `server/csharp/MetaObjects.Codegen.Tests/ExtractorCodegenTests.cs`

**Reference:** `Generators/OutputParserGenerator.cs` (`Recover` emit, the `<Name>Recovered` sealed record), `Generators/RecoverSchemaEmitter.cs`, `PayloadCodegen.cs` (`<Name>` strict `sealed record` with `required init` — **immutable, one-shot `new T { ... }`**), `Generator.cs` (`IGenerator`/`PerEntityGenerator`/`GenContext`), `MetaObjects.Codegen.Tests/Fr010NestedRecoverCodegenTests.cs` (Roslyn in-memory compile + reflection — the compile-and-run template). `RecoveryResult<T>` has `Data` + `Report`; `Report.HasLostRequired()` / `Report.LostRequired()`.

- [ ] **Step 1: Write the failing compile-and-run test.** Mirror `Fr010NestedRecoverCodegenTests`: generate `<Name>Extractor.cs` + parser + payload sources; Roslyn `CSharpCompilation.Emit` to in-memory assembly; reflectively invoke `OrderExtractor.Extract(dirty)`:

```csharp
[Fact]
public void Extract_RecoversDirtyIntoStrictPayload_NestedAndArrayPopulated() {
    var root = OrderRoot(); // template.output Order {Customer (req), Lines: Line[] (req), Note: string?}
    var srcs = new ExtractorGenerator().Generate(Ctx(root)).Select(f => f.Content)
        .Concat(new OutputParserGenerator().Generate(Ctx(root)).Select(f => f.Content))
        .Concat(PayloadSources(root)).ToArray();
    var asm = CompileInMemory(srcs); // same Roslyn helper Fr010 test uses
    var ext = asm.GetType("Acme.Generated.OrderExtractor")!;
    var extract = ext.GetMethod("Extract", new[] { typeof(string) })!;

    var dirty = "ok ```json\n{ \"customer\": {\"name\":\"Ada\"}, \"lines\":[{\"sku\":\"A\",\"qty\":2},{\"sku\":\"B\",\"qty\":1}], }\n```";
    var order = extract.Invoke(null, new object[] { dirty })!;
    // reflectively read Customer.Name == "Ada"; Lines.Count == 2; Lines[0].Sku == "A"
    Assert.Equal("Ada", Prop(Prop(order, "Customer"), "Name"));
    Assert.Equal(2, ((System.Collections.ICollection)Prop(order, "Lines")!).Count);

    var lost = "{ \"lines\": [] }";
    var ex = Assert.Throws<TargetInvocationException>(() => extract.Invoke(null, new object[] { lost }));
    Assert.IsType<ExtractException>(ex.InnerException); // lost-required throws
}
```

- [ ] **Step 2: Run → FAIL.** `cd server/csharp && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --filter ExtractorCodegen` → fails (no `ExtractorGenerator`).

- [ ] **Step 3: Implement `ExtractorGenerator` + `ExtractException`.** Emits `public static class <Name>Extractor`: `public static <Name> Extract(string text) { var r = <Name>OutputParser.Recover(text); if (r.Report.HasLostRequired()) throw new ExtractException(r.Report); return ToStrict(r.Data!); }` (+ `Extract(string, RecoverOptions)` overload); a `private static <Type> ToStrict<Type>(<Type>Recovered m)` per type — one-shot object initializer `new <Type> { Field = m.Field!, Nested = ToStrict(m.Nested!), Lines = m.Lines!.Select(e => ToStrict(e!)).ToList() }`; re-expose `Recover` by delegating to the parser. `ExtractException(RecoveryReport report)` carries the report; message lists `LostRequired()`. Generator mirrors `OutputParserGenerator` (filter `template.output`, one `EmittedFile` per template).

- [ ] **Step 4: Run → PASS** + `cd server/csharp && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj` (no regression).
- [ ] **Step 5: Commit** (`feat(codegen-csharp): <Name>Extractor — tolerant extract into strict record payload`).

---

## Task 4: Kotlin `<Name>Extractor`

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExtractorGenerator.kt` (`MultiFileDirectGeneratorBase<MetaObject>`, emits `<Name>Extractor` object via KotlinPoet, + the mapper emitter)
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinExtractorCompilesTest.kt`

**Reference:** `KotlinOutputParserGenerator.kt` (`recover` fn, the `<Name>Recovered` data class, calls into the shared JVM `com.metaobjects.render.recover.Recover`), `KotlinRecoverSchemaEmitter.kt`, `KotlinPayloadGenerator.kt` (`@Serializable data class <Name>Payload` — **immutable `val`, one-shot primary ctor**, nested recursive emit), `KotlinOutputCompilesTest.kt` (`kotlin-compile-testing` in-process compile + reflective invoke — the compile-and-run template). `RecoveryResult<T>` (Java record) has `.data` / `.report`; `report.hasLostRequired()` / `report.lostRequired()`.

- [ ] **Step 1: Write the failing compile-and-run test.** Mirror `KotlinOutputCompilesTest`: run `KotlinPayloadGenerator` + `KotlinOutputParserGenerator` + `KotlinExtractorGenerator` into a temp dir, compile all with `KotlinCompilation` (`inheritClassPath = true`), reflectively invoke `OrderExtractor.extract(dirty)`:

```kotlin
@Test fun `extract recovers dirty into strict payload — nested and array populated`() {
    val loader = orderLoader() // template.output Order {customer: Customer (req), lines: List<Line> (req), note: String?}
    listOf(KotlinPayloadGenerator(), KotlinOutputParserGenerator(), KotlinExtractorGenerator())
        .forEach { it.setArgs(mapOf("outputDir" to outDir.toString())); it.execute(loader) }
    val result = KotlinCompilation().apply { sources = collectKt(outDir); inheritClassPath = true }.compile()
    assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode)
    val cl = result.classLoader
    val ext = cl.loadClass("acme.ai.prompts.OrderExtractor")
    val inst = ext.getDeclaredField("INSTANCE").get(null)
    val extract = ext.getDeclaredMethod("extract", String::class.java)

    val dirty = "ok ```json\n{ \"customer\": {\"name\":\"Ada\"}, \"lines\":[{\"sku\":\"A\",\"qty\":2},{\"sku\":\"B\",\"qty\":1}], }\n```"
    val order = extract.invoke(inst, dirty)
    assertEquals("Ada", prop(prop(order, "customer"), "name"))
    assertEquals(2, (prop(order, "lines") as List<*>).size)
    assertFailsWith<java.lang.reflect.InvocationTargetException> { extract.invoke(inst, "{ \"lines\": [] }") } // lost-required
}
```

- [ ] **Step 2: Run → FAIL.** `cd server/java && mvn -q -pl codegen-kotlin test -Dtest=KotlinExtractorCompilesTest -DfailIfNoTests=false` → fails (no generator).

- [ ] **Step 3: Implement `KotlinExtractorGenerator`.** Emits an `object <Name>Extractor` (KotlinPoet `TypeSpec.objectBuilder`): `fun extract(text: String): <Name>Payload { val r = <Name>Parser.recover(text); if (r.report.hasLostRequired()) throw ExtractException(r.report); return toStrict(r.data!!) }`; a private `toStrict(m: <Type>Recovered): <Type>Payload` per type — one-shot primary-ctor `<Type>Payload(field = m.field!!, nested = toStrict(m.nested!!), lines = m.lines!!.map { toStrict(it!!) })`; re-expose `recover` by delegating to the parser object. Use the shared JVM `RecoveryResult`/report. Mirror `KotlinPayloadGenerator`'s `MultiFileDirectGeneratorBase` shape (iterate `template.output`, `FileSpec.writeTo`). Add an `ExtractException` (Kotlin, or reuse a shared one) carrying the report.

- [ ] **Step 4: Run → PASS** + `cd server/java && mvn -q -pl codegen-kotlin test -DfailIfNoTests=false` (no regression). If codegen-kotlin needs fresh render/metadata: `mvn -pl metadata,render install -DskipTests` first.
- [ ] **Step 5: Commit** (`feat(codegen-kotlin): <Name>Extractor — tolerant extract into strict data-class payload`).

---

## Task 5: Cross-port value-oracle cross-check + closeout

**Files:**
- Test/check: reuse `fixtures/recover-conformance/` inputs as the shared value oracle.
- Docs: per-port short note (where the Extractor lives + the three-tier API) + roadmap entry.

- [ ] **Step 1: Value-oracle cross-check.** For one shared `fixtures/recover-conformance/` scenario whose payload has a nested object + array (add a minimal one there only if none exists), assert in each port's extractor test that `extract` produces the **same field values** the corpus expects for `recover` (extract = the clean projection of recover when no required is lost). Confirms cross-port behavioral parity without requiring byte-identical native objects. Run all four ports' extractor tests green.

- [ ] **Step 2: Final whole-branch review.** Dispatch a reviewer over `git diff $(git merge-base origin/main HEAD)..HEAD`: confirm each port reuses its existing `recover` (no duplicated parse/coerce logic); `extract` returns the **strict** payload type and throws on lost-required; the mirror→strict mapper recurses nested + arrays and one-shot-constructs immutable types (C#/Kotlin); **no registry/binding/factory** added anywhere; no new flavored object-class generation; public-repo hygiene (no private names / home paths in committed content, incl. commit messages); each port has a compile-and-run proof. Fix findings.

- [ ] **Step 3: Docs + roadmap.** Add a short "Extractor (extract tier)" note per port where the recover docs live, and a roadmap entry under Shipped: cross-port `<Name>Extractor` (tolerant extract → strict typed payload) shipped in TS/Python/C#/Kotlin, capability parity with Java; names pending the #87 rename.

- [ ] **Step 4: Memory** (controller): update `cross-port-runtime-object-model.md` / add a note that the Extractor capability reached parity in all 5 ports; the #87 rename now sweeps `extract`/`recover` across all five.

- [ ] **Step 5: Merge** forward onto the current `origin/main` tip (fetch; if advanced, merge origin/main into the branch, re-verify, FF-push to main — never rebase/reset/force). Remove the worktree (or keep for the rename follow-on). Publish stays deferred.

---

## Notes for the executor

- **Reuse `recover` wholesale** — `extract` = `recover` + throw-on-lost-required + mirror→strict map. Do NOT re-emit parse/coerce/schema logic; import the existing `recover<Name>` and the strict payload type.
- **`extract` returns the STRICT payload type** (`<Name>Payload` / the record), NOT the `<Name>Recovered` mirror. The mirror is recover's shape.
- **One-shot construct** the strict type (object initializer / primary ctor / `Model(**...)`) — required for C# `record` + Kotlin `data class`; harmless for TS/Python.
- **Compile-and-run is the gate** per port (the recon identified each harness: TS dynamic `import`, Python materialize+import, C# Roslyn, Kotlin `kotlin-compile-testing`).
- **Scope = `template.output` payloads.** Arbitrary-entity extraction is a follow-up.
- **Nested type-graph coverage is already present** for `template.output` payloads — the recon confirmed all four payload generators emit nested types (Python `payload_vo_generator.py` nested-in-same-file; Kotlin `KotlinPayloadGenerator` recursive nested emit; C# `PayloadCodegen` nested `sealed record`; TS `payload-codegen.ts` nested interfaces). So the spec's "close per-port nested type-graph coverage gaps" is a **no-op for this scope**; the mapper imports the already-generated nested types. If an implementer finds a port missing a nested type for the chosen fixture, generate it in that port's payload generator and note it — do NOT silently skip.
- Absolute worktree paths; `mvn install` changed JVM modules before dependents; confirm branch before commit; reference projects stay generic in committed content.
```

# FR-010 Kotlin port — recover + output-format prompt codegen (engine reused)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). This is a PORT — Java (`server/java/codegen-spring/.../generator/spring/`) is the reference; mirror it, change only Tier-2 idiom.

**Goal:** Port FR-010 artifacts to the Kotlin codegen (`codegen-kotlin`): each `template.output` (format json|xml) also gets a tolerant `recover(text[,opts])` and a comment-free `renderFormat([overrides])`, generated as idiomatic Kotlin that **calls the shared JVM `render` engine** (no engine reimplementation).

**Architecture:** Kotlin and Java share the `metaobjects-render` module, so `com.metaobjects.render.recover.*` (Recover/RecoverSchema/FieldSpec/FieldKind/Format/RecoverOptions/RecoverOutcome/RecoveryResult/RecoverMap) and `com.metaobjects.render.prompt.*` (OutputFormatRenderer/OutputFormatSpec/PromptField/PromptStyle/PromptOverrides) are **called, not reimplemented**. Generated Kotlin builds the descriptors as Kotlin source literals (`RecoverSchema(Format.JSON, "Root", listOf(FieldSpec.scalar(...)))`) and delegates to the engine. The FR-010 metamodel attrs (`@enumAlias`/`@promptStyle`/`@example`/`@instruction`/`@enumDoc`) are in the shared `metaobjects-metadata` module → already available to Kotlin codegen, read via the same `MetaField`/`MetaTemplate` API. Because the engine is shared, **recovery classification + rendered output are byte-identical to Java by construction** (Tier-1 invariant satisfied for free); the conformance fixtures (`fixtures/conformance/template-output-{xml,json}-simple/`, `fixtures/recover-conformance/`) remain the oracle.

**Tech stack:** Kotlin 2.0.21, Maven (`metaobjects-codegen-kotlin`), KotlinPoet (payload data classes) + `buildString` (parser/prompt, mirroring `KotlinOutputParserGenerator`'s existing style), JUnit5 + `kotlin.test`. Generated code depends on `metaobjects-render` at runtime (already a transitive dep via `metadata-ktx`).

**Depends on:** full Java FR-010 on `origin/main` (engine + emitter reference + metamodel attrs).

## Tier decisions (cross-language-porting skill)
- **Tier 1 (invariant — unchanged):** recovery classification + report shape (same engine), rendered fragment (same `OutputFormatRenderer`), `@promptStyle`/`@enumAlias`/`@enumDoc` vocabulary, the XML root-tag convention (= payload class name, agreeing with the parser).
- **Tier 2 (idiomatic — Kotlin):** `recover()` returns `RecoveryResult<<Name>Recovered>` where `<Name>Recovered` is an **all-nullable data class** (Kotlin can't construct the non-null-required strict `Payload` from best-effort data without NPE — decided 2026-05-29). Kotlin string-literal escaping; `listOf`/`mapOf` instead of `java.util.List.of`/`Map.ofEntries`. The existing dual-API `parse`/`safeParse` (FR-006) is untouched; `recover` is the additive 3rd tier (never throws, returns the report).
- **Tier 3 (free):** emitter internals; verification mechanism.
- **Bounded deferral (Plan KT.1):** nested-object recover/prompt mapping — same `/* FR-010: nested deferred */` markers as Java.

## Tasks

### KT-T1: `KotlinRecoverSchemaEmitter`
Create `codegen-kotlin/.../generator/kotlin/KotlinRecoverSchemaEmitter.kt` mirroring Java `RecoverSchemaEmitter`. Three functions:
- `schemaLiteral(vo: MetaObject, format: String, rootName: String): String` → Kotlin source: `RecoverSchema(Format.JSON|XML, "Root", listOf(<FieldSpec...>))`. Per field: enum → `FieldSpec.enumField("n", required, listOf("A","B"), mapOf("warm" to "FRIENDLY"))` (alias from `@enumAlias`); scalar → `FieldSpec.scalar("n", FieldKind.X, required)` (kind via the `KotlinTypeMapper`-mirrored instanceof set); ObjectField → `FieldSpec.scalar("n", FieldKind.STRING, required) /* FR-010: nested recover deferred */`.
- `recoveredClassDecl(vo: MetaObject, className: String): String` → `data class <className>(\n  val f: T? = null,\n ...\n)` — ALL fields nullable, types from a nullable KotlinTypeMapper view (String?/Int?/Long?/Double?/Boolean?/List<String>? for arrays; enum→String?; ObjectField→String? deferred).
- `recoveredCtorArgs(vo: MetaObject): String` → `RecoverMap.asString(d, "text"), RecoverMap.asInt(d, "n"), ...` matching the nullable field types (asString for string/enum, asInt/asLong/asDouble/asBool, asStringList for arrays, `null /* nested deferred */` for ObjectField).
- Reuse Java's `isRequired`/`@values`/`@enumAlias` read idioms (same MetaField API). Escape emitted free-text via a `kotlinStringLiteral(...)` helper (alias values are canonical members; alias keys may contain quotes — escape `\`,`"`,newline).
- **Test** `KotlinRecoverSchemaEmitterTest.kt`: load a VO (text:string@required, confidence:enum @values[HIGH,OK,LOW] @enumAlias{medium:OK}@required, note:string) via `loadString`; assert `schemaLiteral` contains the `RecoverSchema(Format.JSON, ...)`, `FieldSpec.enumField("confidence", true, listOf("HIGH", "OK", "LOW"), mapOf("medium" to "OK"))`, `FieldSpec.scalar("text", FieldKind.STRING, true)`; assert `recoveredClassDecl` emits `val text: String? = null` etc.; assert `recoveredCtorArgs` emits `RecoverMap.asString(d, "text")`.

### KT-T2: extend `KotlinOutputParserGenerator` — emit `recover()`
For `template.output` of `@format` json|xml only, after the existing `parse`/`safeParse`, emit (into the same `<Name>Parser.kt` file, OR a sibling — match the file/object the existing generator uses; the existing one emits an `object <Name>Parser`):
- the `data class <Name>Recovered(...)` (from KT-T1 `recoveredClassDecl`; emit at file top-level, not inside the object),
- `private val RECOVER_SCHEMA: RecoverSchema = <schemaLiteral>`,
- `fun recover(text: String): RecoveryResult<<Name>Recovered> = recover(text, RecoverOptions.defaults())`,
- `fun recover(text: String, opts: RecoverOptions): RecoveryResult<<Name>Recovered> { val o = Recover.recover(text, RECOVER_SCHEMA, opts); val d = o.data; return RecoveryResult(<Name>Recovered(<recoveredCtorArgs>), o.report) }`
- Emit the needed imports (`com.metaobjects.render.recover.{Recover,RecoverSchema,FieldSpec,FieldKind,Format,RecoverOptions,RecoveryResult,RecoverMap}`). Note Kotlin accesses Java record components as properties: `o.data`/`o.report` (not `o.data()`), and `RecoveryResult(data, report)` constructor.
- **Test**: extend `KotlinOutputParserGeneratorTest.kt` — a json output emits `data class AnswerOutputRecovered`, `RECOVER_SCHEMA`, both `recover` overloads, `RecoveryResult<AnswerOutputRecovered>`; a `text`-format output emits NO recover; `safeParse`/`parse` still present.

### KT-T3: `KotlinOutputFormatSpecEmitter`
Create `KotlinOutputFormatSpecEmitter.kt` mirroring Java `OutputFormatSpecEmitter`: `specLiteral(vo, template, rootName): String` → `OutputFormatSpec(Format.X, "Root", PromptStyle.GUIDE|INLINE|EXAMPLE_ONLY, listOf(PromptField(...)))`. Read `@promptStyle` (via `OutputTemplate.getPromptStyle()`), per-field `@example`/`@instruction` (string), `@enumDoc` (properties → `mapOf("HIGH" to "...")`), enum `@values`. Escape free-text via `kotlinStringLiteral`. Nested → `PromptField("n", FieldKind.OBJECT, ...)` deferred. **Test** `KotlinOutputFormatSpecEmitterTest.kt`: assert the literal shape incl. `PromptStyle.GUIDE`, `mapOf("HIGH" to "...")`, escaped instruction.

### KT-T4: new `KotlinOutputPromptGenerator`
Create `KotlinOutputPromptGenerator.kt` mirroring Java `SpringOutputPromptGenerator` (and the Kotlin parser generator's structure/base class `MultiFileDirectGeneratorBase<MetaObject>`). For json|xml outputs, emit `<Name>OutputPrompt.kt`:
```kotlin
object <Name>OutputPrompt {
    private val SPEC: OutputFormatSpec = <specLiteral>
    fun renderFormat(): String = OutputFormatRenderer.render(SPEC, PromptOverrides.none())
    fun renderFormat(overrides: PromptOverrides): String = OutputFormatRenderer.render(SPEC, overrides)
}
```
rootName = payload class name (= the parser's, agreeing for round-trip). Imports for the prompt package + FieldKind/Format. **Test** `KotlinOutputPromptGeneratorTest.kt`: emits SPEC + both `renderFormat` overloads + `PromptStyle.<X>`. **Also** register `"output-prompt" -> KotlinOutputPromptGenerator()` (and confirm `"output-parser"` covers recover) in the snapshot test's generator switch.

### KT-T5: compile-proof + snapshot fixture
- **Compile-proof** (the gold standard — Java's caught 3 real bugs): add a test that compiles the generated Kotlin against the render jar. Try `org.jetbrains.kotlin:kotlin-compiler-embeddable` (test scope) invoking `K2JVMCompiler` on the emitted `.kt` files with the render jar on the classpath; assert exit OK; if feasible, load + invoke `recover()`/`renderFormat()` reflectively on dirty input and assert (recovered `confidence`="OK" via alias, comment-free fragment). **If kotlin-compiler-embeddable proves too heavy/flaky in-test, FALL BACK**: wire a hand-written consumer of the generated code into `integration-tests-kotlin` (which compiles generated Kotlin via the Maven kotlin plugin), OR document the gap honestly in an expected-coverage note and rely on snapshot + the shared engine's render tests for behavior. Report which path you took.
- **Snapshot fixture(s):** add `codegen-kotlin/src/test/resources/fixtures/template-output-fr010/` (`meta.json` with a json output incl. enum+@enumAlias+@enumDoc+@example+@promptStyle, `config.json` listing `output-parser` + `output-prompt` + `payload`) and let the snapshot test record `<Name>Parser.kt` / `<Name>OutputPrompt.kt`. Eyeball the snapshot for correctness (comment-free prompt, recover present).

### KT-T6: full-module regression + KNOWN_GAPS note
- `mvn -pl :metaobjects-codegen-kotlin test -q` green; full `server/java` build of the touched modules green.
- Add a KNOWN_GAPS note (codegen-kotlin) mirroring Java's: recover/prompt bounded to scalar/enum/scalar-array; nested deferred (KT.1); recover returns the nullable `<Name>Recovered` mirror (Kotlin null-safety); render-classpath dep.

## Self-review checklist
- Engine reuse (no reimpl) ✓; recover classification = Java's by construction ✓; nullable-mirror decision implemented ✓; `@promptStyle`/`@enumAlias`/`@enumDoc` read from shared metadata ✓; rootName agreement parser↔prompt ✓; dual-API parse/safeParse untouched ✓; compile-proof attempted (or gap documented) ✓; bounded nested deferral noted ✓.
- Verify-against-live-code spots: the exact base class + file/object structure of the existing `KotlinOutputParserGenerator`; the snapshot-test generator switch; whether `OutputTemplate.getPromptStyle()` is callable from Kotlin (it is — Java method); kotlin-compiler-embeddable feasibility.

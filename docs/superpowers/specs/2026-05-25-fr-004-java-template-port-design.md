# FR-004 — Java port: `template.*` metatype + render engine + verify

- **Date:** 2026-05-25
- **Status:** Design — plan-of-record. Authority for the Java implementation of the FR-004 fourth pillar.
- **Target version:** 7.0.0 (developed on `7.0.0-SNAPSHOT`)
- **Scope:** Java port of the full prompt-construction pillar — Layer 1 (`template.*` metatype) + Layer 2 (Mustache render engine + `verify`). Mirrors TS (`server/typescript/packages/metadata/src/template/` + `packages/render/`) and C# (`server/csharp/MetaObjects/Template/` + `server/csharp/MetaObjects.Render/`, commit `23d8dcb`). Closes the Java side of the cross-language fourth-pillar story.
- **References:**
  - Parent spec: [FR-004 cross-language prompt construction](2026-05-22-fr-004-cross-language-prompt-construction-design.md)
  - Reference commits: TS `f707fac`, C# `23d8dcb`
  - Conformance corpus: `fixtures/conformance/` (template-* fixtures), `fixtures/render-conformance/` (renderer corpus)

## 1. Background

Three of four ports have shipped FR-004's metatype slice (TS + C# shipped; Python pinned pending its codegen/persistence foundation). Java has none of it — no `template.*` types, no render engine, and the conformance harness reports `template-output-simple` as a hard failure (no `Unknown type 'template' in canonical JSON file` warning suppression in place).

A downstream Kotlin consumer needs to render LLM prompts via MetaObjects from a Kotlin app. The planned path is `metadata-ktx` (Kotlin facade) → on top of Java FR-004. Java FR-004 is the prerequisite: without it, the Kotlin facade has nothing to wrap.

`origin.collection` already exists in Java (`server/java/metadata/src/main/java/com/metaobjects/origin/CollectionOrigin.java`) — the only Layer-1-adjacent piece already in place.

## 2. Scope

**In scope (this project):**

1. **Layer 1 — `template.*` metatype** in `metaobjects-metadata` (existing module).
2. **Layer 2 — Mustache render engine** in `metaobjects-render` (new module).
3. **`verify`** — drift detection for `@textRef` resolution and partial reachability, in `metaobjects-render`.
4. **Cross-language conformance** — the 6 `template-*` fixtures in `fixtures/conformance/` pass in Java; the `fixtures/render-conformance/` corpus runs (report-mode, not gate-mode) against the TS baselines.

**Out of scope (deferred):**

- **Payload assembler** (view-object metadata → materialized payload at runtime via DB queries). Rides FR-003. Render conformance supplies payload fixtures directly; consumers supply payloads from their own code.
- **NoSQL + RDB providers.** Day 1 ships Filesystem + ClasspathResource only.
- **Maven plugin `verify` goal.** Render conformance runs in the test suite; a `metaobjects-maven-plugin` mojo can be added in a follow-up if a real consumer asks.
- **Spring auto-config** for `Provider` / `Renderer` beans. Deferred.
- **`verify` structured JSON output** (for CI consumption). Deferred until a Maven mojo materializes.

## 3. Module layout

```
server/java/render/                              # NEW module
├── pom.xml                                       # parent: metaobjects 7.0.0-SNAPSHOT
└── src/
    ├── main/java/com/metaobjects/render/
    │   ├── Provider.java                         # interface
    │   ├── FilesystemProvider.java               # filesystem-rooted Provider
    │   ├── ClasspathResourceProvider.java        # classpath-rooted Provider
    │   ├── Escapers.java                         # format-keyed escaper registry
    │   ├── Renderer.java                         # render pipeline + cycle guard
    │   └── VerifyResult.java                     # drift-check result type
    └── test/java/com/metaobjects/render/
        ├── EscapersTest.java
        ├── FilesystemProviderTest.java
        ├── ClasspathResourceProviderTest.java
        ├── RendererTest.java
        ├── VerifyTest.java
        ├── RenderSnapshotTest.java               # within-Java snapshot gate
        └── RenderCrossPortReportTest.java        # cross-port comparison, REPORT-ONLY

server/java/metadata/src/main/java/com/metaobjects/template/   # add to existing module
├── MetaTemplate.java                             # abstract base
├── PromptTemplate.java                           # template.prompt subtype
├── OutputTemplate.java                           # template.output subtype
├── TemplateConstants.java                        # attr name + format vocabulary constants
└── TemplateTypesMetaDataProvider.java            # SPI registration

server/java/metadata/src/main/resources/META-INF/services/
└── com.metaobjects.registry.MetaDataTypeProvider # add TemplateTypesMetaDataProvider line

server/java/metadata/src/test/java/com/metaobjects/template/   # template-metatype tests
├── TemplateLoaderTest.java                       # load/round-trip
└── TemplatePayloadRefValidationTest.java         # the 3 ERR_TEMPLATE_* validations
```

**Module coords:**

- Artifact: `metaobjects-render`
- Group: `com.metaobjects`
- Package: `com.metaobjects.render`
- Dependencies:
  - `metaobjects-metadata` (Layer-1 metatype)
  - `com.github.spullara.mustache.java:compiler:0.9.14` (already in reactor via `codegen-mustache`)
- Registered in `server/java/pom.xml` `<modules>` after `codegen-mustache`.

## 4. Layer 1 — `template.*` metatype

### 4.1 Vocabulary (Tier 1 — cross-language invariant)

| Member | Value | Notes |
|---|---|---|
| Type | `template` | abstract base; `MetaTemplate` |
| Subtype | `prompt` | `template.prompt` → `PromptTemplate` |
| Subtype | `output` | `template.output` → `OutputTemplate` |

### 4.2 Attributes

| Attr | Required | Applies to | Constraints |
|---|---|---|---|
| `@payloadRef` | yes | both | dotted reference to a view-object (`object.value`); load-time resolved |
| `@textRef` | yes | both | logical reference `"group/source"` (2-layer); resolved at render time by Provider |
| `@format` | no | both | default `"text"`; closed `allowedValues`: `text\|html\|xml\|csv\|json\|markdown\|spreadsheet` |
| `@maxChars` | no | both | int; optional output-truncation cap |
| `@owner` | no | both | string |
| `@since` | no | both | string |
| `@maxTokens` | no | **prompt only** | int |
| `@requiredSlots` | no | **prompt only** | string-array; each member must name a field on the resolved payload VO |
| `@model` | no | **prompt only** | string |

`@format` values are the format identifier; **never a subtype**. Escaping behavior is keyed off `@format` by the engine — a new format costs one escaper + one allowedValues entry, not a new subtype.

### 4.3 Load-time validation passes

Three validation passes added to `MetaDataLoader`. Each emits one of the FR-004 error codes:

1. **`ERR_TEMPLATE_PAYLOAD_REF_UNRESOLVED`** — `@payloadRef` must resolve to an `object.value` reachable from the loaded metadata. Failure covered by fixture `error-template-payload-ref-unresolved`.
2. **`ERR_TEMPLATE_MISSING_PAYLOAD_REF`** — every `template.prompt` requires a non-empty `@payloadRef`. Failure covered by `error-template-prompt-missing-payload-ref`.
3. **`ERR_TEMPLATE_REQUIRED_SLOT_MISSING`** — each `@requiredSlots` member must name a field on the resolved payload VO. Failure covered by `error-template-required-slot-missing`.

### 4.4 Conformance fixtures that go green in Java

After Layer 1 lands, these fixtures from `fixtures/conformance/` pass (currently fail or have warnings):

- `template-output-simple` (currently FAILS the Java conformance gate)
- `template-prompt-simple`
- `template-output-and-prompt`
- `error-template-payload-ref-unresolved`
- `error-template-prompt-missing-payload-ref`
- `error-template-required-slot-missing`

Java's `conformance-expected-failures.json` does not need any of these added — they all flip green.

### 4.5 `origin.collection` wildcard semantics

`CollectionOrigin` already exists in Java and validates `@via`. The render-conformance fixtures use a wildcard selector form for collection origins that span packages. **Task-0 verification:** confirm the existing `@via` parser/validator accepts the same wildcard syntax used by TS/C# render-conformance fixtures; if it diverges, fix parity before Layer 2.

## 5. Layer 2 — render engine

### 5.1 Pipeline

```
Renderer.render(template: MetaTemplate, payload: Map<String, Object>, provider: Provider): String

  1. (group, source) = parseTextRef(template.getTextRef())   // "g/s" → ("g","s")
  2. text = provider.resolveText(group, source)              // template body
  3. compiled = mustacheFactory.compile(new StringReader(text), template.getName())
                // Mustache.java's native partial handling IS used, with a
                // cycle-guarding Provider wrapper (see 5.2).
                // HTML escaping is DISABLED in the factory; all escaping
                // happens in step 6 via the Escapers registry.
  4. var writer = new StringWriter();
     compiled.execute(writer, payload).flush();
     rendered = writer.toString();
  5. format = template.getFormat() (default "text")
  6. escaped = Escapers.escape(format, rendered)
       // text/markdown  → identity
       // html/xml       → entity-encode & < > " '
       // csv/spreadsheet → CSV-escape + OWASP cell-injection guard ('=','+','-','@' prefix → '\'' prefix)
       // json           → JSON-string encode (RFC 8259)
  7. if (template.getMaxChars().isPresent() && escaped.length() > maxChars)
       escaped = escaped.substring(0, maxChars)
  8. return escaped
```

### 5.2 Cycle guard

`mustache.java` resolves partials via a `MustacheResolver` (one method: `Reader getReader(String partialName)`). We wire `MustacheResolver` to our `Provider`, but wrap it with a **per-render cycle guard**:

```java
class CycleGuardingResolver implements MustacheResolver {
    static final int MAX_DEPTH = 32;
    private final Deque<String> stack = new ArrayDeque<>();
    private final Provider provider;
    @Override public Reader getReader(String name) {
        if (stack.contains(name))
            throw new RenderCycleException("partial cycle: " + String.join(" → ", stack) + " → " + name);
        if (stack.size() >= MAX_DEPTH)
            throw new RenderCycleException("partial depth exceeds MAX_DEPTH=" + MAX_DEPTH);
        var text = provider.resolveText(parseGroup(name), parseSource(name));
        return new StringReader(text);
    }
}
```

Note `mustache.java` re-asks the resolver for the same partial across invocations — we push/pop in render-scope, not resolver-scope. Each render gets a fresh `CycleGuardingResolver` instance.

### 5.3 Provider contract

```java
public interface Provider {
    /** Resolve a logical (group, source) reference to template text. */
    String resolveText(String group, String source) throws UnresolvedTextRefException;
}
```

**`FilesystemProvider`:**

```java
new FilesystemProvider(Path root)   // resolves "group/source" → {root}/{group}/{source}.mustache
```

- Reads files as UTF-8 (`utf-8-sig` tolerance for BOM)
- Rejects path traversal: a group or source containing `..` throws `IllegalArgumentException`
- Missing file → `UnresolvedTextRefException` with the absolute path attempted

**`ClasspathResourceProvider`:**

```java
new ClasspathResourceProvider(ClassLoader cl, String basePrefix)
// e.g., new ClasspathResourceProvider(cl, "prompts/")
// resolves "lobby/welcome" → classpath:prompts/lobby/welcome.mustache
```

- Uses `ClassLoader.getResource(basePrefix + group + "/" + source + ".mustache")`
- Missing resource → `UnresolvedTextRefException`
- Null `cl` rejected at construction

### 5.4 Escapers

```java
public final class Escapers {
    private static final Map<String, UnaryOperator<String>> REGISTRY = Map.of(
        "text",        UnaryOperator.identity(),
        "markdown",    UnaryOperator.identity(),
        "html",        Escapers::escapeHtml,
        "xml",         Escapers::escapeXml,
        "csv",         Escapers::escapeCsv,
        "spreadsheet", Escapers::escapeCsv,
        "json",        Escapers::escapeJson
    );
    public static String escape(String format, String input) { /* dispatch */ }
}
```

- **HTML/XML**: entity-encode `& < > " '` (matches TS + C# character set exactly)
- **CSV/spreadsheet**: standard CSV escape (double-quote wrap if value contains `, " \n`); on top of that, OWASP cell-injection guard — any value whose first char is `= + - @` gets a leading `'` so spreadsheet apps don't evaluate it as a formula
- **JSON**: RFC 8259 string encoding (`\\"`, `\\\\`, `\\b\\f\\n\\r\\t`, `\\u00xx` for other control chars)

### 5.5 `verify`

```java
class Renderer {
    public VerifyResult verify(MetaTemplate template, Provider provider) {
        // 1. Resolve template.textRef → text
        // 2. Walk all {{> partial }} references in text + recursively in resolved partials
        // 3. For each partial ref: attempt provider.resolveText(); collect errors
        // 4. Detect cycles using same MAX_DEPTH=32 guard; report as errors (don't throw)
        // 5. Return VerifyResult { template, errors: List<String>, partialsResolved: Set<String> }
    }
}

public record VerifyResult(MetaTemplate template, List<String> errors, Set<String> partialsResolved) {
    public boolean ok() { return errors.isEmpty(); }
}
```

`verify` is template-side only — no payload needed. Used by:
- The render-conformance corpus harness (sanity-check before rendering)
- Future Maven mojo for build-time drift detection

## 6. Testing strategy

### 6.1 Unit tests (~30 tests in `metaobjects-render`)

| File | Coverage |
|---|---|
| `EscapersTest` | Each format escaper; OWASP CSV cases (`=`, `+`, `-`, `@`); JSON edge cases; HTML/XML entity set |
| `FilesystemProviderTest` | Resolve OK; missing file; `..` traversal blocked; root construction |
| `ClasspathResourceProviderTest` | Resolve OK from test resources; missing resource; null classloader rejected |
| `RendererTest` | Variable substitution; section iteration; partial via Provider (1-level); partial via Provider (nested 3 deep); cycle detection at MAX_DEPTH=32; `@maxChars` truncation; identity-format passthrough; HTML escaping happens in our layer, not Mustache's |
| `VerifyTest` | Unresolved partial detected; cyclic partial detected; all-resolvable returns empty errors; `ok()` parity |

### 6.2 Layer-1 metatype tests

| File | Coverage |
|---|---|
| `TemplateLoaderTest` | `template.prompt` + `template.output` load + canonical round-trip |
| `TemplatePayloadRefValidationTest` | Each of the 3 `ERR_TEMPLATE_*` error codes produced by the corresponding error fixtures |

### 6.3 Conformance — within-Java snapshot gate

`RenderSnapshotTest.java` — uses JUnit 4 parameterized test that walks every fixture under `fixtures/render-conformance/<name>/`, renders it, and compares against a Java-side snapshot file at `server/java/render/src/test/resources/snapshots/<name>.txt`. CI fails if any fixture's rendered output diverges from its snapshot.

**Initial snapshots** are generated by running the test once, copying actual outputs into snapshots, reviewing the diff, committing. This is the **build gate** for Java rendering — it guarantees within-Java stability over time (the LLM prompt-cache invariant).

### 6.4 Conformance — cross-port report (NOT a gate)

`RenderCrossPortReportTest.java` — same fixture walk as 6.3, but compares Java's actual output against the TS-baseline at `fixtures/render-conformance/<name>/expected/rendered.txt`. Prints a diff if they differ; **no assertions** that fail the build. Documented drifts (likely Mustache.java standalone-tag whitespace edges) are tracked in `server/java/render/KNOWN_DRIFT.md` and reviewed when the corpus changes.

The cross-port gate is owned by TS + C# today; Java participates in the corpus as a comparison consumer until/unless byte-identical parity becomes a real consumer need.

### 6.5 Java conformance harness flips green

The 6 `template-*` fixtures in `fixtures/conformance/` already covered by Java's `ConformanceTest` harness flip from FAIL → PASS once Layer 1 ships. `conformance-expected-failures.json` needs no entries for these.

**Total new tests:** ~30 unit + 2 metatype + ~10–15 render-snapshot + ~10–15 cross-port-report (report only) + 6 already-existing harness tests flipping green = ~50–70 new tests, ~150 LOC of test code per test on average.

### 6.6 Test framework

**JUnit 4** for reactor consistency. Render-conformance parameterization uses JUnit 4 `Parameterized` runner. No reactor-wide migration to JUnit 5.

## 7. Cross-port classification

### 7.1 Tier 1 — invariant (must match TS/C# exactly)

- Type/subtype names: `template`, `template.prompt`, `template.output`
- Attribute names: `@payloadRef`, `@textRef`, `@format`, `@maxChars`, `@owner`, `@since`, `@maxTokens`, `@requiredSlots`, `@model`
- `@format` allowedValues: `text|html|xml|csv|json|markdown|spreadsheet`
- Error codes: `ERR_TEMPLATE_PAYLOAD_REF_UNRESOLVED`, `ERR_TEMPLATE_MISSING_PAYLOAD_REF`, `ERR_TEMPLATE_REQUIRED_SLOT_MISSING`
- `@textRef` shape: 2-layer `"group/source"` (no L3 section addressing — per FR-004 R3)
- Cycle guard depth: `MAX_DEPTH = 32`
- Escaper behavior **per format** is char-identical to TS/C# (HTML entity set, CSV OWASP guard char-set, JSON encoding rules)

### 7.2 Tier 2 — idiomatic per port (Java-specific choices)

- Packages: `com.metaobjects.template` (metatype) + `com.metaobjects.render` (engine)
- Provider interface name: `Provider` (drop `I` prefix per Java convention; C# uses same name with no prefix)
- `ClasspathResourceProvider` — Java-specific second provider (classpath isn't a TS/C# concept in the same form)
- Filesystem path type: `java.nio.file.Path`
- `verify` returns `VerifyResult` record (Java 17+ records OK on Java 21)
- Render-conformance is REPORT-ONLY in Java (cross-port byte-identical is a TS/C# gate; Java's gate is its own snapshot)

### 7.3 Tier 3 — internal / free

- Mustache library + version (locked to `mustache.java:0.9.14` for reactor consistency; choice is internal)
- Whether partial pre-expansion is done by us or by mustache.java (current decision: use Mustache.java's native partials with our cycle-guarding resolver; revisit if drift becomes painful)
- Compiled-template caching strategy (none Day 1)
- Whether `Renderer` is stateless static or instantiable (likely instantiable, with default constructor)

## 8. Risks + mitigations

1. **Mustache.java standalone-tag whitespace differs from TS/C#.** Mitigation: cross-port test is report-only (per §6.4). Within-Java snapshot test gates stability.
2. **Mustache.java HTML escapes by default.** Mitigation: configure the factory to disable HTML escaping; do all escaping in our Escapers layer.
3. **`origin.collection` `@via` wildcard syntax may diverge.** Mitigation: Task-0 verification before Layer 2 (§4.5); fix Java parser/validator parity early if it diverges.
4. **Mustache.java 0.9.14 vs newer.** Mitigation: stay pinned at 0.9.14 (matches `codegen-mustache`); bump both modules together if a render conformance issue forces an upgrade.

## 9. Versioning + compatibility

- Target: `7.0.0-SNAPSHOT` (no released artifacts use this code yet).
- No backwards-compat surface to maintain.
- Maven coordinate `metaobjects-render` is new; first release goes out with the next 7.0.0 milestone.

## 10. Open questions (deferred — not gating)

- **`meta-maven-plugin:verify` mojo**: defer until a real consumer wants build-time drift detection.
- **Spring integration**: defer until a Spring-based consumer materializes.
- **Provider for NoSQL / RDB**: defer; the Provider interface is open for extension.
- **Compiled-template caching**: defer until profiling shows a hotspot.

## 11. Cross-references

- [FR-004 cross-language design (parent spec)](2026-05-22-fr-004-cross-language-prompt-construction-design.md)
- [FR-004 Python port spec (pinned, but contains the cross-language render-engine specifics)](2026-05-23-fr-004-python-template-metatype-design.md)
- [ADR-0006 — YAML authoring](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md) — `@textRef` is referenced from YAML metadata authoring
- C# reference commit: `23d8dcb` — `feat(csharp/metadata): port the template (fourth-pillar) metatype (FR-004)`
- TS reference commit: `f707fac` — `refactor(metadata): generalize prompt.* → template.{prompt,output} + @format`
- Shared corpus: `fixtures/conformance/template-*`, `fixtures/conformance/error-template-*`, `fixtures/render-conformance/`

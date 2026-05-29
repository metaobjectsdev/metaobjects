# FR-010 Java Plan 1 — Tolerant `recover()` Engine + Dirty-Input Conformance Corpus

> **STATUS: IMPLEMENTED & MERGED (2026-05-29).** The landed code in
> `server/java/render/src/main/java/com/metaobjects/render/recover/` and the
> `fixtures/recover-conformance/` corpus are the **cross-port reference**, not the
> code listings below. Implementation review surfaced bugs in this plan's original
> listings — **port authors (Kotlin/C#/Python/TS) and Plan 2 must follow the merged
> code, and the corrections in the next section, over the inline listings.**
>
> ## Post-implementation corrections (authoritative)
>
> The original Task listings below were corrected during TDD review. Each correction
> is pinned by a regression test in the merged code:
> 1. **JSON reader (Task 4) — no-hang.** A malformed array closed by `}` (e.g. `{"xs":[}`,
>    `{"xs":[1,}`) infinite-looped/OOM'd. Fix: `readBareScalar` returns `null` on a
>    zero-width read; `readObject`/`readArray` treat `null` as "no value" and stop/skip
>    without spinning. The never-hang guarantee is load-bearing.
> 2. **JSON reader (Task 4) + Recover (Task 7) — malformed-vs-absent.** A present key with
>    an empty/cut-off value (`{"a":}`, `{"a":` at EOF) must NOT be silently omitted. The
>    reader records a package-private `TRUNCATED` sentinel; `Recover` maps it to
>    **MALFORMED** (present-but-garbled), distinct from a never-present field
>    (**LOST_REQUIRED**). This is spec stage-4 and is the engine's core signal.
> 3. **XML reader (Task 5) — no-throw.** A span starting with a close tag (`"</x>"`) threw
>    `StringIndexOutOfBoundsException`. Fix: guard `rootEnd <= gt` in `read(...)`.
> 4. **Coerce (Task 6) — non-finite numerics.** `"NaN"`/`"Infinity"` for INT/DOUBLE must
>    classify **MALFORMED** (not `0L`/`Long.MAX_VALUE`) for cross-port classification
>    parity. Fix: `if (!Double.isFinite(n)) return MALFORMED;` in `clamp`. Also: the
>    `RecoverOptions.normalizers` hook is now actually consumed by `Coerce` (it was a
>    no-op in the listing).
> 5. **Recover (Task 7) — array fields.** `FieldSpec.array()` is honored: array values are
>    coerced/recursed per element. A `List` for a non-array field → MALFORMED; an OBJECT
>    field given a scalar → MALFORMED. A **MALFORMED array still carries its
>    successfully-coerced elements in `data`** (partial recovery) — intentionally unlike a
>    MALFORMED scalar (absent from `data`); documented in `Recover.java` and pinned by test.
> 6. **Conformance runner (Task 8) — exhaustive.** The runner asserts the actual state-key
>    set and data-key set EQUAL the expected sets (no missing, no extra); every fixture's
>    `expected.json` lists every schema field.
> 7. **`Tolerance.LOOSE`** currently behaves identically to `NORMAL`; `FieldRecovery.DEFAULTED`
>    is reserved and not emitted by this engine version. Both are noted in code.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a descriptor-driven, never-throwing tolerant recovery parser for dirty LLM output (XML + JSON) in the JVM `render` module, plus a shared dirty-input conformance corpus that pins recovery *classification* across ports.

**Architecture:** A single shared `Recover` engine consumes a hand-built `RecoverSchema` descriptor and a raw response string, runs an 8-stage pipeline (strip → locate → score/select → forgiving-read → extract+default → malformed-vs-absent → normalize/coerce → report), and returns a `RecoverOutcome` (`Map<String,Object> data` + `RecoveryReport`). The engine is pure runtime — no `metaobjects-metadata` dependency, no codegen, no metamodel attrs (Plan 2 generates the descriptor and the typed wrapper). Tolerance is hand-rolled (not delegated to Jackson) so the bounded malformation set is deterministic and faithfully re-implementable in every port. The conformance assertion is on the per-field **classification** + the **canonical normalized value**; raw numeric coercion carries a documented tolerance.

**Tech Stack:** Java 21, Maven (`metaobjects-render` module), JUnit 4 (matches the existing render-module convention), no new third-party runtime dependency.

**Scope boundaries (this plan):**
- IN: the engine, its data model, the 8 stages, the dirty-input corpus + a parameterized Java runner.
- OUT (→ Plan 2): the `@example`/`@instruction`/`@enumDoc`/`@enumAlias` metamodel attrs, building the descriptor from a value-object via codegen, the generated `recover(...)`/`RecoveryResult<T>` parser surface, the output-prompt fragment generator, `verify` extension, clean `template-output-{xml,json}-simple` fixtures, the round-trip property test.
- The engine is tested in Plan 1 with **hand-authored** `RecoverSchema` instances (no codegen needed to prove it).

**Cross-port contract frozen here (do not drift in later ports):**
- `FieldRecovery` enum: `RECOVERED | DEFAULTED | LOST_OPTIONAL | LOST_REQUIRED | MALFORMED`, plus the report-level `empty` boolean as the degenerate-response state.
- Tolerance presets: `STRICT` (case-sensitive matching; ≈ FR-006 strict), `NORMAL` (default; case-insensitive tag/key matching), `LOOSE` (maximally forgiving locate/repair).
- Alias conflict: runtime alias wins over schema alias, recorded as a coercion note.

---

## File Structure

All paths under `server/java/render/`. New package: `com.metaobjects.render.recover`.

| File | Responsibility |
|---|---|
| `src/main/java/com/metaobjects/render/recover/Format.java` | enum `JSON | XML` |
| `src/main/java/com/metaobjects/render/recover/FieldKind.java` | enum of scalar/object kinds the engine coerces to |
| `src/main/java/com/metaobjects/render/recover/FieldSpec.java` | one field's recover descriptor (name, kind, required, array, enumValues, enumAlias, min/max, nested) |
| `src/main/java/com/metaobjects/render/recover/RecoverSchema.java` | top-level descriptor (format, rootName, fields) |
| `src/main/java/com/metaobjects/render/recover/FieldRecovery.java` | the frozen per-field state enum |
| `src/main/java/com/metaobjects/render/recover/Coercion.java` | a recorded normalization/coercion note |
| `src/main/java/com/metaobjects/render/recover/RecoveryReport.java` | per-field states + empty flag + coercions + convenience accessors |
| `src/main/java/com/metaobjects/render/recover/Tolerance.java` | enum `STRICT | NORMAL | LOOSE` |
| `src/main/java/com/metaobjects/render/recover/RecoverOptions.java` | tolerance + merged aliases + normalizers + onField hook |
| `src/main/java/com/metaobjects/render/recover/RecoverOutcome.java` | engine return: `Map<String,Object> data` + `RecoveryReport report` |
| `src/main/java/com/metaobjects/render/recover/Strip.java` | stage 1 — fence/prose/preamble stripping |
| `src/main/java/com/metaobjects/render/recover/Locate.java` | stages 2–3 — isolate + score/select the root span |
| `src/main/java/com/metaobjects/render/recover/JsonForgivingReader.java` | tolerant JSON read incl. bounded prefix recovery |
| `src/main/java/com/metaobjects/render/recover/XmlForgivingReader.java` | tolerant XML read incl. unclosed-tag recovery |
| `src/main/java/com/metaobjects/render/recover/Coerce.java` | stage 7 — enum alias/vocab, numeric range, type coercion |
| `src/main/java/com/metaobjects/render/recover/Recover.java` | public entry point; assembles stages, does extract+classify (4–6) and empty-guard |
| `src/test/java/com/metaobjects/render/recover/*Test.java` | per-component unit tests |
| `src/test/java/com/metaobjects/render/recover/RecoverConformanceTest.java` | parameterized dirty-corpus runner |
| `fixtures/recover-conformance/<case>/...` (repo-root) | the shared dirty-input corpus |

---

## Task 0: Scaffold the data model (enums + records)

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/Format.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/FieldKind.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/FieldRecovery.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/Tolerance.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/Coercion.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/FieldSpec.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/RecoverSchema.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/ModelTest.java`

- [ ] **Step 1: Write the failing test**

```java
// server/java/render/src/test/java/com/metaobjects/render/recover/ModelTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class ModelTest {

    @Test
    public void scalarFieldSpecBuildsWithDefaults() {
        FieldSpec f = FieldSpec.scalar("confidence", FieldKind.STRING, true);
        assertEquals("confidence", f.name());
        assertEquals(FieldKind.STRING, f.kind());
        assertTrue(f.required());
        assertFalse(f.array());
        assertNull(f.enumValues());
        assertNull(f.nested());
    }

    @Test
    public void enumFieldSpecCarriesValuesAndAliases() {
        FieldSpec f = FieldSpec.enumField(
                "tone", true,
                List.of("FRIENDLY", "NEUTRAL", "HOSTILE"),
                Map.of("warm", "FRIENDLY"));
        assertEquals(FieldKind.ENUM, f.kind());
        assertEquals(List.of("FRIENDLY", "NEUTRAL", "HOSTILE"), f.enumValues());
        assertEquals("FRIENDLY", f.enumAlias().get("warm"));
    }

    @Test
    public void schemaCarriesFormatAndRoot() {
        RecoverSchema s = new RecoverSchema(Format.XML, "answer",
                List.of(FieldSpec.scalar("text", FieldKind.STRING, true)));
        assertEquals(Format.XML, s.format());
        assertEquals("answer", s.rootName());
        assertEquals(1, s.fields().size());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=ModelTest -q`
Expected: COMPILE FAILURE — `Format`, `FieldKind`, `FieldSpec`, `RecoverSchema` do not exist.

- [ ] **Step 3: Write the model types**

```java
// Format.java
package com.metaobjects.render.recover;
public enum Format { JSON, XML }
```

```java
// FieldKind.java
package com.metaobjects.render.recover;
/** The coercion target kinds the engine understands. OBJECT = nested RecoverSchema. */
public enum FieldKind { STRING, INT, LONG, DOUBLE, BOOLEAN, ENUM, OBJECT }
```

```java
// FieldRecovery.java
package com.metaobjects.render.recover;
/** FROZEN cross-port per-field recovery classification. Do not reorder or add without an ADR. */
public enum FieldRecovery { RECOVERED, DEFAULTED, LOST_OPTIONAL, LOST_REQUIRED, MALFORMED }
```

```java
// Tolerance.java
package com.metaobjects.render.recover;
/** STRICT: case-sensitive, minimal repair. NORMAL: case-insensitive keys/tags (default). LOOSE: maximal repair. */
public enum Tolerance { STRICT, NORMAL, LOOSE }
```

```java
// Coercion.java
package com.metaobjects.render.recover;
import java.util.Objects;
/** A recorded normalization/coercion. kind e.g. "alias", "clamp", "case", "runtime-alias-override". */
public record Coercion(String fieldPath, String from, String to, String kind) {
    public Coercion {
        Objects.requireNonNull(fieldPath, "fieldPath");
        Objects.requireNonNull(kind, "kind");
    }
}
```

```java
// FieldSpec.java
package com.metaobjects.render.recover;
import java.util.List;
import java.util.Map;
/**
 * One field's recover descriptor. enumValues/enumAlias non-null only for ENUM;
 * min/max non-null only for numeric range constraints; nested non-null only for OBJECT.
 */
public record FieldSpec(
        String name,
        FieldKind kind,
        boolean required,
        boolean array,
        List<String> enumValues,
        Map<String, String> enumAlias,
        Double min,
        Double max,
        RecoverSchema nested) {

    public static FieldSpec scalar(String name, FieldKind kind, boolean required) {
        return new FieldSpec(name, kind, required, false, null, null, null, null, null);
    }

    public static FieldSpec enumField(String name, boolean required,
                                      List<String> values, Map<String, String> aliases) {
        return new FieldSpec(name, FieldKind.ENUM, required, false,
                values == null ? null : List.copyOf(values),
                aliases == null ? Map.of() : Map.copyOf(aliases),
                null, null, null);
    }

    public static FieldSpec range(String name, FieldKind kind, boolean required,
                                  Double min, Double max) {
        return new FieldSpec(name, kind, required, false, null, null, min, max, null);
    }

    public static FieldSpec object(String name, boolean required, boolean array, RecoverSchema nested) {
        return new FieldSpec(name, FieldKind.OBJECT, required, array, null, null, null, null, nested);
    }
}
```

```java
// RecoverSchema.java
package com.metaobjects.render.recover;
import java.util.List;
import java.util.Objects;
/** Top-level recover descriptor. rootName = the XML root tag / logical JSON root name. */
public record RecoverSchema(Format format, String rootName, List<FieldSpec> fields) {
    public RecoverSchema {
        Objects.requireNonNull(format, "format");
        Objects.requireNonNull(rootName, "rootName");
        fields = fields == null ? List.of() : List.copyOf(fields);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=ModelTest -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/ \
        server/java/render/src/test/java/com/metaobjects/render/recover/ModelTest.java
git commit -m "feat(render): FR-010 recover engine data model (descriptor, report enums)"
```

---

## Task 1: `RecoveryReport`, `RecoverOptions`, `RecoverOutcome`

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/RecoveryReport.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/RecoverOptions.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/RecoverOutcome.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/ReportTest.java`

- [ ] **Step 1: Write the failing test**

```java
// ReportTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class ReportTest {

    @Test
    public void lostRequiredAccessorFiltersStates() {
        RecoveryReport r = new RecoveryReport();
        r.set("a", FieldRecovery.RECOVERED);
        r.set("b", FieldRecovery.LOST_REQUIRED);
        r.set("c", FieldRecovery.LOST_REQUIRED);
        r.set("d", FieldRecovery.DEFAULTED);
        assertEquals(List.of("b", "c"), r.lostRequired());
        assertTrue(r.hasLostRequired());
    }

    @Test
    public void emptyReportFlagsDegenerate() {
        RecoveryReport r = new RecoveryReport();
        r.markEmpty();
        assertTrue(r.isEmpty());
        assertFalse(r.hasLostRequired());
    }

    @Test
    public void optionsDefaultsToNormalTolerance() {
        RecoverOptions opts = RecoverOptions.defaults();
        assertEquals(Tolerance.NORMAL, opts.tolerance());
        assertTrue(opts.aliases().isEmpty());
        assertNull(opts.onField());
    }

    @Test
    public void outcomeHoldsDataAndReport() {
        RecoveryReport r = new RecoveryReport();
        RecoverOutcome o = new RecoverOutcome(java.util.Map.of("x", 1), r);
        assertEquals(1, o.data().get("x"));
        assertSame(r, o.report());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=ReportTest -q`
Expected: COMPILE FAILURE — types do not exist.

- [ ] **Step 3: Implement the three types**

```java
// RecoveryReport.java
package com.metaobjects.render.recover;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Mutable accumulator of per-field recovery classification, the degenerate-response flag, and coercion notes. */
public final class RecoveryReport {
    private final Map<String, FieldRecovery> states = new LinkedHashMap<>();
    private final List<Coercion> coercions = new ArrayList<>();
    private boolean empty = false;

    public void set(String fieldPath, FieldRecovery state) { states.put(fieldPath, state); }
    public void addCoercion(Coercion c) { coercions.add(c); }
    public void markEmpty() { this.empty = true; }

    public boolean isEmpty() { return empty; }
    public Map<String, FieldRecovery> states() { return Map.copyOf(states); }
    public List<Coercion> coercions() { return List.copyOf(coercions); }

    public List<String> lostRequired() { return byState(FieldRecovery.LOST_REQUIRED); }
    public List<String> malformed() { return byState(FieldRecovery.MALFORMED); }
    public boolean hasLostRequired() { return !lostRequired().isEmpty(); }

    private List<String> byState(FieldRecovery s) {
        List<String> out = new ArrayList<>();
        for (var e : states.entrySet()) if (e.getValue() == s) out.add(e.getKey());
        return out;
    }
}
```

```java
// RecoverOptions.java
package com.metaobjects.render.recover;
import java.util.Map;

/**
 * Bounded runtime override surface (the "20%"). aliases/normalizers are MERGED with the
 * schema's, runtime winning on key conflict. onField is the single bespoke-coercion hook.
 */
public record RecoverOptions(
        Tolerance tolerance,
        Map<String, String> aliases,
        Map<String, java.util.function.Function<String, Object>> normalizers,
        OnField onField) {

    /** ctx carries the field path and the FieldSpec; return null to fall through to default coercion. */
    @FunctionalInterface
    public interface OnField {
        Object coerce(String fieldPath, String rawValue, FieldSpec spec);
    }

    public RecoverOptions {
        tolerance = tolerance == null ? Tolerance.NORMAL : tolerance;
        aliases = aliases == null ? Map.of() : Map.copyOf(aliases);
        normalizers = normalizers == null ? Map.of() : Map.copyOf(normalizers);
    }

    public static RecoverOptions defaults() {
        return new RecoverOptions(Tolerance.NORMAL, Map.of(), Map.of(), null);
    }

    public RecoverOptions withTolerance(Tolerance t) {
        return new RecoverOptions(t, aliases, normalizers, onField);
    }
}
```

```java
// RecoverOutcome.java
package com.metaobjects.render.recover;
import java.util.Map;
import java.util.Objects;
/** Engine return. data is a forgiving Map<String,Object>; Plan 2 wraps it into a typed RecoveryResult<T>. */
public record RecoverOutcome(Map<String, Object> data, RecoveryReport report) {
    public RecoverOutcome {
        Objects.requireNonNull(data, "data");
        Objects.requireNonNull(report, "report");
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=ReportTest -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/RecoveryReport.java \
        server/java/render/src/main/java/com/metaobjects/render/recover/RecoverOptions.java \
        server/java/render/src/main/java/com/metaobjects/render/recover/RecoverOutcome.java \
        server/java/render/src/test/java/com/metaobjects/render/recover/ReportTest.java
git commit -m "feat(render): FR-010 RecoveryReport, RecoverOptions, RecoverOutcome"
```

---

## Task 2: Stage 1 — `Strip` (fences / prose / preamble)

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/Strip.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/StripTest.java`

**Behavior contract:** `Strip.strip(raw)` returns the text with markdown code fences unwrapped (```` ```json ... ``` ````, ```` ```xml ... ``` ````, or bare ```` ``` ````), and surrounding conversational text left intact for `Locate` to handle (Strip only removes *fence markers*, not prose — prose removal is `Locate`'s job by span isolation). It never throws; on no fences it returns the input unchanged (trimmed of leading/trailing whitespace only).

- [ ] **Step 1: Write the failing test**

```java
// StripTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import static org.junit.Assert.*;

public class StripTest {

    @Test
    public void unwrapsJsonFence() {
        String in = "Sure! Here you go:\n```json\n{\"a\":1}\n```\nHope that helps.";
        String out = Strip.strip(in);
        assertTrue(out.contains("{\"a\":1}"));
        assertFalse(out.contains("```"));
    }

    @Test
    public void unwrapsBareFence() {
        assertEquals("{\"a\":1}", Strip.strip("```\n{\"a\":1}\n```").trim());
    }

    @Test
    public void unwrapsXmlFence() {
        String out = Strip.strip("```xml\n<a>1</a>\n```");
        assertTrue(out.contains("<a>1</a>"));
        assertFalse(out.contains("```"));
    }

    @Test
    public void noFenceReturnsTrimmedInput() {
        assertEquals("{\"a\":1}", Strip.strip("   {\"a\":1}   "));
    }

    @Test
    public void nullSafe() {
        assertEquals("", Strip.strip(null));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=StripTest -q`
Expected: COMPILE FAILURE — `Strip` does not exist.

- [ ] **Step 3: Implement `Strip`**

```java
// Strip.java
package com.metaobjects.render.recover;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stage 1: remove markdown code-fence markers. Prose around the payload is left for Locate. */
public final class Strip {
    private Strip() {}

    // Captures the body inside a fenced block; optional language tag (json/xml/etc) is dropped.
    private static final Pattern FENCE = Pattern.compile(
            "```[a-zA-Z0-9_-]*\\s*\\r?\\n(.*?)\\r?\\n?```",
            Pattern.DOTALL);

    public static String strip(String raw) {
        if (raw == null) return "";
        Matcher m = FENCE.matcher(raw);
        if (m.find()) {
            // Keep text before+after the first fenced block so Locate still sees context if needed,
            // but replace the fence with just its body.
            StringBuilder sb = new StringBuilder();
            sb.append(raw, 0, m.start());
            sb.append(m.group(1));
            sb.append(raw.substring(m.end()));
            return sb.toString().trim();
        }
        return raw.trim();
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=StripTest -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/Strip.java \
        server/java/render/src/test/java/com/metaobjects/render/recover/StripTest.java
git commit -m "feat(render): FR-010 recover stage 1 — fence stripping"
```

---

## Task 3: Stages 2–3 — `Locate` (isolate + score/select the root span)

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/Locate.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/LocateTest.java`

**Behavior contract:**
- `Locate.json(text)` → the substring of the first **balanced** `{ ... }` object (brace-counting, string-aware so braces inside strings don't count). If the outermost object is unterminated (truncated), returns from the first `{` to end-of-text (bounded prefix recovery feeds the forgiving reader). Returns `null` if no `{` exists.
- `Locate.xml(text, rootName, caseInsensitive)` → the substring spanning `<rootName ...> ... </rootName>`. If the close tag is absent (unclosed root), returns from the opening tag to end-of-text. Tag matching honors `caseInsensitive`. Returns `null` if no opening tag.
- **Score/select:** when multiple candidate roots exist, pick the **first** balanced/closed candidate; if none is closed, pick the first opener. This ordering is part of the cross-port classification contract — first-closed-else-first-open, deterministic.

- [ ] **Step 1: Write the failing test**

```java
// LocateTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import static org.junit.Assert.*;

public class LocateTest {

    @Test
    public void jsonIsolatesBalancedObjectFromProse() {
        String in = "Here is the result: {\"a\":1,\"b\":{\"c\":2}} — done.";
        assertEquals("{\"a\":1,\"b\":{\"c\":2}}", Locate.json(in));
    }

    @Test
    public void jsonIgnoresBracesInsideStrings() {
        String in = "{\"text\":\"a } not a close\",\"n\":1}";
        assertEquals(in, Locate.json(in));
    }

    @Test
    public void jsonTruncatedReturnsPrefixToEnd() {
        String in = "prefix {\"a\":1,\"b\":";   // stream cut off
        assertEquals("{\"a\":1,\"b\":", Locate.json(in));
    }

    @Test
    public void jsonNoBraceReturnsNull() {
        assertNull(Locate.json("no object here"));
    }

    @Test
    public void jsonFirstClosedCandidateWins() {
        String in = "noise {\"a\":1} tail {\"b\":2}";
        assertEquals("{\"a\":1}", Locate.json(in));
    }

    @Test
    public void xmlSpansRoot() {
        String in = "blah <answer><t>hi</t></answer> blah";
        assertEquals("<answer><t>hi</t></answer>", Locate.xml(in, "answer", false));
    }

    @Test
    public void xmlUnclosedRootReturnsToEnd() {
        String in = "x <answer><t>hi</t>";
        assertEquals("<answer><t>hi</t>", Locate.xml(in, "answer", false));
    }

    @Test
    public void xmlCaseInsensitiveMatch() {
        String in = "<Answer><t>hi</t></Answer>";
        assertEquals("<Answer><t>hi</t></Answer>", Locate.xml(in, "answer", true));
    }

    @Test
    public void xmlNoOpenReturnsNull() {
        assertNull(Locate.xml("nothing", "answer", false));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=LocateTest -q`
Expected: COMPILE FAILURE — `Locate` does not exist.

- [ ] **Step 3: Implement `Locate`**

```java
// Locate.java
package com.metaobjects.render.recover;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stages 2–3: isolate and select the payload root span. Selection rule: first-closed-else-first-open. */
public final class Locate {
    private Locate() {}

    /** First balanced {...}; if none closes, first '{' to end; null if no '{'. */
    public static String json(String text) {
        if (text == null) return null;
        int firstOpen = -1;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '{') {
                if (firstOpen < 0) firstOpen = i;
                int end = scanBalanced(text, i);
                if (end >= 0) return text.substring(i, end + 1);
            }
        }
        return firstOpen < 0 ? null : text.substring(firstOpen);
    }

    /** Returns index of the matching '}', or -1 if unterminated. String-aware. */
    private static int scanBalanced(String s, int open) {
        int depth = 0;
        boolean inStr = false;
        boolean esc = false;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inStr) {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
                continue;
            }
            if (c == '"') inStr = true;
            else if (c == '{') depth++;
            else if (c == '}') { depth--; if (depth == 0) return i; }
        }
        return -1;
    }

    /** Span of <root>...</root>; if close absent, opener to end; null if no opener. */
    public static String xml(String text, String rootName, boolean caseInsensitive) {
        if (text == null || rootName == null) return null;
        int flags = caseInsensitive ? Pattern.CASE_INSENSITIVE : 0;
        Matcher open = Pattern.compile("<" + Pattern.quote(rootName) + "(\\s[^>]*)?>", flags).matcher(text);
        if (!open.find()) return null;
        int start = open.start();
        Matcher close = Pattern.compile("</" + Pattern.quote(rootName) + "\\s*>", flags).matcher(text);
        if (close.find(open.end())) return text.substring(start, close.end());
        return text.substring(start);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=LocateTest -q`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/Locate.java \
        server/java/render/src/test/java/com/metaobjects/render/recover/LocateTest.java
git commit -m "feat(render): FR-010 recover stages 2-3 — locate + score/select root span"
```

---

## Task 4: Stage 4 (JSON) — `JsonForgivingReader`

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/JsonForgivingReader.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/JsonForgivingReaderTest.java`

**Behavior contract:** `read(span)` parses a *top-level object* into a `Map<String,Object>` of **raw string-or-nested values**, tolerating: trailing commas, single-quoted strings/keys, unquoted keys, and **truncation** (unclosed braces/strings → recover all fully-read top-level keys; a key whose value is cut off is omitted from the map so the extract stage classifies it `malformed`). Values are returned as: `String` for scalars (un-coerced — coercion is stage 7), `Map<String,Object>` for nested objects, `List<Object>` for arrays. Never throws; on unrecoverable garbage returns an empty map. Nested truncation is best-effort (return what parsed).

This reader is intentionally bounded to the corpus's malformation set. It is hand-rolled (not Jackson) so the behavior is identical when re-implemented per port.

- [ ] **Step 1: Write the failing test (pins the bounded malformation set)**

```java
// JsonForgivingReaderTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class JsonForgivingReaderTest {

    private Map<String, Object> read(String s) { return new JsonForgivingReader().read(s); }

    @Test
    public void cleanObject() {
        Map<String, Object> m = read("{\"a\":\"1\",\"b\":\"two\"}");
        assertEquals("1", m.get("a"));
        assertEquals("two", m.get("b"));
    }

    @Test
    public void trailingComma() {
        Map<String, Object> m = read("{\"a\":\"1\",}");
        assertEquals("1", m.get("a"));
        assertEquals(1, m.size());
    }

    @Test
    public void singleQuotes() {
        Map<String, Object> m = read("{'a':'1'}");
        assertEquals("1", m.get("a"));
    }

    @Test
    public void unquotedKeys() {
        Map<String, Object> m = read("{a:\"1\",b:\"2\"}");
        assertEquals("1", m.get("a"));
        assertEquals("2", m.get("b"));
    }

    @Test
    public void nestedObject() {
        Map<String, Object> m = read("{\"a\":{\"b\":\"1\"}}");
        assertEquals("1", ((Map<?, ?>) m.get("a")).get("b"));
    }

    @Test
    public void arrayValues() {
        Map<String, Object> m = read("{\"xs\":[\"a\",\"b\"]}");
        assertEquals(List.of("a", "b"), m.get("xs"));
    }

    @Test
    public void truncatedRecoversCompletePrefixKeys() {
        // value of "c" cut off → "a","b" recovered, "c" absent
        Map<String, Object> m = read("{\"a\":\"1\",\"b\":\"2\",\"c\":");
        assertEquals("1", m.get("a"));
        assertEquals("2", m.get("b"));
        assertFalse(m.containsKey("c"));
    }

    @Test
    public void unrecoverableReturnsEmpty() {
        assertTrue(read("@@@@").isEmpty());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=JsonForgivingReaderTest -q`
Expected: COMPILE FAILURE — `JsonForgivingReader` does not exist.

- [ ] **Step 3: Implement `JsonForgivingReader`**

Implement a small recursive-descent reader with a cursor. Key rules: skip whitespace; a "string" may be `"`-delimited or `'`-delimited; a key may be a string or a bare identifier (`[A-Za-z_][A-Za-z0-9_]*`) terminated by `:`; after each `key:value` pair, consume an optional `,` (a trailing comma before `}` is fine); on EOF mid-pair, stop and return what was read (truncation). Arrays mirror objects. Scalars are read as raw token text up to the next structural char (`,`, `}`, `]`) and returned as `String`. Commit a complete implementation; the test set above is the behavioral spec it must satisfy.

```java
// JsonForgivingReader.java
package com.metaobjects.render.recover;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Stage-4 tolerant JSON reader for the bounded corpus malformation set. Never throws. */
public final class JsonForgivingReader {
    private String s;
    private int i;

    public Map<String, Object> read(String span) {
        this.s = span == null ? "" : span;
        this.i = 0;
        ws();
        if (i >= s.length() || s.charAt(i) != '{') return new LinkedHashMap<>();
        Object o = readValue();
        return (o instanceof Map) ? castMap(o) : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object o) { return (Map<String, Object>) o; }

    private Object readValue() {
        ws();
        if (i >= s.length()) return null;
        char c = s.charAt(i);
        if (c == '{') return readObject();
        if (c == '[') return readArray();
        if (c == '"' || c == '\'') return readString(c);
        return readBareScalar();
    }

    private Object readObject() {
        Map<String, Object> m = new LinkedHashMap<>();
        i++; // consume '{'
        while (true) {
            ws();
            if (i >= s.length()) return m;            // truncation
            if (s.charAt(i) == '}') { i++; return m; }
            String key = readKey();
            if (key == null) return m;                 // truncation mid-key
            ws();
            if (i >= s.length() || s.charAt(i) != ':') return m; // truncation before value
            i++; // consume ':'
            int before = i;
            ws();
            if (i >= s.length()) return m;             // value cut off → key omitted
            Object v = readValue();
            if (v == null && i <= before) return m;    // nothing readable → stop
            m.put(key, v);
            ws();
            if (i < s.length() && s.charAt(i) == ',') i++; // optional/trailing comma
        }
    }

    private Object readArray() {
        List<Object> xs = new ArrayList<>();
        i++; // consume '['
        while (true) {
            ws();
            if (i >= s.length()) return xs;
            if (s.charAt(i) == ']') { i++; return xs; }
            Object v = readValue();
            if (v != null) xs.add(v);
            ws();
            if (i < s.length() && s.charAt(i) == ',') i++;
            else if (i < s.length() && s.charAt(i) == ']') { i++; return xs; }
            else if (i >= s.length()) return xs;
        }
    }

    private String readKey() {
        ws();
        if (i >= s.length()) return null;
        char c = s.charAt(i);
        if (c == '"' || c == '\'') return (String) readString(c);
        // bare identifier key
        int start = i;
        while (i < s.length() && (Character.isLetterOrDigit(s.charAt(i)) || s.charAt(i) == '_')) i++;
        return i > start ? s.substring(start, i) : null;
    }

    private Object readString(char quote) {
        i++; // opening quote
        StringBuilder sb = new StringBuilder();
        boolean esc = false;
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (esc) { sb.append(unescape(c)); esc = false; }
            else if (c == '\\') esc = true;
            else if (c == quote) return sb.toString();
            else sb.append(c);
        }
        return sb.toString(); // unterminated string → return what we have
    }

    private static char unescape(char c) {
        return switch (c) { case 'n' -> '\n'; case 't' -> '\t'; case 'r' -> '\r'; default -> c; };
    }

    private Object readBareScalar() {
        int start = i;
        while (i < s.length() && ",}]".indexOf(s.charAt(i)) < 0) i++;
        return s.substring(start, i).trim();
    }

    private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=JsonForgivingReaderTest -q`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/JsonForgivingReader.java \
        server/java/render/src/test/java/com/metaobjects/render/recover/JsonForgivingReaderTest.java
git commit -m "feat(render): FR-010 recover stage 4 (JSON) — forgiving reader + bounded prefix recovery"
```

---

## Task 5: Stage 4 (XML) — `XmlForgivingReader`

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/XmlForgivingReader.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/XmlForgivingReaderTest.java`

**Behavior contract:** `read(span, caseInsensitive)` parses a single root element's **direct children** into a `Map<String,Object>` keyed by child tag name (lower-cased when `caseInsensitive`). Each child's value is its inner text (`String`), or a nested `Map` if the child has element children. Repeated sibling tags collapse to a `List<Object>`. Tolerates: attribute-quote variants (single/double/none — attributes are ignored for value extraction), mis-cased tags (when `caseInsensitive`), and **unclosed tags** (a child that opens but never closes recovers its inner text up to the next sibling-open or end-of-span — innermost-first, mirroring HTML5/sloppy-xml recovery). Never throws.

- [ ] **Step 1: Write the failing test**

```java
// XmlForgivingReaderTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class XmlForgivingReaderTest {

    private Map<String, Object> read(String s, boolean ci) {
        return new XmlForgivingReader().read(s, ci);
    }

    @Test
    public void flatChildren() {
        Map<String, Object> m = read("<answer><t>hi</t><c>HIGH</c></answer>", false);
        assertEquals("hi", m.get("t"));
        assertEquals("HIGH", m.get("c"));
    }

    @Test
    public void nestedElement() {
        Map<String, Object> m = read("<answer><meta><n>1</n></meta></answer>", false);
        assertEquals("1", ((Map<?, ?>) m.get("meta")).get("n"));
    }

    @Test
    public void repeatedSiblingsCollapseToList() {
        Map<String, Object> m = read("<answer><x>a</x><x>b</x></answer>", false);
        assertEquals(List.of("a", "b"), m.get("x"));
    }

    @Test
    public void attributesIgnoredForValue() {
        Map<String, Object> m = read("<answer><t lang='en' n=2>hi</t></answer>", false);
        assertEquals("hi", m.get("t"));
    }

    @Test
    public void unclosedChildRecoversInnerText() {
        // <t> never closes; recover up to next sibling open
        Map<String, Object> m = read("<answer><t>hi<c>HIGH</c></answer>", false);
        assertEquals("hi", m.get("t"));
        assertEquals("HIGH", m.get("c"));
    }

    @Test
    public void caseInsensitiveTags() {
        Map<String, Object> m = read("<Answer><T>hi</T></Answer>", true);
        assertEquals("hi", m.get("t"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=XmlForgivingReaderTest -q`
Expected: COMPILE FAILURE — `XmlForgivingReader` does not exist.

- [ ] **Step 3: Implement `XmlForgivingReader`**

Implement a tolerant tag scanner: find the root's inner span (between its `>` and matching `</root>` or end), then iterate child opening tags. For each `<tag ...>`, find its matching `</tag>` (case-folded if requested); if absent, the child's content runs until the next sibling `<...>` open or end-of-span (unclosed recovery). If the child's content itself contains element tags, recurse to a nested `Map`; otherwise the content is trimmed inner text. Accumulate repeated keys into a `List`. Commit a complete implementation satisfying the tests above; the tests are the behavioral spec.

```java
// XmlForgivingReader.java
package com.metaobjects.render.recover;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws. */
public final class XmlForgivingReader {

    public Map<String, Object> read(String span, boolean caseInsensitive) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (span == null || span.isBlank()) return out;
        int gt = span.indexOf('>');
        if (gt < 0) return out;
        int rootEnd = lastIndexOfCloseTag(span);
        String inner = span.substring(gt + 1, rootEnd < 0 ? span.length() : rootEnd);
        parseChildren(inner, caseInsensitive, out);
        return out;
    }

    private static int lastIndexOfCloseTag(String span) {
        int i = span.lastIndexOf("</");
        return i;
    }

    private void parseChildren(String inner, boolean ci, Map<String, Object> out) {
        Pattern openTag = Pattern.compile("<([A-Za-z_][A-Za-z0-9_]*)(\\s[^>]*)?>");
        Matcher m = openTag.matcher(inner);
        int pos = 0;
        while (m.find(pos)) {
            String tag = m.group(1);
            String key = ci ? tag.toLowerCase() : tag;
            int contentStart = m.end();
            String closeRe = "</" + Pattern.quote(tag) + "\\s*>";
            Matcher close = Pattern.compile(closeRe, ci ? Pattern.CASE_INSENSITIVE : 0).matcher(inner);
            int contentEnd, next;
            if (close.find(contentStart)) { contentEnd = close.start(); next = close.end(); }
            else {
                // unclosed: content runs to next sibling open or end
                Matcher sib = openTag.matcher(inner);
                if (sib.find(contentStart)) { contentEnd = sib.start(); next = contentEnd; }
                else { contentEnd = inner.length(); next = inner.length(); }
            }
            String content = inner.substring(contentStart, contentEnd);
            Object value = content.contains("<")
                    ? nestedOrText(content, ci)
                    : content.trim();
            accumulate(out, key, value);
            pos = next;
        }
    }

    private Object nestedOrText(String content, boolean ci) {
        Map<String, Object> nested = new LinkedHashMap<>();
        parseChildren(content, ci, nested);
        return nested.isEmpty() ? content.trim() : nested;
    }

    @SuppressWarnings("unchecked")
    private void accumulate(Map<String, Object> out, String key, Object value) {
        if (!out.containsKey(key)) { out.put(key, value); return; }
        Object existing = out.get(key);
        if (existing instanceof List) { ((List<Object>) existing).add(value); }
        else { List<Object> list = new ArrayList<>(); list.add(existing); list.add(value); out.put(key, list); }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=XmlForgivingReaderTest -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/XmlForgivingReader.java \
        server/java/render/src/test/java/com/metaobjects/render/recover/XmlForgivingReaderTest.java
git commit -m "feat(render): FR-010 recover stage 4 (XML) — forgiving reader + unclosed-tag recovery"
```

---

## Task 6: Stage 7 — `Coerce` (enum alias/vocab, numeric range, type)

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/Coerce.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/CoerceTest.java`

**Behavior contract:** `Coerce.value(rawString, spec, opts, fieldPath, report)` returns the canonical coerced value and records any `Coercion`. Rules:
- **onField hook first:** if `opts.onField` returns non-null, use it (record `kind="onField"`).
- **ENUM:** if raw matches a declared value (case-insensitive when tolerance≠STRICT), canonicalize to the declared casing (record `kind="case"` if changed). Else look up alias: **runtime alias wins over schema alias** on conflict (record `kind="runtime-alias-override"` when both exist and differ; else `kind="alias"`). Else: value is off-vocabulary → return raw and the caller will classify the field `MALFORMED`.
- **INT/LONG/DOUBLE:** parse using `Double.parseDouble`/`Long.parseLong` with **invariant** formatting (no locale). If `min`/`max` set and value out of range, **clamp** and record `kind="clamp"`. If unparseable → return null (caller classifies `MALFORMED`).
- **BOOLEAN:** `true/false/yes/no/1/0` (case-insensitive when tolerance≠STRICT).
- **STRING:** identity.

Returns a sentinel `Coerce.MALFORMED` object when the value is present but cannot be coerced, so the extract stage can distinguish malformed-but-present from absent.

- [ ] **Step 1: Write the failing test**

```java
// CoerceTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class CoerceTest {

    private RecoveryReport rep;
    private RecoverOptions normal() { return RecoverOptions.defaults(); }

    @org.junit.Before public void setup() { rep = new RecoveryReport(); }

    @Test
    public void enumExactMatch() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY", "HOSTILE"), Map.of());
        assertEquals("FRIENDLY", Coerce.value("FRIENDLY", f, normal(), "tone", rep));
    }

    @Test
    public void enumCaseFoldedInNormal() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY"), Map.of());
        assertEquals("FRIENDLY", Coerce.value("friendly", f, normal(), "tone", rep));
    }

    @Test
    public void enumStrictDoesNotCaseFold() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY"), Map.of());
        assertEquals(Coerce.MALFORMED, Coerce.value("friendly", f, normal().withTolerance(Tolerance.STRICT), "tone", rep));
    }

    @Test
    public void enumSchemaAliasFolds() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY"), Map.of("warm", "FRIENDLY"));
        assertEquals("FRIENDLY", Coerce.value("warm", f, normal(), "tone", rep));
        assertTrue(rep.coercions().stream().anyMatch(c -> c.kind().equals("alias")));
    }

    @Test
    public void runtimeAliasWinsOverSchema() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY", "HOSTILE"), Map.of("x", "FRIENDLY"));
        RecoverOptions opts = new RecoverOptions(Tolerance.NORMAL, Map.of("x", "HOSTILE"), Map.of(), null);
        assertEquals("HOSTILE", Coerce.value("x", f, opts, "tone", rep));
        assertTrue(rep.coercions().stream().anyMatch(c -> c.kind().equals("runtime-alias-override")));
    }

    @Test
    public void enumOffVocabIsMalformed() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY"), Map.of());
        assertEquals(Coerce.MALFORMED, Coerce.value("banana", f, normal(), "tone", rep));
    }

    @Test
    public void intClampToRange() {
        FieldSpec f = FieldSpec.range("score", FieldKind.INT, true, 0.0, 10.0);
        assertEquals(10L, Coerce.value("42", f, normal(), "score", rep));
        assertTrue(rep.coercions().stream().anyMatch(c -> c.kind().equals("clamp")));
    }

    @Test
    public void intUnparseableMalformed() {
        FieldSpec f = FieldSpec.scalar("score", FieldKind.INT, true);
        assertEquals(Coerce.MALFORMED, Coerce.value("abc", f, normal(), "score", rep));
    }

    @Test
    public void booleanForms() {
        FieldSpec f = FieldSpec.scalar("ok", FieldKind.BOOLEAN, true);
        assertEquals(Boolean.TRUE, Coerce.value("yes", f, normal(), "ok", rep));
        assertEquals(Boolean.FALSE, Coerce.value("0", f, normal(), "ok", rep));
    }

    @Test
    public void onFieldHookWins() {
        FieldSpec f = FieldSpec.scalar("x", FieldKind.STRING, true);
        RecoverOptions opts = new RecoverOptions(Tolerance.NORMAL, Map.of(), Map.of(),
                (path, raw, spec) -> "HOOKED");
        assertEquals("HOOKED", Coerce.value("anything", f, opts, "x", rep));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=CoerceTest -q`
Expected: COMPILE FAILURE — `Coerce` does not exist.

- [ ] **Step 3: Implement `Coerce`**

```java
// Coerce.java
package com.metaobjects.render.recover;

/** Stage 7: canonicalize a raw scalar string per its FieldSpec. Returns MALFORMED sentinel when present-but-uncoercible. */
public final class Coerce {
    private Coerce() {}

    /** Sentinel: the value was present but could not be coerced to the declared kind/vocabulary. */
    public static final Object MALFORMED = new Object();

    public static Object value(String raw, FieldSpec spec, RecoverOptions opts, String fieldPath, RecoveryReport report) {
        if (raw == null) return MALFORMED;
        // 1) bespoke hook wins
        if (opts.onField() != null) {
            Object hooked = opts.onField().coerce(fieldPath, raw, spec);
            if (hooked != null) { report.addCoercion(new Coercion(fieldPath, raw, String.valueOf(hooked), "onField")); return hooked; }
        }
        boolean ci = opts.tolerance() != Tolerance.STRICT;
        return switch (spec.kind()) {
            case ENUM -> coerceEnum(raw, spec, opts, fieldPath, report, ci);
            case INT, LONG -> coerceInt(raw, spec, fieldPath, report);
            case DOUBLE -> coerceDouble(raw, spec, fieldPath, report);
            case BOOLEAN -> coerceBool(raw, ci);
            default -> raw; // STRING / OBJECT inner text
        };
    }

    private static Object coerceEnum(String raw, FieldSpec spec, RecoverOptions opts,
                                     String path, RecoveryReport report, boolean ci) {
        if (spec.enumValues() != null) {
            for (String v : spec.enumValues()) {
                if (v.equals(raw)) return v;
                if (ci && v.equalsIgnoreCase(raw)) {
                    report.addCoercion(new Coercion(path, raw, v, "case"));
                    return v;
                }
            }
        }
        String schemaTarget = spec.enumAlias() == null ? null : spec.enumAlias().get(raw);
        String runtimeTarget = opts.aliases().get(raw);
        if (runtimeTarget != null) {
            String kind = (schemaTarget != null && !schemaTarget.equals(runtimeTarget))
                    ? "runtime-alias-override" : "alias";
            report.addCoercion(new Coercion(path, raw, runtimeTarget, kind));
            return runtimeTarget;
        }
        if (schemaTarget != null) {
            report.addCoercion(new Coercion(path, raw, schemaTarget, "alias"));
            return schemaTarget;
        }
        return MALFORMED;
    }

    private static Object coerceInt(String raw, FieldSpec spec, String path, RecoveryReport report) {
        try {
            long n = Long.parseLong(raw.trim());
            return clamp((double) n, spec, path, report, true);
        } catch (NumberFormatException e) {
            try { return clamp(Double.parseDouble(raw.trim()), spec, path, report, true); }
            catch (NumberFormatException e2) { return MALFORMED; }
        }
    }

    private static Object coerceDouble(String raw, FieldSpec spec, String path, RecoveryReport report) {
        try { return clamp(Double.parseDouble(raw.trim()), spec, path, report, false); }
        catch (NumberFormatException e) { return MALFORMED; }
    }

    private static Object clamp(double n, FieldSpec spec, String path, RecoveryReport report, boolean asLong) {
        double c = n;
        if (spec.min() != null && c < spec.min()) c = spec.min();
        if (spec.max() != null && c > spec.max()) c = spec.max();
        if (c != n) report.addCoercion(new Coercion(path, String.valueOf(n), String.valueOf(c), "clamp"));
        return asLong ? (Object) (long) c : (Object) c;
    }

    private static Object coerceBool(String raw, boolean ci) {
        String t = ci ? raw.trim().toLowerCase() : raw.trim();
        return switch (t) {
            case "true", "yes", "1" -> Boolean.TRUE;
            case "false", "no", "0" -> Boolean.FALSE;
            default -> MALFORMED;
        };
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=CoerceTest -q`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/Coerce.java \
        server/java/render/src/test/java/com/metaobjects/render/recover/CoerceTest.java
git commit -m "feat(render): FR-010 recover stage 7 — enum alias/vocab + numeric range coercion"
```

---

## Task 7: `Recover` entry point — assemble stages 4–6 + 8 (extract, classify, empty-guard)

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/Recover.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/RecoverTest.java`

**Behavior contract:** `Recover.recover(text, schema, opts)` runs Strip → Locate → forgiving read → per-field extract+default+classify → Coerce → report, and never throws. Per-field classification (stage 4–6):
- field present + coerces cleanly → value in `data`, state `RECOVERED`.
- field present but `Coerce.MALFORMED` (off-vocab / unparseable / out-of-coercion) → omit from `data`, state `MALFORMED`.
- field absent + optional → state `LOST_OPTIONAL` (no default declared in Plan 1's descriptor; a future `@default` rides here).
- field absent + required → state `LOST_REQUIRED`.
- Degenerate input (Locate returns null, or reader returns empty map AND text was blank) → `report.markEmpty()` and every required field `LOST_REQUIRED`.
- A nested OBJECT field recurses with its `nested` schema; its child states are reported under dotted paths (`parent.child`).

- [ ] **Step 1: Write the failing test**

```java
// RecoverTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class RecoverTest {

    private RecoverSchema jsonAnswer() {
        return new RecoverSchema(Format.JSON, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true),
                FieldSpec.enumField("confidence", true, List.of("HIGH", "OK", "LOW"), Map.of("medium", "OK")),
                FieldSpec.scalar("note", FieldKind.STRING, false)));
    }

    @Test
    public void cleanJsonAllRecovered() {
        RecoverOutcome o = Recover.recover(
                "{\"text\":\"hi\",\"confidence\":\"HIGH\",\"note\":\"n\"}", jsonAnswer(), RecoverOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals("HIGH", o.data().get("confidence"));
        assertEquals(FieldRecovery.RECOVERED, o.report().states().get("confidence"));
        assertFalse(o.report().hasLostRequired());
    }

    @Test
    public void fencedAndProseWrappedStillRecovers() {
        String dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"HIGH\"}\n```\nDone.";
        RecoverOutcome o = Recover.recover(dirty, jsonAnswer(), RecoverOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals(FieldRecovery.LOST_OPTIONAL, o.report().states().get("note"));
    }

    @Test
    public void aliasFoldsOffVocab() {
        RecoverOutcome o = Recover.recover(
                "{\"text\":\"hi\",\"confidence\":\"medium\"}", jsonAnswer(), RecoverOptions.defaults());
        assertEquals("OK", o.data().get("confidence"));
        assertEquals(FieldRecovery.RECOVERED, o.report().states().get("confidence"));
    }

    @Test
    public void offVocabRequiredIsMalformed() {
        RecoverOutcome o = Recover.recover(
                "{\"text\":\"hi\",\"confidence\":\"banana\"}", jsonAnswer(), RecoverOptions.defaults());
        assertEquals(FieldRecovery.MALFORMED, o.report().states().get("confidence"));
        assertFalse(o.data().containsKey("confidence"));
    }

    @Test
    public void missingRequiredIsLostRequired() {
        RecoverOutcome o = Recover.recover("{\"text\":\"hi\"}", jsonAnswer(), RecoverOptions.defaults());
        assertEquals(List.of("confidence"), o.report().lostRequired());
    }

    @Test
    public void emptyResponseFlagsEmptyAndAllRequiredLost() {
        RecoverOutcome o = Recover.recover("   ", jsonAnswer(), RecoverOptions.defaults());
        assertTrue(o.report().isEmpty());
        assertTrue(o.report().lostRequired().contains("text"));
        assertTrue(o.report().lostRequired().contains("confidence"));
    }

    @Test
    public void xmlUnclosedTagRecovers() {
        RecoverSchema xml = new RecoverSchema(Format.XML, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true),
                FieldSpec.enumField("confidence", true, List.of("HIGH"), Map.of())));
        RecoverOutcome o = Recover.recover("<answer><text>hi<confidence>HIGH</confidence></answer>",
                xml, RecoverOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals("HIGH", o.data().get("confidence"));
    }

    @Test
    public void neverThrowsOnGarbage() {
        RecoverOutcome o = Recover.recover("@@@ totally broken @@@", jsonAnswer(), RecoverOptions.defaults());
        assertTrue(o.report().isEmpty());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=RecoverTest -q`
Expected: COMPILE FAILURE — `Recover` does not exist.

- [ ] **Step 3: Implement `Recover`**

```java
// Recover.java
package com.metaobjects.render.recover;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Public entry point. Runs the 8-stage pipeline; never throws. */
public final class Recover {
    private Recover() {}

    public static RecoverOutcome recover(String text, RecoverSchema schema, RecoverOptions opts) {
        RecoverOptions o = opts == null ? RecoverOptions.defaults() : opts;
        RecoveryReport report = new RecoveryReport();
        Map<String, Object> data = new LinkedHashMap<>();

        String stripped = Strip.strip(text);
        boolean ci = o.tolerance() != Tolerance.STRICT;

        Map<String, Object> raw;
        if (schema.format() == Format.JSON) {
            String span = Locate.json(stripped);
            raw = span == null ? Map.of() : new JsonForgivingReader().read(span);
        } else {
            String span = Locate.xml(stripped, schema.rootName(), ci);
            raw = span == null ? Map.of() : new XmlForgivingReader().read(span, ci);
        }

        if (raw.isEmpty() && (stripped.isEmpty() || (schema.format() == Format.JSON ? Locate.json(stripped) == null
                : Locate.xml(stripped, schema.rootName(), ci) == null))) {
            report.markEmpty();
        }

        extract(schema.fields(), raw, "", data, report, o, ci);
        return new RecoverOutcome(data, report);
    }

    private static void extract(List<FieldSpec> fields, Map<String, Object> raw, String prefix,
                                Map<String, Object> data, RecoveryReport report, RecoverOptions o, boolean ci) {
        for (FieldSpec f : fields) {
            String path = prefix.isEmpty() ? f.name() : prefix + "." + f.name();
            Object present = lookup(raw, f.name(), ci);
            if (present == null) {
                report.set(path, f.required() ? FieldRecovery.LOST_REQUIRED : FieldRecovery.LOST_OPTIONAL);
                continue;
            }
            if (f.kind() == FieldKind.OBJECT && present instanceof Map<?, ?> nestedRaw && f.nested() != null) {
                Map<String, Object> nestedData = new LinkedHashMap<>();
                @SuppressWarnings("unchecked")
                Map<String, Object> nr = (Map<String, Object>) nestedRaw;
                extract(f.nested().fields(), nr, path, nestedData, report, o, ci);
                data.put(f.name(), nestedData);
                report.set(path, FieldRecovery.RECOVERED);
                continue;
            }
            String rawStr = present instanceof String s ? s : String.valueOf(present);
            Object coerced = Coerce.value(rawStr, f, o, path, report);
            if (coerced == Coerce.MALFORMED) {
                report.set(path, FieldRecovery.MALFORMED);
            } else {
                data.put(f.name(), coerced);
                report.set(path, FieldRecovery.RECOVERED);
            }
        }
    }

    /** Case-folding lookup honoring tolerance. */
    private static Object lookup(Map<String, Object> raw, String name, boolean ci) {
        if (raw.containsKey(name)) return raw.get(name);
        if (ci) {
            for (var e : raw.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=RecoverTest -q`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/Recover.java \
        server/java/render/src/test/java/com/metaobjects/render/recover/RecoverTest.java
git commit -m "feat(render): FR-010 recover entry point — extract, classify, empty-guard"
```

---

## Task 8: Dirty-input conformance corpus + parameterized Java runner

**Files:**
- Create (repo-root): `fixtures/recover-conformance/README.md`
- Create: `fixtures/recover-conformance/<case>/` directories (10 cases below), each with `schema.json`, `input.txt`, `expected.json`
- Create: `server/java/render/src/test/java/com/metaobjects/render/recover/RecoverConformanceTest.java`

**Fixture format (the cross-port contract — keep stable):**
- `schema.json` — a serialized `RecoverSchema` (format, rootName, fields). The Java runner deserializes it into a `RecoverSchema` via a small test helper (Jackson is already a test-scope dep of the render module).
- `input.txt` — the raw dirty model response.
- `expected.json` — `{ "empty": <bool>, "states": { "<fieldPath>": "<FieldRecovery>" }, "data": { "<field>": <canonicalValue> } }`. **The assertion is on `empty` + `states` (the classification) + `data` (canonical normalized values).** Numeric values use a documented tolerance: integers exact; doubles compared with epsilon `1e-9`.

**The 10 corpus cases (one malformation category each):**

| dir | category | format |
|---|---|---|
| `json-clean` | baseline clean | json |
| `json-fenced` | markdown code fence | json |
| `json-prose-wrapped` | conversational prose around payload | json |
| `json-preamble` | reasoning preamble before payload | json |
| `json-trailing-comma` | trailing comma + single quotes | json |
| `json-truncated` | stream cut off mid-object (bounded prefix recovery) | json |
| `json-off-vocab-alias` | enum value folds via alias | json |
| `json-out-of-range` | numeric clamp | json |
| `xml-unclosed-tag` | unclosed child tag recovery | xml |
| `empty-response` | whitespace-only → empty state | json |

- [ ] **Step 1: Write the corpus README + the 10 fixtures**

Create `fixtures/recover-conformance/README.md`:

```markdown
# recover-conformance — FR-010 dirty-input corpus

Each `<case>/` has:
- `schema.json` — serialized RecoverSchema (format, rootName, fields[])
- `input.txt`    — the raw (deliberately dirty) model response
- `expected.json` — { empty, states{path:FieldRecovery}, data{field:canonicalValue} }

Every port's `recover` runs this corpus. The conformance assertion is on `empty` +
`states` (per-field classification) + `data` (canonical normalized values). Raw numeric
coercion carries a documented tolerance: ints exact, doubles within 1e-9. Classification
is byte-identical across ports; raw coercion is not required to be.
```

Create each fixture. Example — `fixtures/recover-conformance/json-fenced/schema.json`:

```json
{
  "format": "JSON",
  "rootName": "answer",
  "fields": [
    { "name": "text", "kind": "STRING", "required": true },
    { "name": "confidence", "kind": "ENUM", "required": true,
      "enumValues": ["HIGH", "OK", "LOW"], "enumAlias": { "medium": "OK" } },
    { "name": "note", "kind": "STRING", "required": false }
  ]
}
```

`fixtures/recover-conformance/json-fenced/input.txt`:

```
Sure! Here's the result:
```json
{"text":"hello","confidence":"HIGH"}
```
Hope that helps!
```

`fixtures/recover-conformance/json-fenced/expected.json`:

```json
{
  "empty": false,
  "states": { "text": "RECOVERED", "confidence": "RECOVERED", "note": "LOST_OPTIONAL" },
  "data": { "text": "hello", "confidence": "HIGH" }
}
```

Author the remaining 9 cases analogously, each `input.txt` exhibiting exactly its category's malformation and each `expected.json` pinning the resulting classification + canonical data. Use the same `schema.json` (the `answer` schema above) for all JSON cases except `json-out-of-range` (add a `{ "name": "score", "kind": "INT", "required": true, "min": 0, "max": 10 }` field) and `xml-unclosed-tag` (`"format": "XML"`, fields `text` + `confidence`). For `json-truncated`, `input.txt` = `{"text":"hi","confidence":` and `expected.json` states `confidence` → `MALFORMED` (value cut off) — note: present-key-but-cutoff-value classifies MALFORMED per the Recover contract; if the key itself is absent it would be LOST_REQUIRED. For `empty-response`, `input.txt` is whitespace only and `expected.json` has `"empty": true` with both required fields `LOST_REQUIRED`.

- [ ] **Step 2: Write the failing parameterized runner**

```java
// RecoverConformanceTest.java
package com.metaobjects.render.recover;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

@RunWith(Parameterized.class)
public class RecoverConformanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CORPUS;
    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/recover-conformance"))) p = p.getParent();
        CORPUS = p == null ? null : p.resolve("fixtures/recover-conformance");
    }

    private final Path dir;
    public RecoverConformanceTest(String name, Path dir) { this.dir = dir; }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> cases() throws IOException {
        if (CORPUS == null || !Files.isDirectory(CORPUS)) return List.of();
        try (Stream<Path> s = Files.list(CORPUS)) {
            return s.filter(Files::isDirectory).sorted()
                    .map(d -> new Object[]{ d.getFileName().toString(), d })
                    .collect(Collectors.toList());
        }
    }

    @Test
    public void classificationAndCanonicalValueMatch() throws IOException {
        RecoverSchema schema = parseSchema(JSON.readTree(dir.resolve("schema.json").toFile()));
        String input = Files.readString(dir.resolve("input.txt"));
        JsonNode expected = JSON.readTree(dir.resolve("expected.json").toFile());

        RecoverOutcome out = Recover.recover(input, schema, RecoverOptions.defaults());

        assertEquals(dir + " empty flag", expected.get("empty").asBoolean(), out.report().isEmpty());

        JsonNode states = expected.get("states");
        states.fieldNames().forEachRemaining(path ->
            assertEquals(dir + " state[" + path + "]",
                    states.get(path).asText(), String.valueOf(out.report().states().get(path))));

        JsonNode data = expected.get("data");
        data.fieldNames().forEachRemaining(field ->
            assertCanonical(dir + " data[" + field + "]", data.get(field), out.data().get(field)));
    }

    private static void assertCanonical(String msg, JsonNode expected, Object actual) {
        if (expected.isNumber() && actual instanceof Number n) {
            assertEquals(msg, expected.asDouble(), n.doubleValue(), 1e-9);
        } else {
            assertEquals(msg, expected.asText(), String.valueOf(actual));
        }
    }

    private static RecoverSchema parseSchema(JsonNode n) {
        Format fmt = Format.valueOf(n.get("format").asText());
        String root = n.get("rootName").asText();
        List<FieldSpec> fields = new ArrayList<>();
        for (JsonNode f : n.get("fields")) fields.add(parseField(f));
        return new RecoverSchema(fmt, root, fields);
    }

    private static FieldSpec parseField(JsonNode f) {
        String name = f.get("name").asText();
        FieldKind kind = FieldKind.valueOf(f.get("kind").asText());
        boolean req = f.has("required") && f.get("required").asBoolean();
        if (kind == FieldKind.ENUM) {
            List<String> vals = new ArrayList<>();
            if (f.has("enumValues")) f.get("enumValues").forEach(v -> vals.add(v.asText()));
            Map<String, String> aliases = new java.util.LinkedHashMap<>();
            if (f.has("enumAlias"))
                f.get("enumAlias").fields().forEachRemaining(e -> aliases.put(e.getKey(), e.getValue().asText()));
            return FieldSpec.enumField(name, req, vals, aliases);
        }
        if (f.has("min") || f.has("max")) {
            Double min = f.has("min") ? f.get("min").asDouble() : null;
            Double max = f.has("max") ? f.get("max").asDouble() : null;
            return FieldSpec.range(name, kind, req, min, max);
        }
        return FieldSpec.scalar(name, kind, req);
    }
}
```

- [ ] **Step 3: Run to verify it fails first (no fixtures / mismatches), then passes after authoring**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=RecoverConformanceTest -q`
Expected on first run before fixtures are correct: FAIL (parameter list empty or assertion mismatches).
Iterate on the 10 `expected.json` files until: PASS (10 parameterized cases).

- [ ] **Step 4: Run the full render module suite (no regressions)**

Run: `cd server/java && mvn -pl :metaobjects-render test -q`
Expected: PASS — all new recover tests + all pre-existing render/verify tests green.

- [ ] **Step 5: Commit**

```bash
git add fixtures/recover-conformance/ \
        server/java/render/src/test/java/com/metaobjects/render/recover/RecoverConformanceTest.java
git commit -m "test(render): FR-010 dirty-input recover-conformance corpus + Java runner"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** Stages 1–8 (strip/locate/score-select/forgiving-read/extract/default/malformed-vs-absent/normalize/report) → Tasks 2–7. XML + JSON symmetry → Tasks 4/5. Bounded prefix recovery (OQ4) → Task 4 `truncatedRecoversCompletePrefixKeys` + `json-truncated` fixture. Frozen report enum (OQ5) → Task 0 `FieldRecovery`. Alias runtime-wins (OQ2) → Task 6 `runtimeAliasWinsOverSchema`. Case-insensitivity folded into tolerance (OQ3) → Task 6 `enumStrictDoesNotCaseFold` + Task 7 `lookup`. Tolerance presets/onField/alias-merge (bounded 20% surface) → Tasks 1/6. Classification + canonical-value conformance (the amended cross-port contract) → Task 8 runner. Empty/degenerate state → Task 7 `emptyResponseFlagsEmptyAndAllRequiredLost`.
- **Out-of-scope, intentionally deferred to Plan 2:** metamodel attrs, descriptor-from-VO codegen, generated `recover()`/`RecoveryResult<T>`, the output-prompt fragment generator, `verify` extension, clean `template-output-{xml,json}-simple` fixtures, round-trip property test. `@example`/`@instruction` carry no engine behavior, so their absence from `FieldSpec` is correct here.
- **Type consistency:** `RecoverOutcome(data, report)`, `RecoveryReport.states()/lostRequired()/isEmpty()`, `Coerce.value(...)` + `Coerce.MALFORMED`, `RecoverOptions.defaults()/withTolerance()`, `FieldSpec.scalar/enumField/range/object`, `RecoverSchema(format, rootName, fields)` are used identically across Tasks 0–8.

---

## Plan 2 (follow-on — written after Plan 1 lands)

Plan 2 builds the codegen + metamodel layer on top of this engine. Its tasks reference the concrete engine API above. Scope:
1. **Metamodel attrs (cross-port loaders):** register `@example`/`@instruction` (string) + `@enumDoc`/`@enumAlias` (`properties`) as field attrs in all five ports' loaders so the shared clean fixtures load. Java pattern = a new `*Attribute` class + a `registerTypes` call in `FieldTypesMetaDataProvider` (see investigation A.1).
2. **Artifact 2 — `recover` codegen:** extend `SpringOutputParserGenerator` to emit a `RecoverSchema` descriptor builder + a typed `RecoveryResult<Payload> recover(String text[, RecoverOptions opts])` that calls `Recover.recover(...)` and maps the `Map<String,Object>` onto the payload record. Emit only for `@format ∈ {xml,json}`.
3. **Artifact 1 — `SpringOutputPromptGenerator`:** new generator emitting `<Template>OutputPrompt.renderFormat([overrides])` producing the format-instruction fragment (skeleton + per-field guidance from `@example`/`@enumDoc`/`@instruction`/required-marking), thin over a shared fragment-renderer in the render module.
4. **`verify` extension:** add the `output-prompt` coverage check + the build-time round-trip check (`recover(renderFormat())` structurally complete) to `render/Verify` + verify-conformance corpus. Confirm/expand the `meta:verify` maven-goal wiring (currently DB-drift only).
5. **Clean conformance fixtures:** `fixtures/conformance/template-output-{xml,json}-simple/` with Java `expected/` for both the prompt fragment and the parser-with-recover.

# FR-010 Java Plan 3 — output-format prompt-fragment generator (`@promptStyle`) + verify + clean fixtures

> **STATUS: IMPLEMENTED & MERGED (2026-05-29).** The merged code is the reference. Notable
> adaptations during execution: `@promptStyle`'s closed-enum enforcement lives in
> `ValidationPhase.validateTemplateNode` (R5), mirroring how `@format` is enforced (abstract-base
> `.withEnum()` doesn't fire for concrete subtypes), not in the registration constraint;
> `OutputFormatSpecEmitter` applies `javaStringLiteral` escaping to free-text `@example`/`@instruction`/`@enumDoc`
> (the hardening Plan 2 deferred) and uses `Map.ofEntries`. The compile-and-run proof caught two real
> missing-import codegen bugs; the renderer review caught a NaN→invalid-JSON bug — all fixed. The
> verify-conformance corpus wiring for `output-prompt` was skipped (the harness has a different input
> shape) — unit tests cover it; cross-port corpus is a follow-up. Nested-object rendering deferred (Plan 3.1).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** From one `template.output` declaration, emit artifact 1 — a `renderXxxFormat([overrides])` that produces the "produce your answer like this" prompt fragment: a **comment-free**, pedagogy-first format-instruction block (skeleton in the declared `@format` + per-field guidance), laid out per a `@promptStyle` metadata attribute (`guide|inline|exampleOnly`, default `guide`), with a render-time override. Plus the `verify` output-prompt coverage + round-trip checks, and the cross-port clean fixtures.

**Architecture:** Thin codegen + a shared runtime `OutputFormatRenderer` in `metaobjects-render` (the artifact-1 twin of the recover engine). The generator bakes an `OutputFormatSpec` descriptor (structure + per-field teaching metadata) from the `@payloadRef` VO + the template's `@promptStyle`/`@format`, and emits a thin `<Template>OutputPrompt.renderFormat([Overrides])` that calls the renderer. Guidance is **never** in comments (models ignore XML comments; JSON has none) — `guide` uses a prose field-guide above a clean valid example; `inline` uses element/field content. Render-time `{style, examples, instructions}` overrides the metadata defaults per call.

**Tech Stack:** Java 21, Maven (`metaobjects-metadata`, `metaobjects-render`, `metaobjects-codegen-spring`), JUnit 4.

**Depends on:** FR-010 Plan 1 (recover engine, merged `33597b10`) and **Plan 2** (recover codegen + `@enumAlias` + `RecoverMap`/`RecoveryResult`) — Task 8's round-trip check calls the recover engine, and Plan 3 reuses `Format`/`FieldKind` from the recover package and the XML-root-tag convention (= payload class name) established in Plan 2 Task 4.

## Design decisions (carried from the amended spec, commit 96542f49)

1. **Guidance carrier = never comments.** `guide` = prose field-guide + clean **valid** example-filled skeleton; `inline` = allowed values/placeholders as element/field **content**; `exampleOnly` = just the filled example. The JSON example block must be valid JSON (parseable); the XML example must be well-formed.
2. **`@promptStyle`** — closed-enum attr on `template.output` (sibling to `@format`), `allowedValues` `guide|inline|exampleOnly`, default `guide`. Project-wide via `abstract`+`extends`; render-time `{style}` overrides per call.
3. **Teaching attrs** consumed here: `@example`/`@instruction` (string, any field), `@enumDoc` (properties, enum fields). `@enumAlias` (registered in Plan 2) is *not* used by artifact 1.
4. **XML root tag = payload class name** (same convention as Plan 2's recover) so the round-trip check holds.
5. **Bounded scope:** scalar/enum/scalar-array fields fully rendered. Nested-object/object-array rendering is a noted Plan 3.1 deferral (the field is listed by name + marked as a nested object, not expanded) — mirrors Plan 2's nested deferral.

## File Structure

| File | Responsibility |
|---|---|
| `metadata/.../template/*` (modify) | register `@promptStyle` (closed enum) on `template.output` |
| `metadata/.../field/MetaField.java` (modify) | register `@example`,`@instruction` (string) on `field.base` |
| `metadata/.../field/EnumField.java` (modify) | register `@enumDoc` (properties) |
| `render/.../recover/...` reused | `Format`, `FieldKind` |
| `render/.../prompt/PromptStyle.java` (create) | enum `GUIDE|INLINE|EXAMPLE_ONLY` |
| `render/.../prompt/OutputFormatSpec.java`, `PromptField.java` (create) | artifact-1 descriptor (structure + teaching metadata) |
| `render/.../prompt/PromptOverrides.java` (create) | render-time `{style, examples, instructions}` |
| `render/.../prompt/OutputFormatRenderer.java` (create) | the renderer (3 styles × 2 formats) |
| `render/.../Verify.java` (modify) | `ERR_OUTPUT_PROMPT_FIELD_MISSING` coverage check |
| `codegen-spring/.../spring/OutputFormatSpecEmitter.java` (create) | VO+template → `OutputFormatSpec` source literal |
| `codegen-spring/.../spring/SpringOutputPromptGenerator.java` (create) | emits `<Template>OutputPrompt.renderFormat(...)` |
| `fixtures/conformance/template-output-{xml,json}-simple/` (create) | clean cross-port fixtures (expected prompt fragment + parser) |

---

## Task 1: Register `@promptStyle`, `@example`, `@instruction`, `@enumDoc`

**Files:**
- Modify: the Java template type registration (where `@format`/`TEMPLATE_FORMATS` is declared — find it: search `metadata/.../template/` for the `format` attr registration and its `allowedValues`/closed-set; mirror it).
- Modify: `metadata/.../field/MetaField.java` (register `@example`,`@instruction` on `field.base`), `metadata/.../field/EnumField.java` (register `@enumDoc` properties; `ATTR_ENUM_ALIAS` already added in Plan 2 — add `ATTR_ENUM_DOC` beside it).
- Test: `metadata/.../template/TemplatePromptStyleTest.java`, `metadata/.../field/FieldTeachingAttrsTest.java`

**Context:** `@format` is already a closed-enum string attr on `template.*` with `allowedValues` and a default (the `TEMPLATE_FORMATS`-equivalent in Java). Register `@promptStyle` the same way with `allowedValues = ["guide","inline","exampleOnly"]`, default `"guide"`, on `template.output`. `@example`/`@instruction` are optional single string attrs on `field.base` (so any field can carry them; inherited by all subtypes). `@enumDoc` is an optional `properties` attr on `field.enum` (like `@enumAlias` from Plan 2).

- [ ] **Step 1: Write the failing tests**

```java
// TemplatePromptStyleTest.java
package com.metaobjects.template;   // adjust package to the actual Java template package

import org.junit.Test;
import static org.junit.Assert.*;

public class TemplatePromptStyleTest {

    @Test public void promptStyleConstantStable() {
        assertEquals("promptStyle", TemplateConstants.ATTR_PROMPT_STYLE);  // use the real constants holder
    }

    @Test public void promptStyleDefaultsToGuide() throws Exception {
        // A template.output with no @promptStyle loads and reports "guide" as the effective default.
        // Construct/load a template.output the way existing template tests do; assert the resolved
        // @promptStyle equals "guide" (default applied), and that "guide"/"inline"/"exampleOnly" are accepted
        // while an out-of-set value (e.g. "fancy") is rejected by the loader (ERR_BAD_ATTR_VALUE).
    }
}
```

```java
// FieldTeachingAttrsTest.java
package com.metaobjects.field;

import com.metaobjects.attr.PropertiesAttribute;
import org.junit.Test;
import java.util.Properties;
import static org.junit.Assert.*;

public class FieldTeachingAttrsTest {

    @Test public void exampleAndInstructionConstants() {
        assertEquals("example", MetaField.ATTR_EXAMPLE);
        assertEquals("instruction", MetaField.ATTR_INSTRUCTION);
    }

    @Test public void enumDocConstant() {
        assertEquals("enumDoc", EnumField.ATTR_ENUM_DOC);
    }

    @Test public void enumFieldReadsEnumDocProperties() {
        EnumField f = /* construct like EnumFieldTest does */ null;
        PropertiesAttribute doc = new PropertiesAttribute(EnumField.ATTR_ENUM_DOC);
        Properties p = new Properties(); p.setProperty("HIGH", "Directly supported.");
        doc.setValueAsObject(p);
        f.addMetaAttr(doc);
        assertEquals("Directly supported.",
                ((Properties) f.getMetaAttr(EnumField.ATTR_ENUM_DOC).getValue()).getProperty("HIGH"));
    }
}
```

> Fill in the construction/loading idiom from the existing `TemplateTest`/`EnumFieldTest`; the assertions (constants + default + allowed-set enforcement + properties round-trip) are the spec.

- [ ] **Step 2: Run → fail.** `cd server/java && mvn -pl :metaobjects-metadata test -Dtest=TemplatePromptStyleTest,FieldTeachingAttrsTest -q` → compile failure (constants/registration missing).

- [ ] **Step 3: Add constants + registrations**

- In the template type registration (mirror the `@format` block): add `ATTR_PROMPT_STYLE = "promptStyle"`, a `PROMPT_STYLES = {"guide","inline","exampleOnly"}` closed set, and register the optional string attr with `allowedValues = PROMPT_STYLES` + default `"guide"` on `template.output`.
- In `MetaField.registerTypes` (on `field.base`): add `ATTR_EXAMPLE="example"`, `ATTR_INSTRUCTION="instruction"`, each `.optionalAttributeWithConstraints(name).ofType(StringAttribute.SUBTYPE_STRING).asSingle()`.
- In `EnumField`: add `ATTR_ENUM_DOC="enumDoc"`, register `.optionalAttributeWithConstraints(ATTR_ENUM_DOC).ofType(PropertiesAttribute.SUBTYPE_PROPERTIES).asSingle()` (beside the Plan-2 `@enumAlias`).

- [ ] **Step 4: Run → pass.** Same command → PASS.
- [ ] **Step 5: Conformance regression.** `mvn -pl :metaobjects-metadata test -q` → green (all new attrs optional / additive).
- [ ] **Step 6: Commit** — `feat(metadata): FR-010 register @promptStyle + @example/@instruction/@enumDoc`.

---

## Task 2: `PromptStyle`, `OutputFormatSpec`, `PromptField`, `PromptOverrides`

**Files:** create under `server/java/render/src/main/java/com/metaobjects/render/prompt/`; test `OutputFormatSpecModelTest.java`.

**Context:** Reuse `com.metaobjects.render.recover.{Format,FieldKind}`. The prompt descriptor carries teaching metadata the recover descriptor doesn't.

- [ ] **Step 1: failing test**

```java
// OutputFormatSpecModelTest.java
package com.metaobjects.render.prompt;

import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.FieldKind;
import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class OutputFormatSpecModelTest {
    @Test public void buildsSpec() {
        PromptField f = new PromptField("confidence", FieldKind.ENUM, true, false,
                List.of("HIGH","LOW"), Map.of("HIGH","Directly supported."),
                "HIGH", "Pick one.", null);
        OutputFormatSpec s = new OutputFormatSpec(Format.XML, "Answer", PromptStyle.GUIDE, List.of(f));
        assertEquals(PromptStyle.GUIDE, s.style());
        assertEquals("Directly supported.", s.fields().get(0).enumDoc().get("HIGH"));
    }
    @Test public void overridesDefaultsEmpty() {
        PromptOverrides o = PromptOverrides.none();
        assertNull(o.style());
        assertTrue(o.examples().isEmpty());
        assertTrue(o.instructions().isEmpty());
    }
}
```

- [ ] **Step 2: fail.** `mvn -pl :metaobjects-render test -Dtest=OutputFormatSpecModelTest -q`.
- [ ] **Step 3: implement**

```java
// PromptStyle.java
package com.metaobjects.render.prompt;
public enum PromptStyle { GUIDE, INLINE, EXAMPLE_ONLY;
    public static PromptStyle from(String s) {
        if (s == null) return GUIDE;
        return switch (s) { case "inline" -> INLINE; case "exampleOnly" -> EXAMPLE_ONLY; default -> GUIDE; };
    }
}
```
```java
// PromptField.java
package com.metaobjects.render.prompt;
import com.metaobjects.render.recover.FieldKind;
import java.util.List; import java.util.Map;
/** enumValues/enumDoc non-null only for ENUM; nested non-null only for OBJECT; example/instruction nullable. */
public record PromptField(String name, FieldKind kind, boolean required, boolean array,
                          List<String> enumValues, Map<String,String> enumDoc,
                          String example, String instruction, OutputFormatSpec nested) {}
```
```java
// OutputFormatSpec.java
package com.metaobjects.render.prompt;
import com.metaobjects.render.recover.Format;
import java.util.List; import java.util.Objects;
public record OutputFormatSpec(Format format, String rootName, PromptStyle style, List<PromptField> fields) {
    public OutputFormatSpec { Objects.requireNonNull(format,"format"); Objects.requireNonNull(rootName,"rootName");
        style = style == null ? PromptStyle.GUIDE : style; fields = fields == null ? List.of() : List.copyOf(fields); }
}
```
```java
// PromptOverrides.java
package com.metaobjects.render.prompt;
import java.util.Map;
/** Render-time overrides of the metadata defaults. style null = keep spec's; maps override per field name. */
public record PromptOverrides(PromptStyle style, Map<String,String> examples, Map<String,String> instructions) {
    public PromptOverrides { examples = examples==null?Map.of():Map.copyOf(examples);
        instructions = instructions==null?Map.of():Map.copyOf(instructions); }
    public static PromptOverrides none() { return new PromptOverrides(null, Map.of(), Map.of()); }
}
```
- [ ] **Step 4: pass.** **Step 5: commit** — `feat(render): FR-010 output-format prompt descriptor model`.

---

## Task 3: `OutputFormatRenderer` — `exampleOnly` (both formats)

**Files:** create `render/.../prompt/OutputFormatRenderer.java`; test `OutputFormatRendererExampleOnlyTest.java`.

**Context:** Start with the simplest style: just the example-filled skeleton, valid + comment-free. Per field, the example value = override example → `@example` → for enum the first value → else a `{name}` placeholder. XML: `<root><field>val</field>…</root>`. JSON: a valid object `{ "field": "val", … }` (numbers/bools unquoted when kind is numeric/boolean AND the value is literal; otherwise quoted — for simplicity in exampleOnly, render example values as strings quoted, numeric/boolean kinds with a literal example unquoted). Tests assert validity (parse the JSON with Jackson; assert XML has matched tags) and comment-freeness.

- [ ] **Step 1: failing test**

```java
// OutputFormatRendererExampleOnlyTest.java
package com.metaobjects.render.prompt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.FieldKind;
import org.junit.Test;
import java.util.List; import java.util.Map;
import static org.junit.Assert.*;

public class OutputFormatRendererExampleOnlyTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private OutputFormatSpec spec(Format fmt) {
        return new OutputFormatSpec(fmt, "Answer", PromptStyle.EXAMPLE_ONLY, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null, "hello", null, null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH","LOW"), null, "HIGH", null, null)));
    }

    @Test public void xmlIsWellFormedAndCommentFree() {
        String out = OutputFormatRenderer.render(spec(Format.XML), PromptOverrides.none());
        assertFalse("no XML comments", out.contains("<!--"));
        assertTrue(out.contains("<Answer>"));
        assertTrue(out.contains("<text>hello</text>"));
        assertTrue(out.contains("<confidence>HIGH</confidence>"));
        assertTrue(out.contains("</Answer>"));
    }

    @Test public void jsonExampleBlockIsValidJson() throws Exception {
        String out = OutputFormatRenderer.render(spec(Format.JSON), PromptOverrides.none());
        assertFalse("no // comments", out.contains("//"));
        int open = out.indexOf('{'), close = out.lastIndexOf('}');
        String json = out.substring(open, close + 1);
        var node = JSON.readTree(json);              // must parse — throws if invalid
        assertEquals("hello", node.get("text").asText());
        assertEquals("HIGH", node.get("confidence").asText());
    }

    @Test public void exampleOverrideWins() {
        PromptOverrides ov = new PromptOverrides(null, Map.of("text", "OVERRIDDEN"), Map.of());
        String out = OutputFormatRenderer.render(spec(Format.XML), ov);
        assertTrue(out.contains("<text>OVERRIDDEN</text>"));
    }
}
```

- [ ] **Step 2: fail.** **Step 3: implement** `OutputFormatRenderer` with the `exampleOnly` path + the shared `exampleValue(field, overrides)` helper + escaping (reuse `com.metaobjects.render.Escapers` for XML/JSON value escaping; the renderer is in the same module). Effective style = `overrides.style() != null ? overrides.style() : spec.style()`. **Step 4: pass.** **Step 5: commit** — `feat(render): FR-010 OutputFormatRenderer exampleOnly`.

---

## Task 4: `OutputFormatRenderer` — `guide` (the default; prose field-guide + valid example)

**Files:** modify `OutputFormatRenderer.java`; test `OutputFormatRendererGuideTest.java`.

**Context:** `guide` = a prose field-guide (one line per field: `- name (required|optional): instruction`; for enums a sub-list of `value = enumDoc[value]`; an `e.g. example` line when present) followed by `Respond exactly like this:` + the `exampleOnly` skeleton (reuse Task 3). All comment-free.

- [ ] **Step 1: failing test**

```java
// OutputFormatRendererGuideTest.java
package com.metaobjects.render.prompt;

import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.FieldKind;
import org.junit.Test;
import java.util.List; import java.util.Map;
import static org.junit.Assert.*;

public class OutputFormatRendererGuideTest {
    private OutputFormatSpec spec() {
        return new OutputFormatSpec(Format.XML, "Answer", PromptStyle.GUIDE, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null,
                "Your refund will appear in 3-5 days.", "One or two sentences to the customer.", null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH","LOW"),
                Map.of("HIGH","Directly supported.","LOW","A guess."), "HIGH", null, null),
            new PromptField("note", FieldKind.STRING, false, false, null, null, null, null, null)));
    }

    @Test public void guideListsFieldsRequiredOptionalAndEnumDocsWithoutComments() {
        String out = OutputFormatRenderer.render(spec(), PromptOverrides.none());
        assertFalse(out.contains("<!--"));
        assertTrue(out.contains("text (required)"));
        assertTrue(out.contains("One or two sentences to the customer."));
        assertTrue(out.contains("confidence (required)"));
        assertTrue(out.contains("HIGH = Directly supported."));
        assertTrue(out.contains("LOW = A guess."));
        assertTrue(out.contains("note (optional)"));
        assertTrue(out.contains("Respond exactly like this:"));
        // ends with the valid example skeleton (reused from exampleOnly):
        assertTrue(out.contains("<Answer>"));
        assertTrue(out.contains("<text>Your refund will appear in 3-5 days.</text>"));
        assertTrue(out.contains("<confidence>HIGH</confidence>"));
    }

    @Test public void instructionOverrideWins() {
        PromptOverrides ov = new PromptOverrides(null, Map.of(), Map.of("text", "NEW INSTRUCTION"));
        assertTrue(OutputFormatRenderer.render(spec(), ov).contains("NEW INSTRUCTION"));
    }
}
```

- [ ] **Step 2: fail. Step 3: implement** the `guide` path (prose guide builder + reuse the skeleton). **Step 4: pass. Step 5: commit** — `feat(render): FR-010 OutputFormatRenderer guide style`.

---

## Task 5: `OutputFormatRenderer` — `inline` (choices/placeholders as content)

**Files:** modify `OutputFormatRenderer.java`; test `OutputFormatRendererInlineTest.java`.

**Context:** `inline` = skeleton only, where enum content = `A | B | C`, scalar content = `{instruction}` or `{type}` placeholder, boolean = `true | false`. Comment-free; XML well-formed; JSON valid (values are the `"A | B | C"` strings).

- [ ] **Step 1: failing test**

```java
// OutputFormatRendererInlineTest.java
package com.metaobjects.render.prompt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.FieldKind;
import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class OutputFormatRendererInlineTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private OutputFormatSpec spec(Format f) {
        return new OutputFormatSpec(f, "Answer", PromptStyle.INLINE, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null, null, "one sentence", null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH","OK","LOW"), null, null, null, null)));
    }
    @Test public void xmlInlineChoices() {
        String out = OutputFormatRenderer.render(spec(Format.XML), PromptOverrides.none());
        assertFalse(out.contains("<!--"));
        assertTrue(out.contains("<confidence>HIGH | OK | LOW</confidence>"));
        assertTrue(out.contains("<text>"));
    }
    @Test public void jsonInlineStillValid() throws Exception {
        String out = OutputFormatRenderer.render(spec(Format.JSON), PromptOverrides.none());
        String json = out.substring(out.indexOf('{'), out.lastIndexOf('}') + 1);
        assertEquals("HIGH | OK | LOW", JSON.readTree(json).get("confidence").asText());
    }
}
```

- [ ] **Step 2–5:** fail → implement `inline` path → pass → commit `feat(render): FR-010 OutputFormatRenderer inline style`.

---

## Task 6: `OutputFormatSpecEmitter` — VO + template → `OutputFormatSpec` source literal

**Files:** create `codegen-spring/.../spring/OutputFormatSpecEmitter.java`; test `OutputFormatSpecEmitterTest.java`.

**Context:** Mirror Plan 2's `RecoverSchemaEmitter` exactly (same VO field-walk, same attr-reading API). Differences: this emits an `OutputFormatSpec` literal carrying `PromptStyle` (from the template's `@promptStyle`, default guide) + per-field `@example`/`@instruction` (string attrs) + `@enumDoc` (properties → `java.util.Map.of(...)` literal) + enum `@values`. Reuse `RecoverSchemaEmitter`'s field-kind mapping and the `aliasMapLiteral`-style properties→`Map.of` helper (factor a shared private helper or copy the small method). Read `@promptStyle` from the template node via `TemplateConstants.ATTR_PROMPT_STYLE`.

- [ ] **Step 1: failing test** — assert `OutputFormatSpecEmitter.specLiteral(vo, template, "Answer")` returns source containing `new OutputFormatSpec(Format.XML, "Answer", PromptStyle.GUIDE, java.util.List.of(`, a `new PromptField("confidence", FieldKind.ENUM, true, false, java.util.List.of("HIGH",...), java.util.Map.of("HIGH", "..."), "HIGH", null, null)`, etc. Use the same `SpringTestFixtures` VO from Plan 2 plus `@example`/`@instruction`/`@enumDoc`/`@promptStyle` on the fields/template.
- [ ] **Step 2–5:** fail → implement (mirror `RecoverSchemaEmitter`) → pass → commit `feat(codegen-spring): FR-010 OutputFormatSpecEmitter`.

---

## Task 7: `SpringOutputPromptGenerator` — emit `<Template>OutputPrompt.renderFormat(...)`

**Files:** create `codegen-spring/.../spring/SpringOutputPromptGenerator.java`; test `SpringOutputPromptGeneratorTest.java` + a compile-and-run test (mirror Plan 2 Task 5).

**Context:** Mirror `SpringOutputParserGenerator` structure (iterate `template.output`, resolve `@payloadRef` VO + package + class names). Emit, for `@format` json|xml only, a class:
```java
public final class AnswerOutputPrompt {
    private static final com.metaobjects.render.prompt.OutputFormatSpec SPEC = <OutputFormatSpecEmitter.specLiteral(...)>;
    private AnswerOutputPrompt() {}
    public static String renderFormat() {
        return com.metaobjects.render.prompt.OutputFormatRenderer.render(SPEC, com.metaobjects.render.prompt.PromptOverrides.none());
    }
    public static String renderFormat(com.metaobjects.render.prompt.PromptOverrides overrides) {
        return com.metaobjects.render.prompt.OutputFormatRenderer.render(SPEC, overrides);
    }
}
```
Emitted file name `<TemplateShort>Prompt.java` (or `<Template>OutputPrompt.java` matching the template name; pick the convention consistent with the parser file naming and assert it).

- [ ] **Step 1: failing test (string-assert emitted source)** — assert imports + `SPEC` + both `renderFormat` overloads emitted for a json output.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: compile-and-run test** (`GeneratedOutputPromptCompileRunTest`) — generate the prompt class, in-memory `javac` against the test classpath (incl. `metaobjects-render`), invoke `renderFormat()`, assert the returned fragment is comment-free, contains the example skeleton, and (for json) the example block parses as JSON. Mirror Plan 2 Task 5's compile harness.
- [ ] **Step 6: commit** — `feat(codegen-spring): FR-010 SpringOutputPromptGenerator + compile-run proof`.

---

## Task 8: `verify` — output-prompt coverage + round-trip

**Files:** modify `render/.../Verify.java` (+ a new check entry point); test `OutputPromptVerifyTest.java`; add verify-conformance fixtures.

**Context:** Two build-time checks (no model call):
1. **Coverage** — every *required* field in the `OutputFormatSpec` must appear in `renderFormat()`'s output. New error code `ERR_OUTPUT_PROMPT_FIELD_MISSING`. A small static `Verify.checkOutputPrompt(String fragment, List<String> requiredFieldNames)` → `List<VerifyError>` (a required field name not present in the fragment → finding).
2. **Round-trip** — `recover(renderFormat(exampleOnly))` is structurally complete (no `LOST_REQUIRED`). Build a `RecoverSchema` from the same fields (reuse Plan 2's descriptor shape) and assert `Recover.recover(fragmentExample, schema, defaults).report().lostRequired()` is empty. This catches a prompt fragment and parser that diverged in the format dimension.

- [ ] **Step 1: failing test**

```java
// OutputPromptVerifyTest.java  (render module)
package com.metaobjects.render;

import com.metaobjects.render.prompt.*;
import com.metaobjects.render.recover.*;
import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class OutputPromptVerifyTest {
    @Test public void coverageFlagsMissingRequiredField() {
        List<VerifyError> e = Verify.checkOutputPrompt("<Answer><text>hi</text></Answer>",
                List.of("text", "confidence"));
        assertEquals(1, e.size());
        assertEquals("ERR_OUTPUT_PROMPT_FIELD_MISSING", e.get(0).code());
        assertEquals("confidence", e.get(0).path());
    }

    @Test public void roundTripExampleOnlyRecoversComplete() {
        OutputFormatSpec spec = new OutputFormatSpec(Format.JSON, "Answer", PromptStyle.EXAMPLE_ONLY, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null, "hi", null, null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH"), null, "HIGH", null, null)));
        String fragment = OutputFormatRenderer.render(spec, PromptOverrides.none());
        String example = fragment.substring(fragment.indexOf('{'), fragment.lastIndexOf('}') + 1);
        RecoverSchema rs = new RecoverSchema(Format.JSON, "Answer", List.of(
            FieldSpec.scalar("text", FieldKind.STRING, true),
            FieldSpec.enumField("confidence", true, List.of("HIGH"), java.util.Map.of())));
        RecoverOutcome o = Recover.recover(example, rs, RecoverOptions.defaults());
        assertTrue("round-trip complete", o.report().lostRequired().isEmpty());
    }
}
```

- [ ] **Step 2–4:** fail → implement `Verify.checkOutputPrompt` + `ERR_OUTPUT_PROMPT_FIELD_MISSING` → pass.
- [ ] **Step 5:** add 2–3 verify-conformance fixtures (a covered case → no findings; a drifted case → `ERR_OUTPUT_PROMPT_FIELD_MISSING`) following the existing verify-conformance fixture layout; extend the runner if needed.
- [ ] **Step 6: commit** — `feat(render): FR-010 verify output-prompt coverage + round-trip`.

---

## Task 9: Clean cross-port conformance fixtures (`template-output-{xml,json}-simple`)

**Files:** create `fixtures/conformance/template-output-xml-simple/` and `…-json-simple/` (input metadata + `expected/` Java outputs for the prompt fragment AND the parser-with-recover); a codegen-spring conformance test that loads each, runs both generators, and asserts.

**Context:** These document the codegen contract as data (cross-port). The existing `template-output-simple` fixture's expected files are TS (`*.output.ts`); Java emits `.java`, so add Java expected files (`expected/<Template>OutputPrompt.java`, `expected/<Template>Parser.java`). Because exact byte-golden Java is brittle, prefer a **structural** conformance assertion (key substrings: the SPEC literal, both renderFormat overloads, the recover members) consistent with codegen-spring's existing substring-style tests — and rely on the compile-and-run tests (Tasks 7 & Plan 2 Task 5) for behavioral proof. Document in each fixture's README that Java asserts structurally + compiles, while byte-identical golden is the TS/cross-port concern.

- [ ] **Step 1–4:** author both fixtures (one `@format: xml @promptStyle: guide`, one `@format: json @promptStyle: inline`, each a VO with a string + enum(+@enumDoc,@enumAlias) + optional field + a `template.output`); write a conformance test that loads each, runs `SpringOutputPromptGenerator` + `SpringOutputParserGenerator`, asserts the structural markers; iterate to green.
- [ ] **Step 5: full regression** — `mvn -pl :metaobjects-metadata,:metaobjects-render,:metaobjects-codegen-spring test -q` green.
- [ ] **Step 6: commit** — `test: FR-010 clean template-output-{xml,json}-simple conformance fixtures`.

---

## Self-Review

- **Spec coverage (artifact 1):** `renderXxxFormat([overrides])` (Tasks 6/7); comment-free guide/inline/exampleOnly styles (Tasks 3–5); `@promptStyle` metadata attr + abstract/extends consistency + render-time `{style}` override (Tasks 1/2/7); teaching attrs `@example`/`@instruction`/`@enumDoc` (Tasks 1/6); verify output-prompt coverage + round-trip (Task 8); clean cross-port fixtures (Task 9). XML root tag = payload class name (shared with Plan 2). Compile-and-run behavioral proof (Task 7).
- **Bounded deferral (→ Plan 3.1):** nested-object / object-array rendering (listed by name, not expanded), mirroring Plan 2's recover nested deferral.
- **Verify-against-live-code spots flagged for the executor:** exact Java template-attr registration site for `@promptStyle` (mirror `@format`); the template package/constants holder name; whether the loader enforces required attrs on `abstract` template bases (the `extends` directive-base pattern); the emitted prompt-class file-naming convention.
- **Type consistency:** `OutputFormatSpec`/`PromptField`/`PromptStyle`/`PromptOverrides`, `OutputFormatRenderer.render(spec, overrides)`, `Verify.checkOutputPrompt`, and the reused `Format`/`FieldKind`/`RecoverSchema`/`Recover` are used identically across tasks and match Plan 1/Plan 2 + the merged engine.

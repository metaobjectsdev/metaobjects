# FR-004 Java Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the FR-004 fourth pillar (template.* metatype + Mustache render engine + verify) to Java. Closes the open `template-output-simple` failure in the Java conformance gate and unblocks the planned `metadata-ktx` Kotlin facade.

**Architecture:** Layer 1 = `template.*` metatype (`MetaTemplate` abstract + `PromptTemplate`/`OutputTemplate` concrete subtypes) added to existing `metaobjects-metadata` module, mirroring the established Java Origin pattern (NOT C#'s single-class-with-loop pattern — Java idiom). Layer 2 = new `metaobjects-render` Maven module: `Provider` interface + `InMemoryProvider`/`FilesystemProvider`/`ClasspathResourceProvider` impls + format-keyed `Escapers` + `Renderer` (regex-pre-expanded partials → Mustache.java compile → escape → maxChars truncate) + `Verify` (token-walking drift detection over template + payload field tree).

**Tech Stack:** Java 21, Maven, JUnit 4, `com.github.spullara.mustache.java:compiler:0.9.14` (already in reactor via codegen-mustache), Jackson for JSON payloads in tests.

**Spec:** [docs/superpowers/specs/2026-05-25-fr-004-java-template-port-design.md](../specs/2026-05-25-fr-004-java-template-port-design.md)

---

## Spec Corrections (apply to plan; spec to be updated inline)

The spec named hypothetical error codes and missed one attribute. Real values from the C# reference + fixture expectations:

| Spec said | Real value | Source |
|---|---|---|
| `ERR_TEMPLATE_PAYLOAD_REF_UNRESOLVED` | `ERR_INVALID_TEMPLATE` (already in `ErrorCode.java:104`) | `fixtures/conformance/error-template-payload-ref-unresolved/expected-errors.json` |
| `ERR_TEMPLATE_REQUIRED_SLOT_MISSING` | `ERR_INVALID_TEMPLATE` (same) | `fixtures/conformance/error-template-required-slot-missing/expected-errors.json` |
| `ERR_TEMPLATE_MISSING_PAYLOAD_REF` | `ERR_MISSING_REQUIRED_ATTR` (already in `ErrorCode.java`) | `fixtures/conformance/error-template-prompt-missing-payload-ref/expected-errors.json` |
| (missing) | `@requiredTags` — generic on BOTH subtypes; string-array | C# `TemplateSchema.GenericAttrs` |

Render-time error codes (already in the enum, used by `Verify`):
- `ERR_VAR_NOT_ON_PAYLOAD` — `{{var}}` references a field not on payload
- `ERR_PARTIAL_UNRESOLVED` — `{{> ref}}` doesn't resolve in provider
- `ERR_REQUIRED_SLOT_UNUSED` — declared `@requiredSlots` slot never referenced (warning-level)
- `ERR_OUTPUT_TAG_MISSING` — `@requiredTags` tag missing from rendered output

---

## Per-port gate

After each Phase's tasks complete: run **code-reviewer + code-simplifier** subagents in parallel, fix Importants, merge to main. Two merge gates total (one per Phase).

---

## File Structure

### Phase 1 — Layer 1 metatype (existing module `metaobjects-metadata`)

```
server/java/metadata/src/main/java/com/metaobjects/template/
├── TemplateConstants.java                  # type/subtype/attr name constants + format enum values
├── MetaTemplate.java                       # abstract base + shared attr registration helper
├── PromptTemplate.java                     # template.prompt concrete
├── OutputTemplate.java                     # template.output concrete
└── TemplateTypesMetaDataProvider.java      # SPI provider

server/java/metadata/src/main/resources/META-INF/services/
└── com.metaobjects.registry.MetaDataTypeProvider   # APPEND TemplateTypesMetaDataProvider line

server/java/metadata/src/main/java/com/metaobjects/loader/
└── ValidationPhase.java                    # add validateTemplates() pass

server/java/metadata/src/test/java/com/metaobjects/template/
├── TemplateLoaderTest.java                 # load + round-trip + attr read
└── TemplateValidationTest.java             # the 3 error cases
```

### Phase 2 — Layer 2 render module (new module `metaobjects-render`)

```
server/java/render/                          # NEW module
├── pom.xml
├── src/main/java/com/metaobjects/render/
│   ├── Provider.java                       # interface
│   ├── InMemoryProvider.java               # Map-backed for tests
│   ├── FilesystemProvider.java             # filesystem-rooted
│   ├── ClasspathResourceProvider.java      # classpath-rooted
│   ├── Escapers.java                       # format-keyed escaper registry
│   ├── RenderRequest.java                  # record: template/ref/payload/provider/format/verify/maxChars
│   ├── Renderer.java                       # pipeline + cycle guard
│   ├── RenderException.java                # render-failure exception
│   ├── VerifyError.java                    # record: code + path
│   ├── VerifyOptions.java                  # record: provider/requiredSlots/requiredTags
│   ├── PayloadField.java                   # record: name + optional nested fields
│   └── Verify.java                         # static Check() — token-walking drift detection
└── src/test/java/com/metaobjects/render/
    ├── EscapersTest.java
    ├── InMemoryProviderTest.java
    ├── FilesystemProviderTest.java
    ├── ClasspathResourceProviderTest.java
    ├── RendererTest.java
    ├── VerifyTest.java
    ├── RenderSnapshotTest.java             # within-Java snapshot gate (parameterized over fixtures/render-conformance/)
    └── RenderCrossPortReportTest.java      # cross-port comparison — REPORT-ONLY (no failing assertions)

server/java/render/src/test/resources/snapshots/
└── <fixture-name>.txt                       # one per render-conformance fixture; generated in Task 2.9

server/java/render/KNOWN_DRIFT.md             # documented cross-port whitespace drift, if any

server/java/pom.xml                           # APPEND <module>render</module> to <modules>
```

---

# Phase 1 — Layer 1: `template.*` metatype

**Branch:** `worktree-fr004-java-template` (already checked out off main).

---

### Task 1.1: TemplateConstants

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/template/TemplateConstants.java`

- [ ] **Step 1: Write the file**

```java
package com.metaobjects.template;

/**
 * Vocabulary constants for the {@code template.*} metatype (FR-004).
 *
 * <p>Type/subtype names and attribute names are Tier-1 cross-language
 * invariants — they must match TS ({@code packages/metadata/src/template/})
 * and C# ({@code MetaObjects/Template/TemplateConstants.cs}) exactly.
 */
public final class TemplateConstants {

    private TemplateConstants() {}

    // --- Type + subtypes ---
    public static final String TYPE_TEMPLATE = "template";
    public static final String SUBTYPE_BASE = "base";
    public static final String SUBTYPE_PROMPT = "prompt";
    public static final String SUBTYPE_OUTPUT = "output";

    // --- Generic attributes (both subtypes) ---
    public static final String ATTR_PAYLOAD_REF = "payloadRef";
    public static final String ATTR_TEXT_REF = "textRef";
    public static final String ATTR_FORMAT = "format";
    public static final String ATTR_MAX_CHARS = "maxChars";
    public static final String ATTR_OWNER = "owner";
    public static final String ATTR_SINCE = "since";
    public static final String ATTR_REQUIRED_TAGS = "requiredTags";

    // --- Prompt-overlay attributes (template.prompt only) ---
    public static final String ATTR_MAX_TOKENS = "maxTokens";
    public static final String ATTR_REQUIRED_SLOTS = "requiredSlots";
    public static final String ATTR_MODEL = "model";

    // --- @format closed value set ---
    public static final String FORMAT_TEXT = "text";
    public static final String FORMAT_HTML = "html";
    public static final String FORMAT_XML = "xml";
    public static final String FORMAT_CSV = "csv";
    public static final String FORMAT_JSON = "json";
    public static final String FORMAT_MARKDOWN = "markdown";
    public static final String FORMAT_SPREADSHEET = "spreadsheet";

    public static final String FORMAT_DEFAULT = FORMAT_TEXT;
}
```

- [ ] **Step 2: Compile**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata compile -q
```

Expected: success.

- [ ] **Step 3: Commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/metadata/src/main/java/com/metaobjects/template/TemplateConstants.java
git commit -m "feat(metadata): TemplateConstants — type/subtype/attr/format vocabulary for FR-004 template.*"
```

---

### Task 1.2: `MetaTemplate` abstract base

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/template/MetaTemplate.java`

Pattern reference: `server/java/metadata/src/main/java/com/metaobjects/origin/MetaOrigin.java`. Use the same registry-registration shape.

- [ ] **Step 1: Write the file**

```java
package com.metaobjects.template;

import com.metaobjects.MetaData;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.template.TemplateConstants.*;

/**
 * Abstract base for the {@code template.*} metatype (FR-004 fourth pillar:
 * cross-language prompt construction). Concrete subtypes: {@link PromptTemplate}
 * ({@code template.prompt}) and {@link OutputTemplate} ({@code template.output}).
 *
 * <p>Shared attributes (both subtypes): {@code @payloadRef}, {@code @textRef},
 * {@code @format}, {@code @maxChars}, {@code @owner}, {@code @since},
 * {@code @requiredTags}. Subtype-specific attributes are declared on the
 * concrete subtype class.
 */
public abstract class MetaTemplate extends MetaData {

    public MetaTemplate(String subType, String name) {
        super(TYPE_TEMPLATE, subType, name);
    }

    /**
     * Register the abstract {@code template.base} type with the shared
     * attribute schema. Concrete subtypes inherit from {@code template.base}
     * and add subtype-specific attributes via their own registration.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.type(TYPE_TEMPLATE, SUBTYPE_BASE)
            .description("Template (abstract base) — FR-004 cross-language prompt construction")
            .optionalAttribute(ATTR_PAYLOAD_REF, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(ATTR_TEXT_REF, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(ATTR_FORMAT, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(ATTR_MAX_CHARS, IntAttribute.SUBTYPE_INT)
            .optionalAttribute(ATTR_OWNER, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(ATTR_SINCE, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(ATTR_REQUIRED_TAGS, StringArrayAttribute.SUBTYPE_STRING_ARRAY);
    }

    // --- typed accessors for use by Verify + render ---

    public String getPayloadRef() {
        return getOwnAttrString(ATTR_PAYLOAD_REF);
    }

    public String getTextRef() {
        return getOwnAttrString(ATTR_TEXT_REF);
    }

    public String getFormat() {
        String v = getOwnAttrString(ATTR_FORMAT);
        return v != null ? v : FORMAT_DEFAULT;
    }

    public Integer getMaxChars() {
        return getOwnAttrInt(ATTR_MAX_CHARS);
    }

    /**
     * @return own-only attr lookup (does NOT walk inheritance).
     */
    private String getOwnAttrString(String name) {
        com.metaobjects.attr.MetaAttribute a = (com.metaobjects.attr.MetaAttribute) getMetaAttr(name, false);
        return a == null ? null : a.getValueAsString();
    }

    private Integer getOwnAttrInt(String name) {
        com.metaobjects.attr.MetaAttribute a = (com.metaobjects.attr.MetaAttribute) getMetaAttr(name, false);
        if (a == null) return null;
        Object v = a.getValue();
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) try { return Integer.parseInt(s); } catch (NumberFormatException e) { return null; }
        return null;
    }
}
```

**Note on `getOwnAttrString` / `getOwnAttrInt`:** these helpers depend on the existing `MetaData.getMetaAttr(name, includeInherited)` API. Verify the exact method name + signature by looking at `MetaOrigin.java` and how it does typed attr access. If the helper names differ (e.g., `getMetaAttribute` vs `getMetaAttr`), adjust to match the existing API. Do NOT invent a new helper layer.

- [ ] **Step 2: Compile**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata compile -q
```

Expected: success. If compile fails on attribute-helper method names, look at how `MetaOrigin` does typed attr access in `getFrom()`, `getVia()` etc. and use the same pattern.

- [ ] **Step 3: Commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/metadata/src/main/java/com/metaobjects/template/MetaTemplate.java
git commit -m "feat(metadata): MetaTemplate abstract base + shared attribute registration"
```

---

### Task 1.3: `PromptTemplate` concrete

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/template/PromptTemplate.java`

- [ ] **Step 1: Write the file**

```java
package com.metaobjects.template;

import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.template.TemplateConstants.*;

/**
 * LLM-targeted template ({@code template.prompt}) — FR-004.
 *
 * <p>In addition to the shared {@link MetaTemplate} attributes, prompts carry
 * the LLM overlay: {@code @maxTokens}, {@code @requiredSlots}, {@code @model}.
 */
public final class PromptTemplate extends MetaTemplate {

    public PromptTemplate(String name) {
        super(SUBTYPE_PROMPT, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        registry.type(TYPE_TEMPLATE, SUBTYPE_PROMPT)
            .inheritsFrom(TYPE_TEMPLATE, SUBTYPE_BASE)
            .description("Template (LLM prompt) — FR-004")
            .implementationClass(PromptTemplate.class)
            .optionalAttribute(ATTR_MAX_TOKENS, IntAttribute.SUBTYPE_INT)
            .optionalAttribute(ATTR_REQUIRED_SLOTS, StringArrayAttribute.SUBTYPE_STRING_ARRAY)
            .optionalAttribute(ATTR_MODEL, StringAttribute.SUBTYPE_STRING);
    }

    /** @return the @requiredSlots list, or null if absent. */
    public java.util.List<String> getRequiredSlots() {
        com.metaobjects.attr.MetaAttribute a = (com.metaobjects.attr.MetaAttribute) getMetaAttr(ATTR_REQUIRED_SLOTS, false);
        if (a == null) return null;
        Object v = a.getValue();
        if (v instanceof java.util.List<?> list) {
            java.util.List<String> out = new java.util.ArrayList<>(list.size());
            for (Object o : list) out.add(String.valueOf(o));
            return out;
        }
        return null;
    }
}
```

Same caveat as Task 1.2 — if the registry builder method names differ (`inheritsFrom`, `implementationClass`), check `PassthroughOrigin.java` for the exact API surface and adjust. The intent is clear: register `template.prompt` as inheriting from `template.base`, bound to the `PromptTemplate` class, with the 3 prompt-overlay attrs.

- [ ] **Step 2: Compile + commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata compile -q
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/metadata/src/main/java/com/metaobjects/template/PromptTemplate.java
git commit -m "feat(metadata): PromptTemplate concrete (template.prompt + LLM overlay attrs)"
```

---

### Task 1.4: `OutputTemplate` concrete

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/template/OutputTemplate.java`

- [ ] **Step 1: Write the file**

```java
package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.template.TemplateConstants.*;

/**
 * Non-LLM rendered artifact template ({@code template.output}) — FR-004.
 *
 * <p>Email / export / docs / config — anything with {@code @format} + payload
 * + template text that isn't an LLM prompt. No subtype-specific attributes
 * beyond what {@link MetaTemplate} provides.
 */
public final class OutputTemplate extends MetaTemplate {

    public OutputTemplate(String name) {
        super(SUBTYPE_OUTPUT, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        registry.type(TYPE_TEMPLATE, SUBTYPE_OUTPUT)
            .inheritsFrom(TYPE_TEMPLATE, SUBTYPE_BASE)
            .description("Template (non-LLM output) — FR-004")
            .implementationClass(OutputTemplate.class);
    }
}
```

- [ ] **Step 2: Compile + commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata compile -q
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/metadata/src/main/java/com/metaobjects/template/OutputTemplate.java
git commit -m "feat(metadata): OutputTemplate concrete (template.output for non-LLM artifacts)"
```

---

### Task 1.5: `TemplateTypesMetaDataProvider` + SPI registration

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/template/TemplateTypesMetaDataProvider.java`
- Modify: `server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` — append one line

Pattern reference: `server/java/metadata/src/main/java/com/metaobjects/origin/OriginTypesMetaDataProvider.java`. Mirror the shape exactly.

- [ ] **Step 1: Write the provider**

```java
package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

import java.util.List;

/**
 * SPI provider for the {@code template.*} metatype (FR-004).
 *
 * <p>Registers the abstract {@code template.base} + the two concrete subtypes
 * {@code template.prompt} and {@code template.output}. Discovered via
 * {@code META-INF/services/com.metaobjects.registry.MetaDataTypeProvider}.
 */
public final class TemplateTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override public String getProviderId() { return "template-types"; }

    @Override public List<String> getDependencies() {
        // Depends on attribute types being registered first.
        return List.of("core-types");
    }

    @Override public String getDescription() {
        return "Registers template.base / template.prompt / template.output (FR-004).";
    }

    @Override public void registerTypes(MetaDataRegistry registry) {
        MetaTemplate.registerTypes(registry);     // abstract base
        PromptTemplate.registerTypes(registry);    // template.prompt
        OutputTemplate.registerTypes(registry);    // template.output
    }
}
```

If `MetaDataTypeProvider` interface methods differ (different method names, additional methods), check `OriginTypesMetaDataProvider.java` for the exact shape — match it.

- [ ] **Step 2: Register in SPI**

Edit `server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`. APPEND a single line at the end:

```
com.metaobjects.template.TemplateTypesMetaDataProvider
```

(Leave all existing lines unchanged.)

- [ ] **Step 3: Compile + run a smoke test that proves type discovery**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata test -q -Dtest=ConformanceTest#conformance[template-output-simple] 2>&1 | tail -20
```

Expected: the test now LOADS the template (no "Unknown type 'template'" warning). It may still fail on canonical serialization comparison if the metatype registration is incomplete, but the load step must succeed.

- [ ] **Step 4: Commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/metadata/src/main/java/com/metaobjects/template/TemplateTypesMetaDataProvider.java \
        server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider
git commit -m "feat(metadata): TemplateTypesMetaDataProvider + SPI registration"
```

---

### Task 1.6: Add `validateTemplates()` to `ValidationPhase`

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java` — add the pass + wire it into `run()`

Three error cases to detect, matching the existing conformance fixture expectations:

1. `template.prompt` missing `@payloadRef` → `ERR_MISSING_REQUIRED_ATTR` (`error-template-prompt-missing-payload-ref`)
2. `template.*` with `@payloadRef` pointing at an undefined view-object → `ERR_INVALID_TEMPLATE` (`error-template-payload-ref-unresolved`)
3. `template.prompt` with `@requiredSlots` member that isn't a field on the resolved payload VO → `ERR_INVALID_TEMPLATE` (`error-template-required-slot-missing`)

- [ ] **Step 1: Write the failing test**

`server/java/metadata/src/test/java/com/metaobjects/template/TemplateValidationTest.java`:

```java
package com.metaobjects.template;

import com.metaobjects.MetaDataException;
import com.metaobjects.ErrorCode;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

import static org.junit.Assert.*;

public class TemplateValidationTest extends SharedRegistryTestBase {

    private static final String PROMPT_MISSING_PAYLOADREF =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
        "  { \"template.prompt\": { \"name\": \"P\", \"@textRef\": \"x/y\" } }" +
        "] } }";

    private static final String PAYLOADREF_UNRESOLVED =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
        "  { \"template.prompt\": { \"name\": \"P\", \"@payloadRef\": \"NoSuch\", \"@textRef\": \"x/y\" } }" +
        "] } }";

    private static final String REQUIRED_SLOT_MISSING =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"Payload\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"present\" } }" +
        "  ] } }," +
        "  { \"template.prompt\": { \"name\": \"P\"," +
        "      \"@payloadRef\": \"Payload\"," +
        "      \"@textRef\": \"x/y\"," +
        "      \"@requiredSlots\": [ \"present\", \"absent\" ] } }" +
        "] } }";

    @Test public void promptMissingPayloadRefRaisesMissingRequired() {
        ErrorCode code = loadAndExpectError(PROMPT_MISSING_PAYLOADREF);
        assertEquals(ErrorCode.ERR_MISSING_REQUIRED_ATTR, code);
    }

    @Test public void payloadRefUnresolvedRaisesInvalidTemplate() {
        ErrorCode code = loadAndExpectError(PAYLOADREF_UNRESOLVED);
        assertEquals(ErrorCode.ERR_INVALID_TEMPLATE, code);
    }

    @Test public void requiredSlotMissingRaisesInvalidTemplate() {
        ErrorCode code = loadAndExpectError(REQUIRED_SLOT_MISSING);
        assertEquals(ErrorCode.ERR_INVALID_TEMPLATE, code);
    }

    private ErrorCode loadAndExpectError(String json) {
        MetaDataLoader loader = createTestLoader("TmplVal", Collections.emptyList());
        try {
            new CanonicalJsonParser(loader, "tmpl.json")
                .loadFromStream(new ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8)));
            fail("expected MetaDataException");
            return null;
        } catch (MetaDataException ex) {
            return ex.getErrorCode();
        }
    }
}
```

- [ ] **Step 2: Verify test fails**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata test -q -Dtest=TemplateValidationTest 2>&1 | tail -15
```

Expected: FAIL — `validateTemplates` not yet wired; templates load without erroring.

- [ ] **Step 3: Add the validation pass to `ValidationPhase.java`**

In `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java`:

1. Add the import block (alongside existing template-related code if any):

```java
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.PromptTemplate;
import com.metaobjects.template.TemplateConstants;
```

2. In the public `run(MetaRoot root, MetaDataLoader loader)` method, add a call to `validateTemplates(root)` AFTER the existing template-adjacent validations and BEFORE `validateEntityHasPrimaryIdentity`. Match the existing pattern in `run()` — see `validateOrigins(root)` for the calling style.

3. Add the helper method to the bottom of the class (private static):

```java
private static void validateTemplates(MetaRoot root) {
    for (MetaData child : root.getChildren()) {
        if (!(child instanceof MetaTemplate template)) continue;

        String subType = template.getSubType();
        String payloadRef = template.getPayloadRef();

        // Rule 1: template.prompt requires @payloadRef
        if (TemplateConstants.SUBTYPE_PROMPT.equals(subType)
                && (payloadRef == null || payloadRef.isEmpty())) {
            throw new MetaDataException(
                ErrorCode.ERR_MISSING_REQUIRED_ATTR,
                "template.prompt '" + template.getName() + "' requires @payloadRef",
                template.getName());
        }

        // Rule 2: @payloadRef (if present) must resolve to an object.value at root
        if (payloadRef != null && !payloadRef.isEmpty()) {
            MetaData payloadVo = findPayloadView(root, payloadRef);
            if (payloadVo == null) {
                throw new MetaDataException(
                    ErrorCode.ERR_INVALID_TEMPLATE,
                    "template '" + template.getName() + "' @payloadRef '" + payloadRef
                        + "' does not resolve to an object.value",
                    template.getName());
            }

            // Rule 3: every @requiredSlots member is a field on the payload VO
            if (template instanceof PromptTemplate prompt) {
                java.util.List<String> required = prompt.getRequiredSlots();
                if (required != null) {
                    java.util.Set<String> available = collectFieldShortNames(payloadVo);
                    for (String slot : required) {
                        if (!available.contains(slot)) {
                            throw new MetaDataException(
                                ErrorCode.ERR_INVALID_TEMPLATE,
                                "template.prompt '" + template.getName()
                                    + "' @requiredSlots includes '" + slot
                                    + "' which is not a field on '" + payloadRef + "'",
                                template.getName());
                        }
                    }
                }
            }
        }
    }
}

/** Find an object.value with the given short or full name at root. */
private static MetaData findPayloadView(MetaRoot root, String ref) {
    for (MetaData child : root.getChildren()) {
        if (!"object".equals(child.getType())) continue;
        if (!"value".equals(child.getSubType())) continue;
        if (nameMatches(child, ref)) return child;
    }
    return null;
}

/** Collect short names of all field.* children of an object node. */
private static java.util.Set<String> collectFieldShortNames(MetaData obj) {
    java.util.Set<String> out = new java.util.HashSet<>();
    for (MetaData child : obj.getChildren()) {
        if ("field".equals(child.getType())) {
            String full = child.getName();
            int idx = full.lastIndexOf("::");
            out.add(idx >= 0 ? full.substring(idx + 2) : full);
        }
    }
    return out;
}
```

The `nameMatches` helper already exists in `ValidationPhase` (per the inventory, lines 777-826) — reuse it without redefining.

- [ ] **Step 4: Verify tests pass**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata test -q -Dtest=TemplateValidationTest 2>&1 | tail -10
```

Expected: 3 tests PASS.

- [ ] **Step 5: Run full metadata-module tests to ensure no regression**

```bash
mvn -pl metadata test -q 2>&1 | tail -5
```

Expected: BUILD SUCCESS, no failures.

- [ ] **Step 6: Commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java \
        server/java/metadata/src/test/java/com/metaobjects/template/TemplateValidationTest.java
git commit -m "feat(metadata): validateTemplates() pass — @payloadRef resolution + @requiredSlots membership"
```

---

### Task 1.7: Template load + round-trip test

**Files:**
- Create: `server/java/metadata/src/test/java/com/metaobjects/template/TemplateLoaderTest.java`

- [ ] **Step 1: Write the test**

```java
package com.metaobjects.template;

import com.metaobjects.MetaData;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

import static org.junit.Assert.*;

public class TemplateLoaderTest extends SharedRegistryTestBase {

    private static final String OUTPUT_FIXTURE =
        "{ \"metadata.root\": { \"package\": \"acme::ai\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"PayloadVo\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"name\" } }" +
        "  ] } }," +
        "  { \"template.output\": { \"name\": \"OutTmpl\"," +
        "      \"@payloadRef\": \"PayloadVo\"," +
        "      \"@textRef\": \"ai/output\"," +
        "      \"@format\": \"json\" } }" +
        "] } }";

    private static final String PROMPT_FIXTURE =
        "{ \"metadata.root\": { \"package\": \"acme::ai\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"PromptVo\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"q\" } }" +
        "  ] } }," +
        "  { \"template.prompt\": { \"name\": \"PromptTmpl\"," +
        "      \"@payloadRef\": \"PromptVo\"," +
        "      \"@textRef\": \"ai/prompt\"," +
        "      \"@maxTokens\": 1024," +
        "      \"@requiredSlots\": [ \"q\" ]," +
        "      \"@model\": \"claude-opus-4-7\" } }" +
        "] } }";

    @Test public void outputTemplateLoadsAndRoundTrips() {
        MetaDataLoader loader = createTestLoader("TmplLoad", Collections.emptyList());
        new CanonicalJsonParser(loader, "out.json")
            .loadFromStream(new ByteArrayInputStream(OUTPUT_FIXTURE.getBytes(StandardCharsets.UTF_8)));

        MetaData out = loader.getRoot().getChildOfType("template", "acme::ai::OutTmpl");
        assertNotNull(out);
        assertEquals("output", out.getSubType());
        assertTrue(out instanceof OutputTemplate);

        String json = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("expected template.output", json.contains("\"template.output\""));
        assertTrue("expected @payloadRef", json.contains("\"@payloadRef\""));
        assertTrue("expected @textRef", json.contains("\"@textRef\""));
        assertTrue("expected @format: json", json.contains("\"@format\": \"json\""));
    }

    @Test public void promptTemplateLoadsAndExposesTypedAttrs() {
        MetaDataLoader loader = createTestLoader("TmplLoad", Collections.emptyList());
        new CanonicalJsonParser(loader, "prompt.json")
            .loadFromStream(new ByteArrayInputStream(PROMPT_FIXTURE.getBytes(StandardCharsets.UTF_8)));

        MetaData node = loader.getRoot().getChildOfType("template", "acme::ai::PromptTmpl");
        assertNotNull(node);
        assertTrue(node instanceof PromptTemplate);

        PromptTemplate p = (PromptTemplate) node;
        assertEquals("PromptVo", p.getPayloadRef());
        assertEquals("ai/prompt", p.getTextRef());
        assertEquals("text", p.getFormat());   // default
        java.util.List<String> slots = p.getRequiredSlots();
        assertNotNull(slots);
        assertEquals(1, slots.size());
        assertEquals("q", slots.get(0));
    }
}
```

- [ ] **Step 2: Run + commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata test -q -Dtest=TemplateLoaderTest 2>&1 | tail -5
```

Expected: 2 tests PASS.

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/metadata/src/test/java/com/metaobjects/template/TemplateLoaderTest.java
git commit -m "test(metadata): TemplateLoaderTest — round-trip + typed accessor coverage"
```

---

### Task 1.8: Verify the 6 conformance fixtures flip green

The 6 `template-*` conformance fixtures in `fixtures/conformance/` should now load + validate + canonical-round-trip correctly.

- [ ] **Step 1: Run the conformance harness**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl metadata test -q -Dtest=ConformanceTest 2>&1 | grep -E 'FAIL|template' | head -20
```

Expected: zero `FAIL` lines. The 6 fixtures `template-output-simple`, `template-prompt-simple`, `template-output-and-prompt`, `error-template-payload-ref-unresolved`, `error-template-required-slot-missing`, `error-template-prompt-missing-payload-ref` all pass.

If any fail with a canonical-serialization mismatch, inspect the diff and adjust serialization (most likely a missing attr being emitted or attr ordering — see `CanonicalJsonSerializer` for the canonical ordering rules; templates should follow the same convention as origins/sources).

- [ ] **Step 2: Run the full reactor sanity-check**

```bash
mvn test -q 2>&1 | grep -E 'BUILD SUCCESS|BUILD FAILURE|Tests run:' | tail -3
```

Expected: BUILD SUCCESS.

- [ ] **Step 3: Commit if any conformance-related test code changed**

If the conformance harness needed any adjustment (e.g., a fixture's `expected.json` needed regeneration), commit it as a separate commit:

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add -p server/java/metadata
git commit -m "test(metadata): align template conformance fixtures with Java loader output"
```

If nothing changed, skip this step.

---

### Task 1.9: Phase 1 review gate + merge

- [ ] **Step 1: Dispatch code-reviewer + code-simplifier in parallel**

Code-reviewer prompt focus areas:
- New code under `server/java/metadata/src/main/java/com/metaobjects/template/`
- The new `validateTemplates()` pass in `ValidationPhase.java`
- Idiom parity with `MetaOrigin` / `OriginTypesMetaDataProvider`
- Whether the registration via `MetaDataRegistry` builder uses the right method names (compile is the gate, but check for `optionalAttribute` vs `withAttribute` etc. drift)

Code-simplifier scope: same files.

- [ ] **Step 2: Apply Important findings**

- [ ] **Step 3: Re-run full reactor**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn test -q
```

- [ ] **Step 4: Merge to main**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git fetch origin main
git merge --no-ff origin/main -m "Merge origin/main into worktree-fr004-java-template (pre-merge sync)"
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn test -q   # verify post-merge
cd <repo-root>/.claude/worktrees/<branch>
git push -u origin worktree-fr004-java-template

# In the main checkout:
git -C <repo-root> pull --ff-only origin main
git -C <repo-root> merge --no-ff worktree-fr004-java-template \
  -m "Merge FR-004 Java Layer 1: template.* metatype + load-time validation"
git -C <repo-root> push origin main
```

---

# Phase 2 — Layer 2: render engine (`metaobjects-render` module)

**Branch:** continue on `worktree-fr004-java-template` OR create a fresh branch off main after the Layer 1 merge. Operator's choice — continuing on the same branch is simpler.

---

### Task 2.1: Module skeleton — `metaobjects-render` Maven module

**Files:**
- Create: `server/java/render/pom.xml`
- Create: directory tree `server/java/render/src/main/java/com/metaobjects/render/`
- Create: directory tree `server/java/render/src/test/java/com/metaobjects/render/`
- Create: directory `server/java/render/src/test/resources/snapshots/`
- Modify: `server/java/pom.xml` — APPEND `<module>render</module>` to `<modules>`

- [ ] **Step 1: Write the pom**

`server/java/render/pom.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects</artifactId>
    <version>7.0.0-SNAPSHOT</version>
  </parent>

  <artifactId>metaobjects-render</artifactId>
  <packaging>bundle</packaging>

  <name>MetaObjects :: Render</name>
  <description>Mustache-driven render engine + verify for the template.* metatype (FR-004).</description>

  <dependencies>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-metadata</artifactId>
      <version>${project.version}</version>
    </dependency>
    <dependency>
      <groupId>com.github.spullara.mustache.java</groupId>
      <artifactId>compiler</artifactId>
      <version>0.9.14</version>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
    </dependency>

    <!-- test -->
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-metadata</artifactId>
      <version>${project.version}</version>
      <type>test-jar</type>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.felix</groupId>
        <artifactId>maven-bundle-plugin</artifactId>
        <extensions>true</extensions>
        <configuration>
          <instructions>
            <Bundle-SymbolicName>${project.artifactId}</Bundle-SymbolicName>
            <Export-Package>com.metaobjects.render.*</Export-Package>
            <Import-Package>
              com.metaobjects.*,
              com.github.mustachejava.*,
              org.slf4j.*,
              *
            </Import-Package>
          </instructions>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
```

- [ ] **Step 2: Register the module + create directories**

```bash
cd <repo-root>/.claude/worktrees/<branch>
mkdir -p server/java/render/src/main/java/com/metaobjects/render
mkdir -p server/java/render/src/test/java/com/metaobjects/render
mkdir -p server/java/render/src/test/resources/snapshots
```

Edit `server/java/pom.xml`. In the `<modules>` block, after `<module>codegen-mustache</module>` (or in any reasonable position), add:

```xml
    <module>render</module>
```

- [ ] **Step 3: Verify the module is recognized**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl render validate -q 2>&1 | tail -5
```

Expected: success — empty module compiles cleanly.

- [ ] **Step 4: Commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/pom.xml server/java/render/pom.xml
git commit -m "build(java): scaffold metaobjects-render module (FR-004 Layer 2)"
```

---

### Task 2.2: `Provider` interface + `InMemoryProvider`

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/Provider.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/InMemoryProvider.java`
- Create: `server/java/render/src/test/java/com/metaobjects/render/InMemoryProviderTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.render;

import org.junit.Test;

import java.util.Map;

import static org.junit.Assert.*;

public class InMemoryProviderTest {

    @Test public void resolvesKnownReference() {
        Provider p = new InMemoryProvider(Map.of("g/s", "hello"));
        assertEquals("hello", p.resolve("g/s"));
    }

    @Test public void returnsNullForUnknownReference() {
        Provider p = new InMemoryProvider(Map.of());
        assertNull(p.resolve("nope/none"));
    }
}
```

- [ ] **Step 2: Verify failure**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl render test -q -Dtest=InMemoryProviderTest 2>&1 | tail -10
```

Expected: FAIL — Provider/InMemoryProvider don't exist.

- [ ] **Step 3: Write the production code**

`Provider.java`:

```java
package com.metaobjects.render;

/**
 * Resolves a logical template reference (group/source) to template text.
 *
 * <p>Returns {@code null} when the reference can't be resolved. Render-time
 * code distinguishes "no provider supplied" from "provider returned null" —
 * the latter triggers {@code ERR_PARTIAL_UNRESOLVED} for partials.
 */
public interface Provider {
    String resolve(String reference);
}
```

`InMemoryProvider.java`:

```java
package com.metaobjects.render;

import java.util.Map;
import java.util.Objects;

/** Deterministic in-memory Provider — conformance fixtures + unit tests. */
public final class InMemoryProvider implements Provider {

    private final Map<String, String> map;

    public InMemoryProvider(Map<String, String> map) {
        this.map = Objects.requireNonNull(map, "map");
    }

    @Override public String resolve(String reference) {
        return map.get(reference);
    }
}
```

- [ ] **Step 4: Test passes**

```bash
mvn -pl render test -q -Dtest=InMemoryProviderTest 2>&1 | tail -5
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render/src/main/java/com/metaobjects/render/Provider.java \
        server/java/render/src/main/java/com/metaobjects/render/InMemoryProvider.java \
        server/java/render/src/test/java/com/metaobjects/render/InMemoryProviderTest.java
git commit -m "feat(render): Provider interface + InMemoryProvider"
```

---

### Task 2.3: `FilesystemProvider`

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/FilesystemProvider.java`
- Create: `server/java/render/src/test/java/com/metaobjects/render/FilesystemProviderTest.java`

Pattern reference: C# `FilesystemProvider.cs` — path traversal guard + `.mustache` extension + null-on-miss.

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.render;

import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.*;

public class FilesystemProviderTest {

    @Test public void resolvesExistingFile() throws IOException {
        Path root = Files.createTempDirectory("fp-");
        Path dir = Files.createDirectories(root.resolve("g"));
        Files.writeString(dir.resolve("s.mustache"), "hello");
        try {
            Provider p = new FilesystemProvider(root);
            assertEquals("hello", p.resolve("g/s"));
        } finally {
            Files.deleteIfExists(dir.resolve("s.mustache"));
            Files.deleteIfExists(dir);
            Files.deleteIfExists(root);
        }
    }

    @Test public void returnsNullForMissingFile() throws IOException {
        Path root = Files.createTempDirectory("fp-");
        try {
            Provider p = new FilesystemProvider(root);
            assertNull(p.resolve("nope/none"));
        } finally {
            Files.deleteIfExists(root);
        }
    }

    @Test public void rejectsPathTraversal() throws IOException {
        Path root = Files.createTempDirectory("fp-");
        try {
            Provider p = new FilesystemProvider(root);
            assertNull(p.resolve("../escape/from-root"));   // null, not exception
        } finally {
            Files.deleteIfExists(root);
        }
    }

    @Test public void customExtension() throws IOException {
        Path root = Files.createTempDirectory("fp-");
        Path dir = Files.createDirectories(root.resolve("g"));
        Files.writeString(dir.resolve("s.txt"), "hello");
        try {
            Provider p = new FilesystemProvider(root, ".txt");
            assertEquals("hello", p.resolve("g/s"));
        } finally {
            Files.deleteIfExists(dir.resolve("s.txt"));
            Files.deleteIfExists(dir);
            Files.deleteIfExists(root);
        }
    }
}
```

- [ ] **Step 2: Verify failure**

```bash
mvn -pl render test -q -Dtest=FilesystemProviderTest 2>&1 | tail -10
```

Expected: FAIL — class doesn't exist.

- [ ] **Step 3: Write the impl**

```java
package com.metaobjects.render;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;

/**
 * Resolves template references from a filesystem root, e.g.
 * {@code resolve("lobby/welcome")} → reads {@code <root>/lobby/welcome.mustache}.
 *
 * <p>Path traversal (segments containing {@code ..}) is rejected at resolve
 * time: returns {@code null} rather than throwing, so the caller sees a clean
 * "unresolved" outcome.
 */
public final class FilesystemProvider implements Provider {

    private final Path root;
    private final String extension;

    public FilesystemProvider(Path root) {
        this(root, ".mustache");
    }

    public FilesystemProvider(Path root, String extension) {
        this.root = Objects.requireNonNull(root, "root").toAbsolutePath().normalize();
        this.extension = Objects.requireNonNull(extension, "extension");
    }

    @Override public String resolve(String reference) {
        if (reference == null || reference.isEmpty()) return null;
        if (reference.contains("..")) return null;  // path-traversal guard

        Path candidate = root.resolve(reference + extension).normalize();
        if (!candidate.startsWith(root)) return null;  // belt-and-suspenders
        if (!Files.isRegularFile(candidate)) return null;

        try {
            return Files.readString(candidate, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }
}
```

- [ ] **Step 4: Tests pass + commit**

```bash
mvn -pl render test -q -Dtest=FilesystemProviderTest 2>&1 | tail -5
```

Expected: 4 tests PASS.

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render
git commit -m "feat(render): FilesystemProvider (filesystem-rooted Provider with path-traversal guard)"
```

---

### Task 2.4: `ClasspathResourceProvider`

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/ClasspathResourceProvider.java`
- Create: `server/java/render/src/test/java/com/metaobjects/render/ClasspathResourceProviderTest.java`
- Create: `server/java/render/src/test/resources/prompts/lobby/welcome.mustache`

- [ ] **Step 1: Add the test resource**

```bash
mkdir -p server/java/render/src/test/resources/prompts/lobby
echo 'Welcome, {{name}}!' > server/java/render/src/test/resources/prompts/lobby/welcome.mustache
```

- [ ] **Step 2: Write the failing test**

```java
package com.metaobjects.render;

import org.junit.Test;
import static org.junit.Assert.*;

public class ClasspathResourceProviderTest {

    @Test public void resolvesClasspathResource() {
        Provider p = new ClasspathResourceProvider(
            Thread.currentThread().getContextClassLoader(),
            "prompts/");
        assertEquals("Welcome, {{name}}!\n", p.resolve("lobby/welcome"));
    }

    @Test public void returnsNullForMissingResource() {
        Provider p = new ClasspathResourceProvider(
            Thread.currentThread().getContextClassLoader(),
            "prompts/");
        assertNull(p.resolve("nope/none"));
    }

    @Test(expected = NullPointerException.class)
    public void rejectsNullClassLoader() {
        new ClasspathResourceProvider(null, "prompts/");
    }
}
```

- [ ] **Step 3: Verify failure, then write impl**

```bash
mvn -pl render test -q -Dtest=ClasspathResourceProviderTest 2>&1 | tail -10
```

Expected: FAIL.

```java
package com.metaobjects.render;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * Resolves template references from classpath resources, e.g.
 * {@code new ClasspathResourceProvider(cl, "prompts/").resolve("lobby/welcome")}
 * → reads {@code classpath:prompts/lobby/welcome.mustache}.
 */
public final class ClasspathResourceProvider implements Provider {

    private final ClassLoader classLoader;
    private final String basePrefix;
    private final String extension;

    public ClasspathResourceProvider(ClassLoader classLoader, String basePrefix) {
        this(classLoader, basePrefix, ".mustache");
    }

    public ClasspathResourceProvider(ClassLoader classLoader, String basePrefix, String extension) {
        this.classLoader = Objects.requireNonNull(classLoader, "classLoader");
        this.basePrefix = basePrefix == null ? "" : basePrefix;
        this.extension = Objects.requireNonNull(extension, "extension");
    }

    @Override public String resolve(String reference) {
        if (reference == null || reference.isEmpty()) return null;
        if (reference.contains("..")) return null;

        String resourcePath = basePrefix + reference + extension;
        try (InputStream in = classLoader.getResourceAsStream(resourcePath)) {
            if (in == null) return null;
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }
}
```

- [ ] **Step 4: Tests pass + commit**

```bash
mvn -pl render test -q -Dtest=ClasspathResourceProviderTest 2>&1 | tail -5
```

Expected: 3 tests PASS.

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render
git commit -m "feat(render): ClasspathResourceProvider (classpath-rooted Provider)"
```

---

### Task 2.5: `Escapers`

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/Escapers.java`
- Create: `server/java/render/src/test/java/com/metaobjects/render/EscapersTest.java`

Behavior reference: C# `Escapers.cs` + TS `escapers.ts`. Per the spec §5.4, escapers MUST match TS/C# byte-for-byte per format.

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.render;

import org.junit.Test;

import static org.junit.Assert.*;

public class EscapersTest {

    @Test public void textIsIdentity() {
        assertEquals("a & b", Escapers.escape("text", "a & b"));
    }

    @Test public void markdownIsIdentity() {
        assertEquals("**bold** & <em>", Escapers.escape("markdown", "**bold** & <em>"));
    }

    @Test public void htmlEntityEncodes() {
        assertEquals("&amp;&lt;&gt;&quot;&#39;", Escapers.escape("html", "&<>\"'"));
    }

    @Test public void xmlEntityEncodes() {
        assertEquals("&amp;&lt;&gt;&quot;&#39;", Escapers.escape("xml", "&<>\"'"));
    }

    @Test public void csvFormulaInjectionGuard() {
        assertEquals("'=SUM(A1:A5)", Escapers.escape("csv", "=SUM(A1:A5)"));
        assertEquals("'+1+1", Escapers.escape("csv", "+1+1"));
        assertEquals("'-1", Escapers.escape("csv", "-1"));
        assertEquals("'@cmd", Escapers.escape("csv", "@cmd"));
        assertEquals("'\tTAB", Escapers.escape("csv", "\tTAB"));
    }

    @Test public void csvQuotesValuesWithCommaOrNewline() {
        assertEquals("\"a,b\"", Escapers.escape("csv", "a,b"));
        assertEquals("\"a\nb\"", Escapers.escape("csv", "a\nb"));
        assertEquals("\"a\"\"b\"", Escapers.escape("csv", "a\"b"));
    }

    @Test public void csvPlainPassesThrough() {
        assertEquals("hello", Escapers.escape("csv", "hello"));
    }

    @Test public void jsonStringEncodes() {
        assertEquals("a\\\"b", Escapers.escape("json", "a\"b"));
        assertEquals("a\\\\b", Escapers.escape("json", "a\\b"));
        assertEquals("a\\nb", Escapers.escape("json", "a\nb"));
        assertEquals("a\\tb", Escapers.escape("json", "a\tb"));
    }

    @Test public void spreadsheetXmlEscapesThenGuards() {
        // = becomes XML-safe identity (= isn't an XML special), then guarded
        assertEquals("'=A1+B1", Escapers.escape("spreadsheet", "=A1+B1"));
        // & gets XML-escaped, no injection
        assertEquals("a&amp;b", Escapers.escape("spreadsheet", "a&b"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void unknownFormatRejected() {
        Escapers.escape("invalid", "x");
    }
}
```

- [ ] **Step 2: Verify failure, then write the impl**

```java
package com.metaobjects.render;

import java.util.Map;
import java.util.function.UnaryOperator;

/**
 * Format-keyed escaper registry for the render engine (FR-004).
 *
 * <p>Tier-1 invariant: escaping behavior per format is character-by-character
 * identical to TS ({@code server/typescript/packages/render/src/escapers.ts})
 * and C# ({@code MetaObjects.Render/Escapers.cs}).
 */
public final class Escapers {

    private Escapers() {}

    private static final Map<String, UnaryOperator<String>> REGISTRY = Map.of(
        "text",        UnaryOperator.identity(),
        "markdown",    UnaryOperator.identity(),
        "html",        Escapers::escapeXml,    // HTML uses XML entity set per FR-004 spec
        "xml",         Escapers::escapeXml,
        "csv",         Escapers::escapeCsv,
        "spreadsheet", s -> escapeCsv(escapeXml(s)),  // XML-escape first, then injection guard
        "json",        Escapers::escapeJson
    );

    public static String escape(String format, String input) {
        UnaryOperator<String> fn = REGISTRY.get(format);
        if (fn == null) throw new IllegalArgumentException("Unknown format: " + format);
        return fn.apply(input);
    }

    static String escapeXml(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&'  -> sb.append("&amp;");
                case '<'  -> sb.append("&lt;");
                case '>'  -> sb.append("&gt;");
                case '"'  -> sb.append("&quot;");
                case '\'' -> sb.append("&#39;");
                default   -> sb.append(c);
            }
        }
        return sb.toString();
    }

    static String escapeCsv(String s) {
        // OWASP cell-injection guard: leading =+-@\t\r → prepend '
        String guarded = s;
        if (!guarded.isEmpty()) {
            char first = guarded.charAt(0);
            if (first == '=' || first == '+' || first == '-' || first == '@' || first == '\t' || first == '\r') {
                guarded = "'" + guarded;
            }
        }
        // Quote if value contains , " \n \r
        boolean needsQuote = guarded.indexOf(',') >= 0
            || guarded.indexOf('"') >= 0
            || guarded.indexOf('\n') >= 0
            || guarded.indexOf('\r') >= 0;
        if (!needsQuote) return guarded;
        return "\"" + guarded.replace("\"", "\"\"") + "\"";
    }

    static String escapeJson(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 4);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"'  -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.toString();
    }
}
```

- [ ] **Step 3: Run tests**

```bash
mvn -pl render test -q -Dtest=EscapersTest 2>&1 | tail -5
```

Expected: 11 tests PASS. If any fail, compare against C# `Escapers.cs` byte-for-byte and adjust.

- [ ] **Step 4: Commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render
git commit -m "feat(render): Escapers — format-keyed registry (text/html/xml/csv/json/markdown/spreadsheet) with OWASP CSV guard"
```

---

### Task 2.6: `Renderer` + `RenderRequest` + `RenderException`

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/RenderRequest.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/RenderException.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/Renderer.java`
- Create: `server/java/render/src/test/java/com/metaobjects/render/RendererTest.java`

Behavior reference: C# `Renderer.cs` + `RenderRequest`.

- [ ] **Step 1: Write `RenderRequest` + `RenderException`**

```java
// RenderRequest.java
package com.metaobjects.render;

import java.util.List;

/**
 * Inputs to {@link Renderer#render(RenderRequest)}.
 *
 * <p>Either {@link #template} (inline body) or {@link #ref} (resolved via
 * {@link #provider}) must be set — never both. {@link #payload} and
 * {@link #provider} are required. Optional: {@link #format} (default "text"),
 * {@link #verify} (drift-guard fields), {@link #maxChars} (output truncation).
 */
public record RenderRequest(
    String template,
    String ref,
    Object payload,
    Provider provider,
    String format,
    List<PayloadField> verify,
    Integer maxChars
) {
    /** Convenience constructor — defaults format="text", no verify, no maxChars. */
    public static RenderRequest of(String ref, Object payload, Provider provider) {
        return new RenderRequest(null, ref, payload, provider, "text", null, null);
    }
}
```

```java
// RenderException.java
package com.metaobjects.render;

public final class RenderException extends RuntimeException {
    public RenderException(String message) { super(message); }
    public RenderException(String message, Throwable cause) { super(message, cause); }
}
```

- [ ] **Step 2: Write Renderer test (TDD)**

```java
package com.metaobjects.render;

import com.github.mustachejava.MustacheException;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

public class RendererTest {

    @Test public void simpleVariableSubstitution() {
        var req = new RenderRequest(
            "Hello {{name}}!", null, Map.of("name", "Ada"),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("Hello Ada!", new Renderer().render(req));
    }

    @Test public void sectionIteration() {
        var req = new RenderRequest(
            "{{#items}}- {{.}}\n{{/items}}", null,
            Map.of("items", List.of("a", "b", "c")),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("- a\n- b\n- c\n", new Renderer().render(req));
    }

    @Test public void partialResolvedViaProvider() {
        var req = new RenderRequest(
            "<doc>\n{{> shared/header }}\nbody\n</doc>", null,
            Map.of(),
            new InMemoryProvider(Map.of("shared/header", "HEADER")),
            "text", null, null);
        // Partial pre-expansion happens BEFORE Mustache parse;
        // exact whitespace per pre-expanded text + Mustache rendering.
        assertTrue(new Renderer().render(req).contains("HEADER"));
    }

    @Test public void nestedPartials() {
        var req = new RenderRequest(
            "{{> a/outer }}", null,
            Map.of(),
            new InMemoryProvider(Map.of(
                "a/outer", "OUTER:{{> a/inner }}",
                "a/inner", "INNER"
            )),
            "text", null, null);
        assertEquals("OUTER:INNER", new Renderer().render(req));
    }

    @Test(expected = RenderException.class)
    public void cyclicPartialDetected() {
        var req = new RenderRequest(
            "{{> a/x }}", null, Map.of(),
            new InMemoryProvider(Map.of(
                "a/x", "X{{> a/y }}",
                "a/y", "Y{{> a/x }}"
            )),
            "text", null, null);
        new Renderer().render(req);
    }

    @Test(expected = RenderException.class)
    public void unresolvedPartialDetected() {
        var req = new RenderRequest(
            "{{> missing/x }}", null, Map.of(),
            new InMemoryProvider(Map.of()),
            "text", null, null);
        new Renderer().render(req);
    }

    @Test public void htmlEscapingHappensInOurLayer() {
        var req = new RenderRequest(
            "{{value}}", null, Map.of("value", "<b>&</b>"),
            new InMemoryProvider(Map.of()), "html", null, null);
        // Triple-mustache bypass NOT used here; output is escaped by Escapers.
        assertEquals("&lt;b&gt;&amp;&lt;/b&gt;", new Renderer().render(req));
    }

    @Test public void maxCharsTruncates() {
        var req = new RenderRequest(
            "{{x}}", null, Map.of("x", "abcdefghij"),
            new InMemoryProvider(Map.of()), "text", null, 5);
        assertEquals("abcde", new Renderer().render(req));
    }

    @Test public void refResolvedViaProvider() {
        var req = new RenderRequest(
            null, "g/s", Map.of("n", "x"),
            new InMemoryProvider(Map.of("g/s", "n={{n}}")),
            "text", null, null);
        assertEquals("n=x", new Renderer().render(req));
    }

    @Test(expected = RenderException.class)
    public void neitherTemplateNorRefSetRejected() {
        var req = new RenderRequest(
            null, null, Map.of(),
            new InMemoryProvider(Map.of()),
            "text", null, null);
        new Renderer().render(req);
    }

    @Test(expected = RenderException.class)
    public void bothTemplateAndRefSetRejected() {
        var req = new RenderRequest(
            "inline", "g/s", Map.of(),
            new InMemoryProvider(Map.of("g/s", "via-ref")),
            "text", null, null);
        new Renderer().render(req);
    }
}
```

- [ ] **Step 3: Verify tests fail**

```bash
mvn -pl render test -q -Dtest=RendererTest 2>&1 | tail -10
```

Expected: FAIL — Renderer doesn't exist.

- [ ] **Step 4: Write `Renderer`**

```java
package com.metaobjects.render;

import com.github.mustachejava.DefaultMustacheFactory;
import com.github.mustachejava.Mustache;
import com.github.mustachejava.MustacheException;
import com.github.mustachejava.MustacheFactory;

import java.io.StringReader;
import java.io.StringWriter;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Mustache-driven render pipeline for the {@code template.*} metatype (FR-004).
 *
 * <p>Pipeline: resolve template text (inline or via provider) → pre-expand
 * partials by recursive inlining (cycle-guarded, MAX_DEPTH=32) →
 * Mustache.java compile + execute (HTML escaping DISABLED on the factory
 * because we own escaping) → apply format-keyed escaper → truncate to
 * {@code maxChars} if set.
 *
 * <p>Pre-expanding partials before Mustache compile guarantees deterministic
 * cross-port whitespace (matches TS + C#) and lets us own cycle detection
 * independent of the library.
 */
public final class Renderer {

    static final int MAX_DEPTH = 32;

    // {{> name }} — captures the reference between the marker and the closing }}
    private static final Pattern PARTIAL_PATTERN =
        Pattern.compile("\\{\\{>\\s*([^\\s}]+)\\s*\\}\\}");

    private final MustacheFactory mustacheFactory = new DefaultMustacheFactory() {
        @Override public void encode(String value, java.io.Writer writer) {
            try { writer.write(value); }  // disable HTML escaping; Escapers owns it
            catch (java.io.IOException e) { throw new MustacheException(e); }
        }
    };

    public String render(RenderRequest req) {
        validate(req);

        String body = req.template() != null
            ? req.template()
            : resolveOrThrow(req.provider(), req.ref());

        String expanded = preExpandPartials(body, req.provider(), new ArrayDeque<>());

        String rendered;
        try {
            Mustache compiled = mustacheFactory.compile(new StringReader(expanded), refOrInline(req));
            StringWriter writer = new StringWriter();
            compiled.execute(writer, req.payload()).flush();
            rendered = writer.toString();
        } catch (MustacheException | java.io.IOException e) {
            throw new RenderException("Mustache compile/execute failed", e);
        }

        String format = req.format() != null ? req.format() : "text";
        String escaped = Escapers.escape(format, rendered);

        if (req.maxChars() != null && escaped.length() > req.maxChars()) {
            escaped = escaped.substring(0, req.maxChars());
        }
        return escaped;
    }

    private static void validate(RenderRequest req) {
        if (req.provider() == null)
            throw new RenderException("RenderRequest.provider is required");
        if (req.payload() == null)
            throw new RenderException("RenderRequest.payload is required");
        if (req.template() == null && req.ref() == null)
            throw new RenderException("RenderRequest must set either template or ref");
        if (req.template() != null && req.ref() != null)
            throw new RenderException("RenderRequest must set template OR ref, not both");
    }

    private static String resolveOrThrow(Provider provider, String ref) {
        String text = provider.resolve(ref);
        if (text == null)
            throw new RenderException("Provider could not resolve ref: " + ref);
        return text;
    }

    private static String refOrInline(RenderRequest req) {
        return req.ref() != null ? req.ref() : "<inline>";
    }

    private static String preExpandPartials(String text, Provider provider, Deque<String> stack) {
        if (stack.size() >= MAX_DEPTH)
            throw new RenderException("partial expansion exceeds MAX_DEPTH=" + MAX_DEPTH
                + " (current chain: " + String.join(" → ", stack) + ")");

        Matcher m = PARTIAL_PATTERN.matcher(text);
        if (!m.find()) return text;
        m.reset();

        StringBuilder out = new StringBuilder(text.length());
        int last = 0;
        while (m.find()) {
            String partialRef = m.group(1);
            if (stack.contains(partialRef))
                throw new RenderException("partial cycle detected: "
                    + String.join(" → ", stack) + " → " + partialRef);

            String partialText = provider.resolve(partialRef);
            if (partialText == null)
                throw new RenderException("partial unresolved: " + partialRef);

            stack.push(partialRef);
            String expanded = preExpandPartials(partialText, provider, stack);
            stack.pop();

            out.append(text, last, m.start());
            out.append(expanded);
            last = m.end();
        }
        out.append(text, last, text.length());
        return out.toString();
    }
}
```

- [ ] **Step 5: Test passes + commit**

```bash
mvn -pl render test -q -Dtest=RendererTest 2>&1 | tail -5
```

Expected: 11 tests PASS.

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render
git commit -m "feat(render): Renderer + RenderRequest + RenderException — pipeline with partial pre-expansion + cycle guard"
```

---

### Task 2.7: `Verify` + supporting records

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/PayloadField.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/VerifyError.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/VerifyOptions.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/Verify.java`
- Create: `server/java/render/src/test/java/com/metaobjects/render/VerifyTest.java`

Behavior reference: C# `Verify.cs` (252 lines) + TS `verify.ts` (204 lines). This is the largest single piece of code in this plan — port the structure faithfully.

- [ ] **Step 1: Write supporting records**

`PayloadField.java`:

```java
package com.metaobjects.render;

import java.util.List;

/**
 * A field node in a template-verification payload tree.
 *
 * <p>{@code fields} present → context-pushing field (object / array-of-object).
 * {@code fields} null → scalar field.
 */
public record PayloadField(String name, List<PayloadField> fields) {
    public PayloadField {
        if (name == null) throw new NullPointerException("name");
    }

    public static PayloadField scalar(String name) {
        return new PayloadField(name, null);
    }

    public static PayloadField object(String name, List<PayloadField> children) {
        return new PayloadField(name, List.copyOf(children));
    }
}
```

`VerifyError.java`:

```java
package com.metaobjects.render;

/** A single drift finding from {@link Verify}. */
public record VerifyError(String code, String path) {}
```

`VerifyOptions.java`:

```java
package com.metaobjects.render;

import java.util.List;

/**
 * Optional inputs to {@link Verify#check}. {@link #provider} (if set) is used
 * to recursively resolve partial references. {@link #requiredSlots} declares
 * slot names that MUST be referenced somewhere in the template body / partials.
 * {@link #requiredTags} declares output tags that MUST appear in rendered output.
 */
public record VerifyOptions(
    Provider provider,
    List<String> requiredSlots,
    List<String> requiredTags
) {
    public static VerifyOptions empty() {
        return new VerifyOptions(null, null, null);
    }
}
```

- [ ] **Step 2: Write `Verify` test (TDD)**

```java
package com.metaobjects.render;

import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

public class VerifyTest {

    @Test public void scalarVariableOnPayloadOk() {
        var errors = Verify.check("Hello {{name}}",
            List.of(PayloadField.scalar("name")),
            VerifyOptions.empty());
        assertTrue(errors.isEmpty());
    }

    @Test public void variableNotOnPayloadFlagged() {
        var errors = Verify.check("Hello {{missing}}",
            List.of(PayloadField.scalar("name")),
            VerifyOptions.empty());
        assertEquals(1, errors.size());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", errors.get(0).code());
        assertTrue(errors.get(0).path().contains("missing"));
    }

    @Test public void sectionWithContextResolvesNestedFields() {
        var errors = Verify.check("{{#posts}}- {{title}}\n{{/posts}}",
            List.of(PayloadField.object("posts",
                List.of(PayloadField.scalar("title")))),
            VerifyOptions.empty());
        assertTrue(errors.isEmpty());
    }

    @Test public void invertedSectionKeepsContext() {
        var errors = Verify.check("{{^posts}}none{{/posts}} {{name}}",
            List.of(
                PayloadField.scalar("name"),
                PayloadField.object("posts", List.of(PayloadField.scalar("title")))
            ),
            VerifyOptions.empty());
        assertTrue(errors.isEmpty());
    }

    @Test public void partialResolvedViaProvider() {
        var opts = new VerifyOptions(
            new InMemoryProvider(Map.of("p/h", "{{title}}")),
            null, null);
        var errors = Verify.check("{{#posts}}{{> p/h }}{{/posts}}",
            List.of(PayloadField.object("posts",
                List.of(PayloadField.scalar("title")))),
            opts);
        assertTrue(errors.isEmpty());
    }

    @Test public void unresolvedPartialFlagged() {
        var opts = new VerifyOptions(new InMemoryProvider(Map.of()), null, null);
        var errors = Verify.check("{{> missing/x }}", List.of(), opts);
        assertEquals(1, errors.size());
        assertEquals("ERR_PARTIAL_UNRESOLVED", errors.get(0).code());
    }

    @Test public void unusedRequiredSlotFlaggedAsWarning() {
        var opts = new VerifyOptions(null, List.of("name", "unused"), null);
        var errors = Verify.check("Hello {{name}}",
            List.of(PayloadField.scalar("name")),
            opts);
        assertEquals(1, errors.size());
        assertEquals("ERR_REQUIRED_SLOT_UNUSED", errors.get(0).code());
        assertEquals("unused", errors.get(0).path());
    }

    @Test public void missingOutputTagFlagged() {
        var opts = new VerifyOptions(null, null, List.of("required"));
        var errors = Verify.check("<other>x</other>", List.of(), opts);
        assertEquals(1, errors.size());
        assertEquals("ERR_OUTPUT_TAG_MISSING", errors.get(0).code());
    }

    @Test public void presentOutputTagOk() {
        var opts = new VerifyOptions(null, null, List.of("present"));
        var errors = Verify.check("<present>x</present>", List.of(), opts);
        assertTrue(errors.isEmpty());
    }

    @Test public void presentOutputTagWithAttributesOk() {
        var opts = new VerifyOptions(null, null, List.of("present"));
        var errors = Verify.check("<present attr=\"v\">x</present>", List.of(), opts);
        assertTrue(errors.isEmpty());
    }
}
```

- [ ] **Step 3: Write `Verify` implementation**

This is a ~200-LOC class. Port the structure from C# `Verify.cs` faithfully — same tokenizer, same context stack semantics, same tag matching, same error codes. Key shape:

```java
package com.metaobjects.render;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Token-walking drift detection for {@code template.*} bodies (FR-004).
 *
 * <p>Walks Mustache tokens (var / section / inverted section / partial) and
 * checks each against a payload-field tree. Returns a list of {@link VerifyError}
 * findings; empty list = no drift.
 *
 * <p>Mirrors C# {@code MetaObjects.Render/Verify.cs} and TS {@code verify.ts}.
 */
public final class Verify {

    public static final String ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD";
    public static final String ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED";
    public static final String ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED";
    public static final String ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING";

    static final int MAX_DEPTH = 32;

    private Verify() {}

    public static List<VerifyError> check(
            String templateText,
            List<PayloadField> rootFields,
            VerifyOptions options
    ) {
        List<VerifyError> errors = new ArrayList<>();
        if (options == null) options = VerifyOptions.empty();

        List<Token> tokens = tokenize(templateText);
        Deque<List<PayloadField>> stack = new ArrayDeque<>();
        stack.push(rootFields == null ? List.of() : rootFields);

        Set<String> referenced = new LinkedHashSet<>();
        StringBuilder allBodies = new StringBuilder(templateText);

        walk(tokens, stack, options, errors, referenced, allBodies, new ArrayDeque<>());

        // Required slots check (warning-level: in TS+C# these are filtered out
        // before throwing in the render pipeline; here we just include them).
        if (options.requiredSlots() != null) {
            for (String slot : options.requiredSlots()) {
                if (!referenced.contains(slot)) {
                    errors.add(new VerifyError(ERR_REQUIRED_SLOT_UNUSED, slot));
                }
            }
        }

        // Required output tags check
        if (options.requiredTags() != null) {
            String body = allBodies.toString();
            for (String tag : options.requiredTags()) {
                if (!tagPresent(body, tag)) {
                    errors.add(new VerifyError(ERR_OUTPUT_TAG_MISSING, tag));
                }
            }
        }

        return errors;
    }

    // --- Token model ---

    sealed interface Token permits VarTok, SectionTok, PartialTok, TextTok {}
    record VarTok(String name) implements Token {}
    record SectionTok(String name, boolean inverted, List<Token> body) implements Token {}
    record PartialTok(String name) implements Token {}
    record TextTok(String text) implements Token {}  // unused for checks but kept for future

    /**
     * Tokenize a Mustache template body into the small subset we care about.
     * IMPORTANT: this is intentionally a lightweight tokenizer — we don't need
     * full Mustache spec compliance, just enough to walk vars/sections/partials.
     */
    static List<Token> tokenize(String text) {
        // ... implement matching C# Verify.cs tokenizer logic ...
        // Output: a flat sequence of tokens, with section bodies as nested List<Token>.
        // Recognize: {{name}}, {{&name}}, {{{name}}}, {{#name}}...{{/name}},
        //            {{^name}}...{{/name}}, {{> name}}
        // Plain text between tags goes into TextTok (or is dropped).
        throw new UnsupportedOperationException("port from C# Verify.cs Tokenize()");
    }

    private static void walk(
            List<Token> tokens,
            Deque<List<PayloadField>> stack,
            VerifyOptions options,
            List<VerifyError> errors,
            Set<String> referenced,
            StringBuilder allBodies,
            Deque<String> partialStack
    ) {
        // ... implement matching C# Verify.cs Walk() ...
        // For each token:
        //   VarTok        → check name resolvable on stack; add to referenced
        //   SectionTok    → if not inverted and name resolves to object/array field, push children
        //   PartialTok    → resolve via options.provider; if null → ERR_PARTIAL_UNRESOLVED;
        //                   otherwise tokenize the resolved body, append to allBodies,
        //                   and recurse (with cycle guard via partialStack + MAX_DEPTH)
        throw new UnsupportedOperationException("port from C# Verify.cs Walk()");
    }

    private static boolean tagPresent(String body, String tag) {
        // Open tag: <tag followed by > or XML whitespace
        Pattern open = Pattern.compile("<" + Pattern.quote(tag) + "(?:\\s|>)");
        Pattern close = Pattern.compile("</" + Pattern.quote(tag) + ">");
        return open.matcher(body).find() && close.matcher(body).find();
    }
}
```

**Implementation note:** The `tokenize` and `walk` methods are sketched here with `throw new UnsupportedOperationException(...)`. Port them faithfully from C# `Verify.cs` lines 1-252 — keep token shape + context-stack semantics + scope-resolution-with-parent-fallback identical. This is a port, not a redesign.

- [ ] **Step 4: Run tests, iterate until green**

```bash
mvn -pl render test -q -Dtest=VerifyTest 2>&1 | tail -10
```

Expected: 10 tests PASS after the port is complete. If some fail, compare specific token cases against the C# reference and adjust.

- [ ] **Step 5: Commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render
git commit -m "feat(render): Verify — token-walking drift detection over template + payload field tree"
```

---

### Task 2.8: `RenderSnapshotTest` — within-Java snapshot gate

**Files:**
- Create: `server/java/render/src/test/java/com/metaobjects/render/RenderSnapshotTest.java`
- Create: `server/java/render/src/test/resources/snapshots/.gitkeep`
- (snapshots populated by Step 3)

- [ ] **Step 1: Write the parameterized harness**

```java
package com.metaobjects.render;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

@RunWith(Parameterized.class)
public class RenderSnapshotTest {

    private static final Path REPO_ROOT;
    private static final Path FIXTURES_DIR;
    private static final Path SNAPSHOTS_DIR;
    private static final ObjectMapper JSON = new ObjectMapper();

    static {
        // Walk up from CWD to find the repo root containing fixtures/
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/render-conformance"))) {
            p = p.getParent();
        }
        REPO_ROOT = p;
        FIXTURES_DIR = REPO_ROOT.resolve("fixtures/render-conformance");
        SNAPSHOTS_DIR = Paths.get("src/test/resources/snapshots").toAbsolutePath();
    }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> fixtures() throws IOException {
        if (FIXTURES_DIR == null || !Files.isDirectory(FIXTURES_DIR)) return List.of();
        try (Stream<Path> s = Files.list(FIXTURES_DIR)) {
            return s.filter(Files::isDirectory)
                    .sorted()
                    .map(p -> new Object[]{p.getFileName().toString(), p})
                    .collect(Collectors.toList());
        }
    }

    private final String name;
    private final Path fixtureDir;

    public RenderSnapshotTest(String name, Path fixtureDir) {
        this.name = name;
        this.fixtureDir = fixtureDir;
    }

    @Test public void rendersToSnapshot() throws IOException {
        Path metaPath = fixtureDir.resolve("meta.json");
        Path templatePath = fixtureDir.resolve("template.mustache");
        Path payloadPath = fixtureDir.resolve("payload.json");
        Path snapshotPath = SNAPSHOTS_DIR.resolve(name + ".txt");
        Path partialsDir = fixtureDir.resolve("partials");

        assertTrue("missing template: " + templatePath, Files.isRegularFile(templatePath));
        assertTrue("missing payload: " + payloadPath, Files.isRegularFile(payloadPath));

        Map<String, Object> meta = Files.isRegularFile(metaPath)
            ? JSON.readValue(metaPath.toFile(), Map.class)
            : Map.of();
        String format = (String) meta.getOrDefault("format", "text");

        String template = Files.readString(templatePath, StandardCharsets.UTF_8);
        Object payload = JSON.readValue(payloadPath.toFile(), Object.class);

        // Provider for partials/ subdirectory (if present)
        Provider provider = Files.isDirectory(partialsDir)
            ? new FilesystemProvider(fixtureDir)   // partials referenced as "partials/<name>"
            : new InMemoryProvider(Map.of());

        String actual = new Renderer().render(new RenderRequest(
            template, null, payload, provider, format, null, null));

        if (!Files.isRegularFile(snapshotPath)) {
            Files.createDirectories(snapshotPath.getParent());
            Files.writeString(snapshotPath, actual, StandardCharsets.UTF_8);
            fail("snapshot created for '" + name + "' at " + snapshotPath
                + " — review + commit. Re-run to gate.");
        }
        String expected = Files.readString(snapshotPath, StandardCharsets.UTF_8);
        assertEquals("render output drifted from snapshot for " + name, expected, actual);
    }
}
```

- [ ] **Step 2: First run — generates snapshots**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl render test -q -Dtest=RenderSnapshotTest 2>&1 | tail -20
```

Expected: every fixture FAILS with "snapshot created for ... — review + commit". Inspect each generated `server/java/render/src/test/resources/snapshots/<name>.txt` file by hand — confirm the rendered output is reasonable (no garbled escaping, sensible whitespace).

- [ ] **Step 3: Commit snapshots + re-run to confirm green**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render/src/test/resources/snapshots/
git commit -m "test(render): initial render snapshots for fixtures/render-conformance/* corpus"

cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl render test -q -Dtest=RenderSnapshotTest 2>&1 | tail -5
```

Expected: all parameterized tests PASS.

- [ ] **Step 4: Commit the harness**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render/src/test/java/com/metaobjects/render/RenderSnapshotTest.java
git commit -m "test(render): RenderSnapshotTest — within-Java snapshot gate for fixtures/render-conformance/"
```

---

### Task 2.9: `RenderCrossPortReportTest` — cross-port comparison (report-only)

**Files:**
- Create: `server/java/render/src/test/java/com/metaobjects/render/RenderCrossPortReportTest.java`
- Create: `server/java/render/KNOWN_DRIFT.md`

- [ ] **Step 1: Write the harness**

```java
package com.metaobjects.render;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Cross-port render-conformance REPORT — compares Java's actual render output
 * against the TS-baseline expected text. <strong>Not a gate</strong> — diffs
 * are printed to stdout but tests do not fail. Track documented drifts in
 * {@code server/java/render/KNOWN_DRIFT.md}.
 *
 * <p>Within-Java stability is the real build gate; see {@link RenderSnapshotTest}.
 */
@RunWith(Parameterized.class)
public class RenderCrossPortReportTest {

    private static final Path REPO_ROOT;
    private static final Path FIXTURES_DIR;
    private static final ObjectMapper JSON = new ObjectMapper();

    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/render-conformance"))) {
            p = p.getParent();
        }
        REPO_ROOT = p;
        FIXTURES_DIR = REPO_ROOT.resolve("fixtures/render-conformance");
    }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> fixtures() throws IOException {
        if (FIXTURES_DIR == null || !Files.isDirectory(FIXTURES_DIR)) return List.of();
        try (Stream<Path> s = Files.list(FIXTURES_DIR)) {
            return s.filter(Files::isDirectory)
                .filter(d -> Files.isRegularFile(d.resolve("expected.txt"))
                          || Files.isRegularFile(d.resolve("expected/rendered.txt")))
                .sorted()
                .map(p -> new Object[]{p.getFileName().toString(), p})
                .collect(Collectors.toList());
        }
    }

    private final String name;
    private final Path fixtureDir;

    public RenderCrossPortReportTest(String name, Path fixtureDir) {
        this.name = name;
        this.fixtureDir = fixtureDir;
    }

    @Test public void compareAgainstTsBaseline() throws IOException {
        Path templatePath = fixtureDir.resolve("template.mustache");
        Path payloadPath = fixtureDir.resolve("payload.json");
        Path expectedPath = Files.isRegularFile(fixtureDir.resolve("expected.txt"))
            ? fixtureDir.resolve("expected.txt")
            : fixtureDir.resolve("expected/rendered.txt");
        Path metaPath = fixtureDir.resolve("meta.json");

        if (!Files.isRegularFile(templatePath) || !Files.isRegularFile(payloadPath)) return;

        Map<String, Object> meta = Files.isRegularFile(metaPath)
            ? JSON.readValue(metaPath.toFile(), Map.class)
            : Map.of();
        String format = (String) meta.getOrDefault("format", "text");
        String template = Files.readString(templatePath, StandardCharsets.UTF_8);
        Object payload = JSON.readValue(payloadPath.toFile(), Object.class);
        Provider provider = Files.isDirectory(fixtureDir.resolve("partials"))
            ? new FilesystemProvider(fixtureDir)
            : new InMemoryProvider(Map.of());

        String actual = new Renderer().render(new RenderRequest(
            template, null, payload, provider, format, null, null));
        String expected = Files.readString(expectedPath, StandardCharsets.UTF_8);

        if (!expected.equals(actual)) {
            System.out.println("=== CROSS-PORT DRIFT: " + name + " ===");
            System.out.println("--- expected (TS baseline) ---");
            System.out.println(expected);
            System.out.println("--- actual (Java) ---");
            System.out.println(actual);
            System.out.println("===");
        }
        // No assertion — this is a report, not a gate.
    }
}
```

- [ ] **Step 2: Write `KNOWN_DRIFT.md`**

`server/java/render/KNOWN_DRIFT.md`:

```markdown
# Known cross-port render drift (Java vs TS/C#)

This file documents intentional or known whitespace/escaping drift between
Java's render output and the TS-baseline render-conformance corpus.

**Within-Java stability** is the build gate (see `RenderSnapshotTest`); this
file tracks where Java *intentionally* diverges from TS so we don't get
surprised when reading `RenderCrossPortReportTest` output.

| Fixture | Drift type | Notes |
|---|---|---|
| (none yet) | | |

When you find a drift in `RenderCrossPortReportTest` output:
1. Decide if it's worth fixing (most aren't — see FR-004 Java spec §6.4).
2. If documenting: add a row above with fixture name + diff summary.
3. If fixing: adjust `Renderer` / `Escapers` and verify both snapshot test AND cross-port report come into agreement.
```

- [ ] **Step 3: Run + commit**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn -pl render test -q -Dtest=RenderCrossPortReportTest 2>&1 | tail -10
```

Expected: PASS (no failing assertions). Stdout may print drift reports — that's expected, not a failure.

```bash
cd <repo-root>/.claude/worktrees/<branch>
git add server/java/render
git commit -m "test(render): RenderCrossPortReportTest (report-only) + KNOWN_DRIFT.md"
```

---

### Task 2.10: Full reactor sanity check + Phase 2 review gate

- [ ] **Step 1: Run full reactor**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn test -q 2>&1 | grep -E 'BUILD SUCCESS|BUILD FAILURE|Tests run:' | tail -3
```

Expected: BUILD SUCCESS, full reactor green (was 788 tests before Phase 1; after Phase 1+2: 788 + ~50 = ~838 tests).

- [ ] **Step 2: Code-reviewer + code-simplifier in parallel**

Code-reviewer focus:
- `server/java/render/` — full module (pom, all source, all tests)
- Cycle-guard correctness in `Renderer`
- Escaper byte-parity with C#/TS references
- `Verify` token-walking semantics vs C# reference
- Snapshot test harness correctness

Code-simplifier scope: same.

- [ ] **Step 3: Apply Important findings; re-run reactor**

```bash
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn test -q 2>&1 | grep -E 'BUILD SUCCESS|BUILD FAILURE|Tests run:' | tail -3
```

- [ ] **Step 4: Push + merge to main**

```bash
cd <repo-root>/.claude/worktrees/<branch>
git fetch origin main
git merge --no-ff origin/main -m "Merge origin/main into worktree-fr004-java-template (pre-Layer-2-merge sync)"
cd <repo-root>/.claude/worktrees/<branch>/server/java && mvn test -q
cd <repo-root>/.claude/worktrees/<branch>
git push origin worktree-fr004-java-template

# In the main checkout:
git -C <repo-root> pull --ff-only origin main
git -C <repo-root> merge --no-ff worktree-fr004-java-template \
  -m "Merge FR-004 Java Layer 2: metaobjects-render module (Provider + Renderer + Verify)"
git -C <repo-root> push origin main
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Plan task(s) |
|---|---|
| §3 module layout (template/ + render/) | 1.1–1.5 (template package), 2.1 (render pom + dirs) |
| §4.1 Vocabulary (types/subtypes) | 1.1 (constants), 1.2/1.3/1.4 (classes) |
| §4.2 Attributes (9 attrs incl. new @requiredTags) | 1.1 (constants), 1.2 (base attrs), 1.3 (prompt overlay) |
| §4.3 3 load-time validations | 1.6 (validateTemplates with 3 cases) |
| §4.4 6 conformance fixtures green | 1.8 (verify all 6 flip) |
| §4.5 origin.collection @via verification | covered by existing Java code; no plan task needed (per inventory) |
| §5.1 Renderer pipeline | 2.6 |
| §5.2 Cycle guard MAX_DEPTH=32 | 2.6 (Renderer) + 2.7 (Verify) |
| §5.3 Provider interface + 2 impls | 2.2, 2.3, 2.4 |
| §5.4 Escapers per format | 2.5 |
| §5.5 verify | 2.7 |
| §6.1 unit tests | 2.2–2.7 |
| §6.2 metatype tests | 1.6 (validation) + 1.7 (loader) |
| §6.3 render snapshot gate | 2.8 |
| §6.4 cross-port report-only | 2.9 |
| §6.5 6 fixtures flip | 1.8 |
| §6.6 JUnit 4 | followed throughout |
| §7 Tier classification | all tasks honor cross-language names + behaviors |

**2. Placeholder scan:**

The Verify implementation in Task 2.7 has `throw new UnsupportedOperationException("port from C# Verify.cs ...")` markers. These are NOT placeholders — they're explicit "port from this reference" instructions for the implementer subagent. The C# `Verify.cs` is fully spelled out at `server/csharp/MetaObjects.Render/Verify.cs` (252 lines, full content captured in the exploration inventory). The implementer reads + ports faithfully. This is the pattern used for large ports in this project.

No other placeholders.

**3. Type consistency:**

- `MetaTemplate.getPayloadRef()` / `getTextRef()` / `getFormat()` / `getMaxChars()` — used consistently across Tasks 1.2, 1.6, 1.7.
- `PromptTemplate.getRequiredSlots()` — used in Tasks 1.3, 1.6, 1.7.
- `Provider.resolve(String)` — Tasks 2.2, 2.3, 2.4, 2.6, 2.7.
- `RenderRequest` record fields — Tasks 2.6, 2.8, 2.9.
- `Verify.check(String, List<PayloadField>, VerifyOptions)` — Task 2.7 (definition + tests).
- Error codes (`ERR_INVALID_TEMPLATE`, `ERR_MISSING_REQUIRED_ATTR`, `ERR_VAR_NOT_ON_PAYLOAD`, etc.) — match the existing Java `ErrorCode` enum per the spec corrections at the top.

No type drift detected.

---

## Execution

**Subagent-Driven Development** — fresh implementer subagent per task, two-stage review per task, code-reviewer + code-simplifier gates per Phase before merging forward into main.

# FR-010 Java Plan 2 — `recover` codegen (typed parser surface) + `@enumAlias` metamodel attr

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the shipped `recover()` engine reachable from generated code: extend the Java output-parser generator so each `template.output` (format `json`|`xml`) also emits a typed, never-throwing `recover(...)` returning `RecoveryResult<Payload>` (best-effort populated record + `RecoveryReport`), driven by a codegen-baked `RecoverSchema` built from the `@payloadRef` value-object. Register the one metamodel attr `recover` consumes (`@enumAlias`).

**Architecture:** Thin codegen + shared engine (the Plan-1 principle). The generator bakes a `static final RecoverSchema RECOVER_SCHEMA = new RecoverSchema(...)` from the VO at codegen time, emits `recover(text[, opts])` that calls `Recover.recover(...)`, and maps the engine's `Map<String,Object>` onto the typed `Payload` record via a small generated constructor call backed by shared coercion helpers (`RecoverMap`) in the `render` module (reflection is forbidden per ADR-0001, so the per-type mapping must be generated — but kept minimal). Correctness is proven by **compiling and running** the generated parser against dirty input, not just string-asserting the emitted source.

**Tech Stack:** Java 21, Maven (`metaobjects-metadata`, `metaobjects-render`, `metaobjects-codegen-spring`), JUnit 4. Generated code depends on `metaobjects-render` at runtime (same precedent as FR-004 render handles depending on the render engine).

**Depends on:** FR-010 Plan 1 (merged `33597b10`): `com.metaobjects.render.recover.{Recover,RecoverSchema,FieldSpec,FieldKind,Format,RecoverOptions,RecoverOutcome,RecoveryReport}`.

## Design decisions (stated for the review gate)

1. **Split from Plan 3.** Plan 2 ships artifact-2 (recover codegen) + the one attr it needs. Plan 3 ships artifact-1 (the output-format prompt-fragment generator + a runtime `OutputFormatRenderer`), the `verify` output-prompt/round-trip checks, the remaining teaching attrs (`@example`/`@instruction`/`@enumDoc`), and the cross-port clean `template-output-{xml,json}-simple` fixtures.
2. **Typed wrapper:** `RecoveryResult<T>` = `record RecoveryResult<T>(T data, RecoveryReport report)` in `render`. `data` is the `Payload` record best-effort populated — components are `null` where the engine classified the field `LOST_*`/`MALFORMED`. Symmetric with FR-006's strict `parse` returning the same record type.
3. **XML root tag convention:** for `format: xml`, `RecoverSchema.rootName` = the payload record's simple class name (e.g. `AnswerOutputPayload`). Documented as the convention Plan 3's skeleton must reproduce; the round-trip check (Plan 3) enforces agreement. No new `@rootTag` attr.
4. **Mapping scope (bounded):** Plan 2 maps **scalar, enum, and scalar-array** payload fields (the common flat LLM-output shape). **Nested-object and object-array** recover-mapping is explicitly deferred to a follow-on (Plan 2.1) — the generator emits a clear `// FR-010: nested-object recover mapping deferred` and treats such a field as `null` in the mapped record (the `RecoveryReport` still classifies it, so no data is silently wrong). Flat/scalar/enum/array covers the consumer's near-term need.
5. **Metamodel:** register only `@enumAlias` (the attr `recover` consumes) in Plan 2 — as a `properties` attr on `EnumField`. `@example`/`@instruction`/`@enumDoc` are registered in Plan 3 with artifact 1. Each registration is additive. Java-only here; other ports register when they implement FR-010.
6. **`recover` is emitted only for `template.output` whose `@format` is `json` or `xml`** (absent ⇒ default `json`). Other formats keep the existing FR-006 `parse` only.

## File Structure

| File | Responsibility |
|---|---|
| `server/java/metadata/.../field/EnumField.java` (modify) | register `@enumAlias` (properties) + `ATTR_ENUM_ALIAS` constant |
| `server/java/render/.../recover/RecoveryResult.java` (create) | `record RecoveryResult<T>(T data, RecoveryReport report)` |
| `server/java/render/.../recover/RecoverMap.java` (create) | shared null-safe coercion helpers map→record (`asString/asInt/asLong/asDouble/asBool/asStringList`) |
| `server/java/codegen-spring/.../spring/RecoverSchemaEmitter.java` (create) | builds the `RecoverSchema` *source literal* + the field-mapping *source* from a VO |
| `server/java/codegen-spring/.../spring/SpringOutputParserGenerator.java` (modify) | emit `RECOVER_SCHEMA` + `recover(...)` alongside `parse(...)` for json/xml outputs |
| test files alongside each | unit + a compile-and-run codegen test |

---

## Task 1: Register `@enumAlias` (properties) on `EnumField`

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/field/EnumField.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/field/EnumFieldEnumAliasTest.java`

**Context:** `EnumField` already registers required `@values` (string-array) and validates members. `@enumAlias` is an optional `properties` (map) attr — off-vocab→canonical, consumed by the recover descriptor. `PropertiesAttribute.SUBTYPE_PROPERTIES = "properties"`; a properties attr's value is read as `java.util.Properties`. Registration DSL: `def.optionalAttributeWithConstraints(name).ofType(subtype).asSingle()` inside `EnumField.registerTypes`.

- [ ] **Step 1: Write the failing test**

```java
// EnumFieldEnumAliasTest.java
package com.metaobjects.field;

import com.metaobjects.attr.PropertiesAttribute;
import com.metaobjects.loader.simple.SimpleLoader;
import com.metaobjects.MetaData;
import org.junit.Test;
import java.util.Properties;
import static org.junit.Assert.*;

public class EnumFieldEnumAliasTest {

    @Test
    public void enumAliasAttrConstantIsStable() {
        assertEquals("enumAlias", EnumField.ATTR_ENUM_ALIAS);
    }

    @Test
    public void enumFieldAcceptsPropertiesEnumAlias() {
        // An enum field carrying @enumAlias as a properties map loads and reads back as Properties.
        EnumField f = (EnumField) EnumField.builder("tone").build();  // see note below if builder differs
        PropertiesAttribute alias = new PropertiesAttribute(EnumField.ATTR_ENUM_ALIAS);
        Properties p = new Properties();
        p.setProperty("warm", "FRIENDLY");
        alias.setValueAsObject(p);
        f.addMetaAttr(alias);

        assertTrue(f.hasMetaAttr(EnumField.ATTR_ENUM_ALIAS));
        Properties read = (Properties) f.getMetaAttr(EnumField.ATTR_ENUM_ALIAS).getValue();
        assertEquals("FRIENDLY", read.getProperty("warm"));
    }
}
```

> **Step 1 note:** if `EnumField.builder(...)` is not the construction idiom in this codebase, construct the field the way other `EnumField` unit tests do (check `EnumFieldTest.java` for the exact constructor/builder) and keep the assertions. The behavioral assertions (constant value + properties round-trip) are the spec.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-metadata test -Dtest=EnumFieldEnumAliasTest -q`
Expected: FAIL — `EnumField.ATTR_ENUM_ALIAS` does not exist (compile error).

- [ ] **Step 3: Add the constant + registration**

In `EnumField.java`, add the constant beside `ATTR_VALUES`:
```java
    /** Optional off-vocabulary → canonical-member alias map (properties). Consumed by FR-010 recover. */
    public static final String ATTR_ENUM_ALIAS = "enumAlias";
```
In `EnumField.registerTypes(...)`, after the existing `requiredAttributeWithConstraints(ATTR_VALUES)...asArray()` registration, add:
```java
       .optionalAttributeWithConstraints(ATTR_ENUM_ALIAS)
          .ofType(com.metaobjects.attr.PropertiesAttribute.SUBTYPE_PROPERTIES)
          .asSingle()
```
(Chain it into the same `def -> { ... }` builder, matching the existing fluent style; mind the trailing `;`/chaining used by the surrounding registrations.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-metadata test -Dtest=EnumFieldEnumAliasTest -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the metadata conformance suite (no regressions)**

Run: `cd server/java && mvn -pl :metaobjects-metadata test -q`
Expected: PASS — existing metadata + conformance tests green (the new attr is optional, so no fixture changes).

- [ ] **Step 6: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/field/EnumField.java \
        server/java/metadata/src/test/java/com/metaobjects/field/EnumFieldEnumAliasTest.java
git commit -m "feat(metadata): FR-010 register @enumAlias (properties) on field.enum"
```

---

## Task 2: `RecoveryResult<T>` + `RecoverMap` coercion helpers (render module)

**Files:**
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/RecoveryResult.java`
- Create: `server/java/render/src/main/java/com/metaobjects/render/recover/RecoverMap.java`
- Test: `server/java/render/src/test/java/com/metaobjects/render/recover/RecoverMapTest.java`

**Context:** The generated `recover(...)` maps `RecoverOutcome.data()` (`Map<String,Object>`: String / Long / Double / Boolean / List) onto the typed `Payload` record. The per-type constructor call is generated; the value coercions are these shared, null-safe helpers (so emitted code stays one line per component and the conversion logic is unit-tested once). All helpers return `null` when the key is absent (engine omitted it — `LOST_*`/`MALFORMED`), so a record component is simply `null`.

- [ ] **Step 1: Write the failing test**

```java
// RecoverMapTest.java
package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class RecoverMapTest {

    private Map<String, Object> data() {
        return Map.of("s", "hi", "n", 7L, "d", 1.5, "b", Boolean.TRUE, "xs", List.of("a", "b"));
    }

    @Test public void asStringReadsAndDefaultsNull() {
        assertEquals("hi", RecoverMap.asString(data(), "s"));
        assertNull(RecoverMap.asString(Map.of(), "s"));
    }

    @Test public void asIntNarrowsLong() {
        assertEquals(Integer.valueOf(7), RecoverMap.asInt(data(), "n"));
        assertNull(RecoverMap.asInt(Map.of(), "n"));
    }

    @Test public void asLongReads() {
        assertEquals(Long.valueOf(7), RecoverMap.asLong(data(), "n"));
    }

    @Test public void asDoubleReads() {
        assertEquals(Double.valueOf(1.5), RecoverMap.asDouble(data(), "d"));
    }

    @Test public void asBoolReads() {
        assertEquals(Boolean.TRUE, RecoverMap.asBool(data(), "b"));
        assertNull(RecoverMap.asBool(Map.of(), "b"));
    }

    @Test public void asStringListReadsAndDefaultsNull() {
        assertEquals(List.of("a", "b"), RecoverMap.asStringList(data(), "xs"));
        assertNull(RecoverMap.asStringList(Map.of(), "xs"));
    }

    @Test public void asStringListCoercesElementsToString() {
        Map<String, Object> m = Map.of("xs", List.of(1L, 2L));
        assertEquals(List.of("1", "2"), RecoverMap.asStringList(m, "xs"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=RecoverMapTest -q`
Expected: COMPILE FAILURE — `RecoverMap` does not exist.

- [ ] **Step 3: Implement both types**

```java
// RecoveryResult.java
package com.metaobjects.render.recover;
import java.util.Objects;
/** Typed result of a generated recover(...): best-effort record (null components where lost/malformed) + report. */
public record RecoveryResult<T>(T data, RecoveryReport report) {
    public RecoveryResult { Objects.requireNonNull(report, "report"); }
}
```

```java
// RecoverMap.java
package com.metaobjects.render.recover;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Null-safe coercions from a RecoverOutcome data map onto typed record components. Generated recover(...) calls these. */
public final class RecoverMap {
    private RecoverMap() {}

    public static String asString(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v == null ? null : (v instanceof String s ? s : String.valueOf(v));
    }

    public static Integer asInt(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v instanceof Number n ? n.intValue() : null;
    }

    public static Long asLong(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v instanceof Number n ? n.longValue() : null;
    }

    public static Double asDouble(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v instanceof Number n ? n.doubleValue() : null;
    }

    public static Boolean asBool(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v instanceof Boolean b ? b : null;
    }

    public static List<String> asStringList(Map<String, Object> d, String k) {
        Object v = d.get(k);
        if (!(v instanceof List<?> list)) return null;
        List<String> out = new ArrayList<>(list.size());
        for (Object e : list) out.add(e == null ? null : String.valueOf(e));
        return out;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-render test -Dtest=RecoverMapTest -q`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/render/src/main/java/com/metaobjects/render/recover/RecoveryResult.java \
        server/java/render/src/main/java/com/metaobjects/render/recover/RecoverMap.java \
        server/java/render/src/test/java/com/metaobjects/render/recover/RecoverMapTest.java
git commit -m "feat(render): FR-010 RecoveryResult + RecoverMap coercion helpers"
```

---

## Task 3: `RecoverSchemaEmitter` — emit `RecoverSchema` + mapping source from a VO

**Files:**
- Create: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/RecoverSchemaEmitter.java`
- Test: `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/RecoverSchemaEmitterTest.java`

**Context:** This isolates the *source-emission* logic (a pure `MetaObject` VO → Java-source strings) so it is unit-testable without running the whole generator. It produces two strings: (a) the `RecoverSchema` literal, (b) the `new Payload(...)` constructor-arg list using `RecoverMap`. Field-reading API (from the codebase): `vo.getMetaFields()`; `field.getName()`; `field instanceof EnumField`; enum values via `(List<String>) field.getMetaAttr(EnumField.ATTR_VALUES).getValue()`; `@enumAlias` via `(java.util.Properties) field.getMetaAttr(EnumField.ATTR_ENUM_ALIAS).getValue()`; `field.isArray()`; `field instanceof ObjectField`; required via `field.hasMetaAttr(MetaField.ATTR_REQUIRED) && (Boolean) field.getMetaAttr(MetaField.ATTR_REQUIRED).getValue()`. Map metaobjects field types → `FieldKind`: String→STRING, Integer→INT, Long→LONG, Double→DOUBLE, Boolean→BOOLEAN, Enum→ENUM. Nested object / object-array → deferred (emit a `null` arg + a `// nested deferred` comment, no FieldSpec contribution beyond a placeholder).

- [ ] **Step 1: Write the failing test**

```java
// RecoverSchemaEmitterTest.java
package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RecoverSchemaEmitterTest {

    // Loads a VO with: text (string, required), confidence (enum HIGH/OK/LOW, alias medium->OK, required), note (string)
    private static final String FIXTURE = SpringTestFixtures.RECOVER_VO_FIXTURE; // defined in Step 3 note

    @Test
    public void emitsSchemaLiteralWithEnumAndAlias() throws Exception {
        MetaObject vo = SpringTestFixtures.loadVo(FIXTURE, "AnswerOutputPayload");
        String schema = RecoverSchemaEmitter.schemaLiteral(vo, "json", "AnswerOutputPayload");

        assertTrue(schema.contains("new RecoverSchema(Format.JSON, \"AnswerOutputPayload\""));
        assertTrue(schema.contains("FieldSpec.scalar(\"text\", FieldKind.STRING, true)"));
        assertTrue(schema.contains("FieldSpec.enumField(\"confidence\", true,"));
        assertTrue(schema.contains("\"HIGH\""));
        assertTrue(schema.contains("java.util.Map.of(\"medium\", \"OK\")"));
        assertTrue(schema.contains("FieldSpec.scalar(\"note\", FieldKind.STRING, false)"));
    }

    @Test
    public void emitsConstructorArgsUsingRecoverMap() throws Exception {
        MetaObject vo = SpringTestFixtures.loadVo(FIXTURE, "AnswerOutputPayload");
        String args = RecoverSchemaEmitter.constructorArgs(vo);
        assertTrue(args.contains("RecoverMap.asString(d, \"text\")"));
        assertTrue(args.contains("RecoverMap.asString(d, \"confidence\")"));   // enum → String component
        assertTrue(args.contains("RecoverMap.asString(d, \"note\")"));
    }

    @Test
    public void xmlSchemaUsesXmlFormatAndRootName() throws Exception {
        MetaObject vo = SpringTestFixtures.loadVo(FIXTURE, "AnswerOutputPayload");
        String schema = RecoverSchemaEmitter.schemaLiteral(vo, "xml", "AnswerOutputPayload");
        assertTrue(schema.contains("new RecoverSchema(Format.XML, \"AnswerOutputPayload\""));
    }
}
```

> **Step 1 note:** `SpringTestFixtures.loadVo(fixtureJson, voName)` and a `RECOVER_VO_FIXTURE` constant must be added to the existing `SpringTestFixtures` test helper (the codebase already has `SpringTestFixtures.loadFixture(...)`; add a thin `loadVo` that loads inline metadata and returns the named `object.value`). The fixture declares one `object.value` `AnswerOutputPayload` with the three fields above. If `loadFixture` already returns a loader, `loadVo` = `(MetaObject) loader.getMetaObjectByName(voName)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-codegen-spring test -Dtest=RecoverSchemaEmitterTest -q`
Expected: COMPILE FAILURE — `RecoverSchemaEmitter` (and the `SpringTestFixtures.loadVo`/`RECOVER_VO_FIXTURE` helpers) do not exist.

- [ ] **Step 3: Implement `RecoverSchemaEmitter` (+ the test-helper additions)**

Add to `SpringTestFixtures` (test sources): the `RECOVER_VO_FIXTURE` inline-JSON constant (one `object.value` `AnswerOutputPayload` with `text`:string+@required, `confidence`:enum `@values ["HIGH","OK","LOW"]` `@enumAlias {medium:OK}` +@required, `note`:string) and a `static MetaObject loadVo(String fixtureJson, String voName)` helper mirroring `loadFixture` then returning the named value-object.

Then create `RecoverSchemaEmitter.java`:
```java
package com.metaobjects.generator.spring;

import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.BooleanField;
import com.metaobjects.object.MetaObject;

import java.util.List;
import java.util.Properties;
import java.util.StringJoiner;

/** Emits the RecoverSchema source literal + the Payload constructor-arg source for a value-object. */
final class RecoverSchemaEmitter {
    private RecoverSchemaEmitter() {}

    /** A `new RecoverSchema(Format.X, "root", java.util.List.of(<FieldSpec ...>))` source literal. */
    static String schemaLiteral(MetaObject vo, String format, String rootName) {
        String fmt = "xml".equalsIgnoreCase(format) ? "Format.XML" : "Format.JSON";
        StringJoiner specs = new StringJoiner(",\n            ");
        for (MetaField f : vo.getMetaFields()) specs.add(fieldSpec(f));
        return "new RecoverSchema(" + fmt + ", \"" + rootName + "\", java.util.List.of(\n            "
                + specs + "))";
    }

    /** The comma-separated constructor args for `new <Payload>(...)`, reading from a `Map<String,Object> d`. */
    static String constructorArgs(MetaObject vo) {
        StringJoiner args = new StringJoiner(",\n                ");
        for (MetaField f : vo.getMetaFields()) args.add(mapAccessor(f));
        return args.toString();
    }

    private static String fieldSpec(MetaField f) {
        String name = f.getName();
        boolean required = isRequired(f);
        if (f instanceof EnumField) {
            List<String> values = enumValues(f);
            StringJoiner vj = new StringJoiner(", ");
            for (String v : values) vj.add("\"" + v + "\"");
            return "FieldSpec.enumField(\"" + name + "\", " + required
                    + ", java.util.List.of(" + vj + "), " + aliasMapLiteral(f) + ")";
        }
        if (f instanceof ObjectField || f.isArray() && !isScalar(f)) {
            return "FieldSpec.scalar(\"" + name + "\", FieldKind.STRING, " + required + ") /* FR-010: nested recover deferred */";
        }
        return "FieldSpec.scalar(\"" + name + "\", " + fieldKind(f) + ", " + required + ")";
    }

    private static String mapAccessor(MetaField f) {
        if (f instanceof EnumField) return "RecoverMap.asString(d, \"" + f.getName() + "\")";
        if (f.isArray()) return "RecoverMap.asStringList(d, \"" + f.getName() + "\")";
        if (f instanceof IntegerField) return "RecoverMap.asInt(d, \"" + f.getName() + "\")";
        if (f instanceof LongField) return "RecoverMap.asLong(d, \"" + f.getName() + "\")";
        if (f instanceof DoubleField) return "RecoverMap.asDouble(d, \"" + f.getName() + "\")";
        if (f instanceof BooleanField) return "RecoverMap.asBool(d, \"" + f.getName() + "\")";
        if (f instanceof ObjectField) return "null /* FR-010: nested recover deferred */";
        return "RecoverMap.asString(d, \"" + f.getName() + "\")";
    }

    private static String fieldKind(MetaField f) {
        if (f instanceof IntegerField) return "FieldKind.INT";
        if (f instanceof LongField) return "FieldKind.LONG";
        if (f instanceof DoubleField) return "FieldKind.DOUBLE";
        if (f instanceof BooleanField) return "FieldKind.BOOLEAN";
        return "FieldKind.STRING"; // StringField, CurrencyField(minor-units as string here), fallback
    }

    private static boolean isScalar(MetaField f) {
        return f instanceof StringField || f instanceof IntegerField || f instanceof LongField
                || f instanceof DoubleField || f instanceof BooleanField || f instanceof EnumField;
    }

    @SuppressWarnings("unchecked")
    private static List<String> enumValues(MetaField f) {
        return (List<String>) f.getMetaAttr(EnumField.ATTR_VALUES).getValue();
    }

    private static String aliasMapLiteral(MetaField f) {
        if (!f.hasMetaAttr(EnumField.ATTR_ENUM_ALIAS)) return "java.util.Map.of()";
        Properties p = (Properties) f.getMetaAttr(EnumField.ATTR_ENUM_ALIAS).getValue();
        StringJoiner kv = new StringJoiner(", ");
        for (String key : p.stringPropertyNames()) kv.add("\"" + key + "\", \"" + p.getProperty(key) + "\"");
        return "java.util.Map.of(" + kv + ")";
    }

    private static boolean isRequired(MetaField f) {
        return f.hasMetaAttr(MetaField.ATTR_REQUIRED)
                && Boolean.TRUE.equals(f.getMetaAttr(MetaField.ATTR_REQUIRED).getValue());
    }
}
```

> **Step 3 note:** verify the exact field-class names/imports (`IntegerField`, `LongField`, etc.) against `SpringTypeMapper.javaTypeName` — that method already switches on the same classes, so mirror its imports/instanceof set exactly. If `enumAlias` properties round-trip yields a non-`Properties` map type, adjust the cast to whatever `PropertiesAttribute.getValue()` returns (Task 1 pinned it as `Properties`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-codegen-spring test -Dtest=RecoverSchemaEmitterTest -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/RecoverSchemaEmitter.java \
        server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/RecoverSchemaEmitterTest.java \
        server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringTestFixtures.java
git commit -m "feat(codegen-spring): FR-010 RecoverSchemaEmitter (VO -> RecoverSchema + mapping source)"
```

---

## Task 4: Extend `SpringOutputParserGenerator` to emit `recover(...)`

**Files:**
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringOutputParserGenerator.java`
- Test: `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringOutputParserRecoverTest.java`

**Context:** The generator's `emit(...)` currently builds a parser class with `parse(text)` (Jackson). Extend the emitted class — for `@format` `json` or `xml` only — to also import the recover engine, hold a `static final RecoverSchema RECOVER_SCHEMA`, and expose `recover(text)` + `recover(text, RecoverOptions)`. Read `@format` from the template (`TEMPLATE_ATTR_FORMAT`, default `json`); `RecoverSchemaEmitter` supplies the schema + arg source; `payloadClass` is already resolved in `emit(...)`.

- [ ] **Step 1: Write the failing test (string-asserts the emitted source)**

```java
// SpringOutputParserRecoverTest.java
package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.*;

public class SpringOutputParserRecoverTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void emitsRecoverAlongsideParseForJsonOutput() throws Exception {
        Path out = tmp.newFolder("gen").toPath();
        Path ws = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "recover-out", SpringTestFixtures.RECOVER_OUTPUT_FIXTURE);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parser = out.resolve("acme/ai/prompts/AnswerOutputParser.java");
        assertTrue("parser emitted", Files.exists(parser));
        String src = Files.readString(parser);

        assertTrue(src.contains("import com.metaobjects.render.recover.Recover;"));
        assertTrue(src.contains("static final com.metaobjects.render.recover.RecoverSchema RECOVER_SCHEMA"));
        assertTrue(src.contains("public static com.metaobjects.render.recover.RecoveryResult<AnswerOutputPayload> recover(String text)"));
        assertTrue(src.contains("recover(String text, com.metaobjects.render.recover.RecoverOptions opts)"));
        assertTrue(src.contains("new AnswerOutputPayload("));
        // strict parse still present:
        assertTrue(src.contains("public static AnswerOutputPayload parse(String text)"));
    }
}
```

> `SpringTestFixtures.RECOVER_OUTPUT_FIXTURE` = the `AnswerOutputPayload` VO (Task 3) PLUS a `template.output` named `AnswerOutput` with `@payloadRef: AnswerOutputPayload`, `@textRef` (any value — unused by recover), `@format: json`, package `acme::ai`. Add it next to `RECOVER_VO_FIXTURE`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -pl :metaobjects-codegen-spring test -Dtest=SpringOutputParserRecoverTest -q`
Expected: FAIL — emitted source lacks the recover members.

- [ ] **Step 3: Extend `emit(...)`**

In `SpringOutputParserGenerator.emit(...)`, after the existing `parse(...)` method is appended and before the closing `}` of the class, insert (guarded by format):
```java
        String format = template.hasMetaAttr(TemplateConstants.ATTR_FORMAT)
                ? template.getMetaAttr(TemplateConstants.ATTR_FORMAT).getValueAsString() : "json";
        if ("json".equalsIgnoreCase(format) || "xml".equalsIgnoreCase(format)) {
            src.append("\n");
            src.append("    private static final com.metaobjects.render.recover.RecoverSchema RECOVER_SCHEMA =\n");
            src.append("        ").append(RecoverSchemaEmitter.schemaLiteral(vo, format, payloadClass)).append(";\n\n");
            src.append("    /** Tolerant best-effort recovery; never throws. Components are null where lost/malformed. */\n");
            src.append("    public static com.metaobjects.render.recover.RecoveryResult<").append(payloadClass)
               .append("> recover(String text) {\n");
            src.append("        return recover(text, com.metaobjects.render.recover.RecoverOptions.defaults());\n");
            src.append("    }\n\n");
            src.append("    public static com.metaobjects.render.recover.RecoveryResult<").append(payloadClass)
               .append("> recover(String text, com.metaobjects.render.recover.RecoverOptions opts) {\n");
            src.append("        com.metaobjects.render.recover.RecoverOutcome o = com.metaobjects.render.recover.Recover.recover(text, RECOVER_SCHEMA, opts);\n");
            src.append("        java.util.Map<String, Object> d = o.data();\n");
            src.append("        ").append(payloadClass).append(" data = new ").append(payloadClass).append("(\n                ")
               .append(RecoverSchemaEmitter.constructorArgs(vo)).append(");\n");
            src.append("        return new com.metaobjects.render.recover.RecoveryResult<>(data, o.report());\n");
            src.append("    }\n");
        }
```
Add the convenience import line near the existing Jackson imports (optional — fully-qualified names above already work without imports, except the test asserts `import com.metaobjects.render.recover.Recover;`, so DO add that one import line):
```java
        src.append("import com.metaobjects.render.recover.Recover;\n");
```
Use the real `TemplateConstants` format-attr constant name (the metadata module defines it; confirm it is `ATTR_FORMAT` — if the constant differs, use the actual one). `vo` and `payloadClass` are the locals already computed in `emit(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -pl :metaobjects-codegen-spring test -Dtest=SpringOutputParserRecoverTest -q`
Expected: PASS.

- [ ] **Step 5: Run full codegen-spring suite (no regressions)**

Run: `cd server/java && mvn -pl :metaobjects-codegen-spring test -q`
Expected: PASS — existing output-parser/payload tests unaffected (recover is additive; non-json/xml formats unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringOutputParserGenerator.java \
        server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringOutputParserRecoverTest.java \
        server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringTestFixtures.java
git commit -m "feat(codegen-spring): FR-010 emit typed recover() alongside parse() for json/xml outputs"
```

---

## Task 5: Compile-and-run proof — the generated `recover()` actually recovers dirty input

**Files:**
- Test: `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/GeneratedRecoverCompileRunTest.java`

**Context:** String-asserting emitted source proves shape, not behavior. This test generates BOTH the payload record (`SpringPayloadGenerator`) and the parser-with-recover (`SpringOutputParserGenerator`), compiles them in-memory with `javax.tools.JavaCompiler` against the test classpath (which includes `metaobjects-render`), loads the parser class, invokes `recover(String)` reflectively on dirty input, and asserts the recovered record fields + the report. This is the gold-standard codegen verification.

- [ ] **Step 1: Write the failing test**

```java
// GeneratedRecoverCompileRunTest.java
package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;
import java.io.File;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

public class GeneratedRecoverCompileRunTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void generatedRecoverRecoversFencedDirtyJson() throws Exception {
        Path gen = tmp.newFolder("gen").toPath();
        Path ws = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "recover-cr", SpringTestFixtures.RECOVER_OUTPUT_FIXTURE);

        // 1) generate payload record + parser-with-recover into the same source root
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator(); payloadGen.setArgs(args); payloadGen.execute(loader);
        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator(); parserGen.setArgs(args); parserGen.execute(loader);

        // 2) compile every generated .java against the current test classpath (includes metaobjects-render)
        Path classes = tmp.newFolder("classes").toPath();
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required to run this test", javac);
        String cp = System.getProperty("java.class.path");
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());
        var fm = javac.getStandardFileManager(null, null, null);
        boolean ok = javac.getTask(null, fm, null, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        assertTrue("generated sources must compile", ok);

        // 3) load + invoke recover(String) on fenced/prose-wrapped dirty input
        try (URLClassLoader cl = new URLClassLoader(new URL[]{ classes.toUri().toURL() },
                getClass().getClassLoader())) {
            Class<?> parser = cl.loadClass("acme.ai.prompts.AnswerOutputParser");
            Method recover = parser.getMethod("recover", String.class);
            String dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"medium\"}\n```\nDone.";
            Object result = recover.invoke(null, dirty);   // RecoveryResult<AnswerOutputPayload>

            Object payload = result.getClass().getMethod("data").invoke(result);
            Object report = result.getClass().getMethod("report").invoke(result);

            // record component accessors: text(), confidence(), note()
            assertEquals("hi", payload.getClass().getMethod("text").invoke(payload));
            assertEquals("OK", payload.getClass().getMethod("confidence").invoke(payload)); // alias medium->OK
            assertNull(payload.getClass().getMethod("note").invoke(payload));               // optional, absent

            boolean hasLostRequired = (boolean) report.getClass().getMethod("hasLostRequired").invoke(report);
            assertFalse(hasLostRequired);
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails (then passes)**

Run: `cd server/java && mvn -pl :metaobjects-codegen-spring test -Dtest=GeneratedRecoverCompileRunTest -q`
Expected first run: this test depends only on Task 4's generator output, which already exists after Task 4 — so it should PASS once written. If it FAILS, the failure is real (the generated `recover` doesn't behave). Likely causes + fixes:
- compile failure → inspect the emitted source; the `RecoverSchemaEmitter` literal or import is malformed; fix the emitter/generator (Task 3/4), not the test.
- `confidence` not `"OK"` → the `@enumAlias` wasn't carried into the schema literal; fix `RecoverSchemaEmitter.aliasMapLiteral`.
Do NOT weaken the assertions to pass.

- [ ] **Step 3: Commit**

```bash
git add server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/GeneratedRecoverCompileRunTest.java
git commit -m "test(codegen-spring): FR-010 compile-and-run proof of generated recover()"
```

---

## Task 6: Full-suite regression + docs touch

**Files:**
- Modify: `server/java/codegen-spring/.../KNOWN_GAPS.md` (if present) or add a short note where output-parser codegen is documented.

- [ ] **Step 1: Run the three affected modules**

Run: `cd server/java && mvn -pl :metaobjects-metadata,:metaobjects-render,:metaobjects-codegen-spring test -q`
Expected: all green.

- [ ] **Step 2: Note the bounded deferral**

Add a short note (where output-parser codegen gaps are tracked, e.g. `codegen-spring/.../KNOWN_GAPS.md`):
```
FR-010 recover codegen (Plan 2): scalar/enum/scalar-array payload fields are mapped.
Nested-object and object-array recover-mapping is deferred (Plan 2.1) — such fields are
classified by the RecoveryReport but mapped to null in the recovered record.
```

- [ ] **Step 3: Commit**

```bash
git add server/java/codegen-spring/
git commit -m "docs(codegen-spring): note FR-010 recover nested-mapping deferral"
```

---

## Self-Review

- **Spec coverage (artifact 2):** typed `recover()` returning `RecoveryResult<Payload>` (Tasks 2/4); descriptor baked from VO incl. `@enumAlias` folding (Tasks 1/3); json+xml gating (Task 4); never-throws inherited from the engine; compile-and-run proof (Task 5). The strict `parse` (FR-006) is untouched and still emitted.
- **Out of scope (→ Plan 3):** artifact-1 output-format prompt fragment generator + `OutputFormatRenderer`; `@example`/`@instruction`/`@enumDoc` attrs; `verify` output-prompt + round-trip checks; cross-port clean `template-output-{xml,json}-simple` fixtures. **Bounded deferral (→ Plan 2.1):** nested-object / object-array recover mapping.
- **Type consistency:** `RecoveryResult<T>(T data, RecoveryReport report)`, `RecoverMap.as{String,Int,Long,Double,Bool,StringList}`, `RecoverSchemaEmitter.{schemaLiteral,constructorArgs}`, engine `Recover.recover`/`RecoverOutcome`/`RecoverOptions.defaults()`/`RecoverSchema`/`FieldSpec.{scalar,enumField}`/`FieldKind` used identically across tasks and match the merged Plan-1 API.
- **Verification-before-completion gates flagged for the executor:** Steps 2/3 distinguish "expected fail" from "real fail"; the compile-and-run test (Task 5) must not have its assertions weakened.

## Plan 3 (follow-on — outline)

1. Register `@example`/`@instruction` (string, field.base) + `@enumDoc` (properties, EnumField).
2. New `OutputFormatRenderer` in `render`: descriptor (+ teaching metadata) + render-time overrides → the format-instruction fragment (skeleton in json/xml + per-field guidance from `@example`/`@enumDoc`/`@instruction`/required-marking). Pedagogy, not schema dump; examples render-time-overridable.
3. New `SpringOutputPromptGenerator`: emits `<Template>OutputPrompt.renderFormat([overrides])` thin over `OutputFormatRenderer`, sharing the XML root-tag convention (payload class name) with Task 4.
4. `verify`: `output-prompt` coverage check + the build-time round-trip check (`recover(renderFormat())` is structurally complete) in `render/Verify` + verify-conformance corpus; confirm/extend the `meta:verify` maven-goal wiring (currently DB-drift only).
5. Cross-port clean fixtures `fixtures/conformance/template-output-{xml,json}-simple/` with Java expected output for both the prompt fragment and the parser-with-recover; round-trip property test.

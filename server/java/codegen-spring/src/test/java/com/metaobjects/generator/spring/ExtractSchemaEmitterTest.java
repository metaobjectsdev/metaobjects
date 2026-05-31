package com.metaobjects.generator.spring;

import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link ExtractSchemaEmitter}.
 *
 * <p>Pins the two output contracts:
 * <ul>
 *   <li>{@link ExtractSchemaEmitter#schemaLiteral} — emits a
 *       {@code new ExtractSchema(...)} literal with correct {@code FieldSpec} calls
 *       for scalar, enum (with alias), and optional fields.</li>
 *   <li>{@link ExtractSchemaEmitter#constructorArgs} — emits the comma-separated
 *       {@code ExtractMap.*} argument list for each field.</li>
 * </ul>
 *
 * <p>The VO fixture (declared in {@link SpringTestFixtures#EXTRACT_VO_FIXTURE})
 * has three fields: {@code text} (string, required), {@code confidence} (enum,
 * required, values HIGH/OK/LOW, alias medium→OK), {@code note} (string, optional).
 */
public class ExtractSchemaEmitterTest extends SharedRegistryTestBase {

    private MetaObject vo() throws Exception {
        return SpringTestFixtures.loadVo(SpringTestFixtures.EXTRACT_VO_FIXTURE, "AnswerOutputPayload");
    }

    // -------------------------------------------------------------------------
    // schemaLiteral tests
    // -------------------------------------------------------------------------

    @Test
    public void emitsSchemaLiteralWithEnumAndAlias() throws Exception {
        String s = ExtractSchemaEmitter.schemaLiteral(vo(), "json", "AnswerOutputPayload");

        assertTrue("expected ExtractSchema(Format.JSON, \"AnswerOutputPayload\"; saw:\n" + s,
            s.contains("new ExtractSchema(Format.JSON, \"AnswerOutputPayload\""));

        assertTrue("expected scalar for text; saw:\n" + s,
            s.contains("FieldSpec.scalar(\"text\", FieldKind.STRING, true)"));

        assertTrue("expected enumField for confidence; saw:\n" + s,
            s.contains("FieldSpec.enumField(\"confidence\", true,"));

        assertTrue("expected HIGH in enum values; saw:\n" + s,
            s.contains("\"HIGH\""));

        assertTrue("expected alias map literal with medium→OK via Map.ofEntries; saw:\n" + s,
            s.contains("java.util.Map.ofEntries(java.util.Map.entry(\"medium\", \"OK\")"));

        assertTrue("expected scalar for note (optional); saw:\n" + s,
            s.contains("FieldSpec.scalar(\"note\", FieldKind.STRING, false)"));
    }

    @Test
    public void xmlSchemaUsesXmlFormat() throws Exception {
        String s = ExtractSchemaEmitter.schemaLiteral(vo(), "xml", "AnswerOutputPayload");
        assertTrue("expected Format.XML; saw:\n" + s,
            s.contains("new ExtractSchema(Format.XML, \"AnswerOutputPayload\""));
    }

    // -------------------------------------------------------------------------
    // constructorArgs tests
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Map.ofEntries regression — >10 alias entries must not use Map.of(...)
    // -------------------------------------------------------------------------

    /**
     * Regression test: an enum field with 12 {@code @enumAlias} entries must emit
     * {@code java.util.Map.ofEntries(...)} (no arity limit) rather than
     * {@code java.util.Map.of(...)} (capped at 10 key-value pairs and would not compile).
     */
    @Test
    public void bigAliasMapsUseOfEntriesNotMapOf() throws Exception {
        MetaObject bigVo = SpringTestFixtures.loadVo(
            SpringTestFixtures.EXTRACT_BIG_ALIAS_FIXTURE, "BigAliasPayload");
        String s = ExtractSchemaEmitter.schemaLiteral(bigVo, "json", "BigAliasPayload");

        assertTrue("expected Map.ofEntries for 12-entry alias map; saw:\n" + s,
            s.contains("java.util.Map.ofEntries("));

        assertTrue("expected individual Map.entry calls; saw:\n" + s,
            s.contains("java.util.Map.entry("));

        // Count occurrences of Map.entry( — there must be exactly 12.
        int entryCount = 0;
        int idx = 0;
        while ((idx = s.indexOf("java.util.Map.entry(", idx)) != -1) {
            entryCount++;
            idx += "java.util.Map.entry(".length();
        }
        assertTrue("expected 12 Map.entry(...) calls for 12-entry alias map, got " + entryCount
            + "; saw:\n" + s, entryCount == 12);

        // Must NOT contain a bare Map.of( with 24 arguments (12 pairs).
        assertFalse("must not use bare Map.of for >10 alias entries; saw:\n" + s,
            s.contains("java.util.Map.of(\"a"));
    }

    // -------------------------------------------------------------------------
    // FR-011 — @coerceDefault + resolved @normalize emission
    // -------------------------------------------------------------------------

    /**
     * FR-011: an enum field owning {@code @coerceDefault} (and inheriting the object-level
     * {@code @normalize: "collapse"}) emits the 7-arg enumField form with the resolved
     * normalize mode and the coerceDefault member. A field with its own {@code @normalize: "none"}
     * overrides the object default. A plain enum with no FR-011 attrs but a non-default inherited
     * normalize still emits the 7-arg form (because the resolved mode != "strip").
     */
    @Test
    public void emitsFr011CoerceDefaultAndResolvedNormalize() throws Exception {
        MetaObject vo = SpringTestFixtures.loadVo(
            SpringTestFixtures.EXTRACT_FR011_FIXTURE, "Fr011Payload");
        String s = ExtractSchemaEmitter.schemaLiteral(vo, "json", "Fr011Payload");

        // status: coerceDefault="LOW", normalize resolves to the object default "collapse".
        assertTrue("status should emit 7-arg form with coerceDefault LOW + normalize collapse; saw:\n" + s,
            s.contains("FieldSpec.enumField(\"status\", true, java.util.List.of(\"HIGH\", \"OK\", \"LOW\")"
                + ", java.util.Map.of(), \"LOW\", \"collapse\", null)"));

        // phase: own @normalize="none" overrides the object default; no coerceDefault/default.
        assertTrue("phase should emit 7-arg form with normalize none; saw:\n" + s,
            s.contains("FieldSpec.enumField(\"phase\", true, java.util.List.of(\"HIGH\", \"OK\", \"LOW\")"
                + ", java.util.Map.of(), null, \"none\", null)"));

        // plain: no FR-011 attrs but inherits object "collapse" → still 7-arg (mode != strip).
        assertTrue("plain should emit 7-arg form with inherited normalize collapse; saw:\n" + s,
            s.contains("FieldSpec.enumField(\"plain\", false, java.util.List.of(\"HIGH\", \"OK\", \"LOW\")"
                + ", java.util.Map.of(), null, \"collapse\", null)"));
    }

    @Test
    public void emitsConstructorArgsUsingExtractMap() throws Exception {
        String a = ExtractSchemaEmitter.constructorArgs(vo());

        assertTrue("expected asString for text; saw:\n" + a,
            a.contains("ExtractMap.asString(d, \"text\")"));

        assertTrue("expected asString for confidence (enum); saw:\n" + a,
            a.contains("ExtractMap.asString(d, \"confidence\")"));

        assertTrue("expected asString for note; saw:\n" + a,
            a.contains("ExtractMap.asString(d, \"note\")"));
    }
}

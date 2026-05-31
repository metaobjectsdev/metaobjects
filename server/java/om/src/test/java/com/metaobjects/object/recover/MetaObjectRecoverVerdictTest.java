/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.object.recover;

import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.render.recover.FieldRecovery;
import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.RecoverException;
import com.metaobjects.render.recover.RecoverOptions;
import com.metaobjects.render.recover.RecoveryResult;
import org.junit.After;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Gold-standard "verdict oracle" proof for the Phase B runtime recover
 * ({@link MetaObjectRecover}).
 *
 * <p>A representative adjudication-verdict {@code object.value} graph — scalars (incl. an
 * enum with a {@code @default}), an array-of-enum, and two arrays-of-records — is recovered
 * from a deliberately DIRTY XML response (preamble + whitespace, an empty array, an
 * uncoercible enum value, an omitted defaulted field). The test proves the full
 * metadata-driven pipeline: {@code recoverSchemaFor} → engine → {@code assemble} into a
 * typed object graph with correct back-references, generalized {@code @default} fill,
 * empty-array → empty-list, never-throws, and the {@code orThrow()} opt-in gate.</p>
 */
public class MetaObjectRecoverVerdictTest {

    private static final String PKG = "com::example::verdict";
    private static final String VERDICT_FQN = PKG + "::Verdict";
    private static final String THREAD_CHECK_FQN = PKG + "::ThreadCheck";
    private static final String EVENT_CHECK_FQN = PKG + "::EventCheck";

    /**
     * A generic adjudication-verdict metamodel (no private/domain names):
     * <ul>
     *   <li>{@code Verdict}: {@code objective_complete} boolean, {@code objective_status}
     *       string, {@code arc_transition} enum [ready|not_ready] with {@code @default}
     *       "not_ready", {@code tags} enum-array [a|b|c], {@code thread_checks} record-array,
     *       {@code event_checks} record-array;</li>
     *   <li>{@code ThreadCheck}: {@code id} string, {@code resolved} enum [yes|no],
     *       {@code reason} string;</li>
     *   <li>{@code EventCheck}: {@code id} string, {@code fires} enum [yes|no],
     *       {@code reason} string.</li>
     * </ul>
     */
    private static final String VERDICT_META = "{ \"metadata.root\": {"
        + "  \"package\": \"" + PKG + "\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"ThreadCheck\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"id\" } },"
        + "      { \"field.enum\":   { \"name\": \"resolved\", \"@values\": [\"yes\", \"no\"] } },"
        + "      { \"field.string\": { \"name\": \"reason\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"EventCheck\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"id\" } },"
        + "      { \"field.enum\":   { \"name\": \"fires\", \"@values\": [\"yes\", \"no\"] } },"
        + "      { \"field.string\": { \"name\": \"reason\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"Verdict\", \"children\": ["
        + "      { \"field.boolean\": { \"name\": \"objective_complete\" } },"
        + "      { \"field.string\":  { \"name\": \"objective_status\" } },"
        + "      { \"field.enum\":    { \"name\": \"arc_transition\", \"@values\": [\"ready\", \"not_ready\"], \"@default\": \"not_ready\" } },"
        + "      { \"field.enum\":    { \"name\": \"tags\", \"isArray\": true, \"@values\": [\"a\", \"b\", \"c\"] } },"
        + "      { \"field.object\":  { \"name\": \"thread_checks\", \"isArray\": true, \"@objectRef\": \"" + THREAD_CHECK_FQN + "\" } },"
        + "      { \"field.object\":  { \"name\": \"event_checks\", \"isArray\": true, \"@objectRef\": \"" + EVENT_CHECK_FQN + "\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    private MetaDataLoader loadVerdict(String name) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "verdict-recover-" + name);
        loader.init();
        loader.load(List.of(new InMemoryStringSource(VERDICT_META, "verdict-recover/meta.json")));
        return loader;
    }

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    // -----------------------------------------------------------------------
    // The gold-standard dirty-XML recover.
    // -----------------------------------------------------------------------

    @Test
    public void dirtyXmlRecoversIntoTypedObjectGraph() {
        MetaDataLoader loader = loadVerdict("dirty");
        MetaObject verdictMo = loader.getMetaObjectByName(VERDICT_FQN);
        assertNotNull("Verdict MetaObject must load", verdictMo);

        // Dirty XML: a chat preamble + whitespace before the root; arc_transition OMITTED
        // (must fall back to @default "not_ready" → DEFAULTED); tags contains an uncoercible
        // member ("zzz") alongside a valid one; event_checks is an EMPTY element (→ empty
        // list, not null); two well-formed thread_checks records.
        String dirtyXml =
            "Sure — here is the verdict you asked for:\n\n" +
            "<Verdict>\n" +
            "  <objective_complete>true</objective_complete>\n" +
            "  <objective_status>partially met</objective_status>\n" +
            "  <tags>a</tags>\n" +
            "  <tags>zzz</tags>\n" +
            "  <thread_checks><id>T1</id><resolved>yes</resolved><reason>closed cleanly</reason></thread_checks>\n" +
            "  <thread_checks><id>T2</id><resolved>no</resolved><reason>still open</reason></thread_checks>\n" +
            "  <event_checks></event_checks>\n" +
            "</Verdict>\n" +
            "\nLet me know if you need anything else!";

        RecoveryResult<Object> result =
                MetaObjectRecover.recover(verdictMo, dirtyXml, Format.XML, RecoverOptions.defaults());

        // ---- never throws; produced a typed Verdict object with the right back-ref ----
        Object verdict = result.data();
        assertNotNull("recover must produce an object (never null on a recoverable response)", verdict);
        assertTrue("object.value default instance is a ValueObject, was " + verdict.getClass().getName(),
                verdict instanceof ValueObject);
        assertSame("assembled instance back-reference must be the Verdict MetaObject",
                verdictMo, ((MetaObjectAware) verdict).getMetaData());

        // ---- scalars ----
        assertEquals(Boolean.TRUE, verdictMo.getMetaField("objective_complete").getBoolean(verdict));
        assertEquals("partially met", verdictMo.getMetaField("objective_status").getString(verdict));

        // ---- @default fill: arc_transition was omitted → DEFAULTED to "not_ready" ----
        assertEquals("not_ready", verdictMo.getMetaField("arc_transition").getString(verdict));
        assertEquals("omitted defaulted enum must be classified DEFAULTED",
                FieldRecovery.DEFAULTED, result.report().states().get("arc_transition"));

        // ---- enum-array: valid element kept, uncoercible "zzz" dropped (partial recovery) ----
        List<Object> tags = verdictMo.getMetaField("tags").getObjectArray(verdict);
        assertNotNull("tags array must be populated", tags);
        assertEquals("only the coercible enum member survives", List.of("a"), tags);

        // ---- array-of-records: thread_checks fully populated as typed ValueObject children ----
        List<Object> threads = verdictMo.getMetaField("thread_checks").getObjectArray(verdict);
        assertNotNull("thread_checks must be populated", threads);
        assertEquals("two thread-check records", 2, threads.size());

        MetaObject threadMo = loader.getMetaObjectByName(THREAD_CHECK_FQN);
        Object t0 = threads.get(0);
        assertTrue("thread-check element is a ValueObject", t0 instanceof ValueObject);
        assertSame("nested record back-reference must be the ThreadCheck MetaObject",
                threadMo, ((MetaObjectAware) t0).getMetaData());
        assertEquals("T1", threadMo.getMetaField("id").getString(t0));
        assertEquals("yes", threadMo.getMetaField("resolved").getString(t0));
        assertEquals("closed cleanly", threadMo.getMetaField("reason").getString(t0));

        Object t1 = threads.get(1);
        assertEquals("T2", threadMo.getMetaField("id").getString(t1));
        assertEquals("no", threadMo.getMetaField("resolved").getString(t1));

        // ---- empty/self-closing array → empty list (NOT null) ----
        List<Object> events = verdictMo.getMetaField("event_checks").getObjectArray(verdict);
        assertNotNull("an empty event_checks element must yield an empty list, not null", events);
        assertTrue("event_checks must be empty (no records inside the empty element)", events.isEmpty());

        // ---- orThrow(): no required field was lost, so it returns the data unharmed ----
        Object same = result.orThrow();
        assertSame("orThrow must return the same assembled object when nothing required was lost",
                verdict, same);
    }

    // -----------------------------------------------------------------------
    // orThrow() — the strict opt-in gate throws iff a required field was lost.
    // -----------------------------------------------------------------------

    @Test
    public void orThrowThrowsWhenRequiredFieldLost() {
        // A schema with a REQUIRED field absent from the response → LOST_REQUIRED.
        String requiredMeta = "{ \"metadata.root\": {"
            + "  \"package\": \"" + PKG + "\","
            + "  \"children\": ["
            + "    { \"object.value\": { \"name\": \"Strict\", \"children\": ["
            + "      { \"field.string\": { \"name\": \"needed\", \"@required\": true } }"
            + "    ]}}"
            + "  ]"
            + "}}";
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "verdict-recover-strict");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(requiredMeta, "verdict-recover/strict.json")));
        MetaObject strictMo = loader.getMetaObjectByName(PKG + "::Strict");

        // Empty JSON object — "needed" is absent → LOST_REQUIRED.
        RecoveryResult<Object> result =
                MetaObjectRecover.recover(strictMo, "{}", Format.JSON, RecoverOptions.defaults());

        assertTrue("a missing required field must be classified LOST_REQUIRED",
                result.report().hasLostRequired());

        try {
            result.orThrow();
            fail("orThrow must throw when a required field was lost");
        } catch (RecoverException expected) {
            assertTrue("the exception names the lost path", expected.lostRequired().contains("needed"));
        }
    }

    // -----------------------------------------------------------------------
    // recover() NEVER throws — even on total garbage input.
    // -----------------------------------------------------------------------

    @Test
    public void recoverNeverThrowsOnGarbage() {
        MetaDataLoader loader = loadVerdict("garbage");
        MetaObject verdictMo = loader.getMetaObjectByName(VERDICT_FQN);

        // Total garbage: no recognizable structure at all.
        RecoveryResult<Object> result = MetaObjectRecover.recover(verdictMo, "%%% not even close %%%");

        assertNotNull("recover must always return a result", result);
        assertNotNull("recover must always return an (assembled) object", result.data());
        // arc_transition still defaults even on a degenerate response.
        assertEquals("not_ready",
                verdictMo.getMetaField("arc_transition").getString(result.data()));
    }

    // -----------------------------------------------------------------------
    // recoverSchemaFor — the schema mirrors the metadata shape (sanity).
    // -----------------------------------------------------------------------

    @Test
    public void recoverSchemaForMirrorsMetadata() {
        MetaDataLoader loader = loadVerdict("schema");
        MetaObject verdictMo = loader.getMetaObjectByName(VERDICT_FQN);

        var schema = MetaObjectRecover.recoverSchemaFor(verdictMo, Format.XML);
        assertEquals(Format.XML, schema.format());
        assertEquals("Verdict", schema.rootName());

        Map<String, com.metaobjects.render.recover.FieldSpec> byName =
                new java.util.LinkedHashMap<>();
        schema.fields().forEach(f -> byName.put(f.name(), f));

        // arc_transition: enum, non-array, carries the @default.
        var arc = byName.get("arc_transition");
        assertEquals(com.metaobjects.render.recover.FieldKind.ENUM, arc.kind());
        assertFalse(arc.array());
        assertEquals("not_ready", arc.defaultValue());
        assertEquals(List.of("ready", "not_ready"), arc.enumValues());

        // tags: enum, array.
        var tags = byName.get("tags");
        assertEquals(com.metaobjects.render.recover.FieldKind.ENUM, tags.kind());
        assertTrue("tags must be an array spec", tags.array());

        // thread_checks: object, array, with a nested schema.
        var threads = byName.get("thread_checks");
        assertEquals(com.metaobjects.render.recover.FieldKind.OBJECT, threads.kind());
        assertTrue(threads.array());
        assertNotNull("nested schema must be built for the record array", threads.nested());
        assertEquals("ThreadCheck", threads.nested().rootName());
    }
}

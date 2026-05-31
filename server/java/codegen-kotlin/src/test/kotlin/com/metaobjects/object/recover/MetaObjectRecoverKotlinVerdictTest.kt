/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.`object`.recover

import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.`object`.MetaObjectAware
import com.metaobjects.`object`.value.ValueObject
import com.metaobjects.registry.ObjectClassRegistry
import com.metaobjects.render.recover.FieldKind
import com.metaobjects.render.recover.FieldRecovery
import com.metaobjects.render.recover.FieldSpec
import com.metaobjects.render.recover.Format
import com.metaobjects.render.recover.RecoverException
import com.metaobjects.render.recover.RecoverOptions
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Kotlin verdict proof for the Phase B runtime recover ([MetaObjectRecover], in the
 * `om` module). Kotlin ships NO new recover code — it reuses the shared JVM engine —
 * so this test is a faithful transliteration of the Java reference
 * `MetaObjectRecoverVerdictTest`, proving the same outcomes hold when the engine is
 * driven from Kotlin: a typed [ValueObject] graph with correct back-references,
 * nested record arrays, generalized `@default` -> DEFAULTED fill, enum-array
 * uncoercible-dropped (partial recovery), empty-array -> empty list, never-throws,
 * and the `orThrow()` opt-in gate.
 */
class MetaObjectRecoverKotlinVerdictTest {

    private val pkg = "com::example::verdict"
    private val verdictFqn = "$pkg::Verdict"
    private val threadCheckFqn = "$pkg::ThreadCheck"
    private val eventCheckFqn = "$pkg::EventCheck"

    /**
     * A generic adjudication-verdict metamodel (no private/domain names): mirrors the
     * Java reference fixture exactly — Verdict (boolean, string, enum-with-@default,
     * enum-array, two record-arrays) over ThreadCheck and EventCheck records.
     */
    private val verdictMeta = """
        { "metadata.root": {
          "package": "$pkg",
          "children": [
            { "object.value": { "name": "ThreadCheck", "children": [
              { "field.string": { "name": "id" } },
              { "field.enum":   { "name": "resolved", "@values": ["yes", "no"] } },
              { "field.string": { "name": "reason" } }
            ]}},
            { "object.value": { "name": "EventCheck", "children": [
              { "field.string": { "name": "id" } },
              { "field.enum":   { "name": "fires", "@values": ["yes", "no"] } },
              { "field.string": { "name": "reason" } }
            ]}},
            { "object.value": { "name": "Verdict", "children": [
              { "field.boolean": { "name": "objective_complete" } },
              { "field.string":  { "name": "objective_status" } },
              { "field.enum":    { "name": "arc_transition", "@values": ["ready", "not_ready"], "@default": "not_ready" } },
              { "field.enum":    { "name": "tags", "isArray": true, "@values": ["a", "b", "c"] } },
              { "field.object":  { "name": "thread_checks", "isArray": true, "@objectRef": "$threadCheckFqn" } },
              { "field.object":  { "name": "event_checks", "isArray": true, "@objectRef": "$eventCheckFqn" } }
            ]}}
          ]
        }}
    """.trimIndent()

    private fun loadVerdict(name: String): MetaDataLoader {
        val loader = MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "verdict-recover-kt-$name"
        )
        loader.init()
        loader.load(listOf(InMemoryStringSource(verdictMeta, "verdict-recover/meta.json")))
        return loader
    }

    @AfterTest
    fun resetRegistry() {
        ObjectClassRegistry.resetGlobal()
    }

    // -----------------------------------------------------------------------
    // The gold-standard dirty-XML recover.
    // -----------------------------------------------------------------------

    @Test
    fun dirtyXmlRecoversIntoTypedObjectGraph() {
        val loader = loadVerdict("dirty")
        val verdictMo: MetaObject = loader.getMetaObjectByName(verdictFqn)
        assertNotNull(verdictMo, "Verdict MetaObject must load")

        // Dirty XML: chat preamble + whitespace before the root; arc_transition OMITTED
        // (-> @default "not_ready" -> DEFAULTED); tags has an uncoercible member ("zzz")
        // alongside a valid one; event_checks is an EMPTY element (-> empty list, not null);
        // two well-formed thread_checks records.
        val dirtyXml =
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
            "\nLet me know if you need anything else!"

        val result = MetaObjectRecover.recover(verdictMo, dirtyXml, Format.XML, RecoverOptions.defaults())

        // ---- never throws; produced a typed Verdict object with the right back-ref ----
        val verdict: Any = result.data()
        assertNotNull(verdict, "recover must produce an object (never null on a recoverable response)")
        assertTrue(verdict is ValueObject,
            "object.value default instance is a ValueObject, was ${verdict.javaClass.name}")
        assertSame(verdictMo, (verdict as MetaObjectAware).metaData,
            "assembled instance back-reference must be the Verdict MetaObject")

        // ---- scalars ----
        assertEquals(java.lang.Boolean.TRUE, verdictMo.getMetaField("objective_complete").getBoolean(verdict))
        assertEquals("partially met", verdictMo.getMetaField("objective_status").getString(verdict))

        // ---- @default fill: arc_transition was omitted -> DEFAULTED to "not_ready" ----
        assertEquals("not_ready", verdictMo.getMetaField("arc_transition").getString(verdict))
        assertEquals(FieldRecovery.DEFAULTED, result.report().states()["arc_transition"],
            "omitted defaulted enum must be classified DEFAULTED")

        // ---- enum-array: valid element kept, uncoercible "zzz" dropped (partial recovery) ----
        val tags = verdictMo.getMetaField("tags").getObjectArray(verdict)
        assertNotNull(tags, "tags array must be populated")
        assertEquals(listOf<Any>("a"), tags, "only the coercible enum member survives")

        // ---- array-of-records: thread_checks fully populated as typed ValueObject children ----
        val threads = verdictMo.getMetaField("thread_checks").getObjectArray(verdict)
        assertNotNull(threads, "thread_checks must be populated")
        assertEquals(2, threads!!.size, "two thread-check records")

        val threadMo: MetaObject = loader.getMetaObjectByName(threadCheckFqn)
        val t0 = threads!![0]
        assertTrue(t0 is ValueObject, "thread-check element is a ValueObject")
        assertSame(threadMo, (t0 as MetaObjectAware).metaData,
            "nested record back-reference must be the ThreadCheck MetaObject")
        assertEquals("T1", threadMo.getMetaField("id").getString(t0))
        assertEquals("yes", threadMo.getMetaField("resolved").getString(t0))
        assertEquals("closed cleanly", threadMo.getMetaField("reason").getString(t0))

        val t1 = threads[1]
        assertEquals("T2", threadMo.getMetaField("id").getString(t1))
        assertEquals("no", threadMo.getMetaField("resolved").getString(t1))

        // ---- empty/self-closing array -> empty list (NOT null) ----
        val events = verdictMo.getMetaField("event_checks").getObjectArray(verdict)
        assertNotNull(events, "an empty event_checks element must yield an empty list, not null")
        assertTrue(events!!.isEmpty(), "event_checks must be empty (no records inside the empty element)")

        // ---- orThrow(): no required field was lost, so it returns the data unharmed ----
        val same = result.orThrow()
        assertSame(verdict, same,
            "orThrow must return the same assembled object when nothing required was lost")
    }

    // -----------------------------------------------------------------------
    // orThrow() — the strict opt-in gate throws iff a required field was lost.
    // -----------------------------------------------------------------------

    @Test
    fun orThrowThrowsWhenRequiredFieldLost() {
        val requiredMeta = """
            { "metadata.root": {
              "package": "$pkg",
              "children": [
                { "object.value": { "name": "Strict", "children": [
                  { "field.string": { "name": "needed", "@required": true } }
                ]}}
              ]
            }}
        """.trimIndent()
        val loader = MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "verdict-recover-kt-strict"
        )
        loader.init()
        loader.load(listOf(InMemoryStringSource(requiredMeta, "verdict-recover/strict.json")))
        val strictMo: MetaObject = loader.getMetaObjectByName("$pkg::Strict")

        // Empty JSON object — "needed" is absent -> LOST_REQUIRED.
        val result = MetaObjectRecover.recover(strictMo, "{}", Format.JSON, RecoverOptions.defaults())

        assertTrue(result.report().hasLostRequired(),
            "a missing required field must be classified LOST_REQUIRED")

        try {
            result.orThrow()
            fail("orThrow must throw when a required field was lost")
        } catch (expected: RecoverException) {
            assertTrue(expected.lostRequired().contains("needed"),
                "the exception names the lost path")
        }
    }

    // -----------------------------------------------------------------------
    // recover() NEVER throws — even on total garbage input.
    // -----------------------------------------------------------------------

    @Test
    fun recoverNeverThrowsOnGarbage() {
        val loader = loadVerdict("garbage")
        val verdictMo: MetaObject = loader.getMetaObjectByName(verdictFqn)

        // Total garbage: no recognizable structure at all.
        val result = MetaObjectRecover.recover(verdictMo, "%%% not even close %%%")

        assertNotNull(result, "recover must always return a result")
        assertNotNull(result.data(), "recover must always return an (assembled) object")
        // arc_transition still defaults even on a degenerate response.
        assertEquals("not_ready",
            verdictMo.getMetaField("arc_transition").getString(result.data()))
    }

    // -----------------------------------------------------------------------
    // recoverSchemaFor — the schema mirrors the metadata shape (sanity).
    // -----------------------------------------------------------------------

    @Test
    fun recoverSchemaForMirrorsMetadata() {
        val loader = loadVerdict("schema")
        val verdictMo: MetaObject = loader.getMetaObjectByName(verdictFqn)

        val schema = MetaObjectRecover.recoverSchemaFor(verdictMo, Format.XML)
        assertEquals(Format.XML, schema.format())
        assertEquals("Verdict", schema.rootName())

        val byName = LinkedHashMap<String, FieldSpec>()
        schema.fields().forEach { byName[it.name()] = it }

        // arc_transition: enum, non-array, carries the @default.
        val arc = byName["arc_transition"]!!
        assertEquals(FieldKind.ENUM, arc.kind())
        assertFalse(arc.array())
        assertEquals("not_ready", arc.defaultValue())
        assertEquals(listOf("ready", "not_ready"), arc.enumValues())

        // tags: enum, array.
        val tags = byName["tags"]!!
        assertEquals(FieldKind.ENUM, tags.kind())
        assertTrue(tags.array(), "tags must be an array spec")

        // thread_checks: object, array, with a nested schema.
        val threads = byName["thread_checks"]!!
        assertEquals(FieldKind.OBJECT, threads.kind())
        assertTrue(threads.array())
        assertNotNull(threads.nested(), "nested schema must be built for the record array")
        assertEquals("ThreadCheck", threads.nested().rootName())
    }
}

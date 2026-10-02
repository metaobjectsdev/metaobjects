/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.render.extract

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull

/**
 * #364 Kotlin interop proof for the document-level [ExtractOptions.OnLocate] hook. Kotlin ships
 * NO new extract code — it drives the shared Java engine (`com.metaobjects.render.extract`,
 * `codegen-kotlin`'s generated parsers call straight into it) — so this is a faithful
 * transliteration of the Java reference `ExtractTest`'s onLocate cases, proving a Kotlin lambda
 * satisfies the Java `OnLocate` functional interface and that the engine's behavior (override,
 * audit, fallthrough, propagation) holds unchanged when driven from Kotlin.
 */
class OnLocateKotlinInteropTest {

    private fun jsonAnswer(): ExtractSchema = ExtractSchema(
        Format.JSON,
        "answer",
        listOf(
            FieldSpec.scalar("text", FieldKind.STRING, true),
            FieldSpec.enumField("confidence", true, listOf("HIGH", "OK", "LOW"), mapOf("medium" to "OK")),
        ),
    )

    @Test
    fun onLocateOverridesDefaultLocatorChoice() {
        // The default locator would pick the FIRST fenced block (it already carries a declared
        // field, #363). This hook picks the LAST fenced block instead.
        val dirty = "```json\n{\"text\":\"draft\",\"confidence\":\"HIGH\"}\n```\n" +
            "Actually, here is the real answer:\n" +
            "```json\n{\"text\":\"final\",\"confidence\":\"HIGH\"}\n```"
        val onLocate = ExtractOptions.OnLocate { text, format ->
            assertEquals(Format.JSON, format)
            Regex("```json\\s*\\n([\\s\\S]*?)\\n```").findAll(text).lastOrNull()?.groupValues?.get(1)
        }
        val opts = ExtractOptions.defaults().withOnLocate(onLocate)
        val outcome = Extract.extract(dirty, jsonAnswer(), opts)
        assertEquals("final", outcome.data()["text"])
    }

    @Test
    fun onLocateNullFallsBackToDefaultLocator() {
        val dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"HIGH\"}\n```\nDone."
        val opts = ExtractOptions.defaults().withOnLocate(ExtractOptions.OnLocate { _, _ -> null })
        val outcome = Extract.extract(dirty, jsonAnswer(), opts)
        assertEquals("hi", outcome.data()["text"])
    }

    @Test
    fun onLocateIsAuditedAsOnLocateCoercionOnDocumentPath() {
        val located = "{\"text\":\"hi\",\"confidence\":\"HIGH\"}"
        val opts = ExtractOptions.defaults().withOnLocate(ExtractOptions.OnLocate { _, _ -> located })
        val outcome = Extract.extract("noise before $located noise after", jsonAnswer(), opts)
        val entry = outcome.report().coercions().firstOrNull { it.kind() == "onLocate" }
        assertNotNull(entry)
        assertEquals("", entry.fieldPath())
        assertEquals(located.length.toString(), entry.to())
    }

    @Test
    fun onLocatedTextStillRunsThroughNormalPipeline() {
        val opts = ExtractOptions.defaults().withOnLocate(
            ExtractOptions.OnLocate { _, _ -> "{\"text\":\"hi\",\"confidence\":\"medium\"}" },
        )
        val outcome = Extract.extract("ignored prose", jsonAnswer(), opts)
        // jsonAnswer()'s confidence field declares @enumAlias medium -> OK.
        assertEquals("OK", outcome.data()["confidence"])
        assertEquals(FieldExtraction.EXTRACTED, outcome.report().states()["confidence"])
    }

    @Test
    fun onLocateThrowingPropagates() {
        val opts = ExtractOptions.defaults().withOnLocate(
            ExtractOptions.OnLocate { _, _ -> throw RuntimeException("boom") },
        )
        val ex = assertFailsWith<RuntimeException> { Extract.extract("anything", jsonAnswer(), opts) }
        assertEquals("boom", ex.message)
    }
}

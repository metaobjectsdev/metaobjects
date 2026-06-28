package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests for [KotlinFilterAllowlistGenerator]. Covers the FR-009 authoring contract
 * mirrored from the sibling Java `SpringFilterAllowlistGeneratorTest`:
 * <ul>
 *   <li>only `@filterable: true` fields appear in the allowlist;</li>
 *   <li>operator gating per field subtype matches the cross-port matrix
 *       (string vs numeric/date/currency vs boolean);</li>
 *   <li>entities with zero filterable fields still emit a (empty) allowlist
 *       so the generated controller can unconditionally delegate to it.</li>
 * </ul>
 */
class KotlinFilterAllowlistGeneratorTest {

    /** All fields present, NONE marked filterable → empty allowlist. */
    private val noFilterableFixture = """{
      "metadata.root": { "package": "acme::blog", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "name", "@maxLength": 100, "@required": true } },
            { "field.string":    { "name": "bio" } },
            { "field.timestamp": { "name": "createdAt" } },
            { "source.rdb":      { "@table": "authors" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    /** Mixed: one numeric + one string + one timestamp + one boolean filterable; bio stays off. */
    private val mixedFilterableFixture = """{
      "metadata.root": { "package": "acme::blog", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":      { "name": "id", "@filterable": true } },
            { "field.string":    { "name": "name", "@maxLength": 100, "@required": true, "@filterable": true } },
            { "field.string":    { "name": "bio" } },
            { "field.timestamp": { "name": "createdAt", "@filterable": true } },
            { "field.boolean":   { "name": "published", "@filterable": true } },
            { "field.uuid":      { "name": "ref", "@filterable": true } },
            { "field.currency":  { "name": "price", "@currency": "USD", "@filterable": true } },
            { "source.rdb":      { "@table": "authors" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun emptyAllowlistWhenNoFieldFilterable() {
        val outDir = Files.createTempDirectory("fa-empty-")
        try {
            val gen = KotlinFilterAllowlistGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("fa-empty", noFilterableFixture))

            val allowlist = outDir.resolve("acme/blog/AuthorFilterAllowlist.kt")
            assertTrue(Files.exists(allowlist),
                "expected $allowlist to exist (empty allowlist still emitted)")
            val src = Files.readString(allowlist)

            // Empty FIELDS set + empty OPS_BY_FIELD map — generator-stable shape so
            // the controller can always call into them without conditional branching.
            assertTrue("val FIELDS: Set<String> = emptySet()" in src,
                "expected empty emptySet() for FIELDS; saw:\n$src")
            assertTrue("val OPS_BY_FIELD: Map<String, Set<String>> = emptyMap()" in src,
                "expected empty emptyMap() for OPS_BY_FIELD; saw:\n$src")
            // No bio / id / createdAt should appear as map keys (no field is filterable).
            assertFalse("\"bio\"" in src,
                "'bio' must not be in the allowlist; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun filterableFieldAppearsInAllowlist() {
        val outDir = Files.createTempDirectory("fa-mixed-")
        try {
            val gen = KotlinFilterAllowlistGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("fa-mixed", mixedFilterableFixture))

            val src = Files.readString(outDir.resolve("acme/blog/AuthorFilterAllowlist.kt"))

            // The four @filterable fields must appear in FIELDS (bio is NOT filterable).
            assertTrue("\"id\"" in src, "expected 'id' in FIELDS; saw:\n$src")
            assertTrue("\"name\"" in src, "expected 'name' in FIELDS; saw:\n$src")
            assertTrue("\"createdAt\"" in src, "expected 'createdAt' in FIELDS; saw:\n$src")
            assertTrue("\"published\"" in src, "expected 'published' in FIELDS; saw:\n$src")
            // bio is NOT marked @filterable — must NOT appear anywhere in this file.
            assertFalse("\"bio\"" in src, "'bio' must not be in the allowlist; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun operatorGatingPerSubtype() {
        val outDir = Files.createTempDirectory("fa-ops-")
        try {
            val gen = KotlinFilterAllowlistGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("fa-ops", mixedFilterableFixture))

            val src = Files.readString(outDir.resolve("acme/blog/AuthorFilterAllowlist.kt"))

            // String → eq, ne, in, like, isNull. Match the full line for 'name' so we
            // assert the exact operator set rather than just "any of these appears".
            assertTrue("\"name\" to setOf(\"eq\", \"ne\", \"in\", \"like\", \"isNull\")" in src,
                "expected name → string ops; saw:\n$src")
            // Long (numeric) → eq, ne, gt, gte, lt, lte, in, isNull.
            assertTrue("\"id\" to setOf(\"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\")" in src,
                "expected id → numeric ops; saw:\n$src")
            // Timestamp shares the numeric op set (gt/lte/etc are valid on timestamps).
            assertTrue("\"createdAt\" to setOf(\"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\")" in src,
                "expected createdAt → numeric ops; saw:\n$src")
            // SP-H Unit9 — uuid → eq, ne, in, isNull (no like, no ordering).
            assertTrue("\"ref\" to setOf(\"eq\", \"ne\", \"in\", \"isNull\")" in src,
                "expected ref → uuid ops; saw:\n$src")
            // SP-H Unit9 — currency → numeric ops (integer minor units, orderable).
            assertTrue("\"price\" to setOf(\"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\")" in src,
                "expected price → numeric ops; saw:\n$src")
            // Boolean → eq, isNull only (no gt/lt/etc allowed on booleans).
            assertTrue("\"published\" to setOf(\"eq\", \"isNull\")" in src,
                "expected published → boolean ops; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun viewKindSkipped() {
        // source.rdb @kind="view" → read-only, must NOT produce a filter allowlist
        // (controller is also skipped — keeping the two generators aligned).
        val viewFixture = """{
          "metadata.root": { "package": "acme::report", "children": [
            { "object.projection": { "name": "SalesReport", "children": [
                { "field.long":   { "name": "id", "@filterable": true } },
                { "field.string": { "name": "regionName", "@maxLength": 100, "@filterable": true } },
                { "source.rdb":   { "@table": "v_sales_report", "@kind": "view" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("fa-view-")
        try {
            val gen = KotlinFilterAllowlistGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("fa-view", viewFixture))

            val allowlist = outDir.resolve("acme/report/SalesReportFilterAllowlist.kt")
            assertTrue(!Files.exists(allowlist),
                "view-kind entities must NOT produce a filter allowlist; saw $allowlist present")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Tests for [KotlinSpringControllerGenerator]. Covers the cross-port API contract
 * (URL grammar + verbs + withCount envelope + sort allowlist + view-kind skip).
 * Hand-rolled string-search assertions match the style of
 * [KotlinExposedTableGeneratorTest] — snapshot stability is gated separately by
 * [KotlinCodegenSnapshotTest] over the {@code entity-with-controller} fixture.
 */
class KotlinSpringControllerGeneratorTest {

    private val authorFixture = """{
      "metadata.root": { "package": "acme::blog", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 100, "@required": true } },
            { "field.string": { "name": "bio" } },
            { "field.timestamp": { "name": "createdAt" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun emitsRestControllerWithFiveEndpoints() {
        val outDir = Files.createTempDirectory("kctrl-five-")
        try {
            val gen = KotlinSpringControllerGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("ctrl-five", authorFixture))

            val controller = outDir.resolve("acme/blog/AuthorController.kt")
            assertTrue(Files.exists(controller),
                "expected $controller; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(controller)

            // @GetMapping (list) — the bare-annotation form without a path.
            assertTrue(Regex("""@GetMapping\s*\n\s*fun list""").containsMatchIn(src),
                "expected bare @GetMapping list handler; saw:\n$src")
            // @GetMapping("/{id}") — get by id.
            assertTrue("@GetMapping(\"/{id}\")" in src,
                "expected @GetMapping(\"/{id}\"); saw:\n$src")
            // @PostMapping — create.
            assertTrue(Regex("""@PostMapping\s*\n\s*fun create""").containsMatchIn(src),
                "expected @PostMapping create handler; saw:\n$src")
            // @PatchMapping AND @PutMapping share the update handler (per API contract).
            assertTrue("@PatchMapping(\"/{id}\")" in src,
                "expected @PatchMapping(\"/{id}\"); saw:\n$src")
            assertTrue("@PutMapping(\"/{id}\")" in src,
                "expected @PutMapping(\"/{id}\") on the same update handler; saw:\n$src")
            // @DeleteMapping("/{id}") — delete.
            assertTrue("@DeleteMapping(\"/{id}\")" in src,
                "expected @DeleteMapping(\"/{id}\"); saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun pathHonorsApiPrefixAndEntityPlural() {
        val outDir = Files.createTempDirectory("kctrl-path-")
        try {
            val gen = KotlinSpringControllerGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("ctrl-path", authorFixture))

            val src = Files.readString(outDir.resolve("acme/blog/AuthorController.kt"))
            // /api/<entity-plural-lowercase> per the cross-port contract; Author → authors.
            assertTrue("@RequestMapping(\"/api/authors\")" in src,
                "expected @RequestMapping(\"/api/authors\"); saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun withCountReturnsEnvelope() {
        val outDir = Files.createTempDirectory("kctrl-wc-")
        try {
            val gen = KotlinSpringControllerGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("ctrl-wc", authorFixture))

            val src = Files.readString(outDir.resolve("acme/blog/AuthorController.kt"))
            // Both the envelope path AND the bare-rows path must be emitted.
            assertTrue("mapOf(\"rows\" to rows, \"total\" to total)" in src,
                "expected {rows,total} envelope on withCount=1; saw:\n$src")
            // Bare rows path: `ResponseEntity.ok(rows as Any)` (no envelope).
            assertTrue("ResponseEntity.ok(rows as Any)" in src,
                "expected bare-rows OK response on default list; saw:\n$src")
            // The withCount parameter itself is declared on the list handler.
            assertTrue("name = \"withCount\"" in src,
                "expected withCount @RequestParam; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun sortAllowlistEmittedPerEntity() {
        val outDir = Files.createTempDirectory("kctrl-sort-")
        try {
            val gen = KotlinSpringControllerGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("ctrl-sort", authorFixture))

            val src = Files.readString(outDir.resolve("acme/blog/AuthorController.kt"))
            // Per-entity prefix on the allowlist name keeps it from colliding with other
            // generated controllers in the same package.
            assertTrue("private val AuthorSortAllowlist = setOf(" in src,
                "expected per-entity AuthorSortAllowlist; saw:\n$src")
            // Every scalar field in Author appears in the allowlist.
            assertTrue("\"id\"," in src && "\"name\"," in src && "\"bio\"," in src && "\"createdAt\"," in src,
                "expected all four scalar fields in the sort allowlist; saw:\n$src")
            // The 400 envelope for invalid sort is `{ "error": "invalid_sort" }`.
            assertTrue("\"invalid_sort\"" in src,
                "expected invalid_sort 400 envelope; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun viewKindSkipped() {
        // SalesReport has @kind="view" — must NOT produce a controller (read-only).
        val viewFixture = """{
          "metadata.root": { "package": "acme::report", "children": [
            { "object.entity": { "name": "SalesReport", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "regionName", "@maxLength": 100 } },
                { "field.long":   { "name": "totalCents" } },
                { "source.rdb":   { "@table": "v_sales_report", "@kind": "view" } },
                { "identity.primary": { "@fields": "id" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("kctrl-view-")
        try {
            val gen = KotlinSpringControllerGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("ctrl-view", viewFixture))

            val controller = outDir.resolve("acme/report/SalesReportController.kt")
            assertTrue(!Files.exists(controller),
                "view-kind entities must NOT produce a controller; saw $controller present")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

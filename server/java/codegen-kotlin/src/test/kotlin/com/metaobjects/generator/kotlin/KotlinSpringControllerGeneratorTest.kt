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
            // PATCH + PUT share one update handler via a single composed @RequestMapping
            // (per API contract). Stacking @PatchMapping + @PutMapping would only register
            // one verb in Spring MVC — the other 405s (SP-F generated-controller lane).
            assertTrue(
                "@RequestMapping(value = [\"/{id}\"], method = [RequestMethod.PATCH, RequestMethod.PUT])" in src,
                "expected a single @RequestMapping(method = [PATCH, PUT]) update handler; saw:\n$src")
            assertTrue("@PatchMapping" !in src && "@PutMapping" !in src,
                "must NOT stack @PatchMapping/@PutMapping (only one composed mapping is honored); saw:\n$src")
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

    @Test fun filterAllowlistEmittedAlongsideController() {
        // Running the controller AND the filter-allowlist generator over the same
        // entity must produce both files in the same package. The pair is the
        // FR-009 contract: the controller's parseAuthorFilter is a closed-over
        // reference to the allowlist's FIELDS + OPS_BY_FIELD.
        val outDir = Files.createTempDirectory("kctrl-pair-")
        try {
            val ctrl = KotlinSpringControllerGenerator()
            ctrl.setArgs(mapOf("outputDir" to outDir.toString()))
            val allow = KotlinFilterAllowlistGenerator()
            allow.setArgs(mapOf("outputDir" to outDir.toString()))
            val filterableFixture = """{
              "metadata.root": { "package": "acme::blog", "children": [
                { "object.entity": { "name": "Author", "children": [
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "name", "@maxLength": 100, "@required": true, "@filterable": true } },
                    { "source.rdb":   { "@table": "authors" } },
                    { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
                ] } }
              ] }
            }""".trimIndent()
            val loader = loadString("ctrl-pair", filterableFixture)
            ctrl.execute(loader)
            allow.execute(loader)

            val controller = outDir.resolve("acme/blog/AuthorController.kt")
            val allowlist = outDir.resolve("acme/blog/AuthorFilterAllowlist.kt")
            assertTrue(Files.exists(controller), "expected $controller")
            assertTrue(Files.exists(allowlist), "expected $allowlist")
            val allowSrc = Files.readString(allowlist)
            // FIELDS contains the @filterable field 'name'.
            assertTrue("\"name\"" in allowSrc,
                "expected name in allowlist FIELDS; saw:\n$allowSrc")
            // OPS_BY_FIELD has the string-shape ops for name.
            assertTrue("\"name\" to setOf(\"eq\", \"ne\", \"in\", \"like\", \"isNull\")" in allowSrc,
                "expected string ops for name; saw:\n$allowSrc")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun controllerListHandlerCallsFilterParser() {
        // FR-009 — the generated list handler must call into parseAuthorFilter
        // + AuthorWhereOp and short-circuit on the cross-port error envelope.
        // Don't try to reproduce exact line shapes; assert the call site +
        // envelope + import surface that a real consumer needs.
        val outDir = Files.createTempDirectory("kctrl-filter-")
        try {
            val gen = KotlinSpringControllerGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("ctrl-filter", authorFixture))

            val src = Files.readString(outDir.resolve("acme/blog/AuthorController.kt"))
            // List handler now accepts a `Map<String,String>` of all params so the
            // bracketed filter keys reach the parser intact.
            assertTrue("@RequestParam allParams: Map<String, String>" in src,
                "expected the list handler to accept allParams; saw:\n$src")
            // Filter parse call (generated function name is parse<Entity>Filter).
            assertTrue("parseAuthorFilter(allParams)" in src,
                "expected list handler to call parseAuthorFilter(allParams); saw:\n$src")
            // 400 envelope path on any of invalid_filter_field / invalid_filter_op /
            // invalid_filter_value — the parser puts the envelope KEY in `filterResult.error`
            // and the controller threads it into the response body verbatim.
            assertTrue("mapOf(\"error\" to filterResult.error)" in src,
                "expected the controller to thread filterResult.error into a 400 envelope; saw:\n$src")
            // AND the WHERE clause wires through AuthorWhereOp(predicates).
            assertTrue("AuthorWhereOp(filterResult.predicates)" in src,
                "expected controller to feed predicates into AuthorWhereOp; saw:\n$src")
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

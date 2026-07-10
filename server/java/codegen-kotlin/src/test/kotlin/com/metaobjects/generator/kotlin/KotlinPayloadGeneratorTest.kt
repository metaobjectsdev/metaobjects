package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadDirectory
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

class KotlinPayloadGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.value": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } }
        ] } },
        { "template.prompt": { "name": "WelcomePrompt",
            "@payloadRef": "Author", "@textRef": "demo/welcome" } }
      ] }
    }""".trimIndent()

    @Test fun `emits payload class with Serializable annotation`() {
        val outDir = Files.createTempDirectory("kpay-")
        try {
            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val emitted = outDir.resolve("acme/demo/prompts/WelcomePromptPayload.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")

            val src = Files.readString(emitted)
            assertTrue("@Serializable" in src, src)
            assertTrue("data class WelcomePromptPayload" in src, src)
            assertTrue("val id: Long" in src, src)
            assertTrue("val name: String" in src, src)
            assertTrue("package acme.demo.prompts" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `jsonb open-bag field is a parsed JSON value in the payload, plain string stays String`() {
        // Issue #98: a `field.string @dbColumnType=jsonb` payload property is exposed as a parsed
        // JSON value (kotlinx `JsonElement`), NOT a (double-encoded) String. A sibling plain
        // `field.string` on the same VO stays `String`, proving the divergence is scoped to the
        // jsonb open-bag. The persistence side (Exposed column / entity data class) is unaffected —
        // KotlinPayloadGenerator emits no table/row code.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Settings", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "config", "@dbColumnType": "jsonb" } },
                { "field.string": { "name": "label" } }
            ] } },
            { "template.prompt": { "name": "SettingsPrompt",
                "@payloadRef": "Settings", "@textRef": "demo/settings" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kpay-jsonb-")
        try {
            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-jsonb", fx))

            val emitted = outDir.resolve("acme/demo/prompts/SettingsPromptPayload.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // The open-bag field → parsed JSON value.
            assertTrue("val config: JsonElement" in src, src)
            assertTrue("import kotlinx.serialization.json.JsonElement" in src, src)
            // The plain string field → String (no double-encoding).
            assertTrue("val label: String" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // -----------------------------------------------------------------------
    // origin.* coverage — FR-004 payload-VO field-value provenance
    // -----------------------------------------------------------------------

    @Test fun originPassthroughResolvesSourceFieldType() {
        // PayloadVo.title carries `origin.passthrough @from "Source.title"`.
        // Expected: emitted property uses Source.title's type (String).
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Source", "children": [
                { "field.string": { "name": "title" } }
            ] } },
            { "object.value": { "name": "ArticleSummary", "children": [
                { "field.string": { "name": "title", "children": [
                    { "origin.passthrough": { "@from": "Source.title" } }
                ] } }
            ] } },
            { "template.prompt": { "name": "Article",
                "@payloadRef": "ArticleSummary", "@textRef": "demo/article" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kpay-pt-")
        try {
            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-pt", fx))

            val emitted = outDir.resolve("acme/demo/prompts/ArticlePayload.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("val title: String" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun originAggregateCountEmitsLong() {
        // PayloadVo.postCount has `origin.aggregate @agg count @of "Post.id" @via "Author.posts"`.
        // Expected: emitted property is Long regardless of the underlying field subtype.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long": { "name": "id" } },
                { "relationship.aggregation": { "name": "posts",
                    "@objectRef": "Post", "@cardinality": "many" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long": { "name": "id" } }
            ] } },
            { "object.value": { "name": "AuthorSummary", "children": [
                { "field.int": { "name": "postCount", "children": [
                    { "origin.aggregate": {
                        "@agg": "count", "@of": "Post.id", "@via": "Author.posts" } }
                ] } }
            ] } },
            { "template.prompt": { "name": "AuthorStats",
                "@payloadRef": "AuthorSummary", "@textRef": "demo/author" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kpay-agg-count-")
        try {
            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-agg-count", fx))

            val emitted = outDir.resolve("acme/demo/prompts/AuthorStatsPayload.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("val postCount: Long" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun originAggregateAvgEmitsDouble() {
        // PayloadVo.avgScore has `origin.aggregate @agg avg @of "Post.score"`.
        // Expected: emitted property is Double regardless of `@of` field's type.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long": { "name": "id" } },
                { "relationship.aggregation": { "name": "posts",
                    "@objectRef": "Post", "@cardinality": "many" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "field.long":   { "name": "score" } }
            ] } },
            { "object.value": { "name": "AuthorSummary", "children": [
                { "field.double": { "name": "avgScore", "children": [
                    { "origin.aggregate": {
                        "@agg": "avg", "@of": "Post.score", "@via": "Author.posts" } }
                ] } }
            ] } },
            { "template.prompt": { "name": "AuthorStats",
                "@payloadRef": "AuthorSummary", "@textRef": "demo/author" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kpay-agg-avg-")
        try {
            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-agg-avg", fx))

            val emitted = outDir.resolve("acme/demo/prompts/AuthorStatsPayload.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("val avgScore: Double" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun originCollectionEmitsListOfNestedPayload() {
        // PayloadVo.posts has `origin.collection @via "Author.posts"`.
        // Expected:
        //   - parent payload emits `val posts: List<PostPayload>`
        //   - a separate file `PostPayload.kt` is also emitted in the same prompts/ package
        //   - PostPayload contains Post's primitive fields
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long": { "name": "id" } },
                { "relationship.aggregation": { "name": "posts",
                    "@objectRef": "Post", "@cardinality": "many" } }
            ] } },
            { "object.value": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "title" } }
            ] } },
            { "object.value": { "name": "AuthorDetail", "children": [
                { "field.string": { "name": "posts", "children": [
                    { "origin.collection": { "@via": "Author.posts" } }
                ] } }
            ] } },
            { "template.prompt": { "name": "AuthorView",
                "@payloadRef": "AuthorDetail", "@textRef": "demo/author" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kpay-coll-")
        try {
            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-coll", fx))

            val parentFile = outDir.resolve("acme/demo/prompts/AuthorViewPayload.kt")
            val nestedFile = outDir.resolve("acme/demo/prompts/PostPayload.kt")
            assertTrue(Files.exists(parentFile),
                "expected $parentFile; files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(nestedFile),
                "expected $nestedFile; files=${Files.walk(outDir).toList()}")

            val parentSrc = Files.readString(parentFile)
            assertTrue("val posts: List<PostPayload>" in parentSrc, parentSrc)

            val nestedSrc = Files.readString(nestedFile)
            assertTrue("data class PostPayload" in nestedSrc, nestedSrc)
            assertTrue("val id: Long" in nestedSrc, nestedSrc)
            assertTrue("val title: String" in nestedSrc, nestedSrc)
            assertTrue("package acme.demo.prompts" in nestedSrc, nestedSrc)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `nested field-object objectRef given as a cross-package FQN emits bare payload names, no package-qualified identifier`() {
        // Regression companion to the TS promptRender FQN-leak fix (0.15.17): a payload VO whose
        // naked `field.object @objectRef` points at ANOTHER object.value declared in a DIFFERENT
        // package. The target's resolved name is a real FQN (`acme::ai::Note`), so
        // PackageMapping.splitFqn must strip the package for BOTH the emitted property type and
        // the nested data-class name — an FQN contains `::`, which is not a valid Kotlin
        // identifier. (The TS port leaked `List<acme::ai::Note>` / `data class acme::ai::Note`;
        // Kotlin's ClassName(pkg, simpleName) construction is FQN-safe — this pins it.)
        //
        // Two packages ⇒ two files (a single loadString supports only one root/package), so the
        // prefix is genuinely non-empty when it reaches splitFqn.
        val noteJson = """{
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "Note", "children": [
                { "field.string": { "name": "text" } }
            ] } }
          ] }
        }""".trimIndent()
        val reportJson = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Report", "children": [
                { "field.string": { "name": "title" } },
                { "field.object": { "name": "notes",
                    "@objectRef": "acme::ai::Note", "isArray": true } }
            ] } },
            { "template.prompt": { "name": "ReportPrompt",
                "@payloadRef": "Report", "@textRef": "demo/report" } }
          ] }
        }""".trimIndent()

        val srcDir = Files.createTempDirectory("kpay-fqn-src-")
        val outDir = Files.createTempDirectory("kpay-fqn-out-")
        try {
            // note.json sorts before report.json — but cross-file @objectRef resolution is
            // load-order-independent (ADR-0041), so ordering is not load-bearing here.
            Files.writeString(srcDir.resolve("note.json"), noteJson)
            Files.writeString(srcDir.resolve("report.json"), reportJson)

            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadDirectory("test-fqn", srcDir))

            // Nested payload for a cross-package target co-locates in the REFERRING template's
            // prompts package (acme.demo.prompts), keyed by the target's bare short name.
            val parentFile = outDir.resolve("acme/demo/prompts/ReportPromptPayload.kt")
            val nestedFile = outDir.resolve("acme/demo/prompts/NotePayload.kt")
            assertTrue(Files.exists(parentFile),
                "expected $parentFile; files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(nestedFile),
                "expected $nestedFile; files=${Files.walk(outDir).toList()}")

            val parentSrc = Files.readString(parentFile)
            // Bare, FQN-stripped array-of-nested-payload type — NOT `List<acme::ai::Note>`.
            assertTrue("val notes: List<NotePayload>" in parentSrc, parentSrc)
            assertTrue("val title: String" in parentSrc, parentSrc)

            val nestedSrc = Files.readString(nestedFile)
            // Bare data-class name — NOT `data class acme::ai::Note`.
            assertTrue("data class NotePayload" in nestedSrc, nestedSrc)
            assertTrue("val text: String" in nestedSrc, nestedSrc)
            assertTrue("package acme.demo.prompts" in nestedSrc, nestedSrc)

            // No emitted IDENTIFIER may contain `::`. The FQN legitimately survives only in KDoc
            // comment lines (which document the source object `acme::ai::Note`); every other line
            // must be `::`-free. Filter comment lines (leading `*` or `/`), then assert clean.
            for ((label, src) in listOf("parent" to parentSrc, "nested" to nestedSrc)) {
                val offenders = src.lines().filter { line ->
                    val t = line.trimStart()
                    "::" in line && !t.startsWith("*") && !t.startsWith("/")
                }
                assertTrue(offenders.isEmpty(),
                    "$label: no emitted identifier may contain '::'; offenders=$offenders\n$src")
            }
        } finally {
            srcDir.toFile().deleteRecursively()
            outDir.toFile().deleteRecursively()
        }
    }
}

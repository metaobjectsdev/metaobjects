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

    @Test fun `issue-195 new origins resolve native payload types (any-all Boolean, collect List, first nullable, computed nullable)`() {
        // The four #195 projection read-model capabilities, hosted on a payload VO. The payload
        // generator's origin dispatch must type each derived field from its origin (NOT the raw
        // declared subType), matching the TS/other-port native-typing contract:
        //   - origin.aggregate @agg:any|all → Boolean (a predicate quantifier over @filter; non-null)
        //   - origin.aggregate @agg:collect → List<T> where T = the @of element type (non-null)
        //   - origin.first                  → the @of source type, NULLABLE (empty set → null)
        //   - origin.computed               → the field's own declared subType, NULLABLE (conservative)
        //
        // Shapes obey the #195 loader validation: any/all carry @filter + @via and FORBID @of;
        // collect is isArray with a subtype-matching @of; first's field is non-@required; computed's
        // @expr references the host VO's own field (`bio`). The Kotlin dispatch keys on @agg / the
        // origin subtype, never on @filter/@orderBy.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "relationship.aggregation": { "name": "posts",
                    "@objectRef": "Post", "@cardinality": "many" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "category" } }
            ] } },
            { "object.value": { "name": "AuthorSummary", "children": [
                { "field.string": { "name": "bio" } },
                { "field.boolean": { "name": "hasAnyPost", "children": [
                    { "origin.aggregate": { "@agg": "any", "@via": "Author.posts",
                        "@filter": { "category": "tech" } } }
                ] } },
                { "field.boolean": { "name": "allPosts", "children": [
                    { "origin.aggregate": { "@agg": "all", "@via": "Author.posts",
                        "@filter": { "category": "tech" } } }
                ] } },
                { "field.string": { "name": "categories", "isArray": true, "children": [
                    { "origin.aggregate": { "@agg": "collect", "@of": "Post.category", "@via": "Author.posts" } }
                ] } },
                { "field.string": { "name": "latestCategory", "children": [
                    { "origin.first": { "@of": "Post.category", "@via": "Author.posts",
                        "@orderBy": ["id:desc"] } }
                ] } },
                { "field.boolean": { "name": "hasBio", "children": [
                    { "origin.computed": { "@expr": { "op": "isNotNull", "arg": { "field": "bio" } } } }
                ] } }
            ] } },
            { "template.prompt": { "name": "AuthorStats",
                "@payloadRef": "AuthorSummary", "@textRef": "demo/author" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kpay-195-")
        try {
            val gen = KotlinPayloadGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-195", fx))

            val emitted = outDir.resolve("acme/demo/prompts/AuthorStatsPayload.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)

            // any / all → Boolean (non-null)
            assertTrue("val hasAnyPost: Boolean" in src && "val hasAnyPost: Boolean?" !in src,
                "origin.aggregate @agg:any must be non-null Boolean; saw:\n$src")
            assertTrue("val allPosts: Boolean" in src && "val allPosts: Boolean?" !in src,
                "origin.aggregate @agg:all must be non-null Boolean; saw:\n$src")
            // collect → List<String> (non-null), element = @of (Post.category) type
            assertTrue("val categories: List<String>" in src && "val categories: List<String>?" !in src,
                "origin.aggregate @agg:collect must be non-null List<String>; saw:\n$src")
            // first → the @of source type (String), NULLABLE
            assertTrue("val latestCategory: String?" in src,
                "origin.first must be nullable @of source type (String?); saw:\n$src")
            // computed → declared subType (Boolean), NULLABLE (conservative)
            assertTrue("val hasBio: Boolean?" in src,
                "origin.computed must be nullable declared subType (Boolean?); saw:\n$src")
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

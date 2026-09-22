package com.metaobjects.generator.kotlin

import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for [KotlinGenUtil] helpers. Covers [KotlinGenUtil.camelToSnake]
 * — the column-name normaliser used by [KotlinExposedTableGenerator] so generated
 * Exposed columns match the snake_case convention nearly every Postgres schema uses —
 * and the #270 closure gates on the extraction-mirror walk
 * ([KotlinExtractSchemaEmitter.emitMirrorFiles] — it walks ONLY declared
 * `field.object @objectRef` -> `object.value` edges).
 */
class KotlinGenUtilTest {

    @Test fun `single lowercase word is unchanged`() {
        assertEquals("id", KotlinGenUtil.camelToSnake("id"))
        assertEquals("name", KotlinGenUtil.camelToSnake("name"))
    }

    @Test fun `camelCase splits at lower-to-upper boundary`() {
        assertEquals("display_name", KotlinGenUtil.camelToSnake("displayName"))
        assertEquals("html_content", KotlinGenUtil.camelToSnake("htmlContent"))
        assertEquals("user_id", KotlinGenUtil.camelToSnake("userId"))
        assertEquals("created_at", KotlinGenUtil.camelToSnake("createdAt"))
        assertEquals("updated_at", KotlinGenUtil.camelToSnake("updatedAt"))
    }

    @Test fun `multi-camel sequences split at every boundary`() {
        assertEquals("first_name_last_name", KotlinGenUtil.camelToSnake("firstNameLastName"))
        assertEquals("the_quick_brown_fox", KotlinGenUtil.camelToSnake("theQuickBrownFox"))
    }

    @Test fun `leading acronym becomes single lowercase token`() {
        // URLPath → url_path (NOT u_r_l_path) — acronym treated as one word
        assertEquals("url_path", KotlinGenUtil.camelToSnake("URLPath"))
        assertEquals("html_parser", KotlinGenUtil.camelToSnake("HTMLParser"))
    }

    @Test fun `trailing or embedded acronyms stay together`() {
        assertEquals("api_url", KotlinGenUtil.camelToSnake("apiURL"))
        assertEquals("parse_html", KotlinGenUtil.camelToSnake("parseHTML"))
    }

    @Test fun `digits stay attached to preceding token`() {
        assertEquals("foo123_bar", KotlinGenUtil.camelToSnake("foo123Bar"))
    }

    @Test fun `empty string is preserved`() {
        assertEquals("", KotlinGenUtil.camelToSnake(""))
    }

    @Test fun `already snake-case input is preserved`() {
        // No camel boundaries → no underscores inserted; only lowercased pass-through.
        assertEquals("already_snake", KotlinGenUtil.camelToSnake("already_snake"))
    }

    // -----------------------------------------------------------------------
    // #270 — closure gates on the extraction-mirror walk (ADR-0056 moved the closure here
    // from the retired ADR-0044 payload name map). The walk follows ONLY declared
    // `field.object @objectRef` -> object.value edges: an origin child on a field.object does
    // NOT remove its declared edge (positive), and a field carrying ONLY an origin contributes
    // nothing (negative).
    //
    // FR-037 R2 (#336) retired `origin.collection`, which is what these gates
    // used to carry. The replacements are SHARPER: `origin.passthrough @from`
    // and `origin.aggregate @of` name a COLUMN, which may be a
    // `field.object @objectRef <object.value>` — exactly the node kind the
    // closure does walk. `origin.collection @via` only ever reached an ENTITY,
    // which the closure would have skipped on kind alone.
    // -----------------------------------------------------------------------

    private val alphaNoteFixture = """{
      "metadata.root": { "package": "acme::alpha", "children": [
        { "object.value": { "name": "Note", "children": [
            { "field.string": { "name": "alphaText" } }
        ] } }
      ] }
    }""".trimIndent()

    private val betaNoteFixture = """{
      "metadata.root": { "package": "acme::beta", "children": [
        { "object.value": { "name": "Note", "children": [
            { "field.string": { "name": "betaText" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun loadPackages(name: String, vararg fixtures: String): MetaDataLoader {
        val loader = MetaDataLoader.createManual(false, name)
        loader.init()
        loader.load(fixtures.mapIndexed { i, fx -> InMemoryStringSource(fx, "$name-src$i") })
        loader.register()
        return loader
    }

    /** The mirror files the walk writes for `acme::app::Digest`, relative to the output root. */
    private fun mirrorFiles(loader: MetaDataLoader): Set<String> {
        val outDir: Path = Files.createTempDirectory("kgu-mirrors-")
        try {
            val digest = loader.getMetaObjectByName("acme::app::Digest") as MetaObject
            KotlinExtractSchemaEmitter.emitMirrorFiles(digest, outDir, mutableSetOf())
            return Files.walk(outDir).filter { Files.isRegularFile(it) }
                .map { outDir.relativize(it).toString() }.toList().toSet()
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `origin-carrying object field stays in the mirror closure (issue-270 positive gate)`() {
        // fromAlpha DECLARES acme::alpha::Note AND carries an origin.passthrough whose
        // @from names Post.attachment — an object column pointing at the Attachment
        // value object; fromBeta declares acme::beta::Note plainly. Both Notes must get a
        // mirror; the origin's Attachment must not.
        val appFixture = """{
          "metadata.root": { "package": "acme::app", "children": [
            { "object.value": { "name": "Attachment", "children": [
                { "field.string": { "name": "url" } }
            ] } },
            { "object.entity": { "name": "Author", "children": [
                { "field.long": { "name": "id" } },
                { "relationship.aggregation": { "name": "headline",
                    "@objectRef": "Post", "@cardinality": "one" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "internalNotes" } },
                { "field.object": { "name": "attachment", "@objectRef": "Attachment" } }
            ] } },
            { "object.projection": { "name": "Digest", "children": [
                { "field.object": { "name": "fromAlpha",
                    "@objectRef": "acme::alpha::Note", "children": [
                    { "origin.passthrough": { "@from": "Post.attachment",
                        "@via": "Author.headline" } }
                ] } },
                { "field.object": { "name": "fromBeta",
                    "@objectRef": "acme::beta::Note" } }
            ] } },
            { "template.output": { "name": "DigestDoc",
                "@payloadRef": "Digest", "@textRef": "app/digest", "@format": "json" } }
          ] }
        }""".trimIndent()

        val loader = loadPackages("kgu-mirror-pos", alphaNoteFixture, betaNoteFixture, appFixture)
        val files = mirrorFiles(loader)

        assertTrue("acme/alpha/NoteExtracted.kt" in files,
            "origin-carrying declared edge must stay in the closure; files=$files")
        assertTrue("acme/beta/NoteExtracted.kt" in files,
            "the plain declared edge must stay in the closure; files=$files")
        assertFalse("acme/app/AttachmentExtracted.kt" in files,
            "the @from target is an object.value — the kind the closure DOES walk — so it " +
                "must be excluded on the EDGE, not on the node kind; files=$files")
        assertFalse(files.any { "Post" in it },
            "the ignored @via entity must NOT enter the closure; files=$files")
    }

    @Test fun `origin-only field contributes nothing to the mirror closure (issue-270 negative gate)`() {
        // The `posts` field carries ONLY an origin (no @objectRef of its own); its
        // @of names acme::beta::Note. Were an origin edge in the closure, that Note would get
        // a mirror. Instead only the DECLARED acme::alpha::Note does.
        val appFixture = """{
          "metadata.root": { "package": "acme::app", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long": { "name": "id" } },
                { "relationship.aggregation": { "name": "notes",
                    "@objectRef": "acme::beta::Note", "@cardinality": "many" } }
            ] } },
            { "object.projection": { "name": "Digest", "children": [
                { "field.object": { "name": "fromAlpha",
                    "@objectRef": "acme::alpha::Note" } },
                { "field.string": { "name": "posts", "children": [
                    { "origin.aggregate": { "@agg": "count",
                        "@of": "acme::beta::Note.betaText", "@via": "Author.notes" } }
                ] } }
            ] } },
            { "template.output": { "name": "DigestDoc",
                "@payloadRef": "Digest", "@textRef": "app/digest", "@format": "json" } }
          ] }
        }""".trimIndent()

        val loader = loadPackages("kgu-mirror-neg", alphaNoteFixture, betaNoteFixture, appFixture)
        val files = mirrorFiles(loader)

        assertTrue("acme/alpha/NoteExtracted.kt" in files,
            "the declared edge must be walked; files=$files")
        assertFalse("acme/beta/NoteExtracted.kt" in files,
            "an origin-only field must contribute nothing to the closure; files=$files")
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.template.MetaTemplate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * Unit tests for [KotlinGenUtil] helpers. Covers [KotlinGenUtil.camelToSnake]
 * — the column-name normaliser used by [KotlinExposedTableGenerator] so generated
 * Exposed columns match the snake_case convention nearly every Postgres schema uses —
 * and the #270 / ADR-0044 name-map closure gates on [KotlinGenUtil.computePayloadNameMap]
 * (the closure walks ONLY declared `field.object @objectRef` -> `object.value` edges).
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
    // #270 / ADR-0044 — name-map closure gates on computePayloadNameMap.
    // The closure walks ONLY declared `field.object @objectRef` -> object.value
    // edges: an origin child on a field.object does NOT remove its declared
    // edge (positive), and a field carrying ONLY an origin contributes nothing
    // (negative). Both directions gate the nestedTargetOf edit that retired the
    // origin closure edge.
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

    private fun payloadNameMap(loader: MetaDataLoader): Map<String, String> {
        // ADR-0039: root-scan discipline — resolving children accessor (mirrors
        // KotlinPayloadGenerator.execute's template scan).
        val templates = loader.root.getChildren(MetaTemplate::class.java, true).sortedBy { it.name }
        return KotlinGenUtil.computePayloadNameMap(templates, loader)
    }

    @Test fun `origin-carrying object field stays in the name-map closure (issue-270 positive gate)`() {
        // fromAlpha DECLARES acme::alpha::Note AND carries an origin.passthrough whose
        // @from names Post.attachment — an object column pointing at the Attachment
        // value object; fromBeta declares acme::beta::Note plainly. Both
        // same-short-named Notes must be package-qualified — if the origin child
        // dropped the declared edge from the closure, the collision would go
        // undetected and both would fall back to a clobbered bare NotePayload.
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

        val loader = loadPackages("kgu-namemap-pos", alphaNoteFixture, betaNoteFixture, appFixture)
        val nameMap = payloadNameMap(loader)

        assertEquals("AcmeAlphaNotePayload", nameMap["acme::alpha::Note"],
            "origin-carrying declared edge must stay in the closure and qualify; map=$nameMap")
        assertEquals("AcmeBetaNotePayload", nameMap["acme::beta::Note"],
            "the plain declared edge must qualify against the colliding alpha Note; map=$nameMap")
        assertFalse(nameMap.containsKey("acme::app::Attachment"),
            "the @from target is an object.value — the kind the closure DOES walk — so it " +
                "must be excluded on the EDGE, not on the node kind; map=$nameMap")
        assertFalse(nameMap.containsKey("acme::app::Post"),
            "the ignored @via entity must NOT enter the closure; map=$nameMap")
    }

    @Test fun `origin-only field contributes nothing to the name-map (issue-270 negative gate)`() {
        // The `posts` field carries ONLY an origin (no @objectRef of its own); its
        // @via walks to acme::beta::Note, which shares a bare short name with the
        // DECLARED acme::alpha::Note. Were an origin edge in the closure, the two
        // would collide and both would qualify. Instead: the declared Note stays
        // BARE and the origin target never enters the map.
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

        val loader = loadPackages("kgu-namemap-neg", alphaNoteFixture, betaNoteFixture, appFixture)
        val nameMap = payloadNameMap(loader)

        assertEquals("NotePayload", nameMap["acme::alpha::Note"],
            "no collision without the origin edge — the declared Note keeps its bare name; map=$nameMap")
        assertFalse(nameMap.containsKey("acme::beta::Note"),
            "an origin-only field must contribute nothing to the closure; map=$nameMap")
    }
}

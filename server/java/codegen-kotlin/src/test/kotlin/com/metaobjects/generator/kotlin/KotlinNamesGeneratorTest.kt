package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests for [KotlinNamesGenerator] (spec §A1/A2/A3/A6, program-A task 5). Mirrors the
 * shipped C# `NamesGeneratorTests` and the TS reference (`names.test.ts` /
 * `names-decl.test.ts`):
 *
 *  - `const val` members for KIND/NAME/READ_ONLY + per-field `_FIELD`/`_COLUMN` pairs,
 *    always both, so a field/column collision (createdAt/created_at) can never
 *    collapse to one constant.
 *  - An explicit `@column` always wins over the naming strategy — never a hand-rolled
 *    re-derivation. The fixture carries a field whose `@column` deliberately is NOT the
 *    snake_case of its name (`callPurpose`/`purpose_code`) — without it, neither arm of
 *    the resolver (explicit vs. strategy-derived) is distinguished from the other.
 *  - SCHEMA line omitted (never emitted as a null const) when undeclared, present when
 *    declared.
 *  - #248: an object with no primary source emits nothing — participation is never
 *    gated on the object subtype.
 *  - Two fields colliding on their SCREAMING_SNAKE member name is refused, naming the
 *    model.
 *  - R19: a per-package layout puts `<Entity>Names` beside the entity it describes.
 *
 * The `entity-with-controller` snapshot fixture's `Author` (id/name/`@table` only) does
 * NOT carry the distinguishing fields these behaviours need — every model here is
 * authored inline, per task-5-brief's own correction.
 */
class KotlinNamesGeneratorTest {

    // Author carries the two distinguishing fields:
    //  - createdAt: no @column -- the default snake_case strategy alone produces
    //    "created_at", proving the FIELD/COLUMN pair is emitted even when nothing is
    //    declared explicitly.
    //  - callPurpose: an EXPLICIT @column "purpose_code" the snake_case strategy would
    //    NOT have produced ("call_purpose") -- the discriminator between "reads
    //    @column" and "re-derives from the field name".
    // AddressValue has no source at all (object.value -- FR-024 value purity forbids one).
    private val authorModel = """{
      "metadata.root": { "package": "acme::blog", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "source.rdb":      { "@table": "authors" } },
            { "field.long":      { "name": "id" } },
            { "field.timestamp": { "name": "createdAt" } },
            { "field.string":    { "name": "callPurpose", "@maxLength": 40, "@column": "purpose_code" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.value": { "name": "AddressValue", "children": [
            { "field.string": { "name": "street" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun emit(model: String, args: Map<String, String> = emptyMap(), outDir: Path? = null): Map<String, String> {
        val dir = outDir ?: Files.createTempDirectory("names-")
        try {
            val gen = KotlinNamesGenerator()
            gen.setArgs(args + mapOf("outputDir" to dir.toString()))
            gen.execute(loadString("test", model))
            return Files.walk(dir).use { stream ->
                stream.filter { it.isRegularFile() }
                    .toList()
                    .associate { dir.relativize(it).toString() to it.readText() }
            }
        } finally {
            // Only clean up a dir we created ourselves -- a caller-supplied outDir
            // (the R19 two-package test) is shared across two emit() calls and cleans
            // up once, itself, when done reading both.
            if (outDir == null) dir.toFile().deleteRecursively()
        }
    }

    private fun authorSource(args: Map<String, String> = emptyMap()): String =
        emit(authorModel, args).getValue("acme/blog/AuthorNames.kt")

    @Test fun `emits const val members for the table and every column`() {
        val src = authorSource()
        assertTrue("object AuthorNames {" in src, src)
        assertTrue("const val KIND: String = \"table\"" in src, src)
        assertTrue("const val NAME: String = \"authors\"" in src, src)
        assertTrue("const val READ_ONLY: Boolean = false" in src, src)
        assertTrue("const val CREATED_AT_FIELD: String = \"createdAt\"" in src, src)
        // Kotlin's generator default is snake_case, unlike the shared JVM default (literal).
        assertTrue("const val CREATED_AT_COLUMN: String = \"created_at\"" in src, src)
    }

    @Test fun `an explicit column beats the strategy`() {
        val src = authorSource()
        assertTrue("const val CALL_PURPOSE_COLUMN: String = \"purpose_code\"" in src, src)
        // The literal the snake_case strategy WOULD have produced must be gone entirely.
        assertFalse("call_purpose" in src, src)
    }

    @Test fun `COLUMNS_BY_FIELD references the constants, not repeated literals`() {
        val src = authorSource()
        assertTrue("\"callPurpose\" to CALL_PURPOSE_COLUMN," in src, src)
        assertTrue("\"createdAt\" to CREATED_AT_COLUMN," in src, src)
        assertTrue("\"id\" to ID_COLUMN," in src, src)
        // The map must not respell the physical column string itself.
        assertFalse("\"callPurpose\" to \"purpose_code\"" in src, src)
    }

    @Test fun `an absent schema omits the line rather than emitting a null const`() {
        // `const val SCHEMA: String? = null` does not compile -- absent means absent.
        val src = authorSource()
        assertFalse("SCHEMA" in src, src)
    }

    @Test fun `a declared schema emits the line`() {
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Widget", "children": [
                { "source.rdb": { "@table": "widgets", "@schema": "inventory" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val src = emit(model).getValue("acme/WidgetNames.kt")
        assertTrue("const val SCHEMA: String = \"inventory\"" in src, src)
    }

    @Test fun `the columnNaming arg is honoured, both arms`() {
        // Default (snake_case): createdAt -> created_at.
        assertTrue("const val CREATED_AT_COLUMN: String = \"created_at\"" in authorSource(), authorSource())
        // literal: createdAt stays createdAt. An explicit @column still always wins.
        val literalSrc = authorSource(mapOf("columnNaming" to "literal"))
        assertTrue("const val CREATED_AT_COLUMN: String = \"createdAt\"" in literalSrc, literalSrc)
        assertTrue("const val CALL_PURPOSE_COLUMN: String = \"purpose_code\"" in literalSrc, literalSrc)
    }

    @Test fun `a view kind source is read-only and keeps its own kind`() {
        // resolveObjectNames dispatches on the primary source's KIND, never the object
        // subtype (#248) -- object.projection legally carries a read-only primary
        // source (an object.entity's primary must be writable per
        // ERR_ENTITY_PRIMARY_SOURCE_READONLY; a derived read model is a projection).
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.projection": { "name": "Report", "children": [
                { "source.rdb": { "@kind": "view", "@view": "v_report" } },
                { "field.int": { "name": "id" } }
            ] } }
          ] }
        }""".trimIndent()
        val src = emit(model).getValue("acme/ReportNames.kt")
        assertTrue("const val KIND: String = \"view\"" in src, src)
        assertTrue("const val NAME: String = \"v_report\"" in src, src)
        assertTrue("const val READ_ONLY: Boolean = true" in src, src)
    }

    @Test fun `an inherited field and its inherited @column both resolve`() {
        // ADR-0039: entity.metaFields (getMetaFields(), which defaults to
        // includeParentData=true) must see a field AND @column declared on an abstract
        // parent -- an own-only read would silently drop it, so the constant would
        // disagree with the column Task 6's Exposed table binding actually names.
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "BaseThing", "abstract": true, "children": [
                { "field.string": { "name": "externalRef", "@column": "ext_ref" } }
            ] } },
            { "object.entity": { "name": "ConcreteThing", "extends": "BaseThing", "children": [
                { "source.rdb": { "@table": "concrete_things" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val src = emit(model).getValue("acme/ConcreteThingNames.kt")
        assertTrue("const val EXTERNAL_REF_FIELD: String = \"externalRef\"" in src, src)
        assertTrue("const val EXTERNAL_REF_COLUMN: String = \"ext_ref\"" in src, src)
    }

    @Test fun `an object with no primary source emits nothing`() {
        // #248 -- participation derives from a declared/inherited primary source, never
        // from the object subtype. AddressValue (object.value) has no source at all
        // (FR-024 value purity) and must not appear in the output.
        val files = emit(authorModel)
        assertTrue(files.keys.none { "AddressValue" in it }, files.keys.toString())
        assertTrue(files.keys.single() == "acme/blog/AuthorNames.kt", files.keys.toString())
    }

    @Test fun `two fields colliding on their SCREAMING_SNAKE form is refused naming the model`() {
        // userId and UserId both camelToSnake+uppercase to USER_ID -- two duplicate
        // const members. Kotlin would refuse to compile the generated file, but the
        // error would name a generated .kt and read as a codegen bug. Fail here
        // instead, naming the entity and both offending field names.
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Weird", "children": [
                { "source.rdb":   { "@table": "weirds" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "userId" } },
                { "field.string": { "name": "UserId" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val ex = assertFailsWith<GeneratorException> { emit(model) }
        val msg = ex.message.orEmpty()
        assertTrue("Weird" in msg, msg)
        assertTrue("userId" in msg, msg)
        assertTrue("UserId" in msg, msg)
    }

    @Test fun `a per-package layout puts the names artifact beside the entity it describes`() {
        // R19 -- codegen-kotlin has no per-package namespace-override arg (every
        // per-entity generator derives its package mechanically from
        // PackageMapping.splitFqn), so this is a cheap proof rather than a hunt: two
        // packages, two entities both named "Thing", and each ThingNames.kt must land
        // in the SAME Kotlin package as the entity it describes.
        val alphaModel = """{
          "metadata.root": { "package": "acme::alpha", "children": [
            { "object.entity": { "name": "Thing", "children": [
                { "source.rdb": { "@table": "alpha_things" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val betaModel = """{
          "metadata.root": { "package": "acme::beta", "children": [
            { "object.entity": { "name": "Thing", "children": [
                { "source.rdb": { "@table": "beta_things" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("names-xpkg-")
        try {
            val alphaFiles = emit(alphaModel, outDir = outDir)
            val betaFiles = emit(betaModel, outDir = outDir)

            val alphaSrc = alphaFiles.getValue("acme/alpha/ThingNames.kt")
            assertTrue("package acme.alpha" in alphaSrc, alphaSrc)
            assertTrue("const val NAME: String = \"alpha_things\"" in alphaSrc, alphaSrc)

            val betaSrc = betaFiles.getValue("acme/beta/ThingNames.kt")
            assertTrue("package acme.beta" in betaSrc, betaSrc)
            assertTrue("const val NAME: String = \"beta_things\"" in betaSrc, betaSrc)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

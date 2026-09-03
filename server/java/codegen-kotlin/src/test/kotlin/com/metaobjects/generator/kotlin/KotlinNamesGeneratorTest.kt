package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
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
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
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
        //
        // The inherited constant now reaches the child BY REFERENCE to the base's object.
        // Kotlin has no static inheritance — an `object` cannot extend another — so the
        // reference is what "extend the parent, do not redo the names" looks like here:
        // the literal `ext_ref` is spelled once, on BaseThingNames. Both halves are
        // asserted, because a positive-only check would pass for a generator emitting the
        // reference AND the restated literal.
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
        val files = emit(model)
        val src = files.getValue("acme/ConcreteThingNames.kt")
        assertTrue("const val EXTERNAL_REF_FIELD: String = BaseThingNames.EXTERNAL_REF_FIELD" in src, src)
        assertTrue("const val EXTERNAL_REF_COLUMN: String = BaseThingNames.EXTERNAL_REF_COLUMN" in src, src)
        assertFalse("\"ext_ref\"" in src, src)
        // COLUMNS_BY_FIELD stays COMPLETE — it is the lookup surface, and a miss on an
        // inherited field is the fallback-to-literal this artifact removes.
        assertTrue("\"externalRef\" to EXTERNAL_REF_COLUMN" in src, src)

        // The base gets an object of its own now — reached by walking `extends` UPWARD from
        // ConcreteThing, which is what keeps #248 intact (see the test below).
        val base = files.getValue("acme/BaseThingNames.kt")
        assertTrue("const val EXTERNAL_REF_COLUMN: String = \"ext_ref\"" in base, base)
        // It declares no source: a NAME here would be a physical name invented for an object
        // that declares none — the phantom-table failure #248 exists to prevent.
        assertFalse("const val NAME" in base, base)
        assertFalse("const val KIND" in base, base)
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

    // -------------------------------------------------------------------------
    // "Those names objects should extend from the parent, not just redo all the names."
    // -------------------------------------------------------------------------
    @Test fun `a TPH subtype references the base's shared table name rather than restating it`() {
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Auth", "@discriminator": "kind", "children": [
                { "source.rdb":   { "@table": "zz_auths" } },
                { "field.long":   { "name": "id" } },
                { "field.enum":   { "name": "kind", "@values": ["Copay"] } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay",
              "children": [
                { "field.long": { "name": "copayAmount", "@column": "zz_copay_cents" } }
            ] } }
          ] }
        }""".trimIndent()
        val src = emit(model).getValue("acme/CopayAuthNames.kt")
        // The subtype INHERITS its base's source, so the shared table name comes from the
        // base object rather than being restated here.
        assertTrue("const val NAME: String = AuthNames.NAME" in src, src)
        assertTrue("const val ID_COLUMN: String = AuthNames.ID_COLUMN" in src, src)
        assertTrue("const val COPAY_AMOUNT_COLUMN: String = \"zz_copay_cents\"" in src, src)
        // The whole point: the subtype used to restate the base's table name and columns.
        assertFalse("zz_auths" in src, src)
    }

    @Test fun `the emitted objects compile, so a cross-object const reference really resolves`() {
        // The teeth. Every assertion above is about TEXT; only a compiler proves that
        // `CopayAuthNames.NAME`, declared as a reference to `AuthNames.NAME`, is a legal
        // `const val` — Kotlin requires a compile-time constant initialiser, and a
        // cross-object reference qualifies only because the target is itself `const`.
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
        val files = emit(model)
        val probe = """
            package acme
            object ZzProbe {
                // An INHERITED constant, reached through the reference the generator emitted.
                const val A: String = ConcreteThingNames.EXTERNAL_REF_COLUMN
                val count: Int = ConcreteThingNames.COLUMNS_BY_FIELD.size
            }
        """.trimIndent()
        val sources = files.map { (path, text) ->
            SourceFile.kotlin(path.substringAfterLast('/'), text)
        } + SourceFile.kotlin("ZzProbe.kt", probe)

        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
            "generated names objects failed to compile:\n${result.messages}")
    }


    @Test fun `a child field colliding with an INHERITED one is refused, naming the model`() {
        // The guard has to see the WHOLE field set, not just what this object declares. Once
        // a child stopped restating its inherited constants, an own-only check could no
        // longer see a collision that spans the `extends` boundary — and here both constants
        // land in the SAME object (the child re-exports the inherited one under its own
        // name), so the emitted file would not even compile, blaming a generated file for a
        // model problem.
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "BaseRow", "abstract": true, "children": [
                { "field.timestamp": { "name": "createdAt" } }
            ] } },
            { "object.entity": { "name": "Row", "extends": "BaseRow", "children": [
                { "source.rdb": { "@table": "rows" } },
                { "field.long":      { "name": "id" } },
                { "field.timestamp": { "name": "created_at" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val e = assertFailsWith<GeneratorException> { emit(model) }
        assertTrue("createdAt" in e.message!!, e.message!!)
        assertTrue("created_at" in e.message!!, e.message!!)
        assertTrue("CREATED_AT" in e.message!!, e.message!!)
    }

}

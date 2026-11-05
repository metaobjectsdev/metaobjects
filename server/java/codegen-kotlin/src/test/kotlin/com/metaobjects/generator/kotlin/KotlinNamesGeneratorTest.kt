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
 *  - `const val` members mirroring the metadata tree — the object's own
 *    `TYPE`/`SUB_TYPE`/`NAME`, a `SOURCE_<ROLE>_*` block per `source.rdb` child (its
 *    physical name under the alias for its `@kind`), an `IDENTITY_<N>_*` / `INDEX_<N>_*`
 *    block per key, and per-field `_FIELD`/`_COLUMN` pairs, always both, so a field/column
 *    collision (createdAt/created_at) can never collapse to one constant.
 *  - An explicit `@column` always wins over the naming strategy — never a hand-rolled
 *    re-derivation. The fixture carries a field whose `@column` deliberately is NOT the
 *    snake_case of its name (`callPurpose`/`purpose_code`) — without it, neither arm of
 *    the resolver (explicit vs. strategy-derived) is distinguished from the other.
 *  - `SOURCE_<ROLE>_SCHEMA` omitted (never emitted as a null const) when undeclared,
 *    present when declared.
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

    private fun emit(
        model: String,
        args: Map<String, String> = emptyMap(),
        outDir: Path? = null,
        columnsRule: String? = null,
    ): Map<String, String> {
        val dir = outDir ?: Files.createTempDirectory("names-")
        try {
            val gen = KotlinNamesGenerator()
            gen.setArgs(args + mapOf("outputDir" to dir.toString()))
            val loader = loadString("test", model)
            // ADR-0058: the rule is read from the loaded root, never the removed
            // columnNaming generator arg.
            if (columnsRule != null) {
                loader.root.physicalNaming =
                    com.metaobjects.database.PhysicalNaming.of(columnsRule, "snake_case")
            }
            gen.execute(loader)
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

    private fun authorSource(args: Map<String, String> = emptyMap(), columnsRule: String? = null): String =
        emit(authorModel, args, columnsRule = columnsRule).getValue("acme/blog/AuthorNames.kt")

    @Test fun `emits const val members for the table and every column`() {
        val src = authorSource()
        assertTrue("object AuthorNames {" in src, src)
        // The object's OWN identity — `NAME` is the metamodel name now, not the table. The
        // physical name sits under the alias for the source's @kind, which is what stopped
        // one member meaning a table, a view and a procedure depending on the object.
        assertTrue("const val TYPE: String = \"object\"" in src, src)
        assertTrue("const val SUB_TYPE: String = \"entity\"" in src, src)
        assertTrue("const val NAME: String = \"Author\"" in src, src)
        assertTrue("const val SOURCE_PRIMARY_TYPE: String = \"source\"" in src, src)
        assertTrue("const val SOURCE_PRIMARY_SUB_TYPE: String = \"rdb\"" in src, src)
        assertTrue("const val SOURCE_PRIMARY_KIND: String = \"table\"" in src, src)
        assertTrue("const val SOURCE_PRIMARY_TABLE: String = \"authors\"" in src, src)
        // READ_ONLY is GONE — a derivation over @kind, never metadata, and read by nothing
        // in any port. A reader who wants it asks SOURCE_PRIMARY_KIND.
        assertFalse("READ_ONLY" in src, src)
        // The identity block: the fixture declares no name, so `pk` is auto-named `primary`,
        // and it carries NO index member — a primary key's database name is migrate's
        // dialect-conditional formula, not something this artifact may restate.
        assertTrue("const val IDENTITY_PRIMARY_TYPE: String = \"identity\"" in src, src)
        assertTrue("const val IDENTITY_PRIMARY_SUB_TYPE: String = \"primary\"" in src, src)
        assertFalse("IDENTITY_PRIMARY_INDEX" in src, src)
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
        // `const val SOURCE_PRIMARY_SCHEMA: String? = null` does not compile -- absent
        // means absent.
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
        assertTrue("const val SOURCE_PRIMARY_SCHEMA: String = \"inventory\"" in src, src)
    }

    @Test fun `the project's naming columns rule is honoured, both arms`() {
        // Default (snake_case): createdAt -> created_at.
        assertTrue("const val CREATED_AT_COLUMN: String = \"created_at\"" in authorSource(), authorSource())
        // literal: createdAt stays createdAt. An explicit @column still always wins.
        val literalSrc = authorSource(columnsRule = "literal")
        assertTrue("const val CREATED_AT_COLUMN: String = \"createdAt\"" in literalSrc, literalSrc)
        assertTrue("const val CALL_PURPOSE_COLUMN: String = \"purpose_code\"" in literalSrc, literalSrc)
    }

    @Test fun `the columnNaming generator arg is refused`() {
        val ex = assertFailsWith<GeneratorException> {
            authorSource(mapOf("columnNaming" to "literal"))
        }
        assertEquals(
            com.metaobjects.database.ColumnNaming.removedConfigurationMessage(
                "the columnNaming generator arg in pom.xml", "literal"),
            ex.message,
        )
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
        assertTrue("const val SOURCE_PRIMARY_KIND: String = \"view\"" in src, src)
        // Under the alias for its @kind — `_VIEW`, not `_TABLE`. Under the old flat shape
        // this same member was `NAME` for all three kinds, so a consumer could not tell what
        // kind of database object it held without reading a second member. Referencing
        // `ReportNames.SOURCE_PRIMARY_TABLE` is now a compile error, which is the point.
        assertTrue("const val SOURCE_PRIMARY_VIEW: String = \"v_report\"" in src, src)
        assertFalse("SOURCE_PRIMARY_TABLE" in src, src)
        assertFalse("READ_ONLY" in src, src)
    }

    @Test fun `a served report gets a names artifact built from its read model`() {
        // D7: a hand-written query over a report's view had no constant to name the view or
        // its derived columns. The artifact is the report's READ MODEL (its derived fields),
        // because the declared report node has no field children.
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Sale", "children": [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "channel" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "dimension.attribute": { "name": "channel", "@of": "Sale.channel" } },
                { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
            ] } },
            { "object.report": { "name": "SalesByChannel", "@from": "Sale",
                "@dimensions": ["channel"], "@measures": ["sales"], "children": [
                { "source.rdb": { "@kind": "view", "@view": "v_sales_by_channel" } }
            ] } },
            { "object.report": { "name": "Unserved", "@from": "Sale",
                "@dimensions": ["channel"], "@measures": ["sales"] } }
          ] }
        }""".trimIndent()
        val files = emit(model)
        val src = files.getValue("acme/SalesByChannelNames.kt")
        assertTrue("const val SOURCE_PRIMARY_VIEW: String = \"v_sales_by_channel\"" in src, src)
        assertTrue("const val SUB_TYPE: String = \"report\"" in src, src)
        assertTrue("const val CHANNEL_COLUMN: String = \"channel\"" in src, src)
        assertTrue("const val SALES_COLUMN: String = \"sales\"" in src, src)
        // A report with no view has nothing to name.
        assertFalse("acme/UnservedNames.kt" in files, files.keys.toString())
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
        // It declares no source, so it carries NO source block at all — a physical name here
        // would be one invented for an object that declares none, the phantom-table failure
        // #248 exists to prevent. It does carry its own TYPE/SUB_TYPE/NAME, and that is not
        // the same claim: `NAME` is the object's metamodel name ("BaseThing"), which a
        // fragment has like any other node.
        assertFalse("SOURCE_" in base, base)
        assertTrue("const val NAME: String = \"BaseThing\"" in base, base)
    }

    @Test fun `a key-only abstract is a link in the chain, not a node to walk past`() {
        // `Audited` declares NO field and NO source -- only a key. That is the whole reason
        // such a node exists: hoist one `identity.secondary` onto a chain. The "has anything
        // to contribute" test used to ask about fields and sources alone, so this node
        // answered "no": the walk stepped over it, no AuditedNames was emitted, and its key
        // landed in neither WidgetNames nor the grandparent's -- while the Exposed table
        // generator still referenced it.
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Base", "abstract": true, "children": [
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "email", "@column": "zz_email_addr" } }
            ] } },
            { "object.entity": { "name": "Audited", "abstract": true, "extends": "Base", "children": [
                { "identity.secondary": { "name": "by_email", "@fields": ["email"] } }
            ] } },
            { "object.entity": { "name": "Widget", "extends": "Audited", "children": [
                { "source.rdb": { "@table": "zz_widgets" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val files = emit(model)

        // The intermediate has something to contribute, so it gets an object of its own...
        val audited = files.getValue("acme/AuditedNames.kt")
        assertTrue("IDENTITY_BY_EMAIL_NAME" in audited, audited)

        // ...and the concrete entity reaches it BY REFERENCE rather than restating it,
        // which is what "extend the parent, do not redo the names" looks like on a port
        // with no static inheritance. Both halves asserted: a positive-only check would
        // pass for a generator emitting the reference AND the literal.
        val widget = files.getValue("acme/WidgetNames.kt")
        assertTrue("AuditedNames.IDENTITY_BY_EMAIL_NAME" in widget, widget)
        assertFalse("IDENTITY_BY_EMAIL_NAME: String = \"by_email\"" in widget, widget)
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
                { "field.string": { "name": "UserId", "@column": "user_id_alt" } },
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

    @Test fun `two identities colliding on their SCREAMING_SNAKE form is refused, naming both node paths`() {
        // The collision guard runs over the WHOLE emitted member set, not per collection —
        // the emitted object has one flat namespace. Two IDENTITIES are the case fields alone
        // could not reach: `by_name` and `byName` both fold to IDENTITY_BY_NAME_*, and Kotlin
        // would refuse the file while blaming generated code for a model problem.
        //
        // The failure names both NODE PATHS, not just two bare names, because a bare name
        // does not say which collection it came from — and with four collections sharing one
        // namespace that is the first thing a reader needs.
        val model = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Widget", "children": [
                { "source.rdb":   { "@table": "widgets" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "alt" } },
                { "identity.primary":   { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                { "identity.secondary": { "name": "by_name", "@fields": ["alt"] } },
                { "identity.secondary": { "name": "byName",  "@fields": ["alt"] } }
            ] } }
          ] }
        }""".trimIndent()
        val e = assertFailsWith<GeneratorException> { emit(model) }
        val msg = e.message.orEmpty()
        assertTrue("identities.by_name" in msg, msg)
        assertTrue("identities.byName" in msg, msg)
        assertTrue("IDENTITY_BY_NAME" in msg, msg)
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
            assertTrue("const val SOURCE_PRIMARY_TABLE: String = \"alpha_things\"" in alphaSrc, alphaSrc)

            val betaSrc = betaFiles.getValue("acme/beta/ThingNames.kt")
            assertTrue("package acme.beta" in betaSrc, betaSrc)
            assertTrue("const val SOURCE_PRIMARY_TABLE: String = \"beta_things\"" in betaSrc, betaSrc)
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
        // The subtype declares no source of its own, so every SOURCE_* member lands in the
        // inherited half and is re-exported by reference from the base. No `inheritsSource`
        // flag decides that — the own-source map is simply empty, which is the same
        // structural question answered by the accessor that had to be consulted anyway.
        assertTrue("const val SOURCE_PRIMARY_TABLE: String = AuthNames.SOURCE_PRIMARY_TABLE" in src, src)
        assertTrue("const val ID_COLUMN: String = AuthNames.ID_COLUMN" in src, src)
        assertTrue("const val COPAY_AMOUNT_COLUMN: String = \"zz_copay_cents\"" in src, src)
        // ...while its OWN identity is restated, because it differs: `NAME` is the object's
        // metamodel name, so the subtype's must say "CopayAuth", not the base's.
        assertTrue("const val NAME: String = \"CopayAuth\"" in src, src)
        // The whole point: the subtype used to restate the base's table name and columns.
        assertFalse("zz_auths" in src, src)
    }

    @Test fun `the emitted objects compile, so a cross-object const reference really resolves`() {
        // The teeth. Every assertion above is about TEXT; only a compiler proves that
        // `ConcreteThingNames.EXTERNAL_REF_COLUMN`, declared as a reference to
        // `BaseThingNames.EXTERNAL_REF_COLUMN`, is a legal `const val` — Kotlin requires a
        // compile-time constant initialiser, and a cross-object reference qualifies only
        // because the target is itself `const`.
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
                { "field.timestamp": { "name": "created_at", "@column": "created_at_alt" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val e = assertFailsWith<GeneratorException> { emit(model) }
        assertTrue("createdAt" in e.message!!, e.message!!)
        assertTrue("created_at" in e.message!!, e.message!!)
        assertTrue("CREATED_AT" in e.message!!, e.message!!)
    }


    // -------------------------------------------------------------------------
    // Flattened value objects: one constant per member's column, none for the field
    // -------------------------------------------------------------------------

    private val flattenedModel = """{
      "metadata.root": { "package": "acme::ship", "children": [
        { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "street" } },
            { "field.string": { "name": "postalCode", "@column": "ZIP" } }
        ] } },
        { "object.entity": { "name": "Shipment", "children": [
            { "source.rdb":   { "@table": "shipments" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "shipTo", "@objectRef": "Address", "@storage": "flattened" } },
            { "field.object": { "name": "payload", "@objectRef": "Address" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `a flattened member gets a column constant beside its field constants`() {
        val src = emit(flattenedModel).getValue("acme/ship/ShipmentNames.kt")

        assertTrue("const val SHIP_TO_STREET_COLUMN: String = \"ship_to_street\"" in src, src)
        assertTrue("const val SHIP_TO_POSTAL_CODE_COLUMN: String = \"ship_to_ZIP\"" in src, src)
        assertTrue("const val SHIP_TO_FIELD: String = \"shipTo\"" in src, src)
        assertTrue("const val PAYLOAD_COLUMN: String = \"payload\"" in src, src)
        // A flattened field has no column of its own, so no _COLUMN constant and no map key.
        assertFalse("SHIP_TO_COLUMN" in src, src)
        assertFalse("Deprecated" in src, src)
        assertFalse("DEPRECATION" in src, src)
        assertFalse("\"shipTo\" to" in src, src)
        assertTrue("\"shipTo.street\" to SHIP_TO_STREET_COLUMN" in src, src)
        assertTrue("\"shipTo.postalCode\" to SHIP_TO_POSTAL_CODE_COLUMN" in src, src)
    }

    /**
     * A flattened field has no column constant: the generated names objects, a base and its
     * child, compile with every warning an error, and reading the field's own column constant
     * is a compile error.
     */
    @Test fun `a flattened field has no column constant to read`() {
        val model = """{
          "metadata.root": { "package": "acme::ship", "children": [
            { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street" } }
            ] } },
            { "object.entity": { "name": "Base", "abstract": true, "children": [
                { "field.long":   { "name": "id" } },
                { "field.object": { "name": "shipTo", "@objectRef": "Address", "@storage": "flattened" } }
            ] } },
            { "object.entity": { "name": "Order", "extends": "acme::ship::Base", "children": [
                { "source.rdb":   { "@table": "orders" } },
                { "field.string": { "name": "note" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val files = emit(model).filterKeys { it.endsWith(".kt") }
        val order = files.getValue("acme/ship/OrderNames.kt")
        assertFalse("SHIP_TO_COLUMN" in order, order)

        fun compile(extra: List<SourceFile>) = KotlinCompilation().apply {
            this.sources = files.map { (path, text) -> SourceFile.kotlin(path.substringAfterLast('/'), text) } + extra
            inheritClassPath = true
            allWarningsAsErrors = true
            messageOutputStream = System.out
        }.compile()

        val clean = compile(emptyList())
        assertEquals(KotlinCompilation.ExitCode.OK, clean.exitCode, "generated names objects warn:\n${clean.messages}")

        val use = compile(listOf(SourceFile.kotlin("UsesIt.kt",
            "package acme.ship\nobject UsesIt { val c: String = OrderNames.SHIP_TO_COLUMN }\n")))
        assertEquals(KotlinCompilation.ExitCode.COMPILATION_ERROR, use.exitCode, use.messages)
        assertTrue("SHIP_TO_COLUMN" in use.messages, use.messages)
    }

    @Test fun `a flattened member constant colliding with a field constant is left out`() {
        val model = flattenedModel.replace(
            "\"@storage\": \"flattened\" }",
            "\"@storage\": \"flattened\", \"@flattenedColumnPrefix\": \"st_\" } },\n" +
                "            { \"field.string\": { \"name\": \"shipToStreet\" }")
        val src = emit(model).getValue("acme/ship/ShipmentNames.kt")

        // The field's constant wins; the model generates, as it did before member constants.
        assertTrue("const val SHIP_TO_STREET_COLUMN: String = \"ship_to_street\"" in src, src)
        assertFalse("\"st_street\"" in src, src)
        assertTrue("const val SHIP_TO_POSTAL_CODE_COLUMN: String = \"st_ZIP\"" in src, src)
    }

    /** The cross-port naming corpus: every `<Object>.<field>.<member>` key is a constant, under every rule. */
    @Test fun `every flattened column in the naming corpus is a constant`() {
        var dir: Path? = Path.of("").toAbsolutePath()
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.parent
        val corpus = requireNotNull(dir) { "could not locate fixtures/" }.resolve("fixtures/naming-conformance/physical-names")
        val model = corpus.resolve("meta.naming.json").readText()
        val cases = com.fasterxml.jackson.databind.ObjectMapper().readTree(corpus.resolve("cases.json").toFile()).get("cases")
        for (c in cases) {
            val naming = c.get("naming")
            val rule = if (naming != null && naming.has("columns")) naming.get("columns").asText() else "snake_case"
            val src = emit(model, columnsRule = rule).getValue("acme/naming/ShipmentNames.kt")
            for ((key, value) in c.get("columns").fields()) {
                val parts = key.split(".")
                if (parts.size != 3 || parts[0] != "Shipment") continue
                val member = "${KotlinNaming.namesMember(parts[1])}_${KotlinNaming.namesMember(parts[2])}_COLUMN"
                val decl = "const val $member: String = \"${value.asText()}\""
                assertTrue(decl in src, "${c.get("name").asText()}: $decl\n$src")
            }
        }
    }
}

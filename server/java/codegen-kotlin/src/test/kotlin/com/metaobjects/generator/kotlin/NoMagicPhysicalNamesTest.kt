package com.metaobjects.generator.kotlin

import com.metaobjects.generator.EmitsPhysicalNameConstants
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.streams.toList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * NO MAGIC STRINGS — the Kotlin half of the gate that makes "generated code references
 * the constant" checkable instead of asserted. Port of the TypeScript
 * `server/typescript/packages/codegen-ts/test/no-magic-physical-names.test.ts` and the
 * C# `MetaObjects.Codegen.Tests/NoMagicPhysicalNamesTests.cs`.
 *
 * METHOD — a DE-BLINDED fixture. Every physical name below is deliberately impossible
 * for a generator to produce by derivation: it is not the snake_case of its field name,
 * not the pluralization of its object name, and carries a `zz_phys_` prefix nothing else
 * in the codebase uses. So a generator that embeds a literal cannot be confused with one
 * that derived the same string by coincidence — if the token appears in a file, that file
 * hard-coded it.
 *
 * Every token carries its REACH — whether it is expected to travel as a constant today,
 * or is one of the categories this port still spells literally. A [Reach.KNOWN_LITERAL]
 * is PINNED, not exempted: the gate asserts the literal is still there, so the day a
 * generator starts referencing the constant instead, this test fails and says "promote
 * it". A known gap that stops being a gap without anyone noticing is how a ledger rots.
 *
 * ONE category is out of this method's reach, and it is worth naming rather than leaving a
 * reader to assume otherwise: a RELATIONSHIP-SYNTHESIZED foreign-key column — the column a
 * parent-side `relationship.composition @cardinality: many` contributes to the child's
 * table when the child declares no field for it. That name is DERIVED (the relationship's
 * short name + "Id", through the naming strategy), never declared, so there is no physical
 * name to de-blind and nothing for a generator to restate. It is a different defect class —
 * a name computed twice by two derivations — and `<Entity>Names` has no constant for it
 * because it belongs to no field of any object.
 */
class NoMagicPhysicalNamesTest {

    /** How a physical name is expected to reach generated output today. */
    private enum class Reach {
        /** Must travel as an `<Entity>Names` reference, and appear literally nowhere else. */
        CONSTANT,

        /** Still spelled literally, for the reason on the row. Pinned, not exempted. */
        KNOWN_LITERAL,
    }

    private data class Token(
        val literal: String,
        val shouldUse: String,
        val reach: Reach = Reach.CONSTANT,
        val why: String = "",
    )

    // -----------------------------------------------------------------------
    // The de-blinded fixture, kept in step with the TypeScript and C# gates so a
    // reader can diff the three ports' coverage directly.
    // -----------------------------------------------------------------------
    private val table = "zz_phys_tbl_alpha"      // NOT pluralize(snake("Customer"))
    private val colId = "zz_phys_col_ident"      // NOT snake("id")
    private val colEmail = "zz_phys_col_mail"    // NOT snake("email")
    private val colFk = "zz_phys_col_owner"      // NOT snake("customerId")
    private val orderTable = "zz_phys_tbl_beta"  // NOT pluralize(snake("Order"))
    private val orderId = "zz_phys_col_okey"
    private val jsonbCol = "zz_phys_col_blob"    // a single-jsonb-column value object
    // Deliberately NOT tracked on its own: under @storage: flattened the field's "column"
    // is not a column at all, only the prefix each member column is built from.
    private val flatPrefix = "zz_phys_col_pfx"
    private val voMemberCol = "zz_phys_col_road"
    // What the flattened branch actually emits: parent column + "_" + member column.
    private val flatCol = flatPrefix + "_" + voMemberCol

    private val tokens = listOf(
        Token(table, "CustomerNames.NAME"),
        Token(colId, "CustomerNames.ID_COLUMN"),
        Token(colEmail, "CustomerNames.EMAIL_COLUMN"),
        Token(orderTable, "OrderNames.NAME"),
        Token(orderId, "OrderNames.ID_COLUMN"),
        Token(colFk, "OrderNames.CUSTOMER_ID_COLUMN"),
        Token(jsonbCol, "CustomerNames.PROFILE_COLUMN"),
        Token(
            flatCol, "(no constant exists)", Reach.KNOWN_LITERAL,
            "A flattened object.value's nested column is a COMPOSITE (owner field column + \"_\" + " +
                "member column). The value object has no source (FR-024 value purity) and so no " +
                "<Vo>Names, and the owner's artifact carries one constant per FIELD, not per " +
                "flattened member — there is no single constant to reference.",
        ),
    )

    private val model = """{
      "metadata.root": { "package": "acme", "children": [
        { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "road", "@column": "$voMemberCol" } }
        ] } },
        { "object.entity": { "name": "Customer", "children": [
            { "source.rdb":   { "@table": "$table" } },
            { "field.long":   { "name": "id",    "@column": "$colId" } },
            { "field.string": { "name": "email", "@column": "$colEmail", "@required": true } },
            { "field.object": { "name": "address", "@column": "$flatPrefix",
                                "@objectRef": "Address", "@storage": "flattened" } },
            { "field.object": { "name": "profile", "@column": "$jsonbCol",
                                "@objectRef": "Address", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Order", "children": [
            { "source.rdb":   { "@table": "$orderTable" } },
            { "field.long":   { "name": "id",         "@column": "$orderId" } },
            { "field.long":   { "name": "customerId", "@column": "$colFk" } },
            { "identity.primary":   { "@fields": ["id"], "@generation": "increment" } },
            { "identity.reference": { "name": "customerRef", "@fields": ["customerId"], "@references": "Customer" } },
            { "relationship.association": { "name": "customer", "@cardinality": "one", "@objectRef": "Customer" } }
        ] } }
      ] }
    }""".trimIndent()

    /** A names artifact is the ONE file allowed to spell a physical name literally. */
    private fun isNamesArtifact(path: Path): Boolean = path.fileName.toString().endsWith("Names.kt")

    /**
     * Run every NATIVE generator the registry knows, exactly as a full `metaobjects:generate`
     * suite would, and return every emitted file. Registry-driven rather than a hand-listed
     * suite: a generator added later is gated the day it is registered, not the day someone
     * remembers to add it here.
     */
    private fun generate(): Map<Path, String> {
        val outDir = Files.createTempDirectory("no-magic-")
        val templateRoot = Files.createTempDirectory("no-magic-tpl-")
        try {
            val loader = loadString("test", model)
            // `templateRoot` (render-helper) and `packageName` (validator, spring-config)
            // are required by a few generators and ignored by the rest; supplying both keeps
            // the whole registry runnable rather than making the suite a hand-picked subset
            // — a subset is how a generator escapes the gate.
            val args = mapOf(
                "outputDir" to outDir.toString(),
                "templateRoot" to templateRoot.toString(),
                "packageName" to "acme.gen",
            )
            // Build the whole suite BEFORE configuring any of it, then derive `useNames`
            // from the suite through the SHIPPED helper — the identical call the Maven
            // mojo makes in AbstractMetaDataMojo.buildGenerators. Re-implementing the
            // derivation here would leave the gate measuring the test's own logic.
            val suite = list().filter { it.tier == GeneratorTier.NATIVE }.map { it.factory() }
            val runArgs = EmitsPhysicalNameConstants.deriveUseNames(args, suite)
            for (generator in suite) {
                generator.apply { setArgs(runArgs) }.execute(loader)
            }
            return Files.walk(outDir).toList()
                .filter { Files.isRegularFile(it) }
                .associate { outDir.relativize(it) to it.readText() }
        } finally {
            outDir.toFile().deleteRecursively()
            templateRoot.toFile().deleteRecursively()
        }
    }

    @Test
    fun `emits a names artifact carrying every de-blinded physical name`() {
        val tree = generate()
        val names = tree.filterKeys { isNamesArtifact(it) }
        // Teeth: with no names artifact at all every assertion below passes vacuously.
        assertTrue(names.isNotEmpty(), "no *Names.kt emitted — every assertion below would be vacuous")
        val all = names.values.joinToString("\n")
        val missing = tokens.filter { it.reach == Reach.CONSTANT && it.literal !in all }
            .map { "${it.literal} appears in no names artifact — ${it.shouldUse} cannot exist" }
            .sorted()
        assertTrue(missing.isEmpty(), missing.joinToString("\n"))
    }

    @Test
    fun `references the constant everywhere else - no generated file spells one literally`() {
        val offenders = generate()
            .filterKeys { !isNamesArtifact(it) }
            .flatMap { (path, content) ->
                tokens.filter { it.reach == Reach.CONSTANT && it.literal in content }
                    .map { """$path: hard-codes "${it.literal}" — should reference ${it.shouldUse}""" }
            }
            .sorted()
        // Reported as a sorted list rather than a boolean, so a failure enumerates every
        // remaining gap in one run instead of one per fix-and-rerun cycle.
        assertTrue(offenders.isEmpty(), offenders.joinToString("\n"))
    }

    @Test
    fun `actually references each constant - absence of the literal is not use of the constant`() {
        // The teeth for the test above. "No file contains the literal" is satisfied just as
        // well by a generator that emits NOTHING, or by one that emits a name it derived
        // instead of read. This asserts the positive.
        val body = generate().filterKeys { !isNamesArtifact(it) }.values.joinToString("\n")
        val unreferenced = tokens.filter { it.reach == Reach.CONSTANT && it.shouldUse !in body }
            .map { """${it.shouldUse} (for "${it.literal}") is referenced by no generated file""" }
            .sorted()
        assertTrue(unreferenced.isEmpty(), unreferenced.joinToString("\n"))
    }

    @Test
    fun `lets no physical name escape that is not a declared known literal`() {
        // The exhaustive form, and the strongest statement this gate can make. [tokens] says
        // what each KNOWN name should do; this says there is nothing ELSE. Every physical name
        // in the fixture is `zz_phys_`-prefixed, so any such token appearing outside a names
        // artifact is a physical name that escaped, whether or not anyone thought to list it.
        //
        // Equality in BOTH directions. A new escape fails — including one from a generator
        // added after this test was written, which a hand-maintained list would miss. And so
        // does a KNOWN_LITERAL quietly fixed: a "known gaps" list nothing re-checks is how a
        // ledger ends up describing a codebase that moved on.
        val escaped = generate()
            .filterKeys { !isNamesArtifact(it) }
            .values
            .flatMap { Regex("""zz_phys_\w+""").findAll(it).map { m -> m.value } }
            .toSortedSet()
        val declared = tokens.filter { it.reach == Reach.KNOWN_LITERAL }.map { it.literal }.toSortedSet()
        assertEquals(declared, escaped)
    }
}

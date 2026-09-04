package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Task 6 — [KotlinExposedTableGenerator]'s Exposed table binding references
 * `<Entity>Names.NAME` / `<Entity>Names.<FIELD>_COLUMN` instead of respelling the
 * physical table/column names as string literals, gated on the `useNames` generator arg
 * (see [KotlinGenUtil.ARG_USE_NAMES]).
 *
 * These two tests pin the ARG's two arms directly, constructing the generator by hand: a
 * caller that never goes through a runner still gets literals by default, because a
 * reference to a type nothing generated does not compile. What DECIDES the arg in a real
 * build is the Maven mojo, which derives it from the run's generator set via
 * `EmitsPhysicalNameConstants` — so a full suite gets the constants with no project
 * configuration. That derivation is pinned by `UseNamesDerivationTest` in maven-plugin,
 * and the end-to-end claim ("no generated file spells a physical name literally") by
 * [NoMagicPhysicalNamesTest].
 *
 * See [KotlinExposedTableSourceSelectionTest] for R27 — the prerequisite fix to WHICH
 * source the table generator names, independent of this substitution.
 */
class KotlinExposedTableNamesTest {

    // callPurpose deliberately carries an explicit @column that is NOT the snake_case
    // of its own name -- the discriminator between "reads the resolved column" and
    // "re-derives it", same rationale as KotlinNamesGeneratorTest's identical fixture.
    private val authorModel = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "callPurpose", "@maxLength": 40, "@column": "purpose_code" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    /** Runs KotlinNamesGenerator (unconditional) + KotlinExposedTableGenerator (given
     *  args) over [authorModel] into a shared outDir, returning the emitted
     *  AuthorTable.kt text. */
    private fun authorTableSrc(tableArgs: Map<String, String> = emptyMap()): String {
        val outDir = Files.createTempDirectory("ktbl-names-")
        try {
            val loader = loadString("test", authorModel)
            KotlinNamesGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinExposedTableGenerator()
                .apply { setArgs(tableArgs + mapOf("outputDir" to outDir.toString())) }
                .execute(loader)
            return outDir.resolve("acme/demo/AuthorTable.kt").readText()
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `the table binding references the name constants when names is enabled`() {
        val src = authorTableSrc(mapOf("useNames" to "true"))
        assertTrue("object AuthorTable : Table(AuthorNames.NAME)" in src, src)
        assertTrue("varchar(AuthorNames.CALL_PURPOSE_COLUMN, 40)" in src, src)
        // The literal the strategy WOULD have produced, and the table literal itself,
        // must be GONE -- a positive assertion alone would still pass a generator that
        // emitted BOTH the constant reference and the old literal.
        assertFalse("Table(\"authors\")" in src, src)
        assertFalse("\"purpose_code\"" in src, src)
    }

    @Test fun `the table binding keeps its literals by default`() {
        // A caller constructing the generator directly, with no runner to derive the arg
        // from the suite: the table generator must still compile without the names
        // generator, so OFF is the default and the output stays byte-identical.
        val src = authorTableSrc()
        assertTrue("Table(\"authors\")" in src, src)
        assertTrue("varchar(\"purpose_code\", 40)" in src, src)
        assertFalse("AuthorNames" in src, src)
    }

    // Fix 1 (Task 6 follow-up) -- an entity's OWN field.enum column previously kept its
    // literal even with useNames=true: enumColumnSpec was a separate code path, never
    // routed through emit()'s columnExprFor. `status` (enum) sits beside `reference`
    // (plain string) so one emitted file proves BOTH sites substitute the same way.
    private val ticketModel = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Ticket", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "reference", "@maxLength": 40 } },
            { "field.enum":   { "name": "status", "@values": ["Open", "Closed"] } },
            { "source.rdb":   { "@table": "tickets" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    /** Same shape as [authorTableSrc], over [ticketModel] -- returns the emitted
     *  TicketTable.kt text. */
    private fun ticketTableSrc(tableArgs: Map<String, String> = emptyMap()): String {
        val outDir = Files.createTempDirectory("ktbl-names-enum-")
        try {
            val loader = loadString("test", ticketModel)
            KotlinNamesGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinExposedTableGenerator()
                .apply { setArgs(tableArgs + mapOf("outputDir" to outDir.toString())) }
                .execute(loader)
            return outDir.resolve("acme/demo/TicketTable.kt").readText()
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `an own field-enum column references the name constant when names is enabled`() {
        val src = ticketTableSrc(mapOf("useNames" to "true"))
        // The non-enum sibling substitutes too (covered on its own by the Author tests
        // above) -- asserted here so a fix that only patched the enum branch, and broke
        // the plain-column branch it sits beside, can't pass this test either.
        assertTrue("varchar(TicketNames.REFERENCE_COLUMN, 40)" in src, src)
        assertTrue("enumerationByName(TicketNames.STATUS_COLUMN, 64, TicketStatus::class)" in src, src)
        // The literal the strategy WOULD have produced must be GONE -- a positive
        // assertion alone would still pass a generator emitting BOTH the constant
        // reference and the old literal side by side.
        assertFalse("enumerationByName(\"status\"" in src, src)
    }

    @Test fun `an own field-enum column keeps its literal by default`() {
        val src = ticketTableSrc()
        assertTrue("enumerationByName(\"status\", 64, TicketStatus::class)" in src, src)
        assertTrue("varchar(\"reference\", 40)" in src, src)
        assertFalse("TicketNames" in src, src)
    }

    // -----------------------------------------------------------------------------------
    // The TPH fold. A discriminator base's single table absorbs every concrete subtype's
    // own columns — the ONE shape where this generator emits a column belonging to a
    // DIFFERENT entity than the one whose names artifact it has in hand. The fold used to
    // build a literal for every such column under a comment declaring the substitution
    // "does not reach this loop"; the rule is now THIS entity's artifact first, the
    // DECLARING entity's on a miss, and the model below is built to hit every arm of it:
    //
    //  - `Vehicle.id` / `Vehicle.kind`: the base's own fields → VehicleNames (a hit).
    //  - `Car.doors`: declared on a concrete subtype in the SAME package → CarNames.
    //  - `Truck.payload`: declared on a concrete subtype in ANOTHER package → the reference
    //    must be package-qualified, or the hand-rolled table body does not resolve.
    //  - `Wheeled.wheels`: declared on an ABSTRACT intermediate between the base and Car.
    //    Its declaring object emits no table, but it inherits the base's source and so
    //    carries a names artifact of its own (WheeledNames) — the reference goes there,
    //    not to CarNames' re-export of it, and must resolve.
    //  - `kind` is a field.enum on the base and `doors` folds through the enum-free arm,
    //    while `grade` folds through the enum arm, so BOTH fold branches are asserted.
    //
    // Every column carries an explicit @column that is NOT the snake_case of its name — the
    // same de-blinding as the rest of this file — so a generator that re-derived the name
    // instead of reading it cannot pass by coincidence.
    // -----------------------------------------------------------------------------------
    private val tphModel = """{
      "metadata.root": { "package": "acme::fleet", "children": [
        { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
            { "source.rdb":   { "@table": "phys_vehicles" } },
            { "field.long":   { "name": "id",   "@column": "phys_vid" } },
            { "field.enum":   { "name": "kind", "@column": "phys_kind", "@values": ["Car", "Truck"] } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Wheeled", "abstract": true, "extends": "Vehicle", "children": [
            { "field.int": { "name": "wheels", "@column": "phys_wheels" } }
        ] } },
        { "object.entity": { "name": "Car", "extends": "Wheeled", "@discriminatorValue": "Car", "children": [
            { "field.int":  { "name": "doors", "@column": "phys_doors" } },
            { "field.enum": { "name": "grade", "@column": "phys_grade", "@values": ["LO", "HI"] } }
        ] } }
      ] }
    }""".trimIndent()

    /** A second file in ANOTHER package, contributing a subtype of `acme::fleet::Vehicle`. */
    private val truckModel = """{
      "metadata.root": { "package": "acme::haulage", "children": [
        { "object.entity": { "name": "Truck", "extends": "acme::fleet::Vehicle", "@discriminatorValue": "Truck", "children": [
            { "field.int": { "name": "payload", "@column": "phys_payload" } }
        ] } }
      ] }
    }""".trimIndent()

    /** Runs the names generator + the table generator (given args) over BOTH TPH files into
     *  one outDir, returning the emitted base VehicleTable.kt text. */
    private fun vehicleTableSrc(tableArgs: Map<String, String> = emptyMap()): String {
        val outDir = Files.createTempDirectory("ktbl-names-tph-")
        try {
            val loader = com.metaobjects.loader.MetaDataLoader.createManual(false, "tph-names").apply {
                init()
                load(listOf(
                    com.metaobjects.loader.InMemoryStringSource(tphModel, "fleet.json",
                        com.metaobjects.loader.MetaDataSource.MetaDataFormat.JSON),
                    com.metaobjects.loader.InMemoryStringSource(truckModel, "haulage.json",
                        com.metaobjects.loader.MetaDataSource.MetaDataFormat.JSON),
                ))
                register()
            }
            KotlinNamesGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinExposedTableGenerator()
                .apply { setArgs(tableArgs + mapOf("outputDir" to outDir.toString())) }
                .execute(loader)
            // The subtypes fold — no VehicleTable sibling may exist for them.
            assertFalse(Files.exists(outDir.resolve("acme/fleet/CarTable.kt")))
            assertFalse(Files.exists(outDir.resolve("acme/haulage/TruckTable.kt")))
            return outDir.resolve("acme/fleet/VehicleTable.kt").readText()
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `the TPH fold references each folded column on its DECLARING entity's names object`() {
        val src = vehicleTableSrc(mapOf("useNames" to "true"))
        // The base's own columns: this entity's artifact (a hit — never redirected).
        assertTrue("object VehicleTable : Table(VehicleNames.NAME)" in src, src)
        assertTrue("long(VehicleNames.ID_COLUMN)" in src, src)
        assertTrue("enumerationByName(VehicleNames.KIND_COLUMN, 64, VehicleKind::class)" in src, src)
        // A same-package concrete subtype's column, through the enum-free fold arm...
        assertTrue("integer(CarNames.DOORS_COLUMN).nullable()" in src, src)
        // ...and through the enum arm.
        assertTrue("enumerationByName(CarNames.GRADE_COLUMN, 64, VehicleGrade::class).nullable()" in src, src)
        // A cross-package subtype's column: the reference is package-qualified.
        assertTrue("integer(acme.haulage.TruckNames.PAYLOAD_COLUMN).nullable()" in src, src)
        // A column declared on an ABSTRACT intermediate resolves to that object's fragment.
        assertTrue("integer(WheeledNames.WHEELS_COLUMN).nullable()" in src, src)
        // The literals must be GONE — a positive assertion alone would still pass a
        // generator emitting the reference and the old literal side by side.
        for (literal in listOf("phys_vehicles", "phys_vid", "phys_kind", "phys_doors", "phys_grade", "phys_payload", "phys_wheels")) {
            assertFalse("\"$literal\"" in src, "literal \"$literal\" still spelled in:\n$src")
        }
    }

    @Test fun `the TPH fold keeps its literals by default`() {
        // Names OFF: the fold's output is byte-for-byte what it was before the redirect
        // existed — every existing TPH snapshot and compile gate runs on this arm.
        val src = vehicleTableSrc()
        assertTrue("object VehicleTable : Table(\"phys_vehicles\")" in src, src)
        assertTrue("integer(\"phys_doors\").nullable()" in src, src)
        assertTrue("enumerationByName(\"phys_grade\", 64, VehicleGrade::class).nullable()" in src, src)
        assertTrue("integer(\"phys_payload\").nullable()" in src, src)
        assertTrue("integer(\"phys_wheels\").nullable()" in src, src)
        assertFalse("Names" in src, src)
    }

    // -----------------------------------------------------------------------------------
    // Write-through (#214). One entity, TWO Exposed objects from two DIFFERENT own sources.
    // <Entity>Names.NAME names the role=primary source — the writable table — so the WRITE
    // object references it, while the replica view has no slot in the artifact and keeps
    // its literal on purpose. The gate used to be `objectNameOverride == null`, which both
    // calls fail, so the write table spelled its name literally beside columns that already
    // referenced the constant.
    // -----------------------------------------------------------------------------------
    private val accountModel = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Account", "children": [
            { "source.rdb": { "@table": "phys_accounts", "@role": "primary" } },
            { "source.rdb": { "@kind": "view", "@view": "phys_v_accounts", "@role": "replica" } },
            { "field.long": { "name": "id", "@column": "phys_acct_id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun accountSrcs(tableArgs: Map<String, String> = emptyMap()): Pair<String, String> {
        val outDir = Files.createTempDirectory("ktbl-names-wt-")
        try {
            val loader = loadString("test", accountModel)
            KotlinNamesGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinExposedTableGenerator()
                .apply { setArgs(tableArgs + mapOf("outputDir" to outDir.toString())) }
                .execute(loader)
            return outDir.resolve("acme/demo/AccountTable.kt").readText() to
                outDir.resolve("acme/demo/AccountView.kt").readText()
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `a write-through entity's WRITE table references the name constant, its replica view keeps the literal`() {
        val (table, view) = accountSrcs(mapOf("useNames" to "true"))
        assertTrue("object AccountTable : Table(AccountNames.NAME)" in table, table)
        assertFalse("\"phys_accounts\"" in table, table)
        // The replica view: a different physical name, no slot in the artifact — literal,
        // deliberately. Its COLUMNS still reference the constant (a column name does not
        // depend on which source is being emitted).
        assertTrue("object AccountView : Table(\"phys_v_accounts\")" in view, view)
        assertFalse("AccountNames.NAME" in view, view)
        assertTrue("long(AccountNames.ID_COLUMN)" in table, table)
        assertTrue("long(AccountNames.ID_COLUMN)" in view, view)
    }

    @Test fun `a write-through entity keeps both literals by default`() {
        val (table, view) = accountSrcs()
        assertTrue("object AccountTable : Table(\"phys_accounts\")" in table, table)
        assertTrue("object AccountView : Table(\"phys_v_accounts\")" in view, view)
        assertFalse("AccountNames" in table, table)
        assertFalse("AccountNames" in view, view)
    }
}

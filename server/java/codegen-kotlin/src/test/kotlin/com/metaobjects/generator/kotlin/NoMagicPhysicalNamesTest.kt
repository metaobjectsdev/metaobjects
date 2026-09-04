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
 * WHAT THE FIXTURE MUST CONTAIN is the other half, and the half that failed first. This
 * gate ran green for its whole life over a fixture with no TPH pair, no `field.enum`, no
 * `identity.secondary`, no `index.lookup`, no callable source, no `@schema`, no `@isArray`,
 * no abstract base, no projection and no write-through entity. Every one of those shapes
 * is handled on its own code path in [KotlinExposedTableGenerator] or
 * [KotlinStoredProcGenerator] — the TPH fold, the enum column spec, the index `init`
 * block, the stored-proc wrapper — so the green meant "the paths we happened to model are
 * clean", a much smaller claim than the one the gate's name makes. Adding them found three
 * escapes and two silently-dropped names on the first run — one of each on a shape the
 * fixture had never contained (the write-through table, the callable's result column). A
 * gate is only ever as wide as its fixture, so treat the model below as the load-bearing
 * part of this file and add to it whenever a generator grows a new path.
 *
 * Every token carries its REACH — see [Reach]. Every non-[Reach.CONSTANT] value is PINNED,
 * not exempted: the gate asserts the condition it names is still true, so the day a
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

    /**
     * How a physical name reaches generated output today.
     *
     * The three non-[CONSTANT] values are kept APART because they are not the same claim,
     * and collapsing them is how a defect acquires the standing of a ruling. A
     * [KNOWN_LITERAL] is STRUCTURAL — there is no constant to reference, and none should be
     * expected. An [ESCAPE] is a DEFECT — the constant exists, in an artifact this very run
     * emits, and a generator spelled the name again anyway; every such row is additionally
     * required to have a REACHABLE constant (see the reachability test), so no row can sit
     * here claiming a fix is impossible when it is merely undone.
     *
     * [DROPPED] is the third failure mode and the one this gate was BLIND to until the
     * fixture grew a shape that has one. An escape spells a name twice; a dropped name is
     * spelled ZERO times — the artifact carries it, no generator reads it, and the binding
     * silently takes a default instead. Every "does any file contain this literal"
     * assertion passes for it, which is why the REFERENCE test is the load-bearing one and
     * why a dropped name needs a row that pins its absence rather than merely tolerating it.
     */
    private enum class Reach {
        /** Travels as an `<Entity>Names` reference, and appears literally nowhere else. */
        CONSTANT,

        /** STRUCTURAL: no constant exists, and none should be expected. Pinned, not exempted. */
        KNOWN_LITERAL,

        /** A DEFECT: the constant exists in an artifact this run emits, and a generator spelled the name again. */
        ESCAPE,

        /** Carried by the artifact, read by no generator — the binding silently takes a default. Spelled zero times. */
        DROPPED,
    }

    private data class Token(
        val literal: String,
        val shouldUse: String,
        val reach: Reach = Reach.CONSTANT,
        val why: String = "",
    )

    // -----------------------------------------------------------------------
    // The de-blinded fixture, kept in step with the TypeScript, C# and Java gates so a
    // reader can diff the ports' coverage directly.
    // -----------------------------------------------------------------------
    private val table = "zz_phys_tbl_alpha"      // NOT pluralize(snake("Customer"))
    private val colId = "zz_phys_col_ident"      // NOT snake("id")
    private val colEmail = "zz_phys_col_mail"    // NOT snake("email")
    private val colFk = "zz_phys_col_owner"      // NOT snake("customerId")
    private val orderTable = "zz_phys_tbl_beta"  // NOT pluralize(snake("Order"))
    private val orderId = "zz_phys_col_okey"
    private val view = "zz_phys_view_gamma"      // NOT "v_" + snake("CustomerSummary")
    private val voCol = "zz_phys_col_street"
    private val jsonbCol = "zz_phys_col_blob"    // a single-jsonb-column value object
    // Deliberately NOT tracked on its own: under @storage: flattened the field's "column"
    // is not a column at all, only the prefix each member column is built from.
    private val flatPrefix = "zz_phys_col_pfx"
    private val voMemberCol = "zz_phys_col_road"
    // What the flattened branch actually emits: parent column + "_" + member column.
    private val flatCol = flatPrefix + "_" + voMemberCol
    private val wtTable = "zz_phys_tbl_delta"    // a write-through entity's table...
    private val wtView = "zz_phys_view_delta"    // ...and its replica view
    private val wtId = "zz_phys_col_acct"        // the write-through entity's key column

    // --- Shapes the original fixture did not contain -----------------------------------
    // Each block below exists because a generator handles it on a DIFFERENT code path from
    // the plain-entity one above, and a path no fixture reaches is a path this gate cannot
    // speak for.
    private val widgetTable = "zz_phys_tbl_wid"  // the index/enum/schema entity's table
    private val tphTable = "zz_phys_tbl_veh"     // a TPH discriminator base's table
    private val tphId = "zz_phys_col_vid"
    // The discriminator column. Declared as a field.ENUM in the model below where the TS and
    // Java fixtures use a field.string: KotlinSpringControllerGenerator.emitTph REQUIRES an
    // enum discriminator (it scopes/injects `<Enum>.<Value>`) and throws "discriminator field
    // 'kind' is not an enum" otherwise, while the Java lane uses string literals and has no
    // such constraint. A port divergence, recorded here rather than papered over — a string
    // discriminator is a shape this port cannot generate at all.
    private val tphDisc = "zz_phys_col_kind"
    private val tphSubCol = "zz_phys_col_doors"  // a SUBTYPE's own column, folded into the base table
    private val schema = "zz_phys_sch_one"       // @schema on a source.rdb
    private val enumCol = "zz_phys_col_stat"     // a string-backed field.enum
    private val enumIntCol = "zz_phys_col_grad"  // an int-backed field.enum (@intValueMap)
    private val arrayCol = "zz_phys_col_tags"    // an @isArray field
    private val altCol = "zz_phys_col_alt"       // the column an identity.secondary keys on
    private val secIndex = "zz_phys_idx_sec"     // an identity.secondary's own name
    private val lkpIndex = "zz_phys_idx_lkp"     // an index.lookup's own name
    private val absCol = "zz_phys_col_bid"       // a column declared on an ABSTRACT base
    private val proc = "zz_phys_proc_alpha"      // a storedProc source's physical name
    private val procArgCol = "zz_phys_col_since"
    private val procOutCol = "zz_phys_col_total"

    /**
     * Every de-blinded token, with the constant a generator should have referenced. Kotlin
     * member names are SCREAMING_SNAKE — [KotlinNaming.namesMember] is
     * `camelToSnake(field).uppercase()` + `_COLUMN`, so `customerId` becomes
     * `CUSTOMER_ID_COLUMN` — derived from what the artifact ACTUALLY emits, not from another
     * port's spelling (C# Pascal-cases the first character only, so a member collision that
     * fires on the JVM does not fire there and vice versa).
     */
    private val tokens = listOf(
        Token(table, "CustomerNames.NAME"),
        Token(colId, "CustomerNames.ID_COLUMN"),
        Token(colEmail, "CustomerNames.EMAIL_COLUMN"),
        Token(voCol, "CustomerNames.STREET_COLUMN"),
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
        Token(view, "CustomerSummaryNames.NAME"),
        // The write-through entity's WRITE table. Its physical name IS the role=primary source
        // that AccountNames.NAME resolves from, so the write call references the constant;
        // only the replica view below has no slot.
        Token(wtTable, "AccountNames.NAME"),
        Token(wtId, "AccountNames.ID_COLUMN"),
        Token(
            wtView, "(no constant exists)", Reach.KNOWN_LITERAL,
            "A write-through entity has TWO physical names; <Entity>Names carries the PRIMARY " +
                "source's only (resolveObjectNames), which for an object.entity must be the WRITABLE " +
                "one. The replica view name has no slot in the artifact, so emitWriteThrough's read " +
                "view keeps the literal on purpose — the one call the objectNameOverride scope was " +
                "written for.",
        ),

        // --- TPH: a discriminator base folds its subtypes' own columns into one table ------
        Token(tphTable, "VehicleNames.NAME"),
        Token(tphId, "VehicleNames.ID_COLUMN"),
        Token(tphDisc, "VehicleNames.KIND_COLUMN"),
        // A subtype's own column is folded into the BASE's table, and the base's artifact
        // does not carry it — the SUBTYPE's does. The fold resolves the declaring entity's
        // artifact on that miss (this entity's first, so the abstract-base row below stays
        // on WidgetNames, never redirected to a fragment).
        Token(tphSubCol, "CarNames.DOORS_COLUMN"),

        // --- the enum / index / schema / abstract-base entity ------------------------------
        Token(widgetTable, "WidgetNames.NAME"),
        Token(enumCol, "WidgetNames.STATUS_COLUMN"),
        Token(enumIntCol, "WidgetNames.GRADE_COLUMN"),
        Token(arrayCol, "WidgetNames.TAGS_COLUMN"),
        Token(altCol, "WidgetNames.ALT_COLUMN"),
        // Declared on the abstract base's FRAGMENT object (AbstractKeyedNames) and re-exported
        // by REFERENCE on WidgetNames (Kotlin has no static inheritance) — the table binding
        // references WidgetNames.ID_COLUMN, so that is the reference the body must carry.
        Token(absCol, "WidgetNames.ID_COLUMN"),
        Token(
            schema, "WidgetNames.SCHEMA", Reach.DROPPED,
            "`@schema` reaches the names artifact (KotlinGenUtil.resolveObjectNames carries " +
                "source.schema) and NO generator anywhere reads it: KotlinExposedTableGenerator " +
                "emits `Table(<Entity>Names.NAME)` with no schema, so the table lands in the " +
                "connection's default schema. TS's postgres binding and C#'s Table() do the same. " +
                "This is a BEHAVIOUR bug that happens to show up here, not a naming nit — and it " +
                "is pinned rather than merely absent so that wiring @schema fails this row and " +
                "says 'promote it' instead of passing unnoticed.",
        ),

        // --- the callable (stored procedure) ----------------------------------------------
        // The wrapper's `PROC_NAME` is initialised FROM the constant, so the ONE resolver
        // (RdbSource.getPhysicalName, FR-016) decides the procedure name in both artifacts.
        Token(proc, "ProcOutNames.NAME"),
        // The result-row loop reads each column by its PHYSICAL name through the constant —
        // previously by FIELD name, which asked the result set for a column the procedure
        // never returns (a runtime failure, not a naming nit). KotlinExposedTableGenerator
        // skips storedProc sources, so the wrapper is the one consumer of this constant.
        Token(procOutCol, "ProcOutNames.TOTAL_COLUMN"),

        // --- index names: a category with no slot in the artifact -------------------------
        Token(
            secIndex, "(no constant exists)", Reach.KNOWN_LITERAL,
            "An index's database name IS its metamodel `name` — an identity.secondary and an " +
                "index.lookup have no `@column`-style physical spelling to diverge from, so there " +
                "is nothing here for a generator to RESTATE. KotlinObjectNames carries " +
                "kind/name/schema/fields and no index slot; the Exposed `init { uniqueIndex(\"…\") }` " +
                "spells the metamodel name. Pinned so that the day the artifact grows an index " +
                "slot, this row fails and says 'promote it'.",
        ),
        Token(
            lkpIndex, "(no constant exists)", Reach.KNOWN_LITERAL,
            "As secIndex — an index.lookup's database name is its metamodel `name` " +
                "(`init { index(\"…\", false, …) }`).",
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
            { "field.string": { "name": "street", "@column": "$voCol" } },
            { "field.object": { "name": "address", "@column": "$flatPrefix",
                                "@objectRef": "Address", "@storage": "flattened" } },
            { "field.object": { "name": "profile", "@column": "$jsonbCol",
                                "@objectRef": "Address", "@storage": "jsonb" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.projection": { "name": "CustomerSummary", "children": [
            { "source.rdb":   { "@kind": "view", "@view": "$view" } },
            { "field.long":   { "name": "id",    "extends": "Customer.id" } },
            { "field.string": { "name": "email", "children": [
                { "origin.passthrough": { "@from": "Customer.email" } } ] } },
            { "identity.primary": { "name": "pk", "extends": "Customer.pk" } }
        ] } },
        { "object.entity": { "name": "Order", "children": [
            { "source.rdb":   { "@table": "$orderTable" } },
            { "field.long":   { "name": "id",         "@column": "$orderId" } },
            { "field.long":   { "name": "customerId", "@column": "$colFk" } },
            { "identity.primary":   { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.reference": { "name": "customerRef", "@fields": ["customerId"], "@references": "Customer" } },
            { "relationship.association": { "name": "customer", "@cardinality": "one", "@objectRef": "Customer" } }
        ] } },
        { "object.entity": { "name": "AbstractKeyed", "abstract": true, "children": [
            { "field.long": { "name": "id", "@column": "$absCol" } }
        ] } },
        { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
            { "source.rdb":   { "@table": "$tphTable" } },
            { "field.long":   { "name": "id",   "@column": "$tphId" } },
            { "field.enum":   { "name": "kind", "@column": "$tphDisc", "@values": ["Car"] } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Car", "extends": "Vehicle", "@discriminatorValue": "Car", "children": [
            { "field.int": { "name": "doors", "@column": "$tphSubCol" } }
        ] } },
        { "object.entity": { "name": "Widget", "extends": "AbstractKeyed", "children": [
            { "source.rdb":   { "@table": "$widgetTable", "@schema": "$schema" } },
            { "field.enum":   { "name": "status", "@column": "$enumCol", "@values": ["OPEN", "SHUT"] } },
            { "field.enum":   { "name": "grade",  "@column": "$enumIntCol", "@values": ["LO", "HI"],
                                "@intValueMap": { "LO": 1, "HI": 2 } } },
            { "field.string": { "name": "tags", "isArray": true, "@column": "$arrayCol" } },
            { "field.string": { "name": "alt", "@column": "$altCol" } },
            { "identity.primary":   { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.secondary": { "name": "$secIndex", "@fields": ["alt"] } },
            { "index.lookup":       { "name": "$lkpIndex", "@fields": ["status"] } }
        ] } },
        { "object.value": { "name": "ProcArgs", "children": [
            { "field.long": { "name": "since", "@column": "$procArgCol" } }
        ] } },
        { "object.projection": { "name": "ProcOut", "children": [
            { "source.rdb": { "@kind": "storedProc", "@proc": "$proc", "@parameterRef": "ProcArgs" } },
            { "field.long": { "name": "total", "@column": "$procOutCol" } }
        ] } },
        { "object.entity": { "name": "Account", "children": [
            { "source.rdb": { "@table": "$wtTable", "@role": "primary" } },
            { "source.rdb": { "@kind": "view", "@view": "$wtView", "@role": "replica" } },
            { "field.long": { "name": "id", "@column": "$wtId" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
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
            // A gate whose fixture the loader would reject proves nothing. loadString throws
            // on most defects; this catches the ones a phase records instead of throwing.
            assertEquals(emptyList(), loader.errors, "the no-magic fixture must load clean")
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

    private fun namesBody(tree: Map<Path, String>): String =
        tree.filterKeys { isNamesArtifact(it) }.values.joinToString("\n")

    private fun consumerBody(tree: Map<Path, String>): String =
        tree.filterKeys { !isNamesArtifact(it) }.values.joinToString("\n")

    @Test
    fun `emits a names artifact carrying every de-blinded physical name`() {
        val tree = generate()
        val names = tree.filterKeys { isNamesArtifact(it) }
        // Teeth: with no names artifact at all every assertion below passes vacuously.
        assertTrue(names.isNotEmpty(), "no *Names.kt emitted — every assertion below would be vacuous")
        val all = names.values.joinToString("\n")
        val missing = tokens.filter { it.reach != Reach.KNOWN_LITERAL && it.literal !in all }
            .map { "${it.literal} appears in no names artifact — ${it.shouldUse} cannot exist" }
            .sorted()
        assertTrue(missing.isEmpty(), missing.joinToString("\n"))
    }

    @Test
    fun `references the constant everywhere else - no generated file spells one literally`() {
        // A declared escape can CONTAIN a constant's literal as a substring (the flattened
        // composite wraps the value object's member column), so the declared literals are
        // masked first — longest FIRST, so a composite is dismantled before the shorter name
        // it wraps could be reported as a standalone hit it is not. Each defect is then
        // reported against exactly one row.
        val declared = tokens.filter { it.reach == Reach.ESCAPE || it.reach == Reach.KNOWN_LITERAL }
            .map { it.literal }
            .sortedByDescending { it.length }
        val offenders = generate()
            .filterKeys { !isNamesArtifact(it) }
            .flatMap { (path, content) ->
                val body = declared.fold(content) { acc, lit -> acc.replace(lit, "") }
                tokens.filter { it.reach == Reach.CONSTANT && it.literal in body }
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
        // instead of read. This asserts the positive: for every de-blinded name, some
        // generated file that is not the names artifact carries the constant REFERENCE.
        val body = consumerBody(generate())
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
        // does a KNOWN_LITERAL or ESCAPE quietly fixed: a "known gaps" list nothing re-checks
        // is how a ledger ends up describing a codebase that moved on.
        val escaped = generate()
            .filterKeys { !isNamesArtifact(it) }
            .values
            .flatMap { Regex("""zz_phys_\w+""").findAll(it).map { m -> m.value } }
            .toSortedSet()
        val declared = tokens.filter { it.reach == Reach.KNOWN_LITERAL || it.reach == Reach.ESCAPE }
            .map { it.literal }.toSortedSet()
        assertEquals(declared, escaped)
    }

    @Test
    fun `proves every escape is a defect and not a structural impossibility`() {
        // The row type lets an author write ESCAPE with a shouldUse naming a constant that
        // does not exist — which would read as "we know about it" while being unfixable, the
        // most comfortable possible state for a defect to sit in. So: for every escape, the
        // constant it should have used must be REACHABLE — its owning names artifact emitted,
        // by this same run, carrying the literal. That turns each row into a claim that can be
        // acted on today, and it is what separates these rows from the KNOWN_LITERAL ones.
        val names = namesBody(generate())
        val unreachable = tokens.filter { it.reach == Reach.ESCAPE && it.literal !in names }
            .map { "${it.literal} is marked an escape but ${it.shouldUse} is in no names artifact" }
            .sorted()
        assertTrue(unreachable.isEmpty(), unreachable.joinToString("\n"))
    }

    @Test
    fun `pins each dropped name as carried-but-unread, so wiring it up fails this row`() {
        // The counterpart to the reference test, for the failure mode that test cannot state.
        // A DROPPED row asserts BOTH halves of its own claim: the artifact carries the name
        // (so a consumer could read it) and no generated file references the constant (so none
        // does). Asserting the second half is the point — it is a pin on a DEFECT, and the day
        // a generator starts honouring the name this row fails and demands promotion to
        // CONSTANT, rather than the fix landing with nothing to notice it.
        val tree = generate()
        val names = namesBody(tree)
        val body = consumerBody(tree)
        val wrong = tokens.filter { it.reach == Reach.DROPPED }.flatMap { t ->
            listOfNotNull(
                if (t.literal !in names) "${t.literal} is marked dropped but no names artifact carries it" else null,
                if (t.shouldUse in body) "${t.shouldUse} IS referenced now — promote \"${t.literal}\" to CONSTANT" else null,
            )
        }.sorted()
        assertTrue(wrong.isEmpty(), wrong.joinToString("\n"))
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.ErrorCode
import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource.MetaDataFormat
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinStoredProcGeneratorTest {

    @Test fun storedProcEntityEmitsCallFnFile() {
        // Entity has 2 result-row fields (id, label) and NO @param fields → emits
        // a no-arg `call(): List<MyProc>` function (not the documented stub).
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "MyProc", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "label", "@required": true } },
                { "source.rdb":   { "@kind": "storedProc", "@proc": "get_data" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-explicit-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-explicit", fixture))

            val emitted = outDir.resolve("acme/demo/MyProcProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // Package + imports wired.
            assertTrue("package acme.demo" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.Transaction" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.transactions.transaction" in src, src)
            // Object + PROC_NAME.
            assertTrue("object MyProcProc {" in src, src)
            assertTrue("const val PROC_NAME = \"get_data\"" in src, src)
            // Real no-arg call function returning the data class.
            assertTrue("fun call(): List<MyProc>" in src, src)
            // Empty-parens SQL (no params).
            assertTrue("SELECT * FROM \${PROC_NAME}()" in src, src)
            // Result-row mapping.
            assertTrue("rs.getLong(\"id\")" in src, src)
            assertTrue("rs.getString(\"label\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun procNameDefaultsToTableAttr() {
        // FR-016 step 2: the legacy @table spelling on a non-table kind still resolves.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "MyProc", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@kind": "storedProc", "@table": "get_orders" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-table-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-table", fixture))

            val emitted = outDir.resolve("acme/demo/MyProcProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("const val PROC_NAME = \"get_orders\"" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun procNameFallsBackToTheCanonicalRule() {
        // A storedProc source declaring no name resolves through FR-016 step 4 —
        // pluralize(snake_case(entity)) — the SAME answer <Entity>Names.NAME, meta verify
        // and every other port give. This generator used to answer `myproc` here (the
        // lowercased short name, a resolver of its own), so a run with the names generator
        // and a run without it named two different procedures for one object.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "MyProc", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@kind": "storedProc" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-fallback-")
        try {
            val loader = loadString("proc-fallback", fixture)
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loader)

            val emitted = outDir.resolve("acme/demo/MyProcProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("const val PROC_NAME = \"my_procs\"" in src, src)
            assertFalse("\"myproc\"" in src, src)
            // The literal IS the canonical resolver's answer — asserted against the resolver
            // itself, not a second spelling of the rule in this test.
            val source = KotlinGenUtil.primaryRdbSource(loader.metaObjects.first { it.shortName == "MyProc" })!!
            assertEquals("my_procs", source.physicalName)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `a strict load refuses the @procName spelling this generator used to read first`() {
        // The generator's old resolver read `@procName` before anything else. No provider
        // registers it (ADR-0018 lists the `@<kind>Name` spelling as REJECTED; source.rdb
        // registers @proc), so under the strict load the Maven mojo runs by default it is
        // ERR_UNKNOWN_ATTR and the build fails before any generator sees it. The step was
        // dead on the adopter path and merely untested-as-dead here: `loadString` builds a
        // LAX loader (LoaderOptions strict=false), which materializes the attr silently.
        // Pinned so the spelling cannot creep back in as a "supported" override.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "MyProc", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@kind": "storedProc", "@procName": "get_data" } }
            ] } }
          ] }
        }""".trimIndent()
        val strict = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "proc-strict")
        strict.init()
        strict.load(listOf(InMemoryStringSource(fixture, "<inline>", MetaDataFormat.JSON)))
        val unknown = strict.errors.filter { it.code.orElse(null) == ErrorCode.ERR_UNKNOWN_ATTR }
        assertTrue(unknown.any { "@procName" in (it.message ?: "") },
            "expected ERR_UNKNOWN_ATTR naming @procName; errors=${strict.errors.map { it.message }}")
    }

    @Test fun `result columns are read by their PHYSICAL column, never the field name`() {
        // `totalCents` carries no @column, so its column is the field name through the
        // project's strategy (snake_case, this port's default) — `total_cents`. `label`
        // carries an explicit @column that is NOT the snake_case of its name, the
        // discriminator between "reads the resolved column" and "re-derives it". The
        // getter used to pass the FIELD name (`rs.getLong("totalCents")`), asking the
        // result set for a column the procedure does not return.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "MyProc", "children": [
                { "field.long":   { "name": "totalCents" } },
                { "field.string": { "name": "label", "@column": "phys_label" } },
                { "source.rdb":   { "@kind": "storedProc", "@proc": "get_data" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-column-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-column", fixture))
            val src = outDir.resolve("acme/demo/MyProcProc.kt").readText()
            assertTrue("totalCents = rs.getLong(\"total_cents\")" in src, src)
            assertTrue("label = rs.getString(\"phys_label\")" in src, src)
            assertFalse("rs.getLong(\"totalCents\")" in src, src)
            assertFalse("rs.getString(\"label\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `with the names artifact in the run, PROC_NAME and every result column reference the constants`() {
        // Task 6 — the procedure name and each result column are spelled ONCE per run, on
        // <Entity>Names; the wrapper references them.
        // `const val PROC_NAME = MyProcNames.SOURCE_PRIMARY_PROC` is a const initialised
        // from a const, which the compiler folds — so PROC_NAME keeps its value AND its
        // callers (`${PROC_NAME}` in the SQL) are unchanged.
        //
        // The member is SOURCE_PRIMARY_PROC, not NAME. Under the old flat shape the same
        // `NAME` member held a table, a view or a procedure depending on the object; it now
        // holds the object's own metamodel name and the physical name sits under the alias
        // for the source's @kind, so `MyProcNames.SOURCE_PRIMARY_TABLE` is a compile error.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "MyProc", "children": [
                { "field.long":   { "name": "totalCents" } },
                { "field.string": { "name": "label", "@column": "phys_label" } },
                { "source.rdb":   { "@kind": "storedProc", "@proc": "get_data" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-names-")
        try {
            val loader = loadString("proc-names", fixture)
            KotlinNamesGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinStoredProcGenerator()
                .apply { setArgs(mapOf("outputDir" to outDir.toString(), "useNames" to "true")) }
                .execute(loader)
            val src = outDir.resolve("acme/demo/MyProcProc.kt").readText()
            assertTrue("const val PROC_NAME = MyProcNames.SOURCE_PRIMARY_PROC" in src, src)
            assertTrue("SELECT * FROM \${PROC_NAME}()" in src, src)
            assertTrue("totalCents = rs.getLong(MyProcNames.TOTAL_CENTS_COLUMN)" in src, src)
            assertTrue("label = rs.getString(MyProcNames.LABEL_COLUMN)" in src, src)
            // The KDoc names the constant rather than restating the literal.
            assertTrue("wrapper for the stored procedure named by `MyProcNames.SOURCE_PRIMARY_PROC`" in src, src)
            // The literals must be GONE from the wrapper — a positive assertion alone would
            // still pass a generator emitting the reference and the old literal side by side.
            for (literal in listOf("get_data", "phys_label", "total_cents", "totalCents\"")) {
                assertFalse(literal in src, "literal $literal still spelled in:\n$src")
            }
            // And the artifact the references point at carries them — the reference is
            // only worth anything if it resolves to the same strings.
            val names = outDir.resolve("acme/demo/MyProcNames.kt").readText()
            assertTrue("const val SOURCE_PRIMARY_PROC: String = \"get_data\"" in names, names)
            assertFalse("SOURCE_PRIMARY_TABLE" in names, names)
            assertTrue("const val TOTAL_CENTS_COLUMN: String = \"total_cents\"" in names, names)
            assertTrue("const val LABEL_COLUMN: String = \"phys_label\"" in names, names)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `the field-less stub references the name constant too`() {
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "Bare", "children": [
                { "source.rdb": { "@kind": "storedProc", "@proc": "sp_bare" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-stub-names-")
        try {
            val loader = loadString("proc-stub-names", fixture)
            KotlinNamesGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinStoredProcGenerator()
                .apply { setArgs(mapOf("outputDir" to outDir.toString(), "useNames" to "true")) }
                .execute(loader)
            val src = outDir.resolve("acme/demo/BareProc.kt").readText()
            assertTrue("const val PROC_NAME = BareNames.SOURCE_PRIMARY_PROC" in src, src)
            assertTrue("stub for the stored procedure named by `BareNames.SOURCE_PRIMARY_PROC`" in src, src)
            assertFalse("sp_bare" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `proc name resolves the role-scoped primary source, not the first-declared one`() {
        // TwoProcEntity declares its @role:replica source FIRST and its @role:primary
        // source SECOND -- the role-blind KotlinGenUtil.firstRdbSource picked whichever
        // was declared first (the replica), naming PROC_NAME after the WRONG procedure
        // on a shape that loads with zero errors.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "TwoProcEntity", "children": [
                { "source.rdb": { "@kind": "storedProc", "@proc": "sp_replica_proc", "@role": "replica" } },
                { "source.rdb": { "@kind": "storedProc", "@proc": "sp_primary_proc", "@role": "primary" } },
                { "field.int": { "name": "id" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-role-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-role", fixture))

            val emitted = outDir.resolve("acme/demo/TwoProcEntityProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("const val PROC_NAME = \"sp_primary_proc\"" in src, src)
            // The wrong (role-blind, first-declared) procedure name must not appear at all.
            assertFalse("sp_replica_proc" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun nonStoredProcEntitySkipped() {
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "authors", "@kind": "table" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-skip-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-skip", fixture))

            val notEmitted = outDir.resolve("acme/demo/AuthorProc.kt")
            assertFalse(Files.exists(notEmitted),
                "should NOT emit Proc stub for table-kind entity; files=${Files.walk(outDir).toList()}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === @parameterRef-binding tests ==========================================
    // These used to declare arguments with a per-field `@param` attribute this port
    // invented and no provider registers, so they loaded only under the lax loader
    // `loadString` used to build — and under the sealed registry (ADR-0023) the predicate
    // reading it answered false for every field of every model that can actually load,
    // making every emitted wrapper zero-argument. The fixtures now use the REGISTERED
    // cross-port contract, `@parameterRef` naming an `object.value` whose fields are the
    // call arguments in declaration order, which is what TS and C# have always bound from.
    //
    // One behavioural consequence is visible in the assertions: the arguments now live on a
    // SEPARATE object, so the callable's own fields are ALL result columns. There is no
    // longer a field that is a parameter and therefore excluded from the result row.

    @Test fun `storedProc with one parameterRef arg emits typed call fn`() {
        // OrderReport: orderId (argument, Long) + status (result, String) + total (result, Long)
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "OrderReportArgs", "children": [
                { "field.long": { "name": "orderId" } }
            ] } },
            { "object.projection": { "name": "OrderReport", "children": [
                { "field.string": { "name": "status" } },
                { "field.long":   { "name": "total" } },
                { "source.rdb":   { "@kind": "storedProc", "@proc": "get_order_report",
                                    "@parameterRef": "OrderReportArgs" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-one-param-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-one-param", fixture))

            val emitted = outDir.resolve("acme/demo/OrderReportProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // Typed call signature with the param.
            assertTrue("fun call(orderId: Long): List<OrderReport>" in src, src)
            // Single `?` placeholder.
            assertTrue("SELECT * FROM \${PROC_NAME}(?)" in src, src)
            // Bindings list with LongColumnType + orderId.
            assertTrue("org.jetbrains.exposed.sql.LongColumnType() to orderId" in src, src)
            // Result-row mapping uses status + total only (orderId is NOT mapped).
            assertTrue("rs.getString(\"status\")" in src, src)
            assertTrue("rs.getLong(\"total\")" in src, src)
            // orderId lives on the ARGS object, not on the callable, so it cannot appear in
            // the result-row mapping — the exclusion is now structural rather than a filter.
            assertFalse("rs.getLong(\"orderId\")" in src,
                "orderId is a call argument, must not appear in result-row mapping; src=$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `storedProc with no parameterRef emits no-arg call fn`() {
        // GetAllProducts: no params, result fields name + price.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "GetAllProducts", "children": [
                { "field.string": { "name": "name" } },
                { "field.long":   { "name": "price" } },
                { "source.rdb":   { "@kind": "storedProc", "@proc": "get_all_products" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-no-param-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-no-param", fixture))

            val emitted = outDir.resolve("acme/demo/GetAllProductsProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // No-arg call signature.
            assertTrue("fun call(): List<GetAllProducts>" in src, src)
            // Empty parens in the SQL.
            assertTrue("SELECT * FROM \${PROC_NAME}()" in src, src)
            // No bindings list emitted.
            assertFalse(", listOf(" in src,
                "no-param call must not emit a bindings list; src=$src")
            // Result-row mapping covers both fields.
            assertTrue("rs.getString(\"name\")" in src, src)
            assertTrue("rs.getLong(\"price\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `storedProc with multiple parameterRef args preserves order`() {
        // GetReport args: year (Int) + region (String) — declared in that order on the args
        // value object, which is what fixes the positional binding order.
        // Result fields: total (Long).
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "GetReportArgs", "children": [
                { "field.int":    { "name": "year" } },
                { "field.string": { "name": "region" } }
            ] } },
            { "object.projection": { "name": "GetReport", "children": [
                { "field.long":   { "name": "total" } },
                { "source.rdb":   { "@kind": "storedProc", "@proc": "get_report",
                                    "@parameterRef": "GetReportArgs" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-multi-param-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-multi-param", fixture))

            val emitted = outDir.resolve("acme/demo/GetReportProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // Signature in authoring order: year first, region second.
            assertTrue("fun call(year: Int, region: String): List<GetReport>" in src, src)
            // Two `?` placeholders.
            assertTrue("SELECT * FROM \${PROC_NAME}(?, ?)" in src, src)
            // Both bindings present, year before region (positional order matters).
            val yearIdx = src.indexOf("IntegerColumnType() to year")
            val regionIdx = src.indexOf("VarCharColumnType(255) to region")
            assertTrue(yearIdx > 0, "year binding missing; src=$src")
            assertTrue(regionIdx > 0, "region binding missing; src=$src")
            assertTrue(yearIdx < regionIdx,
                "year must bind before region (declared order); src=$src")
            // Result-row mapping for total only.
            assertTrue("rs.getLong(\"total\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

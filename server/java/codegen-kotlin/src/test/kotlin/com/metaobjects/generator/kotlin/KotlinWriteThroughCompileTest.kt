package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #214 FR-024 §7 — the Kotlin read-half of a WRITE-THROUGH entity read-view.
 *
 * A write-through entity declares BOTH a writable table `source.rdb` AND a read-only replica
 * view `source.rdb` PLUS derived (`origin.*`) fields. Its generated surface is a hybrid:
 *
 *  - [KotlinExposedTableGenerator] emits TWO Exposed objects — the derived-FREE write
 *    `<Short>Table` (physical `@table` name, PK/autoIncrement/references kept) and the
 *    derived-CARRYING read-only `<Short>View` (physical `@view` name, no autoIncrement/references);
 *  - [KotlinEntityGenerator]'s read data class carries the derived fields (origin-aware nullability);
 *  - [KotlinRepositoryGenerator] / [KotlinSpringControllerGenerator] route READS to the `<Short>View`
 *    and WRITES to the `<Short>Table`, re-reading a create/update through the view by PK.
 *
 * Scope-of-compile caveat (same as [KotlinProjectionCompileTest]): this module's test classpath
 * carries kotlinx.serialization but NOT jetbrains-exposed, so the `*Table.kt` / `*View.kt` /
 * repository / controller files cannot be compiled here — they are asserted STRUCTURALLY. The
 * read-side data class (the surface the derived-field read type lives on) IS truly compiled. A
 * runtime read-your-writes gate (compile + run the repository against an H2 view) lives in
 * `integration-tests-kotlin`'s `RepositoryGeneratorRunTest`.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinWriteThroughCompileTest {

    // Customer (table `customers`) + a write-through Order: a writable `orders` table source AND a
    // read-only replica view `v_order_with_customer`, with a DERIVED `customerName` pass-through
    // (Customer.name via the Order.customer relationship). `customerName` lives only on the view.
    private val writeThroughFixture = """{
      "metadata.root": { "package": "acme::commerce", "children": [
        { "object.entity": { "name": "Customer", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true } },
            { "source.rdb":   { "@table": "customers" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@role": "primary", "@table": "orders" } },
            { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_order_with_customer" } },
            { "field.long":   { "name": "id" } },
            { "field.long":   { "name": "customerId", "@required": true } },
            { "field.string": { "name": "customerName", "children": [
                { "origin.passthrough": { "@from": "acme::commerce::Customer.name", "@via": "Order.customer" } }
            ] } },
            { "relationship.association": { "name": "customer", "@objectRef": "Customer", "@cardinality": "one" } },
            { "identity.primary":   { "name": "pk", "@fields": "id", "@generation": "increment" } },
            { "identity.reference": { "name": "ref_customer", "@fields": "customerId", "@references": "Customer" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `write-through entity emits a derived-free write Table plus a derived-carrying read-only View`() {
        val outDir = Files.createTempDirectory("kwt-tables-")
        try {
            val loader = loadString("write-through-tables", writeThroughFixture)
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val orderKt = outDir.resolve("acme/commerce/Order.kt")
            val orderTableKt = outDir.resolve("acme/commerce/OrderTable.kt")
            val orderViewKt = outDir.resolve("acme/commerce/OrderView.kt")
            assertTrue(Files.exists(orderKt), "expected read data class $orderKt")
            assertTrue(Files.exists(orderTableKt), "expected write table $orderTableKt")
            assertTrue(Files.exists(orderViewKt),
                "expected read view $orderViewKt; files=${Files.walk(outDir).toList()}")

            val orderSrc = Files.readString(orderKt)
            val tableSrc = Files.readString(orderTableKt)
            val viewSrc = Files.readString(orderViewKt)

            // --- Read data class carries the derived field (origin.passthrough → nullable) ---
            assertTrue("data class Order" in orderSrc, "Order must be a data class; saw:\n$orderSrc")
            assertTrue("val customerName: String? = null" in orderSrc,
                "the derived pass-through `customerName` must be a nullable read property; saw:\n$orderSrc")

            // --- WRITE table: physical @table name, PK autoIncrement, FK reference, DERIVED-FREE ---
            assertTrue("object OrderTable : Table(\"orders\")" in tableSrc,
                "write table must bind to the @table physical name; saw:\n$tableSrc")
            assertTrue(".autoIncrement()" in tableSrc,
                "write table PK must auto-increment; saw:\n$tableSrc")
            assertTrue(".references(CustomerTable.id" in tableSrc,
                "write table must carry the identity.reference FK; saw:\n$tableSrc")
            assertFalse("READ-ONLY VIEW" in tableSrc,
                "the write table must NOT carry the read-only view guard; saw:\n$tableSrc")
            // The derived column has NO physical slot on the write table.
            assertFalse("customer_name" in tableSrc || "customerName" in tableSrc,
                "the DERIVED customerName must be EXCLUDED from the write table; saw:\n$tableSrc")
            // The non-derived FK column IS on the write table.
            assertTrue("customer_id" in tableSrc, "customerId must be a write-table column; saw:\n$tableSrc")

            // --- READ view: physical @view name, read-only shape, carries the derived column ---
            assertTrue("object OrderView : Table(\"v_order_with_customer\")" in viewSrc,
                "read view must bind to the @view physical name (distinct object from OrderTable); saw:\n$viewSrc")
            assertTrue("READ-ONLY VIEW" in viewSrc,
                "the read view must carry the read-only view guard; saw:\n$viewSrc")
            assertFalse(".autoIncrement()" in viewSrc,
                "view columns must NOT auto-increment; saw:\n$viewSrc")
            assertFalse(".references(" in viewSrc,
                "the view must NOT emit FK .references(...); saw:\n$viewSrc")
            assertTrue("customer_name" in viewSrc,
                "the read view MUST carry the derived customerName column; saw:\n$viewSrc")

            // --- TRUE compile of the read-side data classes (Exposed not on this classpath) ---
            val dataClassPaths = Files.walk(outDir).filter { it.isRegularFile() }
                .filter { !it.fileName.toString().endsWith("Table.kt") }
                .filter { !it.fileName.toString().endsWith("View.kt") }
                .toList()
            assertTrue(dataClassPaths.any { it.fileName.toString() == "Order.kt" },
                "the Order read data class must be among the compiled sources")
            val dataClassSources = dataClassPaths.map { path ->
                SourceFile.kotlin(
                    path.parent.relativize(path).toString().replace('/', '_'),
                    path.readText(),
                )
            }
            val result = KotlinCompilation().apply {
                this.sources = dataClassSources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated write-through read data classes failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `write-through repository reads through the view and writes to the table`() {
        val outDir = Files.createTempDirectory("kwt-repo-")
        try {
            val loader = loadString("write-through-repo", writeThroughFixture)
            for (gen in listOf(KotlinExposedTableGenerator(), KotlinRepositoryGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }
            val repoKt = outDir.resolve("acme/commerce/OrderRepositoryBase.kt")
            assertTrue(Files.exists(repoKt),
                "a write-through entity IS writable → its repository must be emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(repoKt)

            // rowTo maps ALL fields (incl. derived) from the VIEW row.
            assertTrue("row[OrderView.customerName]" in src,
                "rowToOrder must read the derived customerName from OrderView; saw:\n$src")
            // findById reads from the view.
            assertTrue("OrderView.selectAll().where { OrderView.id eq id }" in src,
                "findById must SELECT from OrderView; saw:\n$src")
            // insert targets the write table, then re-reads through the view by PK.
            assertTrue("OrderTable.insert {" in src, "insert must target OrderTable; saw:\n$src")
            assertTrue("OrderView.selectAll().where { OrderView.id eq newId }" in src,
                "insert must re-read the persisted row through OrderView; saw:\n$src")
            // the insert column set is derived-free (no customerName write).
            assertFalse("it[OrderTable.customerName]" in src,
                "the derived customerName must NOT be written to OrderTable; saw:\n$src")
            assertTrue("it[OrderTable.customerId]" in src,
                "the non-derived customerId must be written to OrderTable; saw:\n$src")
            // delete targets the write table.
            assertTrue("OrderTable.deleteWhere" in src, "delete must target OrderTable; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `write-through controller reads through the view and writes to the table`() {
        val outDir = Files.createTempDirectory("kwt-ctrl-")
        try {
            val loader = loadString("write-through-ctrl", writeThroughFixture)
            for (gen in listOf(
                KotlinExposedTableGenerator(),
                KotlinFilterAllowlistGenerator(),
                KotlinSpringControllerGenerator(),
            )) {
                gen.setArgs(mapOf("outputDir" to outDir.toString(), "packageName" to "acme.commerce"))
                gen.execute(loader)
            }
            val ctrlKt = outDir.resolve("acme/commerce/OrderController.kt")
            assertTrue(Files.exists(ctrlKt),
                "a write-through entity IS writable → its controller must be emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(ctrlKt)

            // rowTo reads the derived column from the view.
            assertTrue("row[OrderView.customerName]" in src,
                "controller rowTo must read customerName from OrderView; saw:\n$src")
            // list + get read from the view.
            assertTrue("OrderView.selectAll()" in src, "list/get must read from OrderView; saw:\n$src")
            // create writes to the table then re-reads through the view.
            assertTrue("OrderTable.insert {" in src, "create must insert into OrderTable; saw:\n$src")
            assertTrue("OrderView.selectAll().where { OrderView.id eq newId }" in src,
                "create must re-read through OrderView by PK; saw:\n$src")
            // the create insert is derived-free.
            assertFalse("it[customerName]" in src,
                "create must NOT write the derived customerName; saw:\n$src")
            // delete + update target the write table.
            assertTrue("OrderTable.deleteWhere" in src, "delete must target OrderTable; saw:\n$src")
            assertTrue("OrderTable.update(" in src, "update must target OrderTable; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // A write-through entity carrying a guaranteed-non-null `origin.aggregate @agg:any` derived
    // field (`anyError`). On a read-only projection such a field is non-null (#195), but on a
    // WRITE-THROUGH entity the SHARED read/create data class must make it nullable + default-null so
    // a POST create body can omit the view-computed value (else the non-null Kotlin ctor param with
    // no default → jackson-module-kotlin MissingKotlinParameterException → HTTP 400). Mirrors the
    // Java port dropping @NotNull for derived-on-write-through fields.
    private val aggregateFixture = """{
      "metadata.root": { "package": "acme::sessions", "children": [
        { "object.entity": { "name": "Turn", "children": [
            { "source.rdb": { "@table": "turns" } },
            { "field.long": { "name": "id" } },
            { "field.boolean": { "name": "success" } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Session", "children": [
            { "source.rdb": { "@role": "primary", "@table": "sessions" } },
            { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_session" } },
            { "field.long": { "name": "id" } },
            { "field.boolean": { "name": "anyError", "children": [
                { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { "success": false } } }
            ] } },
            { "relationship.association": { "name": "turns", "@objectRef": "Turn", "@cardinality": "many" } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `write-through aggregate-derived field is nullable+default on the shared create data class`() {
        val outDir = Files.createTempDirectory("kwt-agg-")
        try {
            val loader = loadString("write-through-agg", aggregateFixture)
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)

            val sessionSrc = Files.readString(outDir.resolve("acme/sessions/Session.kt"))
            // Guaranteed-non-null in the view (#195), but nullable+default on the write-through data
            // class so a create body can omit it (the create-body relaxation).
            assertTrue("val anyError: Boolean? = null" in sessionSrc,
                "aggregate-derived anyError must be nullable+default on a write-through data class; saw:\n$sessionSrc")

            // TRUE compile of the generated read data classes.
            val sources = Files.walk(outDir).filter { it.isRegularFile() }
                .filter { it.fileName.toString().endsWith(".kt") }
                .map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }
                .toList()
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated aggregate write-through data class failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

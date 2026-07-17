package com.metaobjects.integration.kotlin.api.generated

import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinRepositoryGenerator
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * FR-035 Phase 2 — the REAL gate for [KotlinRepositoryGenerator]. A golden pins the emitted
 * TEXT; this proves the emitted repository COMPILES and RUNS: generate → compile (Exposed on
 * classpath) → load → create an H2 schema → exercise insert / findById / patch / update / delete.
 *
 * Two entities, because the two insert branches differ and both matter to #197:
 *   - an INCREMENT PK — insert must skip the PK and return the DB-assigned id;
 *   - a UUID PK       — insert must return the generated uuid (the original #197 pain).
 *
 * The `patch` case is the #198 property: patch ONE column and assert the OTHER survives — a
 * full-row write would clobber it.
 *
 * A hand-written driver object is compiled ALONGSIDE the generated sources so the repository is
 * exercised in TYPE-SAFE Kotlin (a renamed generated symbol is a compile error here, not a
 * reflection surprise); the test invokes `run(jdbcUrl)` reflectively and asserts it returns "OK".
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class RepositoryGeneratorRunTest {

    // --- increment-PK entity ---------------------------------------------------------------
    private val incFixture = """{
      "metadata.root": { "package": "acme::repo", "children": [
        { "object.entity": { "name": "Item", "children": [
            { "source.rdb":   { "@table": "items" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "label", "@required": true, "@maxLength": 200 } },
            { "field.string": { "name": "note" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    // Everything runs inside ONE outer transaction(db): SchemaUtils.create lets Exposed own the
    // exact table/column names, and the repository's own transaction{} blocks JOIN this outer one
    // (Exposed default), so they share the connection + the just-created schema — no H2 in-memory
    // cross-connection visibility surprises, and no manual DDL name-matching.
    private val incDriver = """
        package acme.repo
        import org.jetbrains.exposed.sql.Database
        import org.jetbrains.exposed.sql.SchemaUtils
        import org.jetbrains.exposed.sql.transactions.transaction

        object ItemRepoDriver {
            fun run(jdbcUrl: String): String {
                val db = Database.connect(jdbcUrl, driver = "org.h2.Driver")
                return transaction(db) {
                    SchemaUtils.create(ItemTable)
                    val repo = ItemRepositoryBase()

                    // insert must SKIP the PK and return the DB-assigned id
                    val created = repo.insert(Item(label = "a", note = "n1"))
                    check(created.id != null && created.id != 0L) { "insert did not return a DB-assigned id: ${'$'}{created.id}" }
                    val id = created.id!!
                    check(created.label == "a") { "insert lost label" }

                    check(repo.findById(id)?.label == "a") { "findById" }

                    // patch ONE column — the OMITTED one must survive (#198)
                    val patched = repo.patch(id) { it[ItemTable.label] = "b" }
                    check(patched?.label == "b") { "patch label -> ${'$'}{patched?.label}" }
                    check(patched?.note == "n1") { "patch clobbered the omitted note: ${'$'}{patched?.note}" }

                    // full-row update
                    val updated = repo.update(id, Item(id = id, label = "c", note = "n2"))
                    check(updated?.label == "c" && updated.note == "n2") { "update -> ${'$'}updated" }

                    check(repo.delete(id)) { "delete returned false" }
                    check(repo.findById(id) == null) { "row still present after delete" }
                    "OK"
                }
            }
        }
    """.trimIndent()

    // --- uuid-PK entity --------------------------------------------------------------------
    private val uuidFixture = """{
      "metadata.root": { "package": "acme::repo", "children": [
        { "object.entity": { "name": "Doc", "children": [
            { "source.rdb":   { "@table": "docs" } },
            { "field.uuid":   { "name": "id" } },
            { "field.string": { "name": "title", "@required": true, "@maxLength": 200 } },
            { "field.string": { "name": "tag" } },
            { "identity.primary": { "@fields": "id", "@generation": "uuid" } }
        ] } }
      ] }
    }""".trimIndent()

    // Same one-outer-transaction pattern. SchemaUtils.create(DocTable) exercises the generated
    // uuid table (incl. its server-side default) against H2; the repository CLIENT-generates the
    // uuid regardless, so the returned id is deterministic and does not depend on reading a
    // DB-default value back.
    private val uuidDriver = """
        package acme.repo
        import org.jetbrains.exposed.sql.Database
        import org.jetbrains.exposed.sql.SchemaUtils
        import org.jetbrains.exposed.sql.transactions.transaction

        object DocRepoDriver {
            fun run(jdbcUrl: String): String {
                val db = Database.connect(jdbcUrl, driver = "org.h2.Driver")
                return transaction(db) {
                    SchemaUtils.create(DocTable)
                    val repo = DocRepositoryBase()

                    // insert must return the GENERATED uuid (the #197 pain)
                    val created = repo.insert(Doc(title = "x", tag = "t1"))
                    check(created.id != null) { "uuid insert returned no id" }
                    val id = created.id!!
                    check(created.title == "x") { "insert lost title" }

                    check(repo.findById(id)?.title == "x") { "findById by uuid" }

                    // patch ONE column — the OMITTED one must survive (#198)
                    val patched = repo.patch(id) { it[DocTable.title] = "y" }
                    check(patched?.title == "y") { "patch title" }
                    check(patched?.tag == "t1") { "patch clobbered the omitted tag: ${'$'}{patched?.tag}" }

                    check(repo.delete(id)) { "delete returned false" }
                    check(repo.findById(id) == null) { "uuid row still present after delete" }
                    "OK"
                }
            }
        }
    """.trimIndent()

    // --- #214 write-through entity read-view --------------------------------------------------
    // Customer (table `customers`) + a write-through Order: a writable `orders` table source AND a
    // read-only replica view `v_order_with_customer`, with a DERIVED `customerName` pass-through
    // (Customer.name via the Order.customer relationship). The repository writes to `orders` and
    // re-reads through the view, so the returned Order carries the view-computed derived column.
    private val writeThroughFixture = """{
      "metadata.root": { "package": "acme::repo", "children": [
        { "object.entity": { "name": "Customer", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "fullName", "@required": true, "@maxLength": 200 } },
            { "source.rdb":   { "@table": "customers" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@role": "primary", "@table": "orders" } },
            { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_order_with_customer" } },
            { "field.long":   { "name": "id" } },
            { "field.long":   { "name": "customerId", "@required": true } },
            { "field.string": { "name": "customerName", "children": [
                { "origin.passthrough": { "@from": "acme::repo::Customer.fullName", "@via": "Order.customer" } }
            ] } },
            { "relationship.association": { "name": "customer", "@objectRef": "Customer", "@cardinality": "one" } },
            { "identity.primary":   { "@fields": "id", "@generation": "increment" } },
            { "identity.reference": { "name": "ref_customer", "@fields": "customerId", "@references": "Customer" } }
        ] } }
      ] }
    }""".trimIndent()

    // Reads route to the view, writes to the table. SchemaUtils.create builds the two tables; the
    // view is created by hand (Exposed cannot CREATE a view — its OrderView object is SELECT-only).
    // The derived customerName is NOT a column of the `orders` table; the repository must read it
    // back through v_order_with_customer (read-your-writes across the write→view boundary).
    private val writeThroughDriver = """
        package acme.repo
        import org.jetbrains.exposed.sql.Database
        import org.jetbrains.exposed.sql.SchemaUtils
        import org.jetbrains.exposed.sql.transactions.transaction

        object OrderRepoDriver {
            fun run(jdbcUrl: String): String {
                val db = Database.connect(jdbcUrl, driver = "org.h2.Driver")
                return transaction(db) {
                    SchemaUtils.create(CustomerTable, OrderTable)
                    exec(
                        "CREATE VIEW v_order_with_customer AS " +
                        "SELECT o.id AS id, o.customer_id AS customer_id, c.full_name AS customer_name " +
                        "FROM orders o JOIN customers c ON o.customer_id = c.id"
                    )
                    val customers = CustomerRepositoryBase()
                    val orders = OrderRepositoryBase()

                    val cust = customers.insert(Customer(fullName = "Acme"))
                    val custId = cust.id!!

                    // insert writes the `orders` table, then RE-READS through the view — so the
                    // returned Order carries the derived customerName the write table never stored.
                    val created = orders.insert(Order(customerId = custId))
                    check(created.id != null) { "order insert did not return a PK" }
                    check(created.customerId == custId) { "insert lost customerId: ${'$'}{created.customerId}" }
                    check(created.customerName == "Acme") {
                        "read-your-writes FAILED: derived customerName not read back through the view: ${'$'}{created.customerName}"
                    }

                    // findById reads through the view too.
                    val fetched = orders.findById(created.id!!)
                    check(fetched?.customerName == "Acme") {
                        "findById through the view lost the derived column: ${'$'}{fetched?.customerName}"
                    }

                    check(orders.delete(created.id!!)) { "order delete returned false" }
                    check(orders.findById(created.id!!) == null) { "order row still present after delete" }
                    "OK"
                }
            }
        }
    """.trimIndent()

    @Test
    fun `write-through repository — insert re-reads the derived column through the view (read-your-writes)`() {
        runRepoScenario("repo-wt", writeThroughFixture, "OrderRepoDriver", writeThroughDriver, "jdbc:h2:mem:repo_wt;DB_CLOSE_DELAY=-1;MODE=PostgreSQL")
    }

    @Test
    fun `increment-PK repository — insert returns id, findById, patch keeps omitted col, update, delete`() {
        runRepoScenario("repo-inc", incFixture, "ItemRepoDriver", incDriver, "jdbc:h2:mem:repo_inc;DB_CLOSE_DELAY=-1;MODE=PostgreSQL")
    }

    @Test
    fun `uuid-PK repository — insert returns generated uuid, findById, patch keeps omitted col, delete`() {
        runRepoScenario("repo-uuid", uuidFixture, "DocRepoDriver", uuidDriver, "jdbc:h2:mem:repo_uuid;DB_CLOSE_DELAY=-1;MODE=PostgreSQL")
    }

    private fun runRepoScenario(
        name: String, fixture: String, driverClass: String, driverSource: String, jdbcUrl: String,
    ) {
        val outDir = Files.createTempDirectory("$name-")
        try {
            val loader = loadString(name, fixture)
            for (g in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator(), KotlinRepositoryGenerator())) {
                g.setArgs(mapOf("outputDir" to outDir.toString()))
                g.execute(loader)
            }
            val sources = Files.walk(outDir).filter { it.isRegularFile() }
                .map { SourceFile.kotlin(outDir.relativize(it).toString().replace('/', '_'), it.readText()) }
                .toList() + SourceFile.kotlin("$driverClass.kt", driverSource)

            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                // The whole generated module (entity + table + repository) must be warning-clean:
                // a `-Werror` consumer compiles it all together, so an unused import or an
                // always-true null-guard in the repository would break their build.
                allWarningsAsErrors = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(
                KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated repository failed to compile:\n${result.messages}",
            )

            val cl = result.classLoader
            val driver = cl.loadClass("acme.repo.$driverClass").getField("INSTANCE").get(null)
            val out = driver.javaClass.getMethod("run", String::class.java).invoke(driver, jdbcUrl)
            assertEquals("OK", out, "repository scenario did not complete")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

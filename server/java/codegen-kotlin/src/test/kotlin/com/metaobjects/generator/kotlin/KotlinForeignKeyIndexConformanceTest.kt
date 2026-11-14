package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.config.MigrateSettings
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.index.LookupIndex
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.`object`.MetaObject
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The shared foreign-key index corpus, `fixtures/foreign-key-index-conformance/`: which foreign
 * keys `migrate.foreignKeyIndexes` indexes and under what name, per dialect. The TypeScript
 * migrate suite writes and passes the same expected files, so the Exposed table declares exactly
 * the indexes `meta migrate` creates. `declared.<dialect>.json` pins the database name of every
 * `identity.secondary` and `index.lookup`, so a declared name over 63 bytes is cut on Postgres the
 * way migrate cuts it, in the Exposed table as in the database.
 */
class KotlinForeignKeyIndexConformanceTest {

    private val corpus: Path = Path.of(System.getProperty("user.dir"))
        .resolve("../../..").normalize().resolve("fixtures/foreign-key-index-conformance")

    /** Opens the generator's own rule to the test. */
    private class Probe : KotlinExposedTableGenerator() {
        fun indexes(entity: MetaObject, loader: MetaDataLoader, table: String) = foreignKeyIndexes(entity, loader, table)
    }

    private fun check(file: String, dialect: String) {
        val input = corpus.resolve("input/meta.fk.json")
        assertTrue(Files.exists(input), "shared fixture missing at $input")
        val loader = loadString("fk-index-conformance", Files.readString(input))
        loader.root.setMigrateSettings(MigrateSettings(true, null, dialect))
        val probe = Probe()
        val actual = sortedMapOf<String, List<String>>()
        for (entity in loader.metaObjects) {
            val table = KotlinGenUtil.primaryRdbSource(entity)?.physicalName ?: continue
            val indexes = probe.indexes(entity, loader, table)
            if (indexes.isNotEmpty()) actual[table] = indexes.map { "${it.name}(${it.columns.joinToString(",")})" }
        }
        val expected = sortedMapOf<String, List<String>>()
        for ((table, list) in ObjectMapper().readTree(corpus.resolve(file).toFile()).fields()) {
            expected[table] = list.map { ix -> "${ix["name"].asText()}(${ix["columns"].joinToString(",") { it.asText() }})" }
        }
        assertEquals(expected, actual)
    }

    @Test fun `postgres - the indexes are meta migrate's`() = check("expected.postgres.json", "postgres")

    @Test fun `sqlite - the indexes are meta migrate's`() = check("expected.sqlite.json", "sqlite")

    private fun checkDeclared(file: String, dialect: String) {
        val loader = loadString("fk-index-conformance", Files.readString(corpus.resolve("input/meta.fk.json")))
        val actual = sortedMapOf<String, List<String>>()
        for (entity in loader.metaObjects) {
            val table = KotlinGenUtil.primaryRdbSource(entity)?.physicalName ?: continue
            // ADR-0039: resolving — identities and index nodes may be inherited.
            val nodes = entity.getIdentities(true).filter { it.isSecondary }.map { it to it.fields } +
                entity.getChildren(LookupIndex::class.java, true).map { it to it.fields }
            val names = nodes.map { (node, fields) ->
                val cols = fields.map { f -> KotlinGenUtil.resolveColumnName(entity.metaFields.first { it.name == f }) }
                "${declaredIndexName(node, dialect)}(${cols.joinToString(",")})"
            }
            if (names.isNotEmpty()) actual[table] = names
        }
        val expected = sortedMapOf<String, List<String>>()
        for ((table, list) in ObjectMapper().readTree(corpus.resolve(file).toFile()).fields()) {
            expected[table] = list.map { ix -> "${ix["name"].asText()}(${ix["columns"].joinToString(",") { it.asText() }})" }
        }
        assertEquals(expected, actual)
    }

    @Test fun `postgres - declared index names are meta migrate's`() = checkDeclared("declared.postgres.json", "postgres")

    @Test fun `sqlite - declared index names are meta migrate's`() = checkDeclared("declared.sqlite.json", "sqlite")

    @Test fun `the Exposed table declares the cut name on Postgres`() {
        val loader = loadString("fk-index-conformance", Files.readString(corpus.resolve("input/meta.fk.json")))
        loader.root.setMigrateSettings(MigrateSettings(false, null, "postgres"))
        val out = Files.createTempDirectory("kt-declared-index")
        KotlinExposedTableGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)
        val source = Files.walk(out).use { s -> s.filter { it.toString().endsWith(".kt") }.map { Files.readString(it) }.toList() }
            .joinToString("\n")
        assertTrue("\"customer_order_line_item_allocations_by_region_region_code_look\"" in source, source)
        assertTrue("\"allocation_external_reference_key_for_customer_order_line_items\"" in source, source)
    }
}

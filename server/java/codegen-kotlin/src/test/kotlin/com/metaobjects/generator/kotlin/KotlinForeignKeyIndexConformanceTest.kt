package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.config.MigrateSettings
import com.metaobjects.loader.MetaDataLoader
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
 * the indexes `meta migrate` creates.
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
}

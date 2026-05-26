package com.metaobjects.integration.kotlin

import com.metaobjects.integration.kotlin.tables.ProgramTable
import com.metaobjects.integration.kotlin.tables.ProgramV1Table
import com.metaobjects.integration.kotlin.tables.ProgramV2Table
import com.metaobjects.integration.kotlin.tables.WeekTable
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.transactions.transaction
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.sql.DriverManager
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Migration scenario coverage for the Kotlin/Exposed substrate. Exposed's
 * `SchemaUtils.create(*tables)` is the analogue of the sibling Java port's
 * "emit + apply CREATE DDL against the live connection" loop — both produce
 * the canonical base-table set from an empty Postgres. For additive column
 * migrations, `SchemaUtils.addMissingColumnsStatements(*tables)` is the
 * analogue of `SchemaMigrationEngine.emit(...)` producing an ALTER TABLE
 * ADD COLUMN statement.
 *
 * Scenarios:
 *  - [bootstrap_canonical_from_empty]: SchemaUtils.create(...) the canonical
 *    base-table set. Asserts against the apply-up-then-query post-condition.
 *  - [add_nullable_column]: bootstrap v1 (id + title only), seed two rows,
 *    invoke addMissingColumnsStatements with v2 → assert it surfaces
 *    `ALTER TABLE ... ADD COLUMN "subtitle" VARCHAR(200)` (Exposed's quoting
 *    matches the corpus `up-contains` expectation), apply it, then query.
 *  - [drop_table_blocked_without_allow]: bootstrap v1 (`programs`), declare
 *    an empty expected table set (the target metadata has no entities), and
 *    drive the diff through [ExposedMigrationEngine]. Asserts that
 *    [ExposedMigrationEngine.diff] surfaces a blocked DropTable, that
 *    [ExposedMigrationEngine.apply] throws [BlockedChangesError], and that
 *    the `programs` table is NOT dropped from the live schema — closes the
 *    last persistence-conformance gap for the Kotlin port.
 *
 * NOT registered in the parent reactor — run via:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml test
 */
internal class MigrationScenarioConformanceTest {

    @Test
    fun `bootstrap canonical from empty creates the expected base tables`() {
        val corpus = ScenarioLoader.findCorpusRoot()
        val scenarios = ScenarioLoader.loadMigrations(corpus.resolve("migrations"))
        val bootstrap = scenarios.singleOrNull { it.name == "bootstrap-canonical-from-empty" }
            ?: error("Expected scenario 'bootstrap-canonical-from-empty' in corpus")

        PostgresContainer().use { pg ->
            val db = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)

            // 1. Apply the canonical schema via Exposed's full-CREATE path —
            //    Exposed's analogue of the sibling SchemaMigrationEngine.emit() flow.
            transaction(db) {
                SchemaUtils.create(ProgramTable, WeekTable)
            }

            // 2. Run the scenario's apply-up-then-query post-condition: it queries
            //    information_schema for the BASE TABLE set in 'public' and lists the
            //    expected rows. We compare via Normalization-canonical JSON so the
            //    assertion line is byte-equal to the sibling Java port's.
            val auq = bootstrap.expect.applyUpThenQuery
                ?: error("Bootstrap scenario must declare apply-up-then-query")

            val actualRows = queryRows(pg, auq.sql)

            val expectedJson = Normalization.canonicalRowsJson(auq.rows)
            val actualJson = Normalization.canonicalRowsJson(actualRows)
            assertEquals(expectedJson, actualJson, "bootstrap-canonical-from-empty base-table set mismatch")

            // 3. Sanity: assert each expected table also has columns we declared.
            //    (Catches the failure mode where SchemaUtils silently no-ops because
            //    the Table object's column list was empty.)
            assertColumnsExist(pg, "programs", listOf("id", "title", "priceCents", "status", "createdAt"))
            assertColumnsExist(pg, "weeks", listOf("id", "programId", "label"))
        }
    }

    /** Run [sql] against [pg], materialise the resultset to a list of column-name → value maps. */
    private fun queryRows(pg: PostgresContainer, sql: String): List<Map<String, Any?>> =
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            c.createStatement().use { stmt ->
                stmt.executeQuery(sql).use { rs ->
                    val out = mutableListOf<Map<String, Any?>>()
                    val meta = rs.metaData
                    while (rs.next()) {
                        val row = LinkedHashMap<String, Any?>(meta.columnCount)
                        for (i in 1..meta.columnCount) row[meta.getColumnLabel(i)] = rs.getObject(i)
                        out.add(row)
                    }
                    out
                }
            }
        }

    /** List BASE TABLE names in the `public` schema via JDBC metadata. */
    private fun listLiveTableNames(pg: PostgresContainer): Set<String> =
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            val out = mutableSetOf<String>()
            c.metaData.getTables(null, "public", "%", arrayOf("TABLE")).use { rs ->
                while (rs.next()) out.add(rs.getString("TABLE_NAME"))
            }
            out
        }

    @Test
    fun `add nullable column emits ALTER TABLE ADD COLUMN and preserves existing rows`() {
        val corpus = ScenarioLoader.findCorpusRoot()
        val scenarios = ScenarioLoader.loadMigrations(corpus.resolve("migrations"))
        val scenario = scenarios.singleOrNull { it.name == "add-nullable-column" }
            ?: error("Expected scenario 'add-nullable-column' in corpus")

        PostgresContainer().use { pg ->
            val db = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)

            // 1. Bootstrap the v1 schema — `id` + `title` only.
            transaction(db) {
                SchemaUtils.create(ProgramV1Table)
            }

            // 2. Seed the v1 rows from the scenario's seed-data SQL.
            scenario.seedData?.takeIf { it.isNotBlank() }?.let { sql ->
                DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
                    c.createStatement().use { it.execute(sql) }
                }
            }

            // 3. Generate ALTER statements from the v2 shape vs the live schema.
            //    `addMissingColumnsStatements` is Exposed's diff-and-emit helper for
            //    additive column changes — the substrate-level analogue of the
            //    sibling Java port's SchemaMigrationEngine.emit() for ADD COLUMN.
            val alterStatements = transaction(db) {
                SchemaUtils.addMissingColumnsStatements(ProgramV2Table)
            }

            // 4. Substrate-aware up-contains assertion.
            //    The corpus's up-contains needles are Java/TS/C#-emitter-shaped
            //    (`ALTER TABLE "programs" ADD COLUMN "subtitle" VARCHAR(200)`).
            //    Exposed's emitter produces semantically-equivalent SQL with
            //    different surface form: no identifier quoting on bare lowercase
            //    tables, no `COLUMN` keyword, trailing `NULL` for nullable.
            //    We normalize both sides to a shape-only signature and assert
            //    the structural pieces match — captures the real conformance
            //    contract (ADD `subtitle` of type VARCHAR(200) on `programs`)
            //    while tolerating the substrate's lexical divergence.
            val joined = alterStatements.joinToString("\n")
            for (needle in scenario.expect.upContains) {
                val sig = sqlSignature(needle)
                val joinedSig = sqlSignature(joined)
                assertTrue(
                    joinedSig.contains(sig),
                    "expected ALTER statements to contain shape-equivalent of '$needle'\n" +
                        "  needle signature : '$sig'\n" +
                        "  emitted SQL      : $joined\n" +
                        "  emitted signature: '$joinedSig'"
                )
            }

            // 5. Apply the emitted statements then run the post-condition query.
            transaction(db) {
                for (stmt in alterStatements) {
                    exec(stmt)
                }
            }

            val auq = scenario.expect.applyUpThenQuery
                ?: error("add-nullable-column scenario must declare apply-up-then-query")
            val actualRows = queryRows(pg, auq.sql)
            val expectedJson = Normalization.canonicalRowsJson(auq.rows)
            val actualJson = Normalization.canonicalRowsJson(actualRows)
            assertEquals(expectedJson, actualJson, "add-nullable-column post-query mismatch")
        }
    }

    @Test
    fun `drop table blocked without allow refuses to drop and surfaces the block`() {
        val corpus = ScenarioLoader.findCorpusRoot()
        val scenarios = ScenarioLoader.loadMigrations(corpus.resolve("migrations"))
        val scenario = scenarios.singleOrNull { it.name == "drop-table-blocked-without-allow" }
            ?: error("Expected scenario 'drop-table-blocked-without-allow' in corpus")

        PostgresContainer().use { pg ->
            val db = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)

            // 1. Bootstrap the seed-metadata state — `programs` table with id + title.
            //    Mirrors the v1 metadata in fixtures/persistence-conformance/migrations/states/program-v1/.
            transaction(db) {
                SchemaUtils.create(ProgramV1Table)
            }

            // 2. Build the "expected" Table set for the target metadata. The
            //    target is empty (`target-metadata-inline: { ... children: [] }`),
            //    so the expected set is empty too — the diff should surface a
            //    drop-table for `programs`.
            val expectedTables = emptyList<org.jetbrains.exposed.sql.Table>()

            // 3. Drive the diff with allowDropTable = false (the scenario's
            //    "without-allow" leg). Confirm the destructive change is
            //    classified as blocked, not allowed.
            val diff = DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
                ExposedMigrationEngine.diff(c, expectedTables, AllowOptions(allowDropTable = false))
            }

            assertTrue(
                diff.blocked.isNotEmpty(),
                "expected drop-table to be blocked without allowDropTable; diff=$diff"
            )
            assertTrue(
                diff.blocked.any { it is Change.DropTable && it.tableName == "programs" },
                "expected blocked DropTable for 'programs'; blocked=${diff.blocked}"
            )

            // 4. Cross-check against the corpus expectation shape:
            //    blocked[].kind == 'DropTable' and reason-contains 'allow.dropTable'.
            for (expectedBlock in scenario.expect.blocked) {
                val match = diff.blocked.any { it.kind == expectedBlock.kind }
                assertTrue(match, "expected blocked kind '${expectedBlock.kind}' not found in $diff")
            }

            // 5. Calling apply() must throw BlockedChangesError, and the message
            //    must name the `allow.dropTable` flag (the corpus's
            //    `reason-contains` value).
            val err = assertThrows<BlockedChangesError> {
                DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
                    ExposedMigrationEngine.apply(c, db, expectedTables, AllowOptions(allowDropTable = false))
                }
            }
            for (expectedBlock in scenario.expect.blocked) {
                val needle = expectedBlock.reasonContains
                if (needle.isNotBlank()) {
                    assertTrue(
                        err.message!!.contains(needle),
                        "expected BlockedChangesError message to contain '$needle'; got: ${err.message}"
                    )
                }
            }

            // 6. Critically: the `programs` table must still exist in the live
            //    schema. The corpus contract is "runner should NOT execute the
            //    up SQL when blocked" — apply() must be transactionally inert.
            val liveTables = listLiveTableNames(pg)
            assertTrue(
                "programs" in liveTables,
                "expected 'programs' to still exist after blocked apply; liveTables=$liveTables"
            )

            // 7. Sanity: passing allowDropTable=true allows the drop through —
            //    proves the gate is the policy, not the substrate. (Same
            //    engine, opposite leg of the same scenario.)
            DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
                ExposedMigrationEngine.apply(c, db, expectedTables, AllowOptions(allowDropTable = true))
            }
            val liveTablesAfterAllow = listLiveTableNames(pg)
            assertFalse(
                "programs" in liveTablesAfterAllow,
                "expected 'programs' to be dropped once allowDropTable=true; liveTables=$liveTablesAfterAllow"
            )
        }
    }

    /**
     * Normalize a SQL fragment to a shape-only signature so different emitters
     * (Java/TS/C# vs Exposed) can be compared structurally without coupling to
     * each substrate's lexical choices (identifier quoting, optional COLUMN
     * keyword, trailing NULL/NOT NULL on additive nullable columns).
     *
     * Strips:
     *  - all double quotes (`"id"` → `id`)
     *  - the `COLUMN` keyword between `ADD` and the column name
     *  - trailing `NULL` (additive nullable column — implicit in both shapes)
     *  - all whitespace runs collapsed to a single space
     *  - lower-cases everything for case-insensitive keyword matching
     */
    private fun sqlSignature(sql: String): String =
        sql.replace("\"", "")
            .replace(Regex("\\bCOLUMN\\b", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\bNULL\\b\\s*$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s+"), " ")
            .trim()
            .lowercase()

    private fun assertColumnsExist(pg: PostgresContainer, table: String, expectedColumns: List<String>) {
        val sql = """
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = '$table'
             ORDER BY column_name
        """.trimIndent()
        val actualColumns = queryRows(pg, sql).map { it["column_name"] as String }
        for (col in expectedColumns) {
            assertTrue(
                col in actualColumns,
                "table '$table' missing expected column '$col' — got: $actualColumns"
            )
        }
    }
}

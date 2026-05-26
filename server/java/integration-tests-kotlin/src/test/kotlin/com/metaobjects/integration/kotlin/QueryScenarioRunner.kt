package com.metaobjects.integration.kotlin

import com.metaobjects.integration.kotlin.Scenarios.QueryScenario
import com.metaobjects.integration.kotlin.Scenarios.QuerySpec
import com.metaobjects.integration.kotlin.tables.ProgramTable
import com.metaobjects.integration.kotlin.tables.WeekTable
import org.jetbrains.exposed.sql.AndOp
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.Op
import org.jetbrains.exposed.sql.Query
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.SqlExpressionBuilder
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import java.sql.DriverManager
import java.sql.Timestamp
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset

/**
 * Mirrors the Java `QueryScenarioRunner` but the persistence substrate is
 * JetBrains Exposed, not ObjectManagerDB:
 *
 *  1. Connect Exposed to the testcontainer's Postgres.
 *  2. `SchemaUtils.create(...)` the fitness Tables.
 *  3. Run the scenario's seed-data SQL verbatim.
 *  4. For each [QuerySpec]: dispatch to Exposed (`selectAll`/`count` + Op filter),
 *     normalize the result, compare against the scenario's `expect` block.
 *
 * Only entities exercised by the curated query-scenario subset need to be
 * dispatched in [tableFor]. New scenarios touching other entities will need
 * to extend that map.
 */
object QueryScenarioRunner {

    /**
     * Run a single query scenario end-to-end. Schema creation is idempotent within
     * a fresh container (one container per scenario at the JUnit level).
     */
    fun run(scenario: QueryScenario, pg: PostgresContainer) {
        val db = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)

        transaction(db) {
            SchemaUtils.create(ProgramTable, WeekTable)
        }

        // 2. Seed via the YAML's raw SQL — runs outside Exposed transactions, on a
        // direct JDBC connection, because the seed SQL is portable Postgres DDL/DML
        // that may use double-quoted identifiers Exposed wouldn't synthesize.
        scenario.seedData?.takeIf { it.isNotBlank() }?.let { sql ->
            DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
                c.createStatement().use { it.execute(sql) }
            }
        }

        // 3. Run queries; each gets its own Exposed transaction.
        for (spec in scenario.queries) {
            val actual = transaction(db) { dispatch(spec) }
            assertResult(scenario.sourcePath, spec, actual)
        }
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    private fun dispatch(spec: QuerySpec): Any? {
        val table = tableFor(spec.entity)
        return when (spec.op) {
            "count" -> {
                val q = table.selectAll()
                applyFilter(q, table, spec.filter)
                q.count()
            }
            "get" -> {
                val q = table.selectAll()
                applyBy(q, table, spec.by)
                val row = q.singleOrNull()
                row?.let { rowToMap(it, table) }
            }
            "list" -> {
                val q = table.selectAll()
                applyFilter(q, table, spec.filter)
                applySort(q, table, spec.sort)
                spec.limit?.let { q.limit(it, (spec.offset ?: 0).toLong()) }
                q.map { rowToMap(it, table) }
            }
            else -> error("Unsupported op '${spec.op}' for ${spec.name}")
        }
    }

    private fun tableFor(entity: String): Table = when (entity) {
        "Program" -> ProgramTable
        "Week" -> WeekTable
        else -> error("No Exposed Table registered for entity '$entity' — extend QueryScenarioRunner.tableFor")
    }

    // -----------------------------------------------------------------------
    // Filter / by / sort
    // -----------------------------------------------------------------------

    /** A `by` block is shorthand for an equality filter — convert + delegate. */
    private fun applyBy(q: Query, table: Table, by: Map<String, Any?>?) {
        if (by.isNullOrEmpty()) return
        val combined = combine(by.entries.map { (field, raw) ->
            val col = columnFor(table, field)
            buildEq(col, coerce(raw, col))
        }) ?: return
        q.adjustWhere { combined }
    }

    /**
     * Translate a YAML filter block into Exposed `Op<Boolean>`. Only the
     * operators surfaced by the curated query-scenario subset are
     * implemented (eq); broader operator support belongs in a follow-up
     * once more scenarios land.
     */
    @Suppress("UNCHECKED_CAST")
    private fun applyFilter(q: Query, table: Table, filter: Map<String, Any?>?) {
        if (filter.isNullOrEmpty()) return
        val ops = mutableListOf<Op<Boolean>>()
        for ((field, opsRaw) in filter) {
            val col = columnFor(table, field)
            val opMap = opsRaw as? Map<String, Any?>
                ?: error("filter for '$field' must be an op-map (e.g. { eq: ... }); got: $opsRaw")
            for ((op, raw) in opMap) {
                val coerced = coerce(raw, col)
                ops += when (op) {
                    "eq" -> buildEq(col, coerced)
                    else -> error("Unsupported filter op '$op' for ${col.name} — extend QueryScenarioRunner.applyFilter")
                }
            }
        }
        val combined = combine(ops) ?: return
        q.adjustWhere { combined }
    }

    /**
     * Build an equality op via Exposed's [SqlExpressionBuilder] receiver — the
     * scope that defines `Column<T>.eq(value)`. Keeps the call out of `where`-
     * lambda noise so we can mix it freely with `adjustWhere`.
     */
    @Suppress("UNCHECKED_CAST")
    private fun buildEq(col: Column<*>, value: Any?): Op<Boolean> =
        with(SqlExpressionBuilder) { (col as Column<Any?>).eq(value) }

    /**
     * Combine a list of ops with AND — explicit [AndOp] avoids the
     * `Expression<Boolean>.and(...)` extension overload ambiguity between
     * the eager and lambda forms.
     */
    private fun combine(ops: List<Op<Boolean>>): Op<Boolean>? = when (ops.size) {
        0 -> null
        1 -> ops[0]
        else -> AndOp(ops)
    }

    private fun applySort(q: Query, table: Table, sorts: List<Scenarios.SortSpec>?) {
        if (sorts.isNullOrEmpty()) return
        val orderArgs = sorts.map { spec ->
            val col = columnFor(table, spec.field)
            val order = if (spec.dir.equals("desc", ignoreCase = true)) SortOrder.DESC else SortOrder.ASC
            col to order
        }.toTypedArray()
        q.orderBy(*orderArgs)
    }

    private fun columnFor(table: Table, name: String): Column<*> =
        table.columns.firstOrNull { it.name == name }
            ?: error("No column '$name' on table '${table.tableName}'")

    /**
     * Coerce a YAML scalar to the JVM type the Exposed column expects. YAML
     * surfaces small ints as Int and timestamps as String; the col may be a
     * Long, Instant, etc.
     */
    private fun coerce(raw: Any?, col: Column<*>): Any? {
        if (raw == null) return null
        val type = col.columnType.sqlType().lowercase()
        return when {
            type.contains("bigint") || type.contains("int8") -> (raw as? Number)?.toLong() ?: raw.toString().toLong()
            type.contains("int") -> (raw as? Number)?.toInt() ?: raw.toString().toInt()
            else -> raw
        }
    }

    // -----------------------------------------------------------------------
    // Row materialization + assertion
    // -----------------------------------------------------------------------

    private fun rowToMap(row: ResultRow, table: Table): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(table.columns.size)
        for (col in table.columns) {
            var v: Any? = row[col]
            // Exposed surfaces `timestamp` as java.time.Instant; the normalization
            // contract emits TIMESTAMP (no TZ) as `yyyy-MM-ddTHH:mm:ss`. Convert
            // to LocalDateTime in UTC so Normalization formats it correctly.
            if (v is Instant) v = LocalDateTime.ofInstant(v, ZoneOffset.UTC)
            if (v is Timestamp) v = v.toLocalDateTime()
            out[col.name] = v
        }
        return out
    }

    @Suppress("UNCHECKED_CAST")
    private fun assertResult(scenarioPath: String, spec: QuerySpec, actual: Any?) {
        val expectedJson = canonicalizeExpected(spec.expect, spec.op)
        val actualJson = canonicalizeActual(actual, spec.op)
        if (expectedJson != actualJson) {
            throw AssertionError(
                "$scenarioPath / ${spec.name}: result mismatch\n" +
                    "  expected: $expectedJson\n" +
                    "  actual:   $actualJson"
            )
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun canonicalizeExpected(expect: Any?, op: String): String {
        if (op == "count") {
            val n = (expect as? Number)?.toLong() ?: expect.toString().toLong()
            return n.toString()
        }
        if (op == "get") {
            if (expect == null) return "null"
            // Strip the surrounding [] off canonicalRowsJson — get returns the bare object.
            return Normalization.canonicalRowsJson(listOf(expect as Map<String, Any?>))
                .removePrefix("[").removeSuffix("]")
        }
        if (expect == null) return "[]"
        return Normalization.canonicalRowsJson(expect as List<Map<String, Any?>>)
    }

    @Suppress("UNCHECKED_CAST")
    private fun canonicalizeActual(actual: Any?, op: String): String {
        if (op == "count") {
            val n = (actual as? Number)?.toLong() ?: 0L
            return n.toString()
        }
        if (actual == null) return "null"
        if (op == "get") {
            return Normalization.canonicalRowsJson(listOf(actual as Map<String, Any?>))
                .removePrefix("[").removeSuffix("]")
        }
        return Normalization.canonicalRowsJson(actual as List<Map<String, Any?>>)
    }
}

package com.metaobjects.integration.kotlin

import com.metaobjects.integration.kotlin.Scenarios.QueryScenario
import com.metaobjects.integration.kotlin.Scenarios.QuerySpec
import com.metaobjects.integration.kotlin.tables.ProgramStatView
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
import org.jetbrains.exposed.sql.IsNotNullOp
import org.jetbrains.exposed.sql.IsNullOp
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

        // 2b. Projection views — only created when a scenario actually touches
        // the relevant projection entity. Cheap and explicit; avoids running
        // view DDL on scenarios that don't need it.
        if (scenario.queries.any { it.entity == "ProgramStat" }) {
            DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
                c.createStatement().use { it.execute(ProgramStatView.VIEW_DDL) }
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
        "ProgramStat" -> ProgramStatView
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
     * Translate a YAML filter block into Exposed `Op<Boolean>`. Supports the
     * cross-language filter vocabulary: eq, ne, gt, gte, lt, lte, in, like,
     * isNull. Also supports the top-level `and: [...]` combinator the corpus
     * uses for two-op-on-one-field range queries (filter-range-and).
     */
    @Suppress("UNCHECKED_CAST")
    private fun applyFilter(q: Query, table: Table, filter: Map<String, Any?>?) {
        if (filter.isNullOrEmpty()) return
        val combined = buildFilterOp(table, filter) ?: return
        q.adjustWhere { combined }
    }

    /**
     * Recursively build an `Op<Boolean>` from a filter map. A filter map is
     * either:
     *  - a single-entry map `{ and: [<filter>, <filter>, ...] }` (combinator),
     *  - or a per-field map `{ fieldName: { op: value, ... }, ... }` ANDed together.
     */
    @Suppress("UNCHECKED_CAST")
    private fun buildFilterOp(table: Table, filter: Map<String, Any?>): Op<Boolean>? {
        // Combinator: `and: [...]` — recurse on each child filter map, AND together.
        if (filter.size == 1 && filter.containsKey("and")) {
            val list = filter["and"] as? List<Map<String, Any?>>
                ?: error("`and` value must be a list of filter maps; got: ${filter["and"]}")
            val childOps = list.mapNotNull { buildFilterOp(table, it) }
            return combine(childOps)
        }
        val ops = mutableListOf<Op<Boolean>>()
        for ((field, opsRaw) in filter) {
            val col = columnFor(table, field)
            val opMap = opsRaw as? Map<String, Any?>
                ?: error("filter for '$field' must be an op-map (e.g. { eq: ... }); got: $opsRaw")
            for ((op, raw) in opMap) {
                ops += buildOp(col, op, raw)
            }
        }
        return combine(ops)
    }

    /**
     * Build a single Exposed `Op<Boolean>` from `(column, op-name, raw-value)`.
     * `isNull` is value-shaped: `{ isNull: true }` → IS NULL, `{ isNull: false }` → IS NOT NULL.
     */
    @Suppress("UNCHECKED_CAST")
    private fun buildOp(col: Column<*>, op: String, raw: Any?): Op<Boolean> {
        val any = col as Column<Any?>
        // Comparable cast — gt/gte/lt/lte require `T: Comparable<T>`; YAML scalars
        // (Long, String, Instant) all satisfy that at runtime, but the static type
        // system needs the explicit shape. UNCHECKED_CAST suppression covers it.
        val cmp = col as Column<Comparable<Any>>
        return when (op) {
            "eq" -> buildEq(col, coerce(raw, col))
            "ne" -> with(SqlExpressionBuilder) { any neq coerce(raw, col) }
            "gt" -> with(SqlExpressionBuilder) { cmp greater (coerce(raw, col) as Comparable<Any>) }
            "gte" -> with(SqlExpressionBuilder) { cmp greaterEq (coerce(raw, col) as Comparable<Any>) }
            "lt" -> with(SqlExpressionBuilder) { cmp less (coerce(raw, col) as Comparable<Any>) }
            "lte" -> with(SqlExpressionBuilder) { cmp lessEq (coerce(raw, col) as Comparable<Any>) }
            "like" -> {
                val pattern = (raw as? String)
                    ?: error("`like` value must be a string pattern; got: $raw")
                with(SqlExpressionBuilder) { (col as Column<String>) like pattern }
            }
            "in" -> {
                val list = (raw as? List<Any?>)
                    ?: error("`in` value must be a list; got: $raw")
                val coerced = list.map { coerce(it, col) }
                with(SqlExpressionBuilder) { any inList coerced }
            }
            "isNull" -> {
                val flag = raw as? Boolean
                    ?: error("`isNull` value must be a boolean; got: $raw")
                if (flag) IsNullOp(col) else IsNotNullOp(col)
            }
            else -> error("Unsupported filter op '$op' for ${col.name} — extend QueryScenarioRunner.buildOp")
        }
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

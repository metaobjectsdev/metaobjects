package com.metaobjects.integration.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.MetaRoot
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.MetaRelationship
import com.metaobjects.integration.kotlin.Scenarios.QueryScenario
import com.metaobjects.integration.kotlin.Scenarios.QuerySpec
import com.metaobjects.integration.kotlin.tables.AssetTable
import com.metaobjects.integration.kotlin.tables.AuthTable
import com.metaobjects.integration.kotlin.tables.MeasurementTable
import com.metaobjects.integration.kotlin.tables.NodeTable
import com.metaobjects.integration.kotlin.tables.ProgramStatView
import com.metaobjects.integration.kotlin.tables.ProgramTable
import com.metaobjects.integration.kotlin.tables.ProgramView
import com.metaobjects.integration.kotlin.tables.WeekTable
import org.jetbrains.exposed.sql.AndOp
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.Op
import org.jetbrains.exposed.sql.Query
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.SqlExpressionBuilder
import org.jetbrains.exposed.sql.IsNotNullOp
import org.jetbrains.exposed.sql.IsNullOp
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import org.jetbrains.exposed.sql.statements.InsertStatement
import org.jetbrains.exposed.sql.transactions.transaction
import com.metaobjects.integration.kotlin.tables.AllTypesTable
import java.math.BigDecimal
import java.net.URI
import java.sql.DriverManager
import java.sql.Timestamp
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneOffset
import java.util.UUID

/**
 * Mirrors the Java `QueryScenarioRunner` but the persistence substrate is
 * JetBrains Exposed, not ObjectManagerDB:
 *
 *  1. Connect Exposed to the testcontainer's Postgres.
 *  2. Provision the schema by executing the committed canonical DDL
 *     (`fixtures/persistence-conformance/canonical/schema.postgres.sql`)
 *     verbatim. Schema authority is TS-only (ADR-0015); the Kotlin port no
 *     longer creates the schema from Exposed `Table` objects.
 *  3. Run the scenario's seed-data SQL verbatim.
 *  4. For each [QuerySpec]: dispatch to Exposed (`selectAll`/`count` + Op filter),
 *     normalize the result, compare against the scenario's `expect` block.
 *
 * The Exposed `Table` objects ([ProgramTable], [WeekTable], etc.) survive only
 * as the runtime data-access mapping the query dispatcher addresses — they no
 * longer create tables. Their column names match the canonical DDL's literal
 * (camelCase) physical columns so the queries hit the right columns.
 *
 * Only entities exercised by the curated query-scenario subset need to be
 * dispatched in [tableFor]. New scenarios touching other entities will need
 * to extend that map.
 */
object QueryScenarioRunner {

    /**
     * Run a single query scenario end-to-end against a fresh container (one
     * container per scenario at the JUnit level).
     */
    fun run(scenario: QueryScenario, pg: PostgresContainer) {
        val db = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)

        val corpus = ScenarioLoader.findCorpusRoot()

        // 1. Provision the schema from the committed canonical DDL (base tables +
        //    projection views). Executed verbatim on a direct JDBC connection —
        //    schema authority is the TS-produced artifact, not Exposed.
        val schemaDdl = ScenarioLoader.readCanonicalSchema(corpus)
        execSql(pg, schemaDdl)

        // 2. Seed via the YAML's raw SQL.
        scenario.seedData?.takeIf { it.isNotBlank() }?.let { sql -> execSql(pg, sql) }

        // 3. Load the canonical metadata root once per scenario — op:relate derives
        //    the M:N junction FK fields + physical table/column names from it (the
        //    cross-port SSOT via M2MFields.derive). Tagged uniquely so registry
        //    state can't leak across scenarios. Non-relate ops never touch it.
        val loaderTag = "ktx-query-" + java.util.UUID.randomUUID().toString().substring(0, 8)
        val root: MetaRoot = MetaDataLoader.fromDirectory(loaderTag, corpus.resolve("canonical")).root

        // 4. Run queries; each gets its own Exposed transaction.
        for (spec in scenario.queries) {
            // FR-017 TPH: an `expect-error: true` op (a cross-subtype write rejection) MUST throw —
            // any exception from the dispatch counts as the expected error (the transaction rolls back).
            if (spec.expectError) {
                var threw = false
                try { transaction(db) { dispatch(spec, root) } } catch (e: Throwable) { threw = true }
                if (!threw) throw AssertionError(
                    "${scenario.sourcePath} / ${spec.name}: expected the op to be rejected (expect-error) but it succeeded")
                continue
            }
            val actual = transaction(db) { dispatch(spec, root) }
            assertResult(scenario.sourcePath, spec, actual)
        }
    }

    /**
     * Execute verbatim SQL on a fresh direct JDBC connection — used for both the
     * canonical schema DDL and the scenario's seed SQL, neither of which goes
     * through Exposed (they may use double-quoted identifiers Exposed wouldn't
     * synthesize).
     */
    private fun execSql(pg: PostgresContainer, sql: String) {
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            c.createStatement().use { it.execute(sql) }
        }
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    private fun dispatch(spec: QuerySpec, root: MetaRoot): Any? {
        // op:relate is metadata-driven (M:N junction traversal) — it does NOT go
        // through the Exposed Table map; resolve it before tableFor() is consulted.
        if (spec.op == "relate") return dispatchRelate(spec, root)

        val table = tableFor(spec.entity)

        // FR-017 TPH: when the entity is a discriminator base or subtype it maps to the SINGLE
        // shared table. A subtype's create injects its discriminator; its reads/updates/deletes are
        // scoped to that discriminator (a row of a different subtype is invisible). The row is
        // projected to the ENTITY's own fields (the base reads base columns; a subtype adds its
        // own column) — NOT the whole physical table — so each surfaces only its columns.
        val entityMeta: MetaObject? = entityOrNull(root, spec.entity)
        val tph: TphSubtype? = entityMeta?.let { tphSubtypeOf(it) }
        // Project a row to the entity's own fields ONLY for a TPH base/subtype (which share a wider
        // physical table); every other entity passes null → the existing "all table columns" shape.
        val isTphBase: Boolean = entityMeta?.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false) == true
        val projectFields: Set<String>? =
            if (tph != null || isTphBase) entityMeta?.metaFields?.map { it.name }?.toSet() else null

        // op:roundtrip — WRITE the insert row through Exposed, read back by PK, drop PK.
        if (spec.op == "roundtrip") return dispatchRoundtrip(spec, table)
        // op:create — INSERT a row (TPH: discriminator injected from the entity), read back by PK (PK retained).
        if (spec.op == "create") return dispatchCreate(spec, table, tph, projectFields)
        // op:update — PATCH a row through the Exposed write path, read back by PK (PK retained).
        if (spec.op == "update") return dispatchUpdate(spec, table, tph, projectFields, entityMeta)
        // op:delete — DELETE a row by PK through the Exposed write path; boolean outcome.
        if (spec.op == "delete") return dispatchDelete(spec, table, tph)

        return when (spec.op) {
            "count" -> {
                val q = table.selectAll()
                applyFilter(q, table, spec.filter)
                scope(q, table, tph)
                q.count()
            }
            "get" -> {
                val q = table.selectAll()
                applyBy(q, table, spec.by)
                scope(q, table, tph)
                val row = q.singleOrNull()
                row?.let { rowToMap(it, table, projectFields) }
            }
            "list" -> {
                val q = table.selectAll()
                applyFilter(q, table, spec.filter)
                scope(q, table, tph)
                applySort(q, table, spec.sort)
                spec.limit?.let { q.limit(it, (spec.offset ?: 0).toLong()) }
                q.map { rowToMap(it, table, projectFields) }
            }
            else -> error("Unsupported op '${spec.op}' for ${spec.name}")
        }
    }

    /** The discriminator field NAME + this subtype's discriminator VALUE (a resolved TPH subtype). */
    private data class TphSubtype(val field: String, val value: String)

    /**
     * If [entity] is a TPH subtype, return its discriminator field + value; else null. A subtype
     * declares `@discriminatorValue` (own attr) and inherits `@discriminator` from an ancestor in
     * its resolved super chain. Mirrors the Java `TphHelper` / Python `runtime/tph.py`.
     */
    private fun tphSubtypeOf(entity: MetaObject): TphSubtype? {
        if (!entity.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false)) return null
        val value = entity.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false).valueAsString
        var ancestor: MetaObject? = entity.superObject
        while (ancestor != null) {
            if (ancestor.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false)) {
                return TphSubtype(ancestor.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false).valueAsString, value)
            }
            ancestor = ancestor.superObject
        }
        return null
    }

    private fun entityOrNull(root: MetaRoot, name: String): MetaObject? =
        root.getChildren(MetaObject::class.java, false).firstOrNull { it.shortName == name }

    /** FR-017 TPH: AND the discriminator predicate into a query when [tph] is a subtype (subtype-scoped reads). */
    private fun scope(q: Query, table: Table, tph: TphSubtype?) {
        if (tph == null) return
        val disc = buildEq(columnFor(table, tph.field), tph.value)
        val existing: Op<Boolean>? = q.where
        q.adjustWhere { if (existing == null) disc else AndOp(listOf(existing, disc)) }
    }

    /**
     * op:create — INSERT a row through the Exposed write path. For a TPH subtype the discriminator
     * (`type`) is injected from the entity, never the body. Read back BY the server-generated PK and
     * project to the entity's fields (the create `expect` block retains the id).
     */
    @Suppress("UNCHECKED_CAST")
    private fun dispatchCreate(spec: QuerySpec, table: Table, tph: TphSubtype?, projectFields: Set<String>?): Map<String, Any?>? {
        val data = spec.data
            ?: error("op:create / ${spec.name}: a `data` block (the row to write) is required")
        val pkCol = table.primaryKey?.columns?.singleOrNull()
            ?: error("op:create / ${spec.name}: table '${table.tableName}' must have a single-column primary key")

        val statement: InsertStatement<Number> = table.insert { stmt ->
            for ((field, raw) in data) {
                val col = columnFor(table, field) as Column<Any?>
                stmt[col] = coerceForWrite(raw, col)
            }
            if (tph != null) {
                val discCol = columnFor(table, tph.field) as Column<Any?>
                stmt[discCol] = tph.value // discriminator injected from the entity
            }
        }

        val pkValue = statement[pkCol as Column<Any?>]
            ?: error("op:create / ${spec.name}: insert did not yield a primary key value")
        val q = table.selectAll()
        q.adjustWhere { buildEq(pkCol, pkValue) }
        return q.singleOrNull()?.let { rowToMap(it, table, projectFields) } // PK retained
    }

    /**
     * op:relate — traverse an M:N relationship from a single source entity to its
     * related target rows. The source id comes straight from the scenario `by:`
     * block (e.g. `{ id: 1 }`); the named `relation` is located on the source
     * entity's metadata; the junction traversal + target load is delegated to the
     * generic metadata-driven [M2MResolver] (which derives the junction FK fields
     * via the shared `M2MFields.derive` SSOT). The `relate` verb is order-
     * independent (the runner sorts both sides before comparing).
     */
    private fun dispatchRelate(spec: QuerySpec, root: MetaRoot): List<Map<String, Any?>> {
        val sourceMeta = mustGetEntity(root, spec.entity)
        val sourceId = (spec.by ?: emptyMap())["id"]
            ?: error("op:relate / ${spec.name}: a `by: { id: ... }` source key is required")
        val relationName = spec.relation
            ?: error("op:relate / ${spec.name}: a `relation` (M:N relationship name) is required")
        val rel: MetaRelationship = sourceMeta.relationships.firstOrNull { it.shortName == relationName }
            ?: error(
                "op:relate / ${spec.name}: no relationship named '$relationName' on entity " +
                    "'${sourceMeta.shortName}'"
            )

        // The underlying java.sql.Connection of the current Exposed transaction.
        val jdbc = org.jetbrains.exposed.sql.transactions.TransactionManager
            .current().connection.connection as java.sql.Connection

        return M2MResolver.resolve(jdbc, sourceMeta, sourceId, rel, root)
    }

    /**
     * op:roundtrip — the WRITE gate. INSERT the scenario's `insert:` row through the Exposed
     * write path (NOT raw SQL), coercing each authoring value to the target column's Kotlin
     * type (so the WRITE codec for every field subtype runs); read it back BY the
     * server-generated PK (a fresh SELECT, exercising the read codec); project to a field-keyed
     * row and DROP the PK (server-minted via gen_random_uuid(), non-deterministic).
     *
     * Mirrors the Java/C#/TS RoundtripWriter semantics on the Exposed substrate. The PK column
     * is never supplied on insert — `gen_random_uuid()` mints it — proving server-generated PKs
     * round-trip on the write path too.
     */
    @Suppress("UNCHECKED_CAST")
    private fun dispatchRoundtrip(spec: QuerySpec, table: Table): Map<String, Any?>? {
        val insertRow = spec.insert
            ?: error("op:roundtrip / ${spec.name}: an `insert` block (the row to write) is required")
        val pkCol = table.primaryKey?.columns?.singleOrNull()
            ?: error("op:roundtrip / ${spec.name}: table '${table.tableName}' must have a single-column primary key")

        // 1. INSERT via Exposed, coercing each authoring value to the column's Kotlin type. The
        //    PK column is left unset (gen_random_uuid() fills it server-side).
        val statement: InsertStatement<Number> = table.insert { stmt ->
            for ((field, raw) in insertRow) {
                val col = columnFor(table, field) as Column<Any?>
                stmt[col] = coerceForWrite(raw, col)
            }
        }

        // 2. Capture the server-generated PK Exposed read back from the insert.
        val pkValue = statement[pkCol as Column<Any?>]
            ?: error("op:roundtrip / ${spec.name}: insert did not yield a primary key value")

        // 3. Read back BY PK (fresh SELECT → the read codec runs).
        val q = table.selectAll()
        q.adjustWhere { buildEq(pkCol, pkValue) }
        val row = q.singleOrNull()?.let { rowToMap(it, table) } ?: return null

        // 4. Drop the (server-generated) PK — it's non-deterministic, not part of the expectation.
        return row - pkCol.name
    }

    /**
     * op:update — the UPDATE write gate. PATCH a row through the Exposed write path (NOT raw SQL),
     * coercing each `data:` value to the target column's Kotlin type with the SAME [coerceForWrite]
     * the INSERT path uses — so a port whose UPDATE codec diverges from its INSERT codec is caught.
     * Address the row by its single-column PK (from `by:`), then read it back BY PK (a fresh SELECT
     * → the read codec runs) and return the wire row WITH the PK retained (the update `expect`
     * block asserts the id). Mirrors the Java/C#/TS update semantics on the Exposed substrate.
     */
    @Suppress("UNCHECKED_CAST")
    private fun dispatchUpdate(
        spec: QuerySpec, table: Table, tph: TphSubtype?, projectFields: Set<String>?, entityMeta: MetaObject?,
    ): Map<String, Any?>? {
        val patch = spec.data
            ?: error("op:update / ${spec.name}: a `data` block (the patch to write) is required")
        val (pkCol, pkValue) = requirePkValue(spec, table)

        // FR-017 TPH: a subtype update is SCOPED to its discriminator AND patches only the subtype's
        // own fields. A patch key that is not a field of the subtype (a cross-subtype column) is
        // rejected; a PK that belongs to a different subtype (out of scope) matches no row and is
        // rejected too. Both surface as expect-error.
        if (tph != null) {
            val fieldNames = entityMeta?.metaFields?.map { it.name }?.toSet() ?: emptySet()
            for (key in patch.keys) {
                if (key !in fieldNames) {
                    error("op:update / ${spec.name}: '$key' is not a field of ${spec.entity} (cross-subtype column)")
                }
            }
            val discCol = columnFor(table, tph.field)
            val scoped = { AndOp(listOf(buildEq(pkCol, pkValue), buildEq(discCol, tph.value))) }
            val updated = table.update({ scoped() }) { stmt ->
                for ((field, raw) in patch) {
                    val col = columnFor(table, field) as Column<Any?>
                    stmt[col] = coerceForWrite(raw, col)
                }
            }
            if (updated == 0) {
                error("op:update / ${spec.name}: no ${spec.entity} row with ${pkCol.name}=$pkValue in subtype scope")
            }
            val q = table.selectAll()
            q.adjustWhere { scoped() }
            return q.singleOrNull()?.let { rowToMap(it, table, projectFields) }
        }

        // UPDATE the row by PK, setting each patched column through the WRITE codec.
        table.update({ buildEq(pkCol, pkValue) }) { stmt ->
            for ((field, raw) in patch) {
                val col = columnFor(table, field) as Column<Any?>
                stmt[col] = coerceForWrite(raw, col)
            }
        }

        // Read back BY PK (fresh SELECT → the read codec runs); PK retained for the update expect.
        val q = table.selectAll()
        q.adjustWhere { buildEq(pkCol, pkValue) }
        return q.singleOrNull()?.let { rowToMap(it, table) }
    }

    /**
     * op:delete — the DELETE write gate. DELETE a row by its single-column PK (from `by:`) through
     * the Exposed write path; the boolean outcome is `true` iff a row was removed (delete count > 0).
     * The portable proof the row is gone is a follow-up `op: get` by the same PK asserting null.
     */
    private fun dispatchDelete(spec: QuerySpec, table: Table, tph: TphSubtype?): Boolean {
        val (pkCol, pkValue) = requirePkValue(spec, table)
        // FR-017 TPH: a subtype delete is scoped to its discriminator (cross-subtype id deletes nothing).
        val deleted = if (tph != null) {
            val discCol = columnFor(table, tph.field)
            table.deleteWhere { AndOp(listOf(buildEq(pkCol, pkValue), buildEq(discCol, tph.value))) }
        } else {
            table.deleteWhere { buildEq(pkCol, pkValue) }
        }
        return deleted > 0
    }

    /**
     * Resolve the single-column primary key column + the (write-coerced) PK value from the spec's
     * `by:` block — the shared preamble for the by-PK write ops (`update` / `delete`). Errors with
     * an op-tagged message when the table lacks a single-column PK or `by:` omits the key.
     */
    private fun requirePkValue(spec: QuerySpec, table: Table): Pair<Column<*>, Any?> {
        val pkCol = table.primaryKey?.columns?.singleOrNull()
            ?: error("op:${spec.op} / ${spec.name}: table '${table.tableName}' must have a single-column primary key")
        val pkRaw = (spec.by ?: emptyMap())[pkCol.name]
            ?: error("op:${spec.op} / ${spec.name}: a `by` block carrying the primary key '${pkCol.name}' is required")
        return pkCol to coerceForWrite(pkRaw, pkCol)
    }

    /**
     * Coerce a YAML-parsed authoring value to the JVM type the Exposed column writes. SnakeYAML
     * surfaces scalars as String/Int/Long/Double/Boolean and a nested mapping (the `@objectRef`
     * jsonb value object) as a Map. The target type is keyed off the column's SQL type so this
     * stays generic across the AllTypes columns:
     *
     *  - uuid          → java.util.UUID (the upper-case authoring literal lower-cased; the read
     *                    codec returns it lowercase-canonical, the cross-port contract).
     *  - numeric/dec   → java.math.BigDecimal (exact; the decimal authoring form is a quoted string).
     *  - bigint/int8   → Long; int → Int; real → Float; double → Double.
     *  - date          → java.time.LocalDate ("YYYY-MM-DD").
     *  - time          → java.time.LocalTime ("HH:mm:ss[.fff]"); preserves the millisecond fraction.
     *  - timestamp     → java.time.LocalDateTime (no trailing "Z" — wall-clock, no tz).
     *  - timestamptz   → java.time.Instant (trailing "Z" → absolute instant; the
     *                    instantWithTimeZone Column<Instant> path binds it tz-aware).
     *  - jsonb         → a JSON String (the authoring Map serialized; the raw-String jsonb column
     *                    writes it as a real Postgres JSONB value, not a bare text bind).
     *  - other (varchar/bool) → identity (Exposed binds String/Boolean directly).
     */
    private fun coerceForWrite(raw: Any?, col: Column<*>): Any? {
        if (raw == null) return null
        val type = col.columnType.sqlType().lowercase()
        return when {
            type == "uuid" -> if (raw is UUID) raw else UUID.fromString(raw.toString().lowercase())
            // NUMERIC/DECIMAL: exact BigDecimal from the quoted-string authoring form.
            type.contains("numeric") || type.contains("decimal") -> BigDecimal(raw.toString())
            type.contains("bigint") || type.contains("int8") -> (raw as? Number)?.toLong() ?: raw.toString().toLong()
            // REAL / float4 → Float; DOUBLE PRECISION / float8 → Double. Check the float types
            // before the generic `int` substring guard (neither contains "int", but order-safe).
            type.contains("real") || type == "float4" -> (raw as? Number)?.toFloat() ?: raw.toString().toFloat()
            type.contains("double") || type == "float8" -> (raw as? Number)?.toDouble() ?: raw.toString().toDouble()
            type.contains("int") -> (raw as? Number)?.toInt() ?: raw.toString().toInt()
            // TIMESTAMPTZ → absolute Instant (trailing "Z"); plain TIMESTAMP → wall-clock LocalDateTime.
            type.contains("timestamp") && type.contains("time zone") ->
                Instant.parse(raw.toString())
            type.contains("timestamp") -> {
                val s = raw.toString()
                if (s.endsWith("Z")) LocalDateTime.ofInstant(Instant.parse(s), ZoneOffset.UTC)
                else LocalDateTime.parse(s)
            }
            type == "date" -> LocalDate.parse(raw.toString())
            type.contains("time") -> LocalTime.parse(raw.toString())
            // jsonb column: bind the authoring Map as a JSON string. Both jsonb codec styles in this
            // module accept it via type erasure — the open-bag `Column<JsonElement>` encoder
            // (`{ it.toString() }`) and the object/map `Column<String>` identity encoder (`{ it }`)
            // both receive the String and write a real Postgres JSONB value (a bare String bind
            // would be rejected by jsonb). Read-back (#98) parses it back per-column.
            type.contains("jsonb") -> if (raw is String) raw else JSON.writeValueAsString(raw)
            // `field.uri` → a `Column<URI>` over `text`: construct a java.net.URI from the authoring
            // string so Exposed's MetaUriColumnType binds it (the read-back URI.toString() is verbatim).
            type.contains("text") -> if (raw is URI) raw else URI.create(raw.toString())
            // `field.inet` → a `Column<String>` over the native `inet` type: bind the bare address
            // string; the driver coerces it to inet, and the read-back is the native compressed wire
            // string. (`else` already returns the String — listed explicitly for intent.)
            type == "inet" -> raw.toString()
            else -> raw
        }
    }

    private fun mustGetEntity(root: MetaRoot, name: String): MetaObject =
        root.getChildren(MetaObject::class.java, false).firstOrNull { it.shortName == name }
            ?: error("Entity '$name' not found in canonical metadata root")

    private fun tableFor(entity: String): Table = when (entity) {
        "Program" -> ProgramTable
        "Week" -> WeekTable
        "Node" -> NodeTable
        "Measurement" -> MeasurementTable
        "ProgramStat" -> ProgramStatView
        "ProgramView" -> ProgramView
        "Asset" -> AssetTable
        "AllTypes" -> AllTypesTable
        // FR-017 TPH: the discriminator base + all its subtypes share the single `auths` table.
        "Auth", "BridgeAuth", "CopayAuth", "PriorAuthAuth" -> AuthTable
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
            // uuid columns compare against java.util.UUID — the YAML supplies a string
            // literal (e.g. an `ownerId eq` filter), parse it. Lower-cased first so an
            // upper-case literal still matches the lowercase-canonical stored value.
            type == "uuid" -> if (raw is UUID) raw else UUID.fromString(raw.toString().lowercase())
            type.contains("bigint") || type.contains("int8") -> (raw as? Number)?.toLong() ?: raw.toString().toLong()
            type.contains("int") -> (raw as? Number)?.toInt() ?: raw.toString().toInt()
            else -> raw
        }
    }

    // -----------------------------------------------------------------------
    // Row materialization + assertion
    // -----------------------------------------------------------------------

    private fun rowToMap(row: ResultRow, table: Table, projectFields: Set<String>? = null): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(table.columns.size)
        for (col in table.columns) {
            // FR-017 TPH: project to the ENTITY's own fields (base reads base columns; a subtype adds
            // its own column) — the single physical table also carries the other subtypes' columns,
            // which must not leak into a row the entity doesn't declare. Non-TPH entities pass null
            // (every column is the entity's own column).
            if (projectFields != null && col.name !in projectFields) continue
            var v: Any? = row[col]
            // Temporal columns must preserve their TZ-discriminator all the way to
            // Normalization, which emits the TIMESTAMPTZ `…Z` suffix iff the value is an
            // OffsetDateTime (re-anchored to UTC there) and NO suffix for a plain TIMESTAMP
            // (LocalDateTime). See fixtures/persistence-conformance/normalization.md.
            //
            //  - `timestamp with time zone` (TIMESTAMPTZ) → java.time.Instant (the metaobjects
            //    `instantWithTimeZone` Column<Instant> path) OR java.time.OffsetDateTime (native
            //    Exposed variant): BOTH pass through UNCHANGED. Normalization re-anchors to UTC
            //    and appends `Z`, so a non-UTC stored offset (e.g. -05:00) reads back canonically
            //    as the UTC instant. An Instant is already a UTC point in time, so it must NOT be
            //    collapsed to LocalDateTime here — that would strip the `Z` discriminator.
            //  - plain `timestamp` (no tz) → java.time.LocalDateTime: pass through unchanged
            //    (Normalization formats it with no `Z`).
            //  - `date` → java.time.LocalDate, `time` → java.time.LocalTime: pass through; the
            //    DATE / TIME normalization branches handle them.
            //
            // A raw java.sql.Timestamp (a plain-TIMESTAMP JDBC shape with no zone) is bridged to
            // LocalDateTime so it lands on the no-`Z` branch. Instant (the TZ-aware shape) is left
            // as-is for Normalization's Instant branch.
            if (v is Timestamp) v = v.toLocalDateTime()
            // `@dbColumnType:jsonb` open-JSON column (#98) reads back as a parsed kotlinx
            // JsonElement (or, for an object/map jsonb column, a raw JSON String). Convert
            // whatever it is to a plain JSON value (via its JSON text — JsonElement.toString() is
            // canonical JSON) so Normalization sorts object keys / recurses into arrays and the
            // `expect` block (a YAML object OR array) compares byte-equal. Read as `Any` (NOT
            // `Map`) so both a JSON object (→ LinkedHashMap) and a JSON array (→ ArrayList, e.g. the
            // `labels` array-of-VO column) round-trip. Detected by the column SQL type (`jsonb`).
            if (v != null && col.columnType.sqlType().lowercase().contains("jsonb")) {
                v = JSON.readValue(v.toString(), Any::class.java)
            }
            out[col.name] = v
        }
        return out
    }

    /** Jackson mapper for parsing the `@dbColumnType:jsonb` open-JSON String back to a Map. */
    private val JSON = ObjectMapper()

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
        // op:delete asserts a boolean (true = a row was deleted).
        if (op == "delete") return asBoolean(expect).toString()
        // op:relate is an ORDER-INDEPENDENT set (M:N navigation) — sort both sides.
        if (op == "relate") {
            if (expect == null) return "[]"
            return Normalization.canonicalRowSet(expect as List<Map<String, Any?>>)
        }
        // get / roundtrip / update each return a single bare object (roundtrip drops the
        // server-generated PK; get + update retain it).
        if (isSingleObjectOp(op)) {
            if (expect == null) return "null"
            // Strip the surrounding [] off canonicalRowsJson — the single-object path is bare.
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
        if (op == "delete") return asBoolean(actual).toString()
        if (op == "relate") {
            if (actual == null) return "[]"
            return Normalization.canonicalRowSet(actual as List<Map<String, Any?>>)
        }
        if (actual == null) return "null"
        if (isSingleObjectOp(op)) {
            return Normalization.canonicalRowsJson(listOf(actual as Map<String, Any?>))
                .removePrefix("[").removeSuffix("]")
        }
        return Normalization.canonicalRowsJson(actual as List<Map<String, Any?>>)
    }

    /** Single-bare-object ops: a read-by-PK (`get`), a write-then-read (`roundtrip` / `create` / `update`). */
    private fun isSingleObjectOp(op: String): Boolean =
        op == "get" || op == "roundtrip" || op == "create" || op == "update"

    private fun asBoolean(v: Any?): Boolean = when (v) {
        is Boolean -> v
        null -> false
        else -> v.toString().toBoolean()
    }
}

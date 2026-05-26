package com.metaobjects.integration.kotlin

import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.transactions.transaction
import java.sql.Connection

/**
 * Small Kotlin migration façade on top of JetBrains Exposed that adds the
 * single substrate-level capability Exposed itself does not provide: a
 * status pass that **classifies** planned changes as additive vs destructive
 * and **blocks** the destructive ones unless the caller opts in via
 * [AllowOptions].
 *
 * This closes the last persistence-conformance gap for the Kotlin port —
 * the `drop-table-blocked-without-allow` scenario, where dropping an entity
 * from metadata produces a drop-table change that the migration engine must
 * refuse to apply without an explicit `allow.dropTable=true`.
 *
 * Mirrors the contract surfaced by the sibling Java port's
 * `SchemaMigrationEngine` + `AllowOptions` + `BlockedChangesError`
 * (see `server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/`).
 * Scope is intentionally narrow: table-level adds + drops only — that is all
 * the corpus scenarios actually exercise on Kotlin today. Column-level diffs
 * stay delegated to Exposed's `addMissingColumnsStatements` (additive-only
 * by design — no policy gate needed).
 */

/** Opt-in flags for destructive changes. Defaults to no-op (everything blocked). */
data class AllowOptions(
    val allowDropTable: Boolean = false,
    val allowDropColumn: Boolean = false,
    val allowTypeChange: Boolean = false,
)

/** A single planned change, classified by destructiveness. */
sealed interface Change {
    /** Whether this change destroys schema or data. */
    val isDestructive: Boolean

    /** Short symbolic kind name, matches the corpus YAML `blocked[].kind` value. */
    val kind: String

    data class CreateTable(val table: Table) : Change {
        override val isDestructive = false
        override val kind = "CreateTable"
    }

    data class DropTable(val tableName: String) : Change {
        override val isDestructive = true
        override val kind = "DropTable"
    }
}

/** Result of diffing expected (Kotlin Tables) vs actual (live DB schema). */
data class DiffResult(
    /** Changes that are either additive, or destructive-but-allowed by the [AllowOptions]. */
    val changes: List<Change>,
    /** Destructive changes whose `allow.*` flag is not set. */
    val blocked: List<Change>,
)

/**
 * Thrown when [ExposedMigrationEngine.apply] sees destructive changes that
 * were not allowed by the [AllowOptions]. Message names the flag that would
 * unblock each one — matches the corpus YAML `reason-contains: 'allow.dropTable'`
 * assertion shape.
 */
class BlockedChangesError(val blocked: List<Change>) :
    RuntimeException(buildMessage(blocked)) {

    companion object {
        /** Map a change's kind to the `AllowOptions` flag name that unblocks it. */
        private val ENABLE_FLAG: Map<String, String> = mapOf(
            "DropTable" to "allow.dropTable",
            "DropColumn" to "allow.dropColumn",
            "ChangeColumnType" to "allow.typeChange",
        )

        private fun buildMessage(blocked: List<Change>): String {
            val sb = StringBuilder(blocked.size.toString())
            sb.append(" blocked change(s):")
            for (c in blocked) {
                val locator = when (c) {
                    is Change.DropTable -> c.tableName
                    is Change.CreateTable -> c.table.tableName
                }
                val flag = ENABLE_FLAG[c.kind] ?: "(no flag enables this)"
                sb.append("\n  - ").append(c.kind).append(" on ").append(locator)
                    .append(": pass ").append(flag)
            }
            return sb.toString()
        }
    }
}

object ExposedMigrationEngine {

    /**
     * Compute the diff between the expected Exposed `Table` set and the live
     * DB schema reachable through [connection]. Classifies each change as
     * additive vs destructive and partitions into `(allowed, blocked)` based
     * on [allow].
     *
     * Scope: table presence only (`CreateTable` / `DropTable`). Column-level
     * additive changes are computed by Exposed's `addMissingColumnsStatements`
     * directly at the call site — they are never destructive so they need no
     * gate.
     */
    fun diff(connection: Connection, expectedTables: List<Table>, allow: AllowOptions): DiffResult {
        val actualTableNames = listLiveTableNames(connection)
        val expectedTableNames = expectedTables.map { it.tableName }.toSet()

        val planned = mutableListOf<Change>()
        for (t in expectedTables) {
            if (t.tableName !in actualTableNames) planned.add(Change.CreateTable(t))
        }
        for (a in actualTableNames) {
            if (a !in expectedTableNames) planned.add(Change.DropTable(a))
        }

        val (allowed, blocked) = planned.partition { allowsChange(it, allow) }
        return DiffResult(allowed, blocked)
    }

    /**
     * Apply allowed changes via Exposed. Throws [BlockedChangesError] if any
     * blocked changes are present — nothing is executed in that case
     * (matches the corpus contract: `No 'apply-up-then-query' — the up SQL
     * is non-empty but blocked; runner should NOT execute it`).
     */
    fun apply(
        connection: Connection,
        database: org.jetbrains.exposed.sql.Database,
        expectedTables: List<Table>,
        allow: AllowOptions,
    ) {
        val diff = diff(connection, expectedTables, allow)
        if (diff.blocked.isNotEmpty()) throw BlockedChangesError(diff.blocked)

        // Partition by kind — Exposed's CREATE path takes a vararg of Tables,
        // drops take a vararg of Tables too (we synthesize a stub Table for
        // bare tableName strings — but the corpus scenarios that produce drops
        // start from an actual Exposed Table at seed time, so this path is
        // exercised differently per scenario).
        val drops = diff.changes.filterIsInstance<Change.DropTable>()
        val creates = diff.changes.filterIsInstance<Change.CreateTable>().map { it.table }

        transaction(database) {
            if (creates.isNotEmpty()) SchemaUtils.create(*creates.toTypedArray())
            // For drops we use raw SQL — Exposed's `SchemaUtils.drop` requires
            // a `Table` instance, not a bare name. Quote the identifier to
            // match the live-schema casing returned by JDBC metadata.
            for (drop in drops) {
                exec("""DROP TABLE IF EXISTS "${drop.tableName}"""")
            }
        }
    }

    private fun allowsChange(change: Change, allow: AllowOptions): Boolean = when (change) {
        is Change.DropTable -> allow.allowDropTable
        is Change.CreateTable -> true
    }

    /**
     * List base tables in the `public` schema via JDBC metadata. Mirrors the
     * corpus's `apply-up-then-query` baseline (`information_schema.tables`
     * filtered to `table_schema = 'public' AND table_type = 'BASE TABLE'`).
     */
    private fun listLiveTableNames(connection: Connection): Set<String> {
        val out = mutableSetOf<String>()
        connection.metaData.getTables(null, "public", "%", arrayOf("TABLE")).use { rs ->
            while (rs.next()) out.add(rs.getString("TABLE_NAME"))
        }
        return out
    }
}

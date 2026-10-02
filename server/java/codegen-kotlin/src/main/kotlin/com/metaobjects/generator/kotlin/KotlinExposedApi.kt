package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException

/**
 * Exposed output-API switch (issue #390). Every Kotlin generator that emits Exposed code
 * reads the SAME `exposedApi` generator arg ([ARG_EXPOSED_API], via [parse]) so a `gen` run
 * chooses one version consistently regardless of which generators are wired.
 *
 *  - [V0] (default) — Exposed 0.x: `org.jetbrains.exposed.sql.*`. BYTE-IDENTICAL to every
 *    release before this arg existed; an adopter who sets nothing sees no change.
 *  - [V1] — Exposed 1.x: `org.jetbrains.exposed.v1.*`. The CONSUMER's build needs Kotlin
 *    >= 2.2 and exposed-core/jdbc/java-time/json 1.3.x on its classpath — NOT this module's:
 *    `codegen-kotlin` itself stays on its own Kotlin toolchain, since a generator only emits
 *    text. See `docs/ports/kotlin.md` ("Exposed 1.x output") for the floor this implies and
 *    why it exists (Exposed 1.3.0 fixed `IdentifierManagerApi`'s thread-safety bug that 0.x
 *    output can never reach).
 */
enum class ExposedApi {
    V0,
    V1;

    companion object {
        /** The generator-arg key every Exposed-emitting Kotlin generator reads. */
        const val ARG_EXPOSED_API = "exposedApi"

        /** Unset/blank/`"0"` → [V0] (default); `"1"` → [V1]; anything else is a hard error —
         *  a silently-ignored typo would quietly keep emitting 0.x while the pom claims 1.x. */
        fun parse(raw: String?): ExposedApi = when (raw?.trim()) {
            null, "", "0" -> V0
            "1" -> V1
            else -> throw GeneratorException(
                "Unsupported exposedApi value '$raw' — expected '0' (Exposed 0.x, default) " +
                    "or '1' (Exposed 1.x)"
            )
        }
    }
}

/**
 * FQN builders for the Exposed symbols the Kotlin generators emit, keyed by [ExposedApi] so one
 * call site is correct for both versions. Grouped by the MODULE each symbol moved with in the
 * 1.0 migration (confirmed against the real exposed-core/jdbc/java-time/json 1.3.1 jars — see
 * the official migration guide at jetbrains.com/help/exposed/migration-guide-1-0-0.html), not
 * "replace `.sql` with `.v1.sql`": 0.x's single `org.jetbrains.exposed.sql` package fans out to
 * `v1.core` / `v1.core.statements` / `v1.core.statements.api` / `v1.core.vendors` /
 * `v1.core.java` / `v1.jdbc` / `v1.jdbc.transactions` / `v1.javatime` / `v1.json` in 1.x, and a
 * handful of symbols (`UpdateBuilder`/`UpdateStatement`, `PreparedStatementApi`/`RowApi`,
 * `currentDialect`) stayed in the CORE tier rather than following execution to `v1.jdbc`.
 */
object ExposedImports {

    /** SQL-building types that stay in exposed-core: `Table`, `Column`, `ColumnType`,
     *  `IColumnType`, `IDateColumnType`, `ReferenceOption`, `CustomFunction`, `Op`,
     *  `SortOrder`, `TextColumnType`, `VarCharColumnType` and the other scalar
     *  `*ColumnType`s, `UUIDColumnType` (0.x `java.util.UUID`; see [javaUuid] for the 1.x
     *  replacement), and the `eq`/`neq`/`and`/`or`/`less`/`greater`/`like`/`inList`/`castTo`
     *  top-level operators. */
    fun core(api: ExposedApi, simple: String): String =
        "org.jetbrains.exposed." + (if (api == ExposedApi.V1) "v1.core" else "sql") + ".$simple"

    /** Execution-tier symbols that moved to exposed-jdbc in 1.x: `Database`, `SchemaUtils`,
     *  `Query`, `select`/`selectAll`/`insert`/`update`/`deleteWhere`. */
    fun jdbc(api: ExposedApi, simple: String): String =
        "org.jetbrains.exposed." + (if (api == ExposedApi.V1) "v1.jdbc" else "sql") + ".$simple"

    /** `transactions.transaction` / `TransactionManager`. */
    fun transactions(api: ExposedApi, simple: String): String =
        "org.jetbrains.exposed." +
            (if (api == ExposedApi.V1) "v1.jdbc.transactions" else "sql.transactions") + ".$simple"

    /** `statements.{UpdateBuilder,UpdateStatement}` — stayed in the CORE tier in 1.x
     *  (`v1.core.statements`), unlike the execution-tier functions in [jdbc]. */
    fun statements(api: ExposedApi, simple: String): String =
        "org.jetbrains.exposed." +
            (if (api == ExposedApi.V1) "v1.core.statements" else "sql.statements") + ".$simple"

    /** `statements.api.{PreparedStatementApi,RowApi}` — same core/1.x split as [statements].
     *  `PreparedStatementApi` is NOT removed in 1.x (only `IColumnType.readObject`'s parameter
     *  type changes, from `java.sql.ResultSet` to `RowApi`). */
    fun statementsApi(api: ExposedApi, simple: String): String =
        "org.jetbrains.exposed." +
            (if (api == ExposedApi.V1) "v1.core.statements.api" else "sql.statements.api") + ".$simple"

    /** `javatime.{date,time,datetime,JavaInstantColumnType,JavaLocalDateColumnType,...}`. */
    fun javatime(api: ExposedApi, simple: String): String =
        "org.jetbrains.exposed." + (if (api == ExposedApi.V1) "v1.javatime" else "sql.javatime") + ".$simple"

    /** `json.jsonb`. */
    fun json(api: ExposedApi, simple: String): String =
        "org.jetbrains.exposed." + (if (api == ExposedApi.V1) "v1.json" else "sql.json") + ".$simple"

    /** `vendors.currentDialect` — the SQL-BUILDING dialect accessor (`DataTypeProvider`'s
     *  `timestampWithTimeZoneType()`/`textType()`), which stayed in the core tier. NOT the
     *  JDBC-metadata `currentDialectMetadata` (introspection — `allTablesNames()` etc.), which
     *  this codebase never calls. */
    fun vendors(api: ExposedApi, simple: String): String =
        "org.jetbrains.exposed." + (if (api == ExposedApi.V1) "v1.core.vendors" else "sql.vendors") + ".$simple"

    /**
     * 1.x-ONLY: `core.java.{UUIDColumnType,javaUUID}` — the `java.util.UUID` column support
     * that bare `uuid()` / `UUIDColumnType` no longer provide once `uuid()` binds
     * `kotlin.uuid.Uuid` instead (the migration guide's "silent trap": `uuid()` still compiles
     * under 1.x, it just changes the Kotlin type). [V0] has no equivalent — every call site
     * branches on [ExposedApi] before reaching this; it is never invoked under [ExposedApi.V0].
     */
    fun javaUuid(simple: String): String = "org.jetbrains.exposed.v1.core.java.$simple"
}

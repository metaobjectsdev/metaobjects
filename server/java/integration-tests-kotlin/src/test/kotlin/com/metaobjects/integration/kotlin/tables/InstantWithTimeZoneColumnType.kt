package com.metaobjects.integration.kotlin.tables

import java.time.Instant
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.IDateColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.JavaInstantColumnType
import org.jetbrains.exposed.sql.statements.api.PreparedStatementApi
import org.jetbrains.exposed.sql.vendors.currentDialect

/**
 * Reference copy of the support helper that
 * [com.metaobjects.generator.kotlin.KotlinExposedTableGenerator] emits (file-locally) into a
 * generated table that has a `@dbColumnType=timestamp_with_tz` column. Kept here as a sibling
 * (mirroring [PreciseLocalTimeColumnType]) so the reference [AssetTable] compiles + runs against
 * real Exposed 0.55 — proving the generated helper is well-formed.
 *
 * A `Column<java.time.Instant>` whose SQL DDL is `TIMESTAMP WITH TIME ZONE`. Exposed 0.55's
 * native `timestampWithTimeZone(...)` is a `Column<OffsetDateTime>`, which would MISMATCH the
 * `Instant` data-class property the codegen emits (forcing `Instant`↔`OffsetDateTime` coercion
 * at every callsite). This delegates ALL value/JDBC handling (read, bind, normalize,
 * millisecond-truncate, wire string) to Exposed's tested [JavaInstantColumnType] and overrides
 * ONLY [sqlType] to return the dialect's `TIMESTAMP WITH TIME ZONE` — so the column stays
 * timezone-aware (offset→UTC normalization) while matching the `Instant` property.
 */
class MetaInstantWithTimeZoneColumnType : ColumnType<Instant>(), IDateColumnType {
    private val delegate = JavaInstantColumnType()

    override val hasTimePart: Boolean get() = delegate.hasTimePart

    override fun sqlType(): String = currentDialect.dataTypeProvider.timestampWithTimeZoneType()

    override fun valueFromDB(value: Any): Instant? = delegate.valueFromDB(value)

    override fun notNullValueToDB(value: Instant): Any = delegate.notNullValueToDB(value)

    override fun nonNullValueToString(value: Instant): String = delegate.nonNullValueToString(value)

    override fun nonNullValueAsDefaultString(value: Instant): String =
        delegate.nonNullValueAsDefaultString(value)

    override fun readObject(rs: java.sql.ResultSet, index: Int): Any? = delegate.readObject(rs, index)

    override fun setParameter(stmt: PreparedStatementApi, index: Int, value: Any?) =
        delegate.setParameter(stmt, index, value)
}

/**
 * Register a `Column<Instant>` backed by a `TIMESTAMP WITH TIME ZONE` Postgres column
 * (see [MetaInstantWithTimeZoneColumnType]).
 */
fun Table.instantWithTimeZone(name: String): Column<Instant> =
    registerColumn(name, MetaInstantWithTimeZoneColumnType())

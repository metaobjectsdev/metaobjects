package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.IDateColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.JavaLocalTimeColumnType
import java.sql.ResultSet
import java.time.LocalTime

/**
 * A `TIME` column type that preserves sub-second (millisecond) precision on read.
 *
 * Exposed 0.55.0's stock [JavaLocalTimeColumnType] reads a Postgres `TIME` value via
 * the JDBC default `ResultSet.getObject(index)`, which the Postgres driver surfaces as
 * a [java.sql.Time] — a type whose resolution is whole seconds, so the fractional
 * component is silently truncated (the class even documents "Doesn't return nanos from
 * database"). The TIMESTAMP/TIMESTAMPTZ column types are unaffected because they read
 * through [java.sql.Timestamp], which carries nanos.
 *
 * The SP-A normalization contract requires `TIME` to round-trip at millisecond
 * resolution (e.g. `14:30:00.123`). The stock type is `final`, so this delegates the
 * DDL/write/format behavior to a held [JavaLocalTimeColumnType] instance and overrides
 * ONLY [readObject] to ask the driver for a [LocalTime] directly
 * (`getObject(index, LocalTime::class.java)`) — the Postgres JDBC driver returns a
 * full-precision `LocalTime`, bypassing the lossy `java.sql.Time` hop.
 */
class PreciseLocalTimeColumnType : ColumnType<LocalTime>(), IDateColumnType {
    private val delegate = JavaLocalTimeColumnType()

    override val hasTimePart: Boolean get() = true

    override fun sqlType(): String = delegate.sqlType()

    override fun valueFromDB(value: Any): LocalTime? = delegate.valueFromDB(value)

    override fun notNullValueToDB(value: LocalTime): Any = delegate.notNullValueToDB(value)

    override fun nonNullValueToString(value: LocalTime): String = delegate.nonNullValueToString(value)

    /** The whole point: read a full-precision LocalTime, not a seconds-truncated java.sql.Time. */
    override fun readObject(rs: ResultSet, index: Int): Any? =
        rs.getObject(index, LocalTime::class.java)
}

/** Register a millisecond-preserving `TIME` column (see [PreciseLocalTimeColumnType]). */
fun Table.preciseTime(name: String): Column<LocalTime> =
    registerColumn(name, PreciseLocalTimeColumnType())

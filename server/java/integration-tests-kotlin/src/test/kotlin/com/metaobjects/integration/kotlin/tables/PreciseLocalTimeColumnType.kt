package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.IDateColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.JavaLocalTimeColumnType
import java.sql.ResultSet
import java.time.LocalTime

/**
 * A `TIME` column type that preserves sub-second (millisecond) precision on BOTH read AND write.
 *
 * Exposed 0.55.0's stock [JavaLocalTimeColumnType] loses the fractional-second component twice:
 *
 *  - **Read (SP-A):** it reads a Postgres `TIME` value via the JDBC default
 *    `ResultSet.getObject(index)`, which the Postgres driver surfaces as a [java.sql.Time] — a
 *    type whose resolution is whole seconds, so the fraction is silently truncated (the class
 *    even documents "Doesn't return nanos from database").
 *  - **Write (SP-H Unit 8):** its `notNullValueToDB(LocalTime)` (on the Postgres path) converts
 *    the value to a [java.sql.Time] via `Time.valueOf(LocalTime)` — again whole-second — before
 *    Exposed's `setParameter` binds it via `setObject`, so a `14:30:00.123` authoring value is
 *    stored as `14:30:00`. The SP-A read-only fix masked this because every pre-SP-H scenario
 *    only READ raw-SQL-seeded rows; the WRITE round-trip (`op: roundtrip`) is the first path that
 *    binds a `LocalTime` through this column and surfaced the truncation.
 *
 * The TIMESTAMP/TIMESTAMPTZ column types are unaffected because they read/write through
 * [java.sql.Timestamp], which carries nanos.
 *
 * The SP-A normalization contract requires `TIME` to round-trip at millisecond resolution (e.g.
 * `14:30:00.123`). The stock type is `final`, so this delegates the DDL/format behavior to a held
 * [JavaLocalTimeColumnType] and overrides ONLY the two lossy hops:
 *  - [readObject] asks the driver for a [LocalTime] directly (`getObject(index, LocalTime)`);
 *  - [notNullValueToDB] returns the [LocalTime] UNCHANGED (not a whole-second `java.sql.Time`),
 *    so the inherited `setParameter` binds it via `setObject(index, LocalTime)` — which the
 *    Postgres driver stores at full sub-second resolution.
 */
class PreciseLocalTimeColumnType : ColumnType<LocalTime>(), IDateColumnType {
    private val delegate = JavaLocalTimeColumnType()

    override val hasTimePart: Boolean get() = true

    override fun sqlType(): String = delegate.sqlType()

    override fun valueFromDB(value: Any): LocalTime? = delegate.valueFromDB(value)

    /**
     * The write fix (SP-H Unit 8): return the value UNCHANGED (a full-precision [LocalTime])
     * rather than the stock type's seconds-truncating `java.sql.Time.valueOf(...)` conversion.
     * Exposed's inherited `setParameter` then binds it via `setObject(index, LocalTime)`, which
     * the Postgres JDBC driver stores at full sub-second resolution.
     */
    override fun notNullValueToDB(value: LocalTime): Any = value

    override fun nonNullValueToString(value: LocalTime): String = delegate.nonNullValueToString(value)

    /** The read fix (SP-A): read a full-precision LocalTime, not a seconds-truncated java.sql.Time. */
    override fun readObject(rs: ResultSet, index: Int): Any? =
        rs.getObject(index, LocalTime::class.java)
}

/** Register a millisecond-preserving `TIME` column (see [PreciseLocalTimeColumnType]). */
fun Table.preciseTime(name: String): Column<LocalTime> =
    registerColumn(name, PreciseLocalTimeColumnType())

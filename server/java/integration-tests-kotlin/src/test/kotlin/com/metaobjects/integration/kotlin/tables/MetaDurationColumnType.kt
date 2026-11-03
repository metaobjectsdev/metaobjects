package com.metaobjects.integration.kotlin.tables

import com.metaobjects.field.DurationWire
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.vendors.currentDialect
import java.sql.ResultSet
import java.time.Duration

/**
 * Hand-written reference Exposed column type for `field.duration` — the test-harness analogue of
 * the per-package `MetaDurationColumnType.kt` the
 * [com.metaobjects.generator.kotlin.KotlinExposedTableGenerator] emits, over the metadata
 * module's [DurationWire] (the generated copy carries its own `MetaDurationWire`).
 *
 * A `Column<java.time.Duration>` over the Postgres-native `INTERVAL`, and elsewhere (SQLite, MySQL)
 * a BIGINT count of microseconds. Postgres refuses a signed ISO-8601 duration as interval
 * input, so the value binds in the interval spelling `[-]HH:MM:SS[.f]` under a
 * `CAST(? AS INTERVAL)` marker; the read takes the interval's text (`ResultSet.getString`, the
 * `postgres` IntervalStyle) and refuses one with a year or month part.
 */
internal class MetaDurationColumnType : ColumnType<Duration>() {
    private fun isPostgres(): Boolean = currentDialect.name.equals("postgresql", ignoreCase = true)
    override fun sqlType(): String = if (isPostgres()) "INTERVAL" else "BIGINT"
    override fun valueFromDB(value: Any): Duration = when (value) {
        is Duration -> value
        is Number -> DurationWire.fromMicros(value.toLong())
        else -> DurationWire.fromStored(value.toString())
    }
    override fun notNullValueToDB(value: Duration): Any =
        if (isPostgres()) DurationWire.formatPostgres(value) else DurationWire.toMicros(value)
    override fun nonNullValueToString(value: Duration): String =
        if (isPostgres()) "'" + notNullValueToDB(value) + "'" else notNullValueToDB(value).toString()
    override fun parameterMarker(value: Duration?): String = if (isPostgres()) "CAST(? AS INTERVAL)" else "?"
    /** Read the interval's text on Postgres (never pgjdbc's PGInterval object), the integer elsewhere. */
    override fun readObject(rs: ResultSet, index: Int): Any? = if (isPostgres()) rs.getString(index) else rs.getObject(index)
}

/** Column builder for `field.duration`: a `Column<java.time.Duration>`. */
internal fun Table.durationColumn(name: String): Column<Duration> =
    registerColumn(name, MetaDurationColumnType())

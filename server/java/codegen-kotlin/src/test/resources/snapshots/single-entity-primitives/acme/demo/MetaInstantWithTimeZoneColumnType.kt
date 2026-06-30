package acme.demo

import java.time.Instant
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.IDateColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.JavaInstantColumnType
import org.jetbrains.exposed.sql.statements.api.PreparedStatementApi
import org.jetbrains.exposed.sql.vendors.currentDialect

/**
 * GENERATED — do not hand-edit.
 * Custom Exposed column type for instant (default, non-`@localTime`): a
 * `Column<java.time.Instant>` whose SQL DDL is `TIMESTAMP WITH TIME ZONE`.
 * Delegates all value/JDBC handling to Exposed's `JavaInstantColumnType` and
 * overrides only `sqlType()`, so the column type matches the `Instant` data-class
 * property (no Instant↔OffsetDateTime coercion) while staying timezone-aware.
 */
internal class MetaInstantWithTimeZoneColumnType :
    ColumnType<Instant>(),
    IDateColumnType {
    private val delegate = JavaInstantColumnType()
    override val hasTimePart: Boolean get() = delegate.hasTimePart
    override fun sqlType(): String =
        currentDialect.dataTypeProvider.timestampWithTimeZoneType()
    override fun valueFromDB(value: Any): Instant? = delegate.valueFromDB(value)
    override fun notNullValueToDB(value: Instant): Any = delegate.notNullValueToDB(value)
    override fun nonNullValueToString(value: Instant): String = delegate.nonNullValueToString(value)
    override fun nonNullValueAsDefaultString(value: Instant): String =
        delegate.nonNullValueAsDefaultString(value)
    override fun readObject(rs: java.sql.ResultSet, index: Int): Any? = delegate.readObject(rs, index)
    override fun setParameter(
        stmt: PreparedStatementApi,
        index: Int,
        value: Any?,
    ) = delegate.setParameter(stmt, index, value)
}

/**
 * Column builder for instant (default, non-`@localTime`): a `Column<Instant>` backed by
 * a `TIMESTAMP WITH TIME ZONE` Postgres column (see [MetaInstantWithTimeZoneColumnType]).
 */
internal fun Table.instantWithTimeZone(name: String): Column<Instant> =
    registerColumn(name, MetaInstantWithTimeZoneColumnType())


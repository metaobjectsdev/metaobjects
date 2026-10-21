package acme.catalog

import java.math.BigDecimal
import java.util.UUID
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.DecimalColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.UUIDColumnType
import org.jetbrains.exposed.sql.vendors.currentDialect

private fun isPostgres(): Boolean = currentDialect.name.equals("postgresql", ignoreCase = true)

private fun isSqlite(): Boolean = currentDialect.name.equals("sqlite", ignoreCase = true)

/** GENERATED — do not hand-edit. A `java.util.UUID` column: native `uuid` on Postgres, text elsewhere. */
internal class MetaPortableUuidColumnType : ColumnType<UUID>() {
    private val delegate = UUIDColumnType()
    override fun sqlType(): String = delegate.sqlType()
    override fun valueFromDB(value: Any): UUID = requireNotNull(delegate.valueFromDB(value)) { "null uuid column value" }
    override fun notNullValueToDB(value: UUID): Any =
        if (isPostgres()) delegate.notNullValueToDB(value) else value.toString()
    override fun nonNullValueToString(value: UUID): String =
        if (isPostgres()) delegate.nonNullValueToString(value) else "'$value'"
}

/** Column builder for `field.uuid`: a `Column<java.util.UUID>`. */
internal fun Table.portableUuid(name: String): Column<UUID> =
    registerColumn(name, MetaPortableUuidColumnType())

/** GENERATED — do not hand-edit. A decimal column: the exact decimal everywhere but SQLite, which gets a REAL. */
internal class MetaPortableDecimalColumnType(precision: Int, scale: Int) : ColumnType<BigDecimal>() {
    private val delegate = DecimalColumnType(precision, scale)
    override fun sqlType(): String = delegate.sqlType()
    // ADR-0019 Amendment 1 (W4): SQLite stores a REAL, so a value is read at 15 significant
    // digits, which turns `sum(0.1, 0.2)` (0.30000000000000004) back into 0.3.
    override fun valueFromDB(value: Any): BigDecimal =
        if (isSqlite() && value is Number && value !is BigDecimal) {
            MetaDecimalWire.fromDouble15(value.toDouble())
        } else {
            delegate.valueFromDB(value)
        }
    override fun notNullValueToDB(value: BigDecimal): Any =
        if (isSqlite()) value.toDouble() else delegate.notNullValueToDB(value)
    override fun nonNullValueToString(value: BigDecimal): String = delegate.nonNullValueToString(value)
}

/** Column builder for `field.decimal`: a `Column<java.math.BigDecimal>`. */
internal fun Table.portableDecimal(name: String, precision: Int, scale: Int): Column<BigDecimal> =
    registerColumn(name, MetaPortableDecimalColumnType(precision, scale))


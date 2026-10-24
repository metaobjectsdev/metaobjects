package acme.catalog

import java.math.BigDecimal
import java.util.UUID
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.DecimalColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.statements.api.PreparedStatementApi
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

/**
 * GENERATED — do not hand-edit. A decimal column with no declared `@precision`: plain unbounded
 * `NUMERIC`, read exactly. Exposed's own `DecimalColumnType` would round every value to its scale
 * (HALF_EVEN) on read, so this type does not delegate the read to it.
 */
internal class MetaUnboundedDecimalColumnType : ColumnType<BigDecimal>() {
    override fun sqlType(): String = "NUMERIC"
    override fun valueFromDB(value: Any): BigDecimal = when {
        value is BigDecimal -> value
        value is Number && isSqlite() -> MetaDecimalWire.fromDouble15(value.toDouble())
        else -> BigDecimal(value.toString())
    }
    override fun notNullValueToDB(value: BigDecimal): Any =
        if (isSqlite()) value.toDouble() else value
    override fun nonNullValueToString(value: BigDecimal): String = value.toPlainString()
}

/** Column builder for a `field.decimal` with no `@precision`: a `Column<java.math.BigDecimal>`, unbounded. */
internal fun Table.portableDecimal(name: String): Column<BigDecimal> =
    registerColumn(name, MetaUnboundedDecimalColumnType())

/**
 * GENERATED — do not hand-edit. An `isArray` decimal column: a native `NUMERIC[]` on Postgres, and on
 * MySQL and SQLite (no array type) a JSON text array of canonical strings. Elements are read exactly.
 */
internal class MetaDecimalArrayColumnType : ColumnType<List<BigDecimal>>() {
    private fun isMySql(): Boolean = currentDialect.name.let { it.equals("mysql", ignoreCase = true) || it.equals("mariadb", ignoreCase = true) }
    private fun decimalOf(element: Any): BigDecimal = if (element is BigDecimal) element else BigDecimal(element.toString())
    private fun json(value: List<BigDecimal>): String = value.joinToString(",", "[", "]") { "\"" + MetaDecimalWire.format(it) + "\"" }
    override fun sqlType(): String = if (isPostgres()) "NUMERIC[]" else if (isMySql()) "JSON" else "TEXT"
    override fun valueFromDB(value: Any): List<BigDecimal> = when (value) {
        is java.sql.Array -> (value.array as Array<*>).map { decimalOf(it!!) }
        is Array<*> -> value.map { decimalOf(it!!) }
        is List<*> -> value.map { decimalOf(it!!) }
        else -> com.fasterxml.jackson.databind.ObjectMapper().readTree(value.toString()).map { MetaDecimalWire.fromNode(it) }
    }
    override fun notNullValueToDB(value: List<BigDecimal>): Any =
        if (isPostgres()) value.toTypedArray<Any?>() else json(value)
    override fun nonNullValueToString(value: List<BigDecimal>): String =
        if (isPostgres()) value.joinToString(",", "ARRAY[", "]::numeric[]") { it.toPlainString() } else "'" + json(value) + "'"
    override fun setParameter(stmt: PreparedStatementApi, index: Int, value: Any?) {
        if (value is Array<*>) {
            @Suppress("UNCHECKED_CAST")
            stmt.setArray(index, "numeric", value as Array<Any?>)
        } else {
            super.setParameter(stmt, index, value)
        }
    }
}

/** Column builder for an `isArray` `field.decimal`: a `Column<List<java.math.BigDecimal>>`. */
internal fun Table.portableDecimalArray(name: String): Column<List<BigDecimal>> =
    registerColumn(name, MetaDecimalArrayColumnType())


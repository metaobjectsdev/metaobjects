package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.DecimalColumnType
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.vendors.currentDialect
import java.math.BigDecimal

/**
 * The reference twin of the `MetaPortableDecimalColumnType` that KotlinExposedTableGenerator emits
 * (ADR-0019 Amendment 1): the exact decimal on Postgres and MySQL, and on SQLite, which has no
 * decimal and keeps a REAL, a number bound as a double (W4) and read at 15 significant digits,
 * so `0.1 + 0.2` reads `0.3`. The reference tables use it so the persistence lane exercises the
 * same read and write path a generated table has.
 */
class PortableDecimalColumnType(precision: Int, scale: Int) : ColumnType<BigDecimal>() {
    private val delegate = DecimalColumnType(precision, scale)
    override fun sqlType(): String = delegate.sqlType()
    override fun valueFromDB(value: Any): BigDecimal =
        if (isSqlite() && value is Number && value !is BigDecimal) ReferenceDecimal.fromDouble15(value.toDouble())
        else delegate.valueFromDB(value)
    override fun notNullValueToDB(value: BigDecimal): Any =
        if (isSqlite()) value.toDouble() else delegate.notNullValueToDB(value)
    override fun nonNullValueToString(value: BigDecimal): String = delegate.nonNullValueToString(value)
}

private fun isSqlite(): Boolean = currentDialect.name.equals("sqlite", ignoreCase = true)

fun Table.portableDecimal(name: String, precision: Int, scale: Int): Column<BigDecimal> =
    registerColumn(name, PortableDecimalColumnType(precision, scale))

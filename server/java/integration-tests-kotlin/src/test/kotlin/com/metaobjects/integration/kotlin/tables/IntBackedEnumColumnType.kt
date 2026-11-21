package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.statements.api.PreparedStatementApi
import org.jetbrains.exposed.sql.vendors.currentDialect

/**
 * Hand-written reference Exposed column type for an INT-BACKED `field.enum` (`@intValueMap`) —
 * the test-harness analogue of the `customEnumeration(...)` call
 * [com.metaobjects.generator.kotlin.KotlinExposedTableGenerator] emits for such a field.
 *
 * The column is physically `INTEGER` (plus the canonical DDL's `CHECK (… IN (0, 5, 9))`) while
 * the value carried in and out is the member SYMBOL — which is the whole contract of int-backing:
 * storage changes, the wire format does not.
 *
 * It is a `Column<String>` rather than a `Column<SomeEnum>` because this cross-port oracle has no
 * generated enum class to bind — the generic [com.metaobjects.integration.kotlin.QueryScenarioRunner]
 * moves plain YAML scalars. The GENERATED form binds a real Kotlin enum through
 * `customEnumeration`, and is covered separately by the codegen tests; the divergence is the same
 * one already documented for the jsonb columns in [AllTypesTable].
 *
 * **A stored int that maps to no member THROWS** rather than surfacing the raw value or nulling
 * it, matching the generated `customEnumeration`'s `else ->` branch and every sibling port: the
 * row holds data the model says is impossible, and both alternatives hand the caller something
 * untrue. The write side is exhaustive by construction upstream (`@intValueMap`'s keys are
 * loader-validated to equal `@values`), so an unmapped SYMBOL here can only be a harness bug —
 * it fails loudly for the same reason.
 */
internal class IntBackedEnumColumnType(
    private val intByMember: Map<String, Int>,
) : ColumnType<String>() {

    private val memberByInt: Map<Int, String> =
        intByMember.entries.associate { (member, stored) -> stored to member }

    override fun sqlType(): String = "INTEGER"

    override fun valueFromDB(value: Any): String {
        val stored = (value as? Number)?.toInt()
            ?: error("int-backed field.enum column read a non-numeric value: $value")
        return memberByInt[stored]
            ?: error(
                "field.enum read stored value $stored with no member in @intValueMap " +
                    "(declared: $intByMember) — the database holds a value the model does not describe."
            )
    }

    override fun notNullValueToDB(value: String): Any =
        intByMember[value]
            ?: error("field.enum has no @intValueMap entry for member '$value' (declared: $intByMember).")

    override fun nonNullValueToString(value: String): String = notNullValueToDB(value).toString()
}

/**
 * Column builder for an int-backed `field.enum`: a `Column<String>` carrying the member symbol
 * over an `INTEGER` column, translating through [intByMember] (`@intValueMap`) in both directions.
 */
internal fun Table.intBackedEnum(name: String, intByMember: Map<String, Int>): Column<String> =
    registerColumn(name, IntBackedEnumColumnType(intByMember))

/**
 * The `@intValueMap` of the canonical fixture's one int-backed enum — `AllTypes.intEnumVal`,
 * whose `legacyStatus` dimension reads through the same map. Stated once because both columns
 * must carry the fixture's map exactly (`fixtures/persistence-conformance/canonical/meta.fitness.json`).
 */
internal val INT_ENUM_MEMBERS: Map<String, Int> = mapOf("DRAFT" to 0, "PUBLISHED" to 5, "ARCHIVED" to 9)

/**
 * Hand-written reference column type for an INT-BACKED `field.enum` ARRAY: the test-harness analogue
 * of the `portableIntEnumArray(...)` column [com.metaobjects.generator.kotlin.KotlinExposedTableGenerator]
 * emits. Each element is stored as its declared integer: a native `INTEGER[]` on Postgres, and on
 * SQLite and MySQL (no array type) a JSON array of numbers (`[5,0]`), never the member symbols.
 * Like [IntBackedEnumColumnType] it carries the member SYMBOL in and out (`Column<List<String>>`),
 * and an integer with no member throws on the read.
 */
internal class IntBackedEnumArrayColumnType(
    private val intByMember: Map<String, Int>,
) : ColumnType<List<String>>() {

    private val memberByInt: Map<Int, String> =
        intByMember.entries.associate { (member, stored) -> stored to member }

    private fun isPostgres(): Boolean = currentDialect.name.equals("postgresql", ignoreCase = true)
    private fun isMySql(): Boolean =
        currentDialect.name.let { it.equals("mysql", ignoreCase = true) || it.equals("mariadb", ignoreCase = true) }

    private fun member(stored: Int): String = memberByInt[stored]
        ?: error(
            "field.enum read stored value $stored with no member in @intValueMap " +
                "(declared: $intByMember) — the database holds a value the model does not describe."
        )

    private fun stored(member: String): Int = intByMember[member]
        ?: error("field.enum has no @intValueMap entry for member '$member' (declared: $intByMember).")

    private fun json(value: List<String>): String = value.joinToString(",", "[", "]") { stored(it).toString() }

    override fun sqlType(): String = if (isPostgres()) "INTEGER[]" else if (isMySql()) "JSON" else "TEXT"

    override fun valueFromDB(value: Any): List<String> = when (value) {
        is java.sql.Array -> (value.array as Array<*>).map { member((it as Number).toInt()) }
        is Array<*> -> value.map { member((it as Number).toInt()) }
        is List<*> -> value.map { member((it as Number).toInt()) }
        else -> com.fasterxml.jackson.databind.ObjectMapper().readTree(value.toString()).map { member(it.intValue()) }
    }

    override fun notNullValueToDB(value: List<String>): Any =
        if (isPostgres()) value.map { stored(it) }.toTypedArray<Any?>() else json(value)

    override fun nonNullValueToString(value: List<String>): String =
        if (isPostgres()) value.joinToString(",", "ARRAY[", "]::integer[]") { stored(it).toString() }
        else "'" + json(value) + "'"

    override fun setParameter(stmt: PreparedStatementApi, index: Int, value: Any?) {
        if (value is Array<*>) {
            @Suppress("UNCHECKED_CAST")
            stmt.setArray(index, "integer", value as Array<Any?>)
        } else {
            super.setParameter(stmt, index, value)
        }
    }
}

/** Column builder for an int-backed `field.enum` array: a `Column<List<String>>` of member symbols over `integer[]` / JSON text. */
internal fun Table.intBackedEnumArray(name: String, intByMember: Map<String, Int>): Column<List<String>> =
    registerColumn(name, IntBackedEnumArrayColumnType(intByMember))

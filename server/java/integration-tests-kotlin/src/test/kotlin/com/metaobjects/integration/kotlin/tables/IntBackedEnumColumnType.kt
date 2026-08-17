package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.ColumnType
import org.jetbrains.exposed.sql.Table

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

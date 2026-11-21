package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed table for the `IntEnumArray` entity (`int_enum_arrays`), the subject of
 * the `roundtrip-int-enum-array` scenario: a scalar and an array column that share one inherited
 * `@intValueMap`. Both are nullable, matching the canonical DDL.
 */
internal object IntEnumArrayTable : Table("int_enum_arrays") {
    val id = long("id").autoIncrement()
    val state = intBackedEnum("state", INT_ENUM_MEMBERS).nullable()
    val history = intBackedEnumArray("history", INT_ENUM_MEMBERS).nullable()

    override val primaryKey = PrimaryKey(id)
}

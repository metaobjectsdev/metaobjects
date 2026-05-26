package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimestampField
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import com.squareup.kotlinpoet.TypeName

/**
 * Centralized mapping from MetaField subtype to (a) KotlinPoet TypeName for data class
 * properties and (b) the Exposed `Table` column statement.
 *
 * Per the codegen-kotlin spec §6 (type mapping table). Tier-1 invariant: the *semantic*
 * type per field subtype is identical across all language ports. The exact Kotlin/Exposed
 * names are Tier-2 idiomatic per port.
 *
 * MVP coverage: the 7 most-common primitive types. Enum / currency / object / uuid throw
 * IllegalArgumentException with a clear message at generator time; add support per real
 * consumer ask.
 */
object KotlinTypeMapper {

    /** Map a MetaField to its KotlinPoet data-class property TypeName. */
    fun kotlinTypeName(field: MetaField<*>): TypeName = when (field) {
        is StringField    -> STRING
        is IntegerField   -> INT
        is LongField      -> LONG
        is DoubleField    -> DOUBLE
        is BooleanField   -> BOOLEAN
        is DateField      -> ClassName("java.time", "LocalDate")
        is TimestampField -> ClassName("java.time", "Instant")
        else -> throw IllegalArgumentException(
            "unsupported Kotlin type mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /** Map a MetaField to the Exposed `Table` column statement (e.g., `varchar("name", 100)`). */
    fun exposedColumnSpec(field: MetaField<*>): String {
        val colName = field.name
        return when (field) {
            is StringField    -> "varchar(\"$colName\", ${stringMaxLength(field)})"
            is IntegerField   -> "integer(\"$colName\")"
            is LongField      -> "long(\"$colName\")"
            is DoubleField    -> "double(\"$colName\")"
            is BooleanField   -> "bool(\"$colName\")"
            is DateField      -> "date(\"$colName\")"
            is TimestampField -> "timestampWithTimeZone(\"$colName\")"
            else -> throw IllegalArgumentException(
                "unsupported Exposed column mapping for ${field::class.simpleName} '${field.name}'"
            )
        }
    }

    /** Resolve @maxLength on a StringField; default 255. */
    private fun stringMaxLength(field: StringField): Int {
        if (!field.hasMetaAttr(StringField.ATTR_MAX_LENGTH, false)) return 255
        val raw = runCatching {
            field.getMetaAttr(StringField.ATTR_MAX_LENGTH, false).value
        }.getOrNull()
        return when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull() ?: 255
            else -> 255
        }
    }
}

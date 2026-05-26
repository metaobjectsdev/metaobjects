package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
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
 * Coverage: 7 primitive types + currency + enum + uuid (matched by metadata subtype name,
 * since `field.uuid` has no dedicated Java class yet — see {@code UUID_SUBTYPE} below).
 * Object / class / decimal etc. still throw IllegalArgumentException with a clear message;
 * add support per real consumer ask.
 */
object KotlinTypeMapper {

    /**
     * Metadata subtype name for `field.uuid`. There is no `UuidField` JVM class today
     * (the type exists only as a planned subtype name across ports — neither Java nor
     * TS has a typed field class). Match against the subtype string instead so we don't
     * have to wait for the class to land before codegen can emit a sensible column.
     */
    private const val UUID_SUBTYPE = "uuid"

    /** Map a MetaField to its KotlinPoet data-class property TypeName. */
    fun kotlinTypeName(field: MetaField<*>): TypeName = when {
        field is StringField    -> STRING
        field is IntegerField   -> INT
        field is LongField      -> LONG
        field is DoubleField    -> DOUBLE
        field is BooleanField   -> BOOLEAN
        field is DateField      -> ClassName("java.time", "LocalDate")
        field is TimestampField -> ClassName("java.time", "Instant")
        // Currency: integer minor units on the wire (project-wide invariant). Same JVM
        // representation as Long; surfaced as its own arm so the semantic is documented
        // and downstream tooling can branch on subtype.
        field is CurrencyField  -> LONG
        // Enum (string-backed v1): emit as Kotlin String. Generating a real enum class
        // requires materialising the `@values` set into a top-level declaration — deferred
        // until the enum-class generator lands (see field-constants enum design doc).
        field is EnumField      -> STRING
        // UUID: matched on subtype name because there is no UuidField class yet.
        field.subType == UUID_SUBTYPE -> ClassName("java.util", "UUID")
        else -> throw IllegalArgumentException(
            "unsupported Kotlin type mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /** Map a MetaField to the Exposed `Table` column statement (e.g., `varchar("name", 100)`). */
    fun exposedColumnSpec(field: MetaField<*>): String = exposedColumnSpec(field, field.name)

    /**
     * Same as [exposedColumnSpec], but with an explicit physical column name. Used by the
     * `@storage: "flattened"` codepath to emit prefixed columns (e.g., `address_street`)
     * for nested object.value fields without mutating the underlying MetaField.
     */
    fun exposedColumnSpec(field: MetaField<*>, colName: String): String {
        return when {
            field is StringField    -> "varchar(\"$colName\", ${stringMaxLength(field)})"
            field is IntegerField   -> "integer(\"$colName\")"
            field is LongField      -> "long(\"$colName\")"
            field is DoubleField    -> "double(\"$colName\")"
            field is BooleanField   -> "bool(\"$colName\")"
            field is DateField      -> "date(\"$colName\")"
            field is TimestampField -> "timestampWithTimeZone(\"$colName\")"
            // Currency stored as BIGINT minor units — same as Long. Separate arm for
            // semantic clarity (a future migration generator can branch on it).
            field is CurrencyField  -> "long(\"$colName\")"
            // Enum stored as VARCHAR(64) for v1. Proper enum-column handling needs the
            // generated enum class (Exposed's `customEnumeration` / `enumerationByName`
            // takes a KClass<E>) and is intentionally deferred.
            field is EnumField      -> "varchar(\"$colName\", 64)"
            // UUID column — Exposed has first-class `uuid(name)`.
            field.subType == UUID_SUBTYPE -> "uuid(\"$colName\")"
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

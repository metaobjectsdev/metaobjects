package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.`object`.MetaObject
import java.util.Properties

/**
 * Pure helper that turns a value-object (VO) [MetaObject] into Kotlin SOURCE strings
 * for the FR-010 recover codegen.
 *
 * Three functions:
 * - [schemaLiteral] — emits a `RecoverSchema(Format.X, "Root", listOf(...))` literal
 *   using Kotlin collection syntax.
 * - [recoveredClassDecl] — emits an all-nullable Kotlin `data class` mirroring the VO shape,
 *   suitable for use as the recover deserialization target.
 * - [recoveredCtorArgs] — emits the comma-separated `RecoverMap.asX(d, "name")` argument
 *   list for constructing the recovered instance from a `Map<String, Object> d`.
 *
 * Field-kind mapping (mirrors [KotlinTypeMapper]):
 * - [EnumField] → `FieldKind.ENUM` via `FieldSpec.enumField`
 * - [StringField] → `FieldKind.STRING`
 * - [IntegerField] → `FieldKind.INT`
 * - [LongField] → `FieldKind.LONG`
 * - [DoubleField] → `FieldKind.DOUBLE`
 * - [BooleanField] → `FieldKind.BOOLEAN`
 * - [ObjectField] / non-scalar array → `FieldKind.STRING` with FR-010 nested-recover-deferred comment
 *
 * Isolating this logic makes all three paths unit-testable without running the full
 * generator pipeline. This object is internal; generators delegate here.
 */
internal object KotlinRecoverSchemaEmitter {

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Emit a `RecoverSchema(Format.X, "<rootName>", listOf(...))` literal for all
     * fields on [vo]. Kotlin collection literals are used throughout (not Java APIs).
     *
     * @param vo       the payload value-object whose fields drive the schema
     * @param format   `"xml"` → `Format.XML`; anything else → `Format.JSON`
     * @param rootName the logical root name embedded in the schema
     * @return Kotlin source snippet, e.g.
     *         `RecoverSchema(Format.JSON, "Foo", listOf(...))`
     */
    fun schemaLiteral(vo: MetaObject, format: String, rootName: String): String {
        val formatEnum = if ("xml".equals(format, ignoreCase = true)) "Format.XML" else "Format.JSON"

        val fieldSpecs = vo.metaFields.map { fieldSpecLiteral(it) }

        return "RecoverSchema($formatEnum, \"${kotlinStringLiteral(rootName)}\", listOf(${fieldSpecs.joinToString(", ")}))"
    }

    /**
     * Emit an all-nullable Kotlin `data class` with a `= null` default for every
     * property. Types are the nullable versions of the standard KotlinTypeMapper mapping:
     * - String? for string/enum/unknown
     * - Int? for integer
     * - Long? for long
     * - Double? for double
     * - Boolean? for boolean
     * - List<String>? for array fields
     * - String? for nested object (deferred)
     *
     * @param vo        the payload value-object whose fields define the properties
     * @param className the name of the generated data class
     * @return Kotlin source snippet for the data class declaration
     */
    fun recoveredClassDecl(vo: MetaObject, className: String): String {
        val props = vo.metaFields.joinToString(",\n") { field ->
            "    val ${field.name}: ${nullableTypeName(field)} = null"
        }
        return "data class $className(\n$props,\n)"
    }

    /**
     * Emit the comma-separated constructor arguments for reconstructing the recovered
     * instance, reading each field from a `Map<String, Object> d` via [RecoverMap].
     *
     * @param vo the payload value-object
     * @return Kotlin source snippet, e.g.
     *         `RecoverMap.asString(d, "text"), RecoverMap.asString(d, "confidence")`
     */
    fun recoveredCtorArgs(vo: MetaObject): String =
        vo.metaFields.joinToString(", ") { constructorArgForField(it) }

    // -------------------------------------------------------------------------
    // Private helpers — schema literal
    // -------------------------------------------------------------------------

    /**
     * Build a `FieldSpec.*(...)}` call for a single field, using Kotlin collection
     * literals (`listOf`, `mapOf`) instead of the Java `List.of` / `Map.ofEntries` APIs.
     */
    private fun fieldSpecLiteral(field: MetaField<*>): String {
        val name = field.name
        val required = isRequired(field)

        if (field is EnumField) {
            return enumFieldSpec(name, required, field)
        }

        // Nested object or array-of-objects: bounded deferral.
        if (field is ObjectField) {
            return "FieldSpec.scalar(\"${kotlinStringLiteral(name)}\", FieldKind.STRING, $required) /* FR-010: nested recover deferred */"
        }

        val kindName = scalarKind(field)
            ?: return "FieldSpec.scalar(\"${kotlinStringLiteral(name)}\", FieldKind.STRING, $required) /* FR-010: unsupported field type, defaulting to STRING */"

        return "FieldSpec.scalar(\"${kotlinStringLiteral(name)}\", FieldKind.$kindName, $required)"
    }

    /**
     * Build a `FieldSpec.enumField(...)` call, including enum values and the alias map
     * (empty `mapOf()` when no `@enumAlias` is present). Entries in the alias map are
     * sorted by key for deterministic output.
     */
    private fun enumFieldSpec(name: String, required: Boolean, field: EnumField): String {
        @Suppress("UNCHECKED_CAST")
        val values = field.getMetaAttr(EnumField.ATTR_VALUES).value as List<String>

        val aliasAttr = if (field.hasMetaAttr(EnumField.ATTR_ENUM_ALIAS, false))
            field.getMetaAttr(EnumField.ATTR_ENUM_ALIAS)
        else null
        val aliases: Properties? = aliasAttr?.value as? Properties

        val aliasMapLiteral = if (aliases != null && aliases.isNotEmpty()) {
            buildMapOfLiteral(aliases)
        } else {
            "mapOf()"
        }

        val valuesList = values.joinToString(", ") { "\"${kotlinStringLiteral(it)}\"" }

        return "FieldSpec.enumField(\"${kotlinStringLiteral(name)}\", $required, listOf($valuesList), $aliasMapLiteral)"
    }

    /**
     * Emit a `mapOf(k to v, ...)` literal from a [Properties]. Entries are sorted by key
     * for deterministic output. Kotlin's `mapOf` has no arity cap (unlike `java.util.Map.of`).
     * Shared with [KotlinOutputFormatSpecEmitter].
     */
    internal fun buildMapOfLiteral(props: Properties): String {
        val keys = props.keys.map { it.toString() }.sorted()
        val entries = keys.joinToString(", ") { k ->
            val v = props.getProperty(k)
            "\"${kotlinStringLiteral(k)}\" to \"${kotlinStringLiteral(v)}\""
        }
        return "mapOf($entries)"
    }

    /**
     * Return the [FieldKind] enum member name for a scalar field, or `null` when the
     * field type is not a known scalar. Matches the same instanceof order as
     * [KotlinTypeMapper.kotlinTypeName]. Shared with [KotlinOutputFormatSpecEmitter].
     */
    internal fun scalarKind(field: MetaField<*>): String? = when (field) {
        is StringField  -> "STRING"
        is IntegerField -> "INT"
        is LongField    -> "LONG"
        is DoubleField  -> "DOUBLE"
        is BooleanField -> "BOOLEAN"
        else            -> null
    }

    // -------------------------------------------------------------------------
    // Private helpers — recovered class declaration
    // -------------------------------------------------------------------------

    /**
     * Nullable Kotlin type name for a field, used in the all-nullable data class.
     * Mirrors [KotlinTypeMapper.kotlinTypeName] but always nullable with `= null` defaults.
     */
    private fun nullableTypeName(field: MetaField<*>): String = when {
        field.isArray                -> "List<String>?"
        field is EnumField           -> "String?"
        field is StringField         -> "String?"
        field is IntegerField        -> "Int?"
        field is LongField           -> "Long?"
        field is DoubleField         -> "Double?"
        field is BooleanField        -> "Boolean?"
        field is ObjectField         -> "String? /* FR-010: nested recover deferred */"
        else                         -> "String?"
    }

    // -------------------------------------------------------------------------
    // Private helpers — constructor args
    // -------------------------------------------------------------------------

    /**
     * Build the `RecoverMap.*` call for a single field's constructor argument.
     * `isArray` is checked BEFORE `EnumField` so that an array-of-enum field uses
     * `asStringList`, consistent with [nullableTypeName] which also checks `isArray` first.
     */
    private fun constructorArgForField(field: MetaField<*>): String {
        val name = field.name

        // Array fields: List<String> — checked first so isArray+EnumField → asStringList.
        if (field.isArray) {
            return "RecoverMap.asStringList(d, \"${kotlinStringLiteral(name)}\")"
        }

        // Enum fields (non-array): string-backed on the wire.
        if (field is EnumField) {
            return "RecoverMap.asString(d, \"${kotlinStringLiteral(name)}\")"
        }

        // Nested object: deferred.
        if (field is ObjectField) {
            return "null /* FR-010: nested recover deferred */"
        }

        // Scalar types.
        return when (field) {
            is IntegerField -> "RecoverMap.asInt(d, \"${kotlinStringLiteral(name)}\")"
            is LongField    -> "RecoverMap.asLong(d, \"${kotlinStringLiteral(name)}\")"
            is DoubleField  -> "RecoverMap.asDouble(d, \"${kotlinStringLiteral(name)}\")"
            is BooleanField -> "RecoverMap.asBool(d, \"${kotlinStringLiteral(name)}\")"
            // StringField (and any other unrecognized type): asString.
            else            -> "RecoverMap.asString(d, \"${kotlinStringLiteral(name)}\")"
        }
    }

    // -------------------------------------------------------------------------
    // Private helpers — common
    // -------------------------------------------------------------------------

    /**
     * Returns `true` when the field carries `@required: true`. Uses `valueAsString`
     * to handle both the Boolean-attribute and String-attribute storage paths
     * (mirrors [KotlinGenUtil.isRequiredField] and the Java `RecoverSchemaEmitter`).
     * Shared with [KotlinOutputFormatSpecEmitter].
     */
    internal fun isRequired(field: MetaField<*>): Boolean =
        field.hasMetaAttr(MetaField.ATTR_REQUIRED)
            && "true".equals(field.getMetaAttr(MetaField.ATTR_REQUIRED).valueAsString, ignoreCase = true)

    /**
     * Escape a string for safe embedding in a Kotlin double-quoted string literal.
     * Handles the six sequences that require escaping: `\`, `"`, `$`, newline, tab,
     * carriage return. `$` must be escaped to `\$` because Kotlin uses `$` and `${}`
     * for string-template interpolation — a bare `$identifier` in generated source
     * would cause an unresolved-reference compile error in the consumer's code.
     * Order: `\` must be first so its own replacement backslash is not re-escaped.
     */
    internal fun kotlinStringLiteral(s: String): String =
        s.replace("\\", "\\\\")
         .replace("\"", "\\\"")
         .replace("$", "\\$")
         .replace("\n", "\\n")
         .replace("\t", "\\t")
         .replace("\r", "\\r")
}

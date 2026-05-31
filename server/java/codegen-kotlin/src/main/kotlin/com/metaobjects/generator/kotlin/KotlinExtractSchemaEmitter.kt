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
import com.metaobjects.util.MetaDataUtil
import java.util.Properties

/**
 * Pure helper that turns a value-object (VO) [MetaObject] into Kotlin SOURCE strings
 * for the FR-010 extract codegen.
 *
 * Three functions:
 * - [schemaLiteral] — emits a `ExtractSchema(Format.X, "Root", listOf(...))` literal
 *   using Kotlin collection syntax.
 * - [extractedClassDecl] — emits an all-nullable Kotlin `data class` mirroring the VO shape,
 *   suitable for use as the extract deserialization target.
 * - [extractedCtorArgs] — emits the comma-separated `ExtractMap.asX(d, "name")` argument
 *   list for constructing the extracted instance from a `Map<String, Object> d`.
 *
 * Field-kind mapping (mirrors [KotlinTypeMapper]):
 * - [EnumField] → `FieldKind.ENUM` via `FieldSpec.enumField`
 * - [StringField] → `FieldKind.STRING`
 * - [IntegerField] → `FieldKind.INT`
 * - [LongField] → `FieldKind.LONG`
 * - [DoubleField] → `FieldKind.DOUBLE`
 * - [BooleanField] → `FieldKind.BOOLEAN`
 * - [ObjectField] / non-scalar array → `FieldKind.STRING` with FR-010 nested-extract-deferred comment
 *
 * Isolating this logic makes all three paths unit-testable without running the full
 * generator pipeline. This object is internal; generators delegate here.
 */
internal object KotlinExtractSchemaEmitter {

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Emit a `ExtractSchema(Format.X, "<rootName>", listOf(...))` literal for all
     * fields on [vo]. Kotlin collection literals are used throughout (not Java APIs).
     *
     * @param vo       the payload value-object whose fields drive the schema
     * @param format   `"xml"` → `Format.XML`; anything else → `Format.JSON`
     * @param rootName the logical root name embedded in the schema
     * @return Kotlin source snippet, e.g.
     *         `ExtractSchema(Format.JSON, "Foo", listOf(...))`
     */
    fun schemaLiteral(vo: MetaObject, format: String, rootName: String): String {
        val formatEnum = if ("xml".equals(format, ignoreCase = true)) "Format.XML" else "Format.JSON"

        val fieldSpecs = vo.metaFields.map { fieldSpecLiteral(it, vo) }

        return "ExtractSchema($formatEnum, \"${kotlinStringLiteral(rootName)}\", listOf(${fieldSpecs.joinToString(", ")}))"
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
    fun extractedClassDecl(vo: MetaObject, className: String): String {
        val props = vo.metaFields.joinToString(",\n") { field ->
            "    val ${field.name}: ${nullableTypeName(field)} = null"
        }
        return "data class $className(\n$props,\n)"
    }

    /**
     * Emit the comma-separated constructor arguments for reconstructing the extracted
     * instance, reading each field from a `Map<String, Object> d` via [ExtractMap].
     *
     * @param vo the payload value-object
     * @return Kotlin source snippet, e.g.
     *         `ExtractMap.asString(d, "text"), ExtractMap.asString(d, "confidence")`
     */
    fun extractedCtorArgs(vo: MetaObject): String =
        vo.metaFields.joinToString(", ") { constructorArgForField(it) }

    // -------------------------------------------------------------------------
    // Public API — nested-aware (runtime-delegating extract)
    // -------------------------------------------------------------------------

    /**
     * FR-010 nested gap (codegen-wrapping-runtime): emit the all-nullable extracted
     * mirror `data class` for [rootVo] AS [rootClassName], PLUS one nested mirror
     * `data class <NestedShort>Extracted` per reachable nested value-object (deduped
     * by FQN). Unlike [extractedClassDecl] — which flattens nested objects to
     * `String?` — nested object fields here are typed as the nested mirror
     * (`<NestedShort>Extracted?`) or `List<<NestedShort>Extracted>?` for an
     * array-of-objects, so the runtime-delegating extract can populate the full graph.
     *
     * <p>Cycle/depth bounding is handled upstream by `MetaObjectExtractor`; the per-FQN
     * dedupe set here also stops the emitter from recursing forever on a cyclic graph.</p>
     *
     * @return Kotlin source: the root mirror declaration followed by the nested ones,
     *         separated by blank lines. Returns the same shape as [extractedClassDecl]
     *         when [rootVo] has no nested object fields.
     */
    fun extractedClassDeclsNested(rootVo: MetaObject, rootClassName: String): String {
        val out = StringBuilder()
        val emitted = LinkedHashSet<String>()
        emitMirror(rootVo, rootClassName, out, emitted)
        return out.toString().trimEnd()
    }

    /**
     * The nested mirror class name for a value-object: `<ShortName>Extracted`. Mirrors
     * [KotlinPayloadGenerator]'s nested payload naming (`<ShortName>Payload`) but for the
     * extracted (all-nullable) mirror. Public so the parser generator names mappers consistently.
     */
    fun nestedExtractedClass(vo: MetaObject): String =
        PackageMapping.splitFqn(vo.name).second + "Extracted"

    private fun emitMirror(
        vo: MetaObject,
        className: String,
        out: StringBuilder,
        emitted: LinkedHashSet<String>,
    ) {
        if (!emitted.add(vo.name)) return // dedupe + cycle guard

        val nested = mutableListOf<MetaObject>()
        val props = vo.metaFields.joinToString(",\n") { field ->
            "    val ${field.name}: ${nestedNullableTypeName(field, nested)} = null"
        }
        out.append("data class $className(\n$props,\n)\n\n")

        for (nestedVo in nested) {
            emitMirror(nestedVo, nestedExtractedClass(nestedVo), out, emitted)
        }
    }

    /**
     * Nullable Kotlin type for a field in the nested-aware mirror. Object fields whose
     * `@objectRef` resolves to a value-object become the nested mirror type (single) or
     * `List<<NestedShort>Extracted>?` (array-of-objects); the discovered nested VO is
     * recorded into [nested] so the caller emits its mirror. All other fields fall back
     * to the scalar mapping in [nullableTypeName].
     */
    private fun nestedNullableTypeName(field: MetaField<*>, nested: MutableList<MetaObject>): String {
        val target = objectRefValueObject(field)
        if (target != null) {
            val nestedClass = nestedExtractedClass(target)
            nested.add(target)
            return if (field.isArrayType()) "List<$nestedClass>?" else "$nestedClass?"
        }
        return nullableTypeName(field)
    }

    // -------------------------------------------------------------------------
    // Private helpers — schema literal
    // -------------------------------------------------------------------------

    /**
     * Build a `FieldSpec.*(...)}` call for a single field, using Kotlin collection
     * literals (`listOf`, `mapOf`) instead of the Java `List.of` / `Map.ofEntries` APIs.
     */
    private fun fieldSpecLiteral(field: MetaField<*>, owner: MetaObject): String {
        val name = field.name
        val required = isRequired(field)

        if (field is EnumField) {
            return enumFieldSpec(name, required, field, owner)
        }

        // Nested object or array-of-objects: bounded deferral.
        if (field is ObjectField) {
            return "FieldSpec.scalar(\"${kotlinStringLiteral(name)}\", FieldKind.STRING, $required) /* FR-010: nested extract deferred */"
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
    private fun enumFieldSpec(name: String, required: Boolean, field: EnumField, owner: MetaObject): String {
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

        // FR-011: resolve the three new enum args (field → object.value → "strip" for normalize).
        // Keep the back-compat 4-arg form when nothing is set; otherwise emit the 7-arg form
        // (name, required, values, aliases, coerceDefault, normalize, defaultValue).
        val coerceDefault = ownAttrString(field, EnumField.ATTR_COERCE_DEFAULT)
        val defaultValue = ownAttrString(field, EnumField.ATTR_DEFAULT)
        val normalize = resolveNormalize(field, owner)

        if (coerceDefault == null && defaultValue == null && normalize == EnumField.NORMALIZE_DEFAULT) {
            return "FieldSpec.enumField(\"${kotlinStringLiteral(name)}\", $required, listOf($valuesList), $aliasMapLiteral)"
        }

        val cdLit = if (coerceDefault == null) "null" else "\"${kotlinStringLiteral(coerceDefault)}\""
        val normLit = "\"$normalize\""
        val dvLit = if (defaultValue == null) "null" else "\"${kotlinStringLiteral(defaultValue)}\""

        return "FieldSpec.enumField(\"${kotlinStringLiteral(name)}\", $required, listOf($valuesList), " +
            "$aliasMapLiteral, $cdLit, $normLit, $dvLit)"
    }

    /**
     * FR-011: resolve the enum normalization mode for a field — field-level `@normalize`, else the
     * owning `object.value`'s `@normalize` (the per-object default), else the global default
     * ("strip"). Mirrors the Java ExtractSchemaEmitter.resolveNormalize and the TS resolveNormalize.
     */
    internal fun resolveNormalize(field: MetaField<*>, owner: MetaObject?): String {
        ownAttrString(field, EnumField.ATTR_NORMALIZE)?.let { return it }
        if (owner != null) ownAttrString(owner, EnumField.ATTR_NORMALIZE)?.let { return it }
        return EnumField.NORMALIZE_DEFAULT
    }

    /** The own (non-inherited) string value of an attr on a node, or null when absent/empty. */
    private fun ownAttrString(node: com.metaobjects.MetaData, attr: String): String? {
        if (!node.hasMetaAttr(attr, false)) return null
        val s = node.getMetaAttr(attr, false).valueAsString
        return if (s.isNullOrEmpty()) null else s
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
    // Private helpers — extracted class declaration
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
        field is ObjectField         -> "String? /* FR-010: nested extract deferred */"
        else                         -> "String?"
    }

    // -------------------------------------------------------------------------
    // Private helpers — constructor args
    // -------------------------------------------------------------------------

    /**
     * Build the `ExtractMap.*` call for a single field's constructor argument.
     * `isArray` is checked BEFORE `EnumField` so that an array-of-enum field uses
     * `asStringList`, consistent with [nullableTypeName] which also checks `isArray` first.
     */
    private fun constructorArgForField(field: MetaField<*>): String {
        val name = field.name

        // Nested object / array-of-objects (NOT enum): deferred in the self-contained path
        // (the mirror property is a nested Extracted mirror or List<NestedExtracted>?, which
        // the scalar ExtractMap readers can't produce). The runtime-delegating extract
        // overload populates these — emit a null so the self-contained ctor still compiles.
        // Checked BEFORE isArray so array-of-objects also defers (not asStringList).
        if (objectRefValueObject(field) != null) {
            return "null /* FR-010: nested extract deferred — use extractLenient(loader, text) */"
        }

        // Array fields: List<String> — checked before EnumField so isArray+EnumField → asStringList.
        if (field.isArray) {
            return "ExtractMap.asStringList(d, \"${kotlinStringLiteral(name)}\")"
        }

        // Enum fields (non-array): string-backed on the wire.
        if (field is EnumField) {
            return "ExtractMap.asString(d, \"${kotlinStringLiteral(name)}\")"
        }

        // Nested object whose ref is unresolved / non-VO: defensive deferral.
        if (field is ObjectField) {
            return "null /* FR-010: nested extract deferred */"
        }

        // Scalar types.
        return when (field) {
            is IntegerField -> "ExtractMap.asInt(d, \"${kotlinStringLiteral(name)}\")"
            is LongField    -> "ExtractMap.asLong(d, \"${kotlinStringLiteral(name)}\")"
            is DoubleField  -> "ExtractMap.asDouble(d, \"${kotlinStringLiteral(name)}\")"
            is BooleanField -> "ExtractMap.asBool(d, \"${kotlinStringLiteral(name)}\")"
            // StringField (and any other unrecognized type): asString.
            else            -> "ExtractMap.asString(d, \"${kotlinStringLiteral(name)}\")"
        }
    }

    // -------------------------------------------------------------------------
    // Private helpers — common
    // -------------------------------------------------------------------------

    /**
     * Returns `true` when the field carries `@required: true`. Uses `valueAsString`
     * to handle both the Boolean-attribute and String-attribute storage paths
     * (mirrors [KotlinGenUtil.isRequiredField] and the Java `ExtractSchemaEmitter`).
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

    /**
     * Resolve a field's `@objectRef` to its target value-object, or null when the field is
     * not an object reference, is an enum (string-backed scalar), the ref can't be resolved,
     * or the target is not an `object.value` (e.g. an entity — defensive, matches the payload-VO
     * contract). Used to decide whether a field is a nested-object component.
     */
    internal fun objectRefValueObject(field: MetaField<*>): MetaObject? {
        if (field is EnumField) return null
        val isObjectField = field is ObjectField || MetaDataUtil.hasObjectRef(field)
        if (!isObjectField) return null
        val target = try {
            MetaDataUtil.getObjectRef(field)
        } catch (e: RuntimeException) {
            return null
        }
        return target?.takeIf { it.subType == MetaObject.SUBTYPE_VALUE }
    }
}

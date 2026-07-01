package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.field.MapField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.`object`.MetaObject
import com.metaobjects.util.MetaDataUtil
import java.util.Properties

/**
 * Pure helper that turns a value-object (VO) [MetaObject] into Kotlin SOURCE strings
 * for the FR-010 extract codegen.
 *
 * Emits the all-nullable "Extracted" mirror `data class` graph for the
 * runtime-delegating `extractLenient(loader, text)` path, and hosts the shared
 * string/field-kind helpers reused by [KotlinExtractMapperEmitter],
 * [KotlinExtractorGenerator], and [KotlinOutputFormatSpecEmitter]:
 * - [extractedClassDeclsNested] — the root mirror + one nested mirror per reachable VO.
 * - [nestedExtractedClass] — the `<ShortName>Extracted` mirror class name.
 * - [kotlinStringLiteral] / [scalarKind] / [isRequired] / [buildMapOfLiteral] /
 *   [objectRefValueObject] — shared source-emission utilities.
 *
 * The metadata is read directly off the live [MetaField] (inheritance-aware), so there
 * is no baked snapshot to drift. This object is internal; generators delegate here.
 */
internal object KotlinExtractSchemaEmitter {

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
    // Private helpers — shared source-emission utilities
    // -------------------------------------------------------------------------

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
        // ADR-0039: resolving array-ness (isArray is the own-only native flag).
        field.isArrayType()          -> "List<String>?"
        field is EnumField           -> "String?"
        field is StringField         -> "String?"
        field is IntegerField        -> "Int?"
        field is LongField           -> "Long?"
        field is DoubleField         -> "Double?"
        field is BooleanField        -> "Boolean?"
        field is ObjectField         -> "String? /* FR-010: nested extract deferred */"
        field is MapField            -> "String? /* FR-010: map extract deferred */"
        else                         -> "String?"
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

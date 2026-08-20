package com.metaobjects.generator.kotlin

import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.field.MapField
import com.metaobjects.field.ObjectField
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.PromptTemplate
import com.metaobjects.template.TemplateConstants
import java.util.Properties

/**
 * Pure helper that turns a value-object (VO) [MetaObject] + its `template.output`
 * node into a Kotlin SOURCE literal for an `OutputFormatSpec` — the artifact-1
 * prompt descriptor used by the FR-010 prompt-fragment codegen.
 *
 * The public entry point is [specLiteral], which emits an
 * `OutputFormatSpec(Format.X, "<rootName>", PromptStyle.<S>, listOf(<PromptField...>))`
 * source snippet ready for embedding in a generated Kotlin file.
 *
 * Field-kind mapping (mirrors the Java [com.metaobjects.generator.spring.OutputFormatSpecEmitter]):
 * - [EnumField]    → `FieldKind.ENUM`
 * - [StringField]  → `FieldKind.STRING`
 * - [IntegerField] → `FieldKind.INT`
 * - [LongField]    → `FieldKind.LONG`
 * - [DoubleField]  → `FieldKind.DOUBLE`
 * - [BooleanField] → `FieldKind.BOOLEAN`
 * - [ObjectField]  → `FieldKind.OBJECT`, nested arg `null` (FR-010: nested prompt deferred)
 *
 * String escaping, scalar-kind mapping, required-field resolution, and map-literal
 * building all delegate to [KotlinExtractSchemaEmitter] (shared helpers, same package).
 *
 * This object is internal; generators delegate here.
 */
internal object KotlinOutputFormatSpecEmitter {

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Emit an `OutputFormatSpec(Format.X, "<rootName>", PromptStyle.<S>, listOf(...))`
     * literal for all fields on [vo]. Kotlin collection literals are used throughout
     * (`listOf`, `mapOf`) rather than the Java `List.of` / `Map.ofEntries` APIs.
     *
     * `@format` from the template: `"xml"` → `Format.XML`; anything else → `Format.JSON`.
     *
     * `@promptStyle`: `"guide"` → `PromptStyle.GUIDE` (default),
     * `"inline"` → `PromptStyle.INLINE`,
     * `"exampleOnly"` → `PromptStyle.EXAMPLE_ONLY`.
     *
     * @param vo       the payload value-object whose fields drive the spec
     * @param template the `template.output` node carrying `@format` and `@promptStyle`
     * @param rootName the logical root name embedded in the spec
     * @return Kotlin source snippet, e.g.
     *         `OutputFormatSpec(Format.JSON, "Foo", PromptStyle.GUIDE, listOf(...))`
     */
    fun specLiteral(vo: MetaObject, template: MetaTemplate, rootName: String): String {
        val formatEnum = resolveFormatEnum(template)
        val promptStyleEnum = resolvePromptStyleEnum(template)

        val fieldLiterals = vo.metaFields.map { promptFieldLiteral(it) }

        return "OutputFormatSpec($formatEnum, \"${KotlinExtractSchemaEmitter.kotlinStringLiteral(rootName)}\", $promptStyleEnum, listOf(${fieldLiterals.joinToString(", ")}))"
    }

    // -------------------------------------------------------------------------
    // Private helpers — template attr resolution
    // -------------------------------------------------------------------------

    /**
     * Resolve the REPLY's syntax to a `Format.*` enum literal.
     *
     * ADR-0053: reads `@responseFormat`, never `@format`. The fragment this spec drives tells
     * the model how to format its REPLY; `@format` is the syntax of the rendered prompt BODY,
     * and the two genuinely differ — a text-bodied prompt asking for a JSON answer is the
     * common case.
     */
    private fun resolveFormatEnum(template: MetaTemplate): String =
        if (FindInbound.isXml(FindInbound.responseFormatOf(template))) "Format.XML" else "Format.JSON"

    /**
     * Resolve `@promptStyle` to a `PromptStyle.*` enum literal.
     * Default (absent or unrecognized) → `PromptStyle.GUIDE`.
     */
    private fun resolvePromptStyleEnum(template: MetaTemplate): String {
        val raw = (template as? PromptTemplate)?.promptStyle
            ?: TemplateConstants.PROMPT_STYLE_DEFAULT
        return when (raw) {
            TemplateConstants.PROMPT_STYLE_INLINE       -> "PromptStyle.INLINE"
            TemplateConstants.PROMPT_STYLE_EXAMPLE_ONLY -> "PromptStyle.EXAMPLE_ONLY"
            else                                        -> "PromptStyle.GUIDE"
        }
    }

    // -------------------------------------------------------------------------
    // Private helpers — field literal
    // -------------------------------------------------------------------------

    /**
     * Build a `PromptField(...)` call for a single field.
     *
     * Constructor shape:
     * `PromptField(name, FieldKind, required, array,
     * enumValues-or-null, enumDoc-map-or-null, example-or-null,
     * instruction-or-null, nested-or-null)`
     */
    private fun promptFieldLiteral(field: MetaField<*>): String {
        val name = field.name
        val required = KotlinExtractSchemaEmitter.isRequired(field)
        // ADR-0039: resolving array-ness (isArray is the own-only native flag).
        val array = field.isArrayType()

        // Nested object OR open-keyed map — both structured JSON values; bounded
        // deferral (mirrors Java plan 3.1). FieldKind.OBJECT, nested prompt deferred.
        if (field is ObjectField || field is MapField) {
            return "PromptField(\"${KotlinExtractSchemaEmitter.kotlinStringLiteral(name)}\", FieldKind.OBJECT, $required, $array, null, null, null, null, null) /* FR-010: nested prompt deferred */"
        }

        // Enum field — include values + optional enumDoc.
        if (field is EnumField) {
            return enumPromptFieldLiteral(name, required, array, field)
        }

        // Scalar — resolve @example and @instruction.
        val kindName = KotlinExtractSchemaEmitter.scalarKind(field) ?: "STRING" // Unknown type: fall back to STRING.
        val exampleLit = optStringAttr(field, MetaField.ATTR_EXAMPLE)
        val instructionLit = optStringAttr(field, MetaField.ATTR_INSTRUCTION)

        return "PromptField(\"${KotlinExtractSchemaEmitter.kotlinStringLiteral(name)}\", FieldKind.$kindName, $required, $array, null, null, $exampleLit, $instructionLit, null)"
    }

    /**
     * Build a `PromptField(...)` call for an enum field, including values list
     * and optional enumDoc map. Entries in the enumDoc map are sorted by key for
     * deterministic output. Kotlin's `mapOf` has no arity cap.
     */
    private fun enumPromptFieldLiteral(
        name: String, required: Boolean, array: Boolean, field: EnumField
    ): String {
        // @values — guaranteed non-null by the loader's ValidationPhase.
        @Suppress("UNCHECKED_CAST")
        val values = field.getMetaAttr(EnumField.ATTR_VALUES).value as List<String>
        val valuesList = values.joinToString(", ") { "\"${KotlinExtractSchemaEmitter.kotlinStringLiteral(it)}\"" }
        val valuesLit = "listOf($valuesList)"

        // @enumDoc — optional; null when absent or empty.
        // ADR-0039: @enumDoc is an effective property — resolve (consistent with @values above).
        val enumDocLit: String = run {
            if (!field.hasMetaAttr(EnumField.ATTR_ENUM_DOC)) return@run "null"
            val v = field.getMetaAttr(EnumField.ATTR_ENUM_DOC).value
            if (v is Properties && v.isNotEmpty()) KotlinExtractSchemaEmitter.buildMapOfLiteral(v) else "null"
        }

        val exampleLit = optStringAttr(field, MetaField.ATTR_EXAMPLE)
        val instructionLit = optStringAttr(field, MetaField.ATTR_INSTRUCTION)

        return "PromptField(\"${KotlinExtractSchemaEmitter.kotlinStringLiteral(name)}\", FieldKind.ENUM, $required, $array, $valuesLit, $enumDocLit, $exampleLit, $instructionLit, null)"
    }

    // -------------------------------------------------------------------------
    // Private helpers — attribute reads
    // -------------------------------------------------------------------------

    /**
     * Return a Kotlin string literal for an optional String attribute, or the literal `null`.
     * The value is escaped via [KotlinExtractSchemaEmitter.kotlinStringLiteral] so that
     * example/instruction free-text containing quotes or newlines embeds safely in Kotlin source.
     */
    private fun optStringAttr(field: MetaField<*>, attrName: String): String {
        // ADR-0039: @example/@instruction are effective properties — resolve (consistent
        // with @values/@required which resolve).
        if (!field.hasMetaAttr(attrName)) return "null"
        val v = field.getMetaAttr(attrName).valueAsString ?: return "null"
        return "\"${KotlinExtractSchemaEmitter.kotlinStringLiteral(v)}\""
    }

}

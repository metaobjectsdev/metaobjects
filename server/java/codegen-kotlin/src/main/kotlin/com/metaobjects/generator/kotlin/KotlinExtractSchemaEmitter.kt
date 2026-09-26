package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MapField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.FLOAT
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import com.squareup.kotlinpoet.TypeName
import java.nio.file.Path
import java.util.Properties

/**
 * The lenient extraction mirror of a value object, and the source-emission helpers the FR-010
 * extract tier shares.
 *
 * <p>A mirror is `data class <VoShort>Extracted` — every property nullable, enum and scalar-array
 * leaves kept as the strings the extract engine produces — so a partial model reply still maps.
 * Per ADR-0056 it is keyed by the VALUE OBJECT, not by the template that reached it: one file,
 * `<vo-package>/<VoShort>Extracted.kt`, beside the strict data class [KotlinEntityGenerator] emits,
 * written at most once per run. Where it lands never depends on which template reached it first,
 * which is the defect the old per-template placement had (#387).
 *
 * <p>The file carries both conversions a mirror takes part in:
 * <ul>
 *   <li>`fromMap(Map)` — the assembled `ValueObject` graph (a `Map<String, Any?>` with nested
 *       maps and lists) the runtime `MetaObjectExtractor` produces, onto the typed mirror;</li>
 *   <li>`toStrict()` — the mirror onto the strict value-object data class, once the caller knows
 *       no `@required` field was lost.</li>
 * </ul>
 *
 * <p>The metadata is read off the live [MetaField] (inheritance-aware), so there is no baked
 * snapshot to drift. This object is internal; generators delegate here.
 */
object KotlinExtractSchemaEmitter {

    // -------------------------------------------------------------------------
    // Mirror files
    // -------------------------------------------------------------------------

    /** The mirror class name for [vo]: `<VoShort>Extracted`. */
    fun mirrorName(vo: MetaObject): String =
        KotlinNaming.extractedName(PackageMapping.splitFqn(vo.name).second)

    // strictRef / mirrorRef / requireReferenceable now live in KotlinNaming — the naming
    // layer every tier asks to reference a value object's types (ADR-0056); this emitter is
    // a consumer like the others.

    /**
     * Write the mirror file for [rootVo] and for every value object it reaches through a declared
     * `field.object @objectRef`, skipping any FQN already in [emitted] (the run-wide dedupe, and
     * the cycle guard).
     */
    fun emitMirrorFiles(rootVo: MetaObject, outRoot: Path, emitted: MutableSet<String>) {
        if (!emitted.add(rootVo.name)) return
        val (pkg, _) = PackageMapping.splitFqn(rootVo.name)
        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("${mirrorName(rootVo)}.kt")
        GeneratedFileWriter.write(outFile, mirrorSource(rootVo))
        for (field in rootVo.metaFields) {
            val nested = objectRefValueObject(field) ?: continue
            KotlinNaming.requireReferenceable(pkg, nested, "value object '${rootVo.name}'")
            emitMirrorFiles(nested, outRoot, emitted)
        }
    }

    /** The full Kotlin source of [vo]'s mirror file. */
    fun mirrorSource(vo: MetaObject): String {
        val (pkg, short) = PackageMapping.splitFqn(vo.name)
        val mirror = mirrorName(vo)
        val fields = vo.metaFields.toList()
        return buildString {
            append("// GENERATED — DO NOT EDIT — lenient extraction mirror of value object `")
            append(vo.name)
            append("`\n")
            if (pkg.isNotEmpty()) append("package ").append(pkg).append("\n\n")
            append("import com.metaobjects.render.extract.ExtractMap\n\n")
            append("/**\n")
            append(" * All-nullable mirror of [").append(short).append("] for tolerant extraction: a partial model\n")
            append(" * reply still maps. [toStrict] converts it once no `@required` field was lost or malformed.\n")
            append(" */\n")
            append("data class ").append(mirror).append("(\n")
            for (field in fields) {
                append("    val ").append(field.name).append(": ").append(mirrorPropertyType(field)).append(" = null,\n")
            }
            append(") {\n\n")
            append("    /** The strict [").append(short).append("]. Call only once the extract report shows no lost or malformed required field. */\n")
            append("    fun toStrict(): ").append(short).append(" = ").append(short).append("(\n")
            for (field in fields) {
                append("        ").append(field.name).append(" = ").append(strictArg(field, vo)).append(",\n")
            }
            append("    )\n\n")
            append("    companion object {\n\n")
            append("        /** Map an assembled ValueObject (a Map) onto the typed mirror; null-tolerant. */\n")
            append("        @JvmStatic\n")
            append("        fun fromMap(d: Map<String, Any?>?): ").append(mirror).append("? {\n")
            append("            if (d == null) return null\n")
            append("            return ").append(mirror).append("(\n")
            for (field in fields) {
                append("                ").append(field.name).append(" = ").append(fromMapArg(field)).append(",\n")
            }
            append("            )\n")
            append("        }\n")
            // The two helpers only a nested value object needs: `asMap` for a single nested
            // object (and inside mapObjectList), `mapObjectList` for an array of them.
            val nestedFields = fields.filter { objectRefValueObject(it) != null }
            if (nestedFields.isNotEmpty()) {
                append("\n")
                append("        /** Null-tolerant cast of an assembled value to a Map (a ValueObject IS a Map). */\n")
                append("        @Suppress(\"UNCHECKED_CAST\")\n")
                append("        private fun asMap(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>\n")
            }
            if (nestedFields.any { it.isArrayType() }) {
                append("\n")
                append("        /** Map each element of an assembled List<Map> via [fn]; null/absent -> null; non-Map elements skipped. */\n")
                append("        private fun <T> mapObjectList(d: Map<String, Any?>, key: String, fn: (Map<String, Any?>) -> T): List<T>? {\n")
                append("            val v = d[key] as? List<*> ?: return null\n")
                append("            val outList = ArrayList<T>(v.size)\n")
                append("            for (elem in v) {\n")
                append("                val m = asMap(elem)\n")
                append("                if (m != null) outList.add(fn(m))\n")
                append("            }\n")
                append("            return outList\n")
                append("        }\n")
            }
            append("    }\n")
            append("}\n")
        }
    }

    /**
     * The nullable mirror type of one property. A value-object field is its nested mirror (or a
     * list of them); every other leaf keeps the type the extract engine produces.
     */
    private fun mirrorPropertyType(field: MetaField<*>): String {
        val target = objectRefValueObject(field)
        if (target != null) {
            return if (field.isArrayType()) "List<${KotlinNaming.mirrorRef(target)}>?" else "${KotlinNaming.mirrorRef(target)}?"
        }
        return when {
            // ADR-0039: resolving array-ness (isArray is the own-only native flag).
            field.isArrayType()  -> "List<String>?"
            field is EnumField   -> "String?"
            field is StringField -> "String?"
            field is IntegerField -> "Int?"
            field is LongField   -> "Long?"
            field is DoubleField -> "Double?"
            field is BooleanField -> "Boolean?"
            field is ObjectField -> "String? /* FR-010: a non-value-object target is not extracted */"
            field is MapField    -> "String? /* FR-010: map extract deferred */"
            else                 -> "String?"
        }
    }

    /**
     * The `fromMap` constructor argument reading [field] from the assembled map `d`. Scalars,
     * enums and scalar arrays go through `ExtractMap`; a nested value object recurses into its
     * own mirror's `fromMap`; an array of them maps element-wise.
     */
    private fun fromMapArg(field: MetaField<*>): String {
        val key = "\"${kotlinStringLiteral(field.name)}\""
        val target = objectRefValueObject(field)
        if (target != null) {
            val nested = KotlinNaming.mirrorRef(target)
            // `it` is a non-null Map here, so fromMap never returns null — `!!` keeps the element
            // type non-null to match the List<Nested> mirror property.
            return if (field.isArrayType()) "mapObjectList(d, $key) { $nested.fromMap(it)!! }"
            else "$nested.fromMap(asMap(d[$key]))"
        }
        if (field.isArrayType()) return "ExtractMap.asStringList(d, $key)"
        return when (field) {
            is EnumField    -> "ExtractMap.asString(d, $key)"
            is IntegerField -> "ExtractMap.asInt(d, $key)"
            is LongField    -> "ExtractMap.asLong(d, $key)"
            is DoubleField  -> "ExtractMap.asDouble(d, $key)"
            is BooleanField -> "ExtractMap.asBool(d, $key)"
            else            -> "ExtractMap.asString(d, $key)"
        }
    }

    /**
     * The `toStrict()` constructor argument for one property: the mirror value, converted to the
     * strict property type [KotlinEntityGenerator] declares, and null-asserted only where that
     * property is non-null ([KotlinGenUtil.isNullableShapeProperty] — the same predicate the entity
     * generator uses, so the two cannot disagree).
     */
    private fun strictArg(field: MetaField<*>, owner: MetaObject): String {
        val name = field.name
        val nullable = KotlinGenUtil.isNullableShapeProperty(field)
        // `!!` where the strict property is non-null; a safe call where it may be null.
        val deref = if (nullable) "?" else "!!"

        // A nested value object (or a list of them): its own mirror's toStrict().
        val target = objectRefValueObject(field)
        if (target != null) {
            return if (field.isArrayType()) "$name$deref.map { it.toStrict() }" else "$name$deref.toStrict()"
        }

        // Enum BEFORE the generic scalar-array branch: the mirror keeps the member symbol as a
        // String, the strict property is the generated enum class. `valueOf` is safe because the
        // loader validated @values against the enum constants.
        if (field is EnumField) {
            val enumType = KotlinTypeMapper.enumTypeName(field, owner)
            if (enumType != null) {
                val enumFqn = enumType.canonicalName
                return if (field.isArrayType()) {
                    if (nullable) "$name?.filterNotNull()?.map { $enumFqn.valueOf(it) }"
                    else "$name!!.filterNotNull().map { $enumFqn.valueOf(it) }"
                } else {
                    if (nullable) "$name?.let { $enumFqn.valueOf(it) }" else "$enumFqn.valueOf($name!!)"
                }
            }
        }

        // Scalar arrays: the mirror is always List<String> (ExtractMap.asStringList stringifies
        // every element), so each element parses to the strict element type.
        if (field.isArrayType()) {
            val conv = fromStringConversion(field, KotlinTypeMapper.payloadTypeName(field))
            val base = if (nullable) "$name?.filterNotNull()" else "$name!!.filterNotNull()"
            if (conv == null) return base
            return if (nullable) "$base?.map { $conv }" else "$base.map { $conv }"
        }

        // A map, or an object field onto something other than a value object: the mirror does
        // not extract it (see mirrorPropertyType), so there is no value to carry across.
        if (field is MapField || field is ObjectField) {
            if (nullable) return "null /* FR-010: not extracted */"
            throw GeneratorException(
                "extract tier: required field '$name' on '${owner.name}' is a " +
                    (if (field is MapField) "field.map" else "field.object onto a non-value-object target") +
                    ", which the lenient extract does not populate — make it optional, or own a " +
                    "generator that extracts it"
            )
        }

        // A single scalar: parse when the mirror leaf is a String and the strict type is not.
        val strict = KotlinTypeMapper.payloadTypeName(field)
        val conv = if (mirrorScalar(field) == strict) null else fromStringConversion(field, strict)
        return when {
            conv == null && nullable -> name
            conv == null -> "$name!!"
            nullable -> "$name?.let { $conv }"
            else -> "$name!!.let { $conv }"
        }
    }

    /** The mirror's non-null leaf type for a single scalar (see [mirrorPropertyType]). */
    private fun mirrorScalar(field: MetaField<*>): TypeName = when (field) {
        is IntegerField -> INT
        is LongField    -> LONG
        is DoubleField  -> DOUBLE
        is BooleanField -> BOOLEAN
        else            -> STRING
    }

    /**
     * The expression that parses a non-null `String` named `it` into [strict], or `null` when
     * [strict] is itself `String`. Fails loud at codegen time for a type with no safe parse, rather
     * than emitting Kotlin that does not compile.
     */
    private fun fromStringConversion(field: MetaField<*>, strict: TypeName): String? {
        if (KotlinTypeMapper.isJsonbOpenBag(field)) return "kotlinx.serialization.json.Json.parseToJsonElement(it)"
        return when (strict) {
            STRING  -> null
            INT     -> "it.toInt()"
            LONG    -> "it.toLong()"      // also field.currency (minor-unit Long)
            DOUBLE  -> "it.toDouble()"
            FLOAT   -> "it.toFloat()"
            BOOLEAN -> "it.toBoolean()"
            else -> when (strict.toString()) {
                "java.util.UUID"          -> "java.util.UUID.fromString(it)"
                "java.math.BigDecimal"    -> "java.math.BigDecimal(it)"
                "java.net.URI"            -> "java.net.URI(it)"
                "java.time.LocalDate"     -> "java.time.LocalDate.parse(it)"
                "java.time.LocalTime"     -> "java.time.LocalTime.parse(it)"
                "java.time.LocalDateTime" -> "java.time.LocalDateTime.parse(it)"
                "java.time.Instant"       -> "java.time.Instant.parse(it)"
                else -> throw GeneratorException(
                    "extract tier: no String->$strict conversion for field '${field.name}' — " +
                        "add one in KotlinExtractSchemaEmitter.fromStringConversion, or own a " +
                        "generator that maps it"
                )
            }
        }
    }

    // -------------------------------------------------------------------------
    // Shared source-emission utilities
    // -------------------------------------------------------------------------

    /**
     * Emit a `mapOf(k to v, ...)` literal from a [Properties]. Entries are sorted by key
     * for deterministic output. Kotlin's `mapOf` has no arity cap (unlike `java.util.Map.of`).
     * Shared with [KotlinOutputFormatSpecEmitter].
     */
    fun buildMapOfLiteral(props: Properties): String {
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
    fun scalarKind(field: MetaField<*>): String? = when (field) {
        is StringField  -> "STRING"
        is IntegerField -> "INT"
        is LongField    -> "LONG"
        is DoubleField  -> "DOUBLE"
        is BooleanField -> "BOOLEAN"
        else            -> null
    }

    /**
     * Returns `true` when the field carries `@required: true`. Uses `valueAsString`
     * to handle both the Boolean-attribute and String-attribute storage paths
     * (mirrors [KotlinGenUtil.isRequiredField] and the Java `ExtractSchemaEmitter`).
     * Shared with [KotlinOutputFormatSpecEmitter].
     */
    fun isRequired(field: MetaField<*>): Boolean =
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
    fun kotlinStringLiteral(s: String): String =
        s.replace("\\", "\\\\")
         .replace("\"", "\\\"")
         .replace("$", "\\$")
         .replace("\n", "\\n")
         .replace("\t", "\\t")
         .replace("\r", "\\r")

    /**
     * Resolve a field's `@objectRef` to its target value object, or null when the field is not
     * a `field.object`, the ref can't be resolved, or the target is not an `object.value`. A
     * `field.map @objectRef` is deliberately NOT a nested object here: it is a keyed map of value
     * objects, which the lenient extract does not populate (see [mirrorPropertyType]).
     */
    fun objectRefValueObject(field: MetaField<*>): MetaObject? {
        if (field !is ObjectField) return null
        val target = try {
            field.objectRef
        } catch (e: RuntimeException) {
            return null
        }
        return target?.takeIf { it.subType == MetaObject.SUBTYPE_VALUE }
    }
}

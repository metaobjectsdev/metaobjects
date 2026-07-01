package com.metaobjects.generator.kotlin

import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.OutputTemplate
import com.metaobjects.template.TemplateConstants
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.FLOAT
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.slf4j.LoggerFactory

/**
 * Cross-port Extractor codegen (Kotlin port) — the `extract` tier over the existing tolerant
 * extract. Emits one `<TemplateShortName>Extractor.kt` per nested-capable `template.output`.
 *
 * <p>The emitted `object <Name>Extractor` turns dirty LLM text into the STRICT typed payload
 * `data class` ([KotlinPayloadGenerator]'s immutable, all-non-null `@Serializable data class`)
 * in one call. It REUSES the nested-capable runtime-delegating extract emitted by
 * [KotlinOutputParserGenerator] — `<Name>Parser.extractLenient(loader, text)`, which assembles the FULL
 * nested object graph via the runtime [com.metaobjects.object.extract.MetaObjectExtractor] — runs
 * it, throws [com.metaobjects.render.extract.ExtractException] iff a `@required` field was lost,
 * else maps the all-nullable `<Name>Extracted` mirror onto the strict payload via a generated
 * recursive mirror->strict mapper (recurse nested objects + arrays-of-objects; one-shot construct
 * via the primary constructor). `extract` is re-exposed unchanged.</p>
 *
 * <p>NO registry / binding / factory — codegen knows the whole type graph statically.</p>
 *
 * <h3>Why the extract path is loader-based (nested-capable)</h3>
 * The parser's self-contained `extractLenient(text)` leaves nested objects null (FR-010 nested gap).
 * Only the parser's `extractLenient(loader, text)` overload — which delegates to `MetaObjectExtractor` and
 * maps the assembled `ValueObject` graph into the typed mirror — populates the full nested graph.
 * The extractor therefore routes exclusively through `extractLenient(loader, text)`, mirroring the
 * shipped Java `ExtractorCodeGenerator` (which delegates `MetaObjectExtractor.extract(mo, text)`).
 *
 * <h3>Optionality (no-skew)</h3>
 * [KotlinPayloadGenerator] emits EVERY payload field via [KotlinTypeMapper.kotlinTypeName] (or a
 * nested-payload type), all NON-NULLABLE — it does not honor `@required` in the property type.
 * The strict `data class` therefore has no nullable/optional properties, so the mapper maps EVERY
 * field as required (`m.f!!`), matching the payload generator's predicate exactly. The
 * lost-REQUIRED gate ([com.metaobjects.render.extract.ExtractException]) fires only for fields the
 * metadata marks `@required: true`. (Same shape as the C# port.)
 *
 * <p>Cross-port parity: the Kotlin sibling of TS `renderExtractor`, the Python
 * `ExtractorGenerator`, the C# `ExtractorGenerator`, and the Java `ExtractorCodeGenerator`.</p>
 *
 * <p>Substrate justification (hand-rolled string builder rather than KotlinPoet): the emitted
 * object is straight-line Kotlin (delegate + a recursive mapper of `m.f!!` expressions) with no
 * generic-type machinery, so the hand-rolled emit is clearer than the KotlinPoet equivalent — the
 * same trade-off [KotlinOutputParserGenerator] makes.</p>
 */
open class KotlinExtractorGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        // Stable name order — matches the sibling generators' deterministic emission.
        // ADR-0039: root-level declaration scan — root is never extended (matches the TS
        // reference's root.ownChildren()), so own children is correct.
        val outputs = loader.root.children
            .filterIsInstance<OutputTemplate>()
            .sortedBy { it.name }

        for (tmpl in outputs) {
            emit(tmpl, loader, outRoot)
        }
    }

    protected open fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
        val payloadRef = template.payloadRef
        if (payloadRef.isNullOrEmpty()) {
            LOG.warn("skipping extractor for {} — missing @payloadRef", template.name)
            return
        }
        val payloadVo = resolveViewObject(loader, payloadRef)
        if (payloadVo == null) {
            LOG.warn(
                "skipping extractor for {} — @payloadRef '{}' does not resolve to an object.value",
                template.name, payloadRef
            )
            return
        }

        // The extract tier sits over the NESTED-CAPABLE delegating extract, which the parser
        // generator emits only for json/xml. Skip otherwise (nothing to extract over).
        val format = template.format
        val extractable = TemplateConstants.FORMAT_JSON.equals(format, ignoreCase = true)
            || TemplateConstants.FORMAT_XML.equals(format, ignoreCase = true)
        if (!extractable) {
            LOG.warn("skipping extractor for {} — format '{}' has no extract", template.name, format)
            return
        }

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = KotlinNaming.promptsPackage(templatePkg)
        // Root mirror + payload are keyed on the TEMPLATE short name (matching the parser's
        // `<TemplateShort>Extracted` and the payload generator's `<TemplateShort>Payload`); the
        // nested mirrors/payloads are keyed on the value-object short name.
        val extractorClass = KotlinNaming.extractorName(templateShort)
        val parserClass = KotlinNaming.parserName(templateShort)
        val rootMirror = templateShort + "Extracted"
        val rootStrict = KotlinNaming.payloadName(templateShort)

        val src = buildString {
            append("// GENERATED — DO NOT EDIT — extractor for template.output `")
            append(template.name)
            append("`\n")
            append("package ")
            append(outPkg)
            append("\n\n")
            append("import com.metaobjects.loader.MetaDataLoader\n")
            append("import com.metaobjects.render.extract.ExtractException\n")
            append("import com.metaobjects.render.extract.ExtractOptions\n")
            append("import com.metaobjects.render.extract.ExtractionResult\n")
            append("\n")
            append("/**\n")
            append(" * The `extract` tier for the `")
            append(templateShort)
            append("` template.output — turns dirty LLM text into a fully-typed\n")
            append(" * [")
            append(rootStrict)
            append("] graph (nested objects + arrays-of-objects populated) in one call, by\n")
            append(" * delegating to the nested-capable extract and mapping the all-nullable [")
            append(rootMirror)
            append("] mirror\n")
            append(" * onto the strict payload. No registry / binding / factory.\n")
            append(" */\n")
            append("object ")
            append(extractorClass)
            append(" {\n")
            append("\n")
            append("    /**\n")
            append("     * Extract a fully-typed [")
            append(rootStrict)
            append("] from dirty [text], resolving this payload's MetaObject\n")
            append("     * from [loader]. Runs the tolerant extract, then maps the extracted mirror onto the strict payload.\n")
            append("     *\n")
            append("     * @throws ExtractException iff a `@required` field was lost (the strict opt-in gate).\n")
            append("     */\n")
            append("    @JvmOverloads\n")
            append("    fun extract(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ")
            append(rootStrict)
            append(" {\n")
            append("        val r = ")
            append(parserClass)
            append(".extractLenient(loader, text, opts)\n")
            append("        if (r.report.hasLostRequired()) throw ExtractException(r.report.lostRequired())\n")
            append("        return toStrict")
            append(rootStrict)
            append("(r.data!!)\n")
            append("    }\n")
            append("\n")
            append("    /**\n")
            append("     * Re-exposes the nested-capable tolerant extract; never throws. Inspect `report` for\n")
            append("     * lost/defaulted fields. Returns the all-nullable [")
            append(rootMirror)
            append("] mirror (not the strict payload).\n")
            append("     */\n")
            append("    @JvmOverloads\n")
            append("    fun extractLenient(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ExtractionResult<")
            append(rootMirror)
            append("> =\n")
            append("        ")
            append(parserClass)
            append(".extractLenient(loader, text, opts)\n")
            // Recursive mirror->strict mappers (root + nested, deduped, cycle-safe).
            appendMappers(payloadVo, rootMirror, rootStrict)
            append("}\n")
        }

        val outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve("$extractorClass.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, src)
    }

    /**
     * Append one `toStrict<Type>(m: <Type>Extracted): <Type>Payload` mapper per reachable
     * value-object (root + nested), deduped by FQN (the dedupe set is also the cycle guard).
     *
     * <p>The ROOT mapper is named with [rootMirror]/[rootStrict] (keyed on the template short
     * name, matching the parser's mirror + the payload generator's payload class); each NESTED
     * mapper is named on its value-object short name (`<Short>Extracted`/`<Short>Payload`),
     * matching the nested classes those generators emit.</p>
     */
    private fun StringBuilder.appendMappers(rootVo: MetaObject, rootMirror: String, rootStrict: String) {
        val emitted = LinkedHashSet<String>()
        appendMapper(rootVo, rootMirror, rootStrict, emitted)
    }

    private fun StringBuilder.appendMapper(
        vo: MetaObject,
        mirror: String,
        strict: String,
        emitted: LinkedHashSet<String>,
    ) {
        if (!emitted.add(vo.name)) return // dedupe + cycle guard

        val nested = mutableListOf<MetaObject>()

        val args = vo.metaFields.joinToString(",\n") { field ->
            "        ${field.name} = ${strictArg(field, vo, nested)}"
        }

        append("\n")
        append("    /** Map the all-nullable [")
        append(mirror)
        append("] mirror onto the strict [")
        append(strict)
        append("] payload. Generated. */\n")
        append("    private fun toStrict")
        append(strict)
        append("(m: ")
        append(mirror)
        append("): ")
        append(strict)
        append(" = ")
        append(strict)
        append("(\n")
        append(args)
        append(",\n")
        append("    )\n")

        // Recurse into nested-object targets (single + array) for their mappers (post-order).
        // Nested mappers are keyed on the value-object short name.
        for (nestedVo in nested) {
            val nestedShort = PackageMapping.splitFqn(nestedVo.name).second
            appendMapper(nestedVo, nestedShort + "Extracted", nestedShort + "Payload", emitted)
        }
    }

    /**
     * The strict `data class` initializer expression for one field, reading mirror property
     * `m.<name>`. Matches [KotlinPayloadGenerator]'s predicate: every strict property is
     * non-nullable, so every field maps as required.
     *
     * <ul>
     *   <li>single nested object → `toStrict<Nested>(m.f!!)`;</li>
     *   <li>array-of-objects → `m.f!!.map { toStrict<Item>(it!!) }`;</li>
     *   <li>enum (single) → `<EnumFqn>.valueOf(m.f!!)` (the string-backed mirror member is coerced
     *       to the generated strict enum class — `valueOf` returns the enum, so the strict
     *       property type matches with no cast);</li>
     *   <li>enum array → `m.f!!.filterNotNull().map { <EnumFqn>.valueOf(it) }` (per-element
     *       coercion; the mirror element stays `String`);</li>
     *   <li>scalar array → `m.f!!.filterNotNull()` (drop nulls); a non-string element type
     *       (Int/Long/Double/Float/Boolean/UUID/LocalDate/LocalTime/Instant) additionally maps
     *       each `String` element to the strict element type. String arrays pass through unchanged;</li>
     *   <li>scalar (single) → `m.f!!`.</li>
     * </ul>
     */
    private fun strictArg(field: MetaField<*>, owner: MetaObject, nested: MutableList<MetaObject>): String {
        val name = field.name

        // Object BEFORE array: array-of-objects maps element-wise (checked before isArray).
        val target = KotlinExtractSchemaEmitter.objectRefValueObject(field)
        if (target != null) {
            nested.add(target)
            val nestedStrict = PackageMapping.splitFqn(target.name).second + "Payload"
            return if (field.isArrayType()) {
                // The mirror element type for an array-of-objects is the NON-NULL nested mirror
                // (KotlinExtractSchemaEmitter.nestedNullableTypeName emits `List<<Nested>Extracted>?`),
                // so `it` is already non-null after `m.f!!` — no per-element `!!` (which would be an
                // "Unnecessary non-null assertion" warning, breaking -Werror consumers).
                "m.$name!!.map { toStrict$nestedStrict(it) }"
            } else {
                "toStrict$nestedStrict(m.$name!!)"
            }
        }

        // Enum BEFORE the generic scalar-array branch (an enum array is still List<String> in the
        // mirror but must coerce each element to the strict enum class). The strict payload types
        // a `field.enum` as the generated enum class (single) / List<enum> (array); the mirror leaf
        // stays String / List<String?>. Bridge via `<EnumFqn>.valueOf(...)` — `valueOf` returns the
        // enum, so the strict element type matches with no cast. FQN-qualified so the emitted code
        // resolves without an import (as the rest of this generator does). @values has already been
        // validated == enum constants, so valueOf is safe.
        if (field is EnumField) {
            val enumType = KotlinTypeMapper.enumTypeName(field, owner)
            if (enumType != null) {
                val enumFqn = enumType.canonicalName
                return if (field.isArrayType()) {
                    "m.$name!!.filterNotNull().map { $enumFqn.valueOf(it) }"
                } else {
                    "$enumFqn.valueOf(m.$name!!)"
                }
            }
        }

        // Scalar arrays: the mirror is always List<String>? (the extract engine's only list
        // accessor, ExtractMap.asStringList, string-ifies every element). The strict payload is
        // List<ElementType>. filterNotNull() drops nulls; a per-element parse then narrows each
        // String to the strict element type (Int/Long/Double/Boolean) — handling non-string
        // scalar arrays, not just string (the C# string-only-array bug). String arrays pass
        // through unchanged.
        if (field.isArrayType()) {
            val conv = scalarArrayElementConversion(field)
            return if (conv == null) "m.$name!!.filterNotNull()"
            else "m.$name!!.filterNotNull().map { $conv }"
        }

        // jsonb open bag (`field.string @dbColumnType=jsonb`): the strict payload types this as a
        // parsed JSON value (kotlinx `JsonElement`, via KotlinTypeMapper.payloadTypeName — issue #98)
        // while the lenient mirror leaf stays `String` (the LLM emits text). Bridge String → JsonElement
        // by parsing. FQN-qualified so the emitted code resolves without an import (as elsewhere here).
        if (KotlinTypeMapper.isJsonbOpenBag(field)) {
            return "kotlinx.serialization.json.Json.parseToJsonElement(m.$name!!)"
        }

        // Scalar (single): mirror is T?, strict is T — null-assert.
        return "m.$name!!"
    }

    /**
     * The per-element conversion (applied to a non-null `String` element `it`) that narrows the
     * mirror's `List<String>` element to the strict payload's scalar-array element type. Returns
     * `null` for string-backed elements (`String` + `enum`), which pass through unchanged.
     *
     * <p>DRIFT-PROOF by construction: the strict element type is derived from the SAME call
     * [KotlinPayloadGenerator.resolveFieldType] uses for a scalar-array element —
     * [KotlinTypeMapper.kotlinTypeName] — so the element type the payload declares
     * (`List<<that type>>`) and the parse emitted here cannot diverge. We dispatch on the resulting
     * KotlinPoet [com.squareup.kotlinpoet.TypeName] rather than on the field subtype, so the two
     * sites stay in lockstep through the single mapper.</p>
     *
     * <p>If [KotlinTypeMapper] ever grows an element type with no safe `String`→type parse, this
     * FAILS LOUD at codegen time ([GeneratorException]) rather than emitting non-compiling code.</p>
     */
    private fun scalarArrayElementConversion(field: MetaField<*>): String? {
        // jsonb open bag element (`field.string @dbColumnType=jsonb` + isArray): the strict payload
        // element is a parsed JSON value (kotlinx `JsonElement`, via payloadTypeName — issue #98);
        // the mirror element stays `String`. Parse each element. Checked first because the generic
        // dispatch below keys on kotlinTypeName, which (correctly, for persistence) reports `String`.
        if (KotlinTypeMapper.isJsonbOpenBag(field)) {
            return "kotlinx.serialization.json.Json.parseToJsonElement(it)"
        }
        // Same path the payload generator wraps in List<…> for a scalar-array element.
        val elementType = KotlinTypeMapper.kotlinTypeName(field)
        return when (elementType) {
            STRING -> null            // String element — passthrough (enum arrays are handled earlier)
            INT     -> "it.toInt()"
            LONG    -> "it.toLong()"  // also field.currency (minor-unit Long)
            DOUBLE  -> "it.toDouble()"
            FLOAT   -> "it.toFloat()"
            BOOLEAN -> "it.toBoolean()"
            // Reference element types — match on the fully-qualified canonical name and emit a
            // parse using FQNs so the emitted code resolves without imports (as the rest of the
            // generator does). java.time.Instant is field.timestamp's element type.
            else -> when (elementType.toString()) {
                "java.util.UUID"          -> "java.util.UUID.fromString(it)"
                "java.time.LocalDate"     -> "java.time.LocalDate.parse(it)"
                "java.time.LocalTime"     -> "java.time.LocalTime.parse(it)"
                "java.time.LocalDateTime" -> "java.time.LocalDateTime.parse(it)"
                "java.time.Instant"       -> "java.time.Instant.parse(it)"
                else -> throw GeneratorException(
                    "no scalar-array element conversion for field '${field.name}' " +
                        "(element type $elementType) — add a String->type parse in " +
                        "KotlinExtractorGenerator.scalarArrayElementConversion"
                )
            }
        }
    }

    /** Resolve a `@payloadRef` to its `object.value` (rejects entities — payloads must be VOs). */
    private fun resolveViewObject(loader: MetaDataLoader, ref: String): MetaObject? =
        KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref)
            ?.takeIf { it.subType == MetaObject.SUBTYPE_VALUE }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun <T : GeneratorIOWriter<*>?> getSingleWriter(
        loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?
    ): T? = null
    override fun <T : GeneratorIOWriter<*>?> getFinalWriter(
        loader: MetaDataLoader?, out: OutputStream?
    ): T? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String = ""
    override fun getSingleOutputFilename(md: MetaObject): String = "${md.name}.kt"

    companion object {
        private val LOG = LoggerFactory.getLogger(KotlinExtractorGenerator::class.java)
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.OutputTemplate
import com.metaobjects.template.TemplateConstants
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.slf4j.LoggerFactory

/**
 * Cross-port Extractor codegen (Kotlin port) — the `extract` tier over the existing tolerant
 * recover. Emits one `<TemplateShortName>Extractor.kt` per nested-capable `template.output`.
 *
 * <p>The emitted `object <Name>Extractor` turns dirty LLM text into the STRICT typed payload
 * `data class` ([KotlinPayloadGenerator]'s immutable, all-non-null `@Serializable data class`)
 * in one call. It REUSES the nested-capable runtime-delegating recover emitted by
 * [KotlinOutputParserGenerator] — `<Name>Parser.recover(loader, text)`, which assembles the FULL
 * nested object graph via the runtime [com.metaobjects.object.recover.MetaObjectRecover] — runs
 * it, throws [com.metaobjects.render.recover.RecoverException] iff a `@required` field was lost,
 * else maps the all-nullable `<Name>Recovered` mirror onto the strict payload via a generated
 * recursive mirror->strict mapper (recurse nested objects + arrays-of-objects; one-shot construct
 * via the primary constructor). `recover` is re-exposed unchanged.</p>
 *
 * <p>NO registry / binding / factory — codegen knows the whole type graph statically.</p>
 *
 * <h3>Why the recover path is loader-based (nested-capable)</h3>
 * The parser's self-contained `recover(text)` leaves nested objects null (FR-010 nested gap).
 * Only the parser's `recover(loader, text)` overload — which delegates to `MetaObjectRecover` and
 * maps the assembled `ValueObject` graph into the typed mirror — populates the full nested graph.
 * The extractor therefore routes exclusively through `recover(loader, text)`, mirroring the
 * shipped Java `ExtractorCodeGenerator` (which delegates `MetaObjectRecover.recover(mo, text)`).
 *
 * <h3>Optionality (no-skew)</h3>
 * [KotlinPayloadGenerator] emits EVERY payload field via [KotlinTypeMapper.kotlinTypeName] (or a
 * nested-payload type), all NON-NULLABLE — it does not honor `@required` in the property type.
 * The strict `data class` therefore has no nullable/optional properties, so the mapper maps EVERY
 * field as required (`m.f!!`), matching the payload generator's predicate exactly. The
 * lost-REQUIRED gate ([com.metaobjects.render.recover.RecoverException]) fires only for fields the
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
class KotlinExtractorGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        // Stable name order — matches the sibling generators' deterministic emission.
        val outputs = loader.root.children
            .filterIsInstance<OutputTemplate>()
            .sortedBy { it.name }

        for (tmpl in outputs) {
            emit(tmpl, loader, outRoot)
        }
    }

    private fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
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

        // The extract tier sits over the NESTED-CAPABLE delegating recover, which the parser
        // generator emits only for json/xml. Skip otherwise (nothing to extract over).
        val format = template.format
        val recoverable = TemplateConstants.FORMAT_JSON.equals(format, ignoreCase = true)
            || TemplateConstants.FORMAT_XML.equals(format, ignoreCase = true)
        if (!recoverable) {
            LOG.warn("skipping extractor for {} — format '{}' has no recover", template.name, format)
            return
        }

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = if (templatePkg.isEmpty()) "prompts" else "$templatePkg.prompts"
        // Root mirror + payload are keyed on the TEMPLATE short name (matching the parser's
        // `<TemplateShort>Recovered` and the payload generator's `<TemplateShort>Payload`); the
        // nested mirrors/payloads are keyed on the value-object short name.
        val extractorClass = templateShort + "Extractor"
        val parserClass = templateShort + "Parser"
        val rootMirror = templateShort + "Recovered"
        val rootStrict = templateShort + "Payload"

        val src = buildString {
            append("// GENERATED — DO NOT EDIT — extractor for template.output `")
            append(template.name)
            append("`\n")
            append("package ")
            append(outPkg)
            append("\n\n")
            append("import com.metaobjects.loader.MetaDataLoader\n")
            append("import com.metaobjects.render.recover.RecoverException\n")
            append("import com.metaobjects.render.recover.RecoverOptions\n")
            append("import com.metaobjects.render.recover.RecoveryResult\n")
            append("\n")
            append("/**\n")
            append(" * The `extract` tier for the `")
            append(templateShort)
            append("` template.output — turns dirty LLM text into a fully-typed\n")
            append(" * [")
            append(rootStrict)
            append("] graph (nested objects + arrays-of-objects populated) in one call, by\n")
            append(" * delegating to the nested-capable recover and mapping the all-nullable [")
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
            append("     * from [loader]. Runs the tolerant recover, then maps the recovered mirror onto the strict payload.\n")
            append("     *\n")
            append("     * @throws RecoverException iff a `@required` field was lost (the strict opt-in gate).\n")
            append("     */\n")
            append("    @JvmOverloads\n")
            append("    fun extract(loader: MetaDataLoader, text: String, opts: RecoverOptions = RecoverOptions.defaults()): ")
            append(rootStrict)
            append(" {\n")
            append("        val r = ")
            append(parserClass)
            append(".recover(loader, text, opts)\n")
            append("        if (r.report.hasLostRequired()) throw RecoverException(r.report.lostRequired())\n")
            append("        return toStrict")
            append(rootStrict)
            append("(r.data!!)\n")
            append("    }\n")
            append("\n")
            append("    /**\n")
            append("     * Re-exposes the nested-capable tolerant recover; never throws. Inspect `report` for\n")
            append("     * lost/defaulted fields. Returns the all-nullable [")
            append(rootMirror)
            append("] mirror (not the strict payload).\n")
            append("     */\n")
            append("    @JvmOverloads\n")
            append("    fun recover(loader: MetaDataLoader, text: String, opts: RecoverOptions = RecoverOptions.defaults()): RecoveryResult<")
            append(rootMirror)
            append("> =\n")
            append("        ")
            append(parserClass)
            append(".recover(loader, text, opts)\n")
            // Recursive mirror->strict mappers (root + nested, deduped, cycle-safe).
            appendMappers(payloadVo, rootMirror, rootStrict)
            append("}\n")
        }

        val outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve("$extractorClass.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, src)
    }

    /**
     * Append one `toStrict<Type>(m: <Type>Recovered): <Type>Payload` mapper per reachable
     * value-object (root + nested), deduped by FQN (the dedupe set is also the cycle guard).
     *
     * <p>The ROOT mapper is named with [rootMirror]/[rootStrict] (keyed on the template short
     * name, matching the parser's mirror + the payload generator's payload class); each NESTED
     * mapper is named on its value-object short name (`<Short>Recovered`/`<Short>Payload`),
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
            "        ${field.name} = ${strictArg(field, nested)}"
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
            appendMapper(nestedVo, nestedShort + "Recovered", nestedShort + "Payload", emitted)
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
     *   <li>scalar array → `m.f!!.filterNotNull()` (drop nulls); a non-string element type
     *       (Int/Long/Double/Boolean) additionally maps each `String` element to the strict
     *       element type. String + enum arrays pass through unchanged;</li>
     *   <li>scalar / enum (single) → `m.f!!`.</li>
     * </ul>
     */
    private fun strictArg(field: MetaField<*>, nested: MutableList<MetaObject>): String {
        val name = field.name

        // Object BEFORE array: array-of-objects maps element-wise (checked before isArray).
        val target = KotlinRecoverSchemaEmitter.objectRefValueObject(field)
        if (target != null) {
            nested.add(target)
            val nestedStrict = PackageMapping.splitFqn(target.name).second + "Payload"
            return if (field.isArrayType()) {
                "m.$name!!.map { toStrict$nestedStrict(it!!) }"
            } else {
                "toStrict$nestedStrict(m.$name!!)"
            }
        }

        // Scalar arrays: the mirror is always List<String>? (the recover engine's only list
        // accessor, RecoverMap.asStringList, string-ifies every element). The strict payload is
        // List<ElementType>. filterNotNull() drops nulls; a per-element parse then narrows each
        // String to the strict element type (Int/Long/Double/Boolean) — handling non-string
        // scalar arrays, not just string (the C# string-only-array bug). String + enum arrays
        // pass through unchanged.
        if (field.isArrayType()) {
            val conv = scalarArrayElementConversion(field)
            return if (conv == null) "m.$name!!.filterNotNull()"
            else "m.$name!!.filterNotNull().map { $conv }"
        }

        // Scalar / enum (single): mirror is T?, strict is T — null-assert.
        return "m.$name!!"
    }

    /**
     * The per-element conversion (applied to a non-null `String` element `it`) that narrows the
     * mirror's `List<String>` element to the strict payload's scalar-array element type. Returns
     * `null` for string-backed elements (string + enum), which pass through unchanged. Mirrors the
     * single-scalar [KotlinTypeMapper.kotlinTypeName] type mapping (enum is string-backed → null).
     */
    private fun scalarArrayElementConversion(field: MetaField<*>): String? = when (field) {
        is EnumField    -> null   // string-backed on the wire
        is IntegerField -> "it.toInt()"
        is LongField    -> "it.toLong()"
        is DoubleField  -> "it.toDouble()"
        is BooleanField -> "it.toBoolean()"
        else            -> null   // StringField + any unrecognized type stay String
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

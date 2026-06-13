package com.metaobjects.generator.kotlin.apidocs

import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.generator.kotlin.KotlinGenUtil
import com.metaobjects.generator.kotlin.KotlinM2mSupport
import com.metaobjects.generator.kotlin.KotlinNaming
import com.metaobjects.generator.kotlin.KotlinTphPlan
import com.metaobjects.generator.kotlin.KotlinTypeMapper
import com.metaobjects.generator.kotlin.PackageMapping
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.source.MetaSource
import com.metaobjects.source.RdbSource
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.OutputTemplate
import com.metaobjects.template.TemplateConstants

/**
 * Builds a [KotlinApiModel] — the per-project enumeration of the generated Kotlin SDK surface —
 * from a loaded [MetaDataLoader].
 *
 * This is the ACCURATE-BY-CONSTRUCTION half of the api-docs pipeline: every documented symbol name
 * comes from the [KotlinNaming] / [KotlinM2mSupport] / [PackageMapping] seams (never re-concatenated
 * here — the SAME seam the real `codegen-kotlin` generators delegate to), and every inclusion
 * decision REUSES the corresponding generator's own gate (subtype + abstract + `source.rdb @kind` +
 * TPH-subtype + `@payloadRef` resolution + json/xml format) rather than re-implementing it. The
 * result is that what this builder documents == what the generators emit, by SHARING the single
 * source of truth.
 *
 * **Per-category enumeration** (mirrors the Java `JavaApiModelBuilder` / C# / Python builders,
 * Kotlin/Exposed-flavored):
 * - **Objects** (`loader.metaObjects`): each concrete object → a [ApiSymbolKind.MODEL] symbol (the
 *   `@Serializable data class` from `KotlinEntityGenerator`). A writable-table entity additionally
 *   yields DATA_ACCESS (the Exposed `Table` object) / VALIDATION (the jakarta constraints on the
 *   data class, the controller's `@Valid @RequestBody`) / REST (one per controller route + each M:N
 *   traversal) / FILTER (the `<Entity>FilterAllowlist` object). A value object → MODEL only. An
 *   abstract object / a TPH subtype yields no instance artifacts.
 * - **Templates** (`template.output` only): each → PAYLOAD / RENDER / OUTPUT_PARSER, plus PROMPT +
 *   EXTRACTOR when `@format` is json/xml — each gated by the matching generator's applies-predicate.
 *
 * An object that yields no symbols (e.g. an abstract object) produces NO unit at all (never an
 * empty unit).
 *
 * **Deferred / intentional omissions:** the TRACE symbol (no LLM-trace `record<Entity>` helper ships
 * for Kotlin — it is a pure-codegen-persistence port, ADR-0024 deferral), so [ApiSymbolKind.TRACE]
 * is carried in the IR for cross-port parity but is never emitted here. The DTO symbol is omitted:
 * Kotlin's controller request/response body IS the entity `data class` (no separate `<Entity>Dto`
 * record), so the wire shape is documented via the MODEL + VALIDATION symbols (matching what the
 * generators actually emit).
 */
class KotlinApiModelBuilder {

    private companion object {
        /** Structured formats that additionally get an output-format prompt + a tolerant extractor. */
        val STRUCTURED_FORMATS = setOf(TemplateConstants.FORMAT_JSON, TemplateConstants.FORMAT_XML)
    }

    /** Build the SDK-surface model for [project] from the loaded [loader]. */
    fun build(loader: MetaDataLoader, project: String): KotlinApiModel {
        val units = mutableListOf<ApiUnit>()

        // Objects: one unit per object.entity / object.value (entity vs value drives which symbol
        // categories the gates let through). object.projection is left to the cross-port builders'
        // current scope (the shared manifest fixture carries entities + a value object + a template).
        for (obj in loader.metaObjects) {
            if (obj.subType != MetaObject.SUBTYPE_ENTITY && obj.subType != MetaObject.SUBTYPE_VALUE) continue
            val unit = buildObjectUnit(obj, loader)
            if (unit != null) units.add(unit)
        }

        // Templates: one unit per template.output under the model root.
        for (child in loader.root.children) {
            if (child is OutputTemplate) {
                units.add(buildTemplateUnit(child, loader))
            }
        }

        return KotlinApiModel(project, units)
    }

    // ----- objects -----------------------------------------------------------

    private fun buildObjectUnit(obj: MetaObject, loader: MetaDataLoader): ApiUnit? {
        val (pkg, shortName) = PackageMapping.splitFqn(obj.name)
        val entity = obj.subType == MetaObject.SUBTYPE_ENTITY
        val unitKind = if (entity) "entity" else "value"

        val symbols = mutableListOf<ApiSymbol>()

        // MODEL — documented only for concrete objects. An abstract object cannot be instantiated,
        // so we do not document a MODEL symbol for it (documented ⊆ generated). A concrete value
        // object → MODEL only. The data class is the @Serializable model AND the controller body.
        if (!KotlinGenUtil.isAbstractEntity(obj)) {
            symbols.add(
                ApiSymbol(
                    name = shortName,
                    kind = ApiSymbolKind.MODEL,
                    importLine = importLine(pkg, shortName),
                    signature = "data class $shortName",
                    usage = if (entity) "the @Serializable entity model (also the controller request/response body)"
                    else "the @Serializable value-object model",
                )
            )
        }

        if (entity && isWritableTableEntity(obj, loader)) {
            // VALIDATION — the jakarta.validation constraints carried on the entity data class
            // (the controller enforces them via @Valid @RequestBody). Names the data class.
            symbols.add(
                ApiSymbol(
                    name = shortName,
                    kind = ApiSymbolKind.VALIDATION,
                    importLine = importLine(pkg, shortName),
                    signature = "data class $shortName",
                    usage = "jakarta.validation constraints on the create/update body (enforced by @Valid)",
                    fields = modelFields(obj),
                )
            )

            // DATA_ACCESS — the Exposed Table object the controller reads/writes through.
            val table = KotlinNaming.tableObjectName(shortName)
            symbols.add(
                ApiSymbol(
                    name = table,
                    kind = ApiSymbolKind.DATA_ACCESS,
                    importLine = importLine(pkg, table),
                    signature = "object $table : Table",
                    usage = "data access — the Exposed table object (typed columns; query via transaction { })",
                    returns = "Exposed Query / ResultRow",
                )
            )

            // REST — one symbol per controller route the generator registers.
            addRestSymbols(symbols, obj, pkg, shortName, loader)

            // FILTER — the per-entity sort/filter allowlist object.
            val filter = KotlinNaming.filterAllowlistName(shortName)
            symbols.add(
                ApiSymbol(
                    name = filter,
                    kind = ApiSymbolKind.FILTER,
                    importLine = importLine(pkg, filter),
                    signature = "object $filter",
                    usage = "the filterable-field (FIELDS) + per-field operator (OPS_BY_FIELD) allowlist",
                )
            )
        }

        // An object that yields no symbols (e.g. an abstract object) produces no unit at all.
        if (symbols.isEmpty()) return null
        return ApiUnit(shortName, pkg, unitKind, symbols)
    }

    /**
     * The shared gate for the controller + filter-allowlist generators: a non-abstract entity with
     * a `source.rdb @kind="table"` child that is NOT a TPH subtype (a TPH subtype is folded into its
     * base's single table — it emits no standalone controller/allowlist). Mirrors the gates in
     * [com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator] /
     * [com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator].
     */
    private fun isWritableTableEntity(obj: MetaObject, loader: MetaDataLoader): Boolean {
        if (obj.subType != MetaObject.SUBTYPE_ENTITY) return false
        if (KotlinGenUtil.isAbstractEntity(obj)) return false
        if (KotlinTphPlan.isTphSubtype(obj)) return false
        val src = obj.children.filterIsInstance<RdbSource>().firstOrNull() ?: return false
        return src.effectiveKind == MetaSource.KIND_TABLE
    }

    private fun addRestSymbols(
        symbols: MutableList<ApiSymbol>,
        obj: MetaObject,
        pkg: String,
        shortName: String,
        loader: MetaDataLoader,
    ) {
        val controller = KotlinNaming.controllerName(shortName)
        val controllerImport = importLine(pkg, controller)
        val base = KotlinNaming.controllerPath(shortName)
        fun rest(verbPath: String, usage: String) {
            symbols.add(
                ApiSymbol(
                    name = verbPath,
                    kind = ApiSymbolKind.REST,
                    importLine = controllerImport,
                    signature = verbPath,
                    usage = usage,
                )
            )
        }
        rest("GET $base", "list with pagination / sort / filters")
        rest("GET $base/{id}", "fetch one by id")
        rest("POST $base", "create")
        rest("PATCH $base/{id}", "update")
        rest("DELETE $base/{id}", "delete")
        // FR-018 M:N traversal — GET /<source-plural>/{id}/<relation>.
        for (nav in KotlinM2mSupport.resolve(obj, loader)) {
            rest(
                "GET $base/{id}/${nav.relationName}",
                "M:N traversal — the related ${nav.targetShortName} rows",
            )
        }
    }

    // ----- templates ---------------------------------------------------------

    private fun buildTemplateUnit(tmpl: MetaTemplate, loader: MetaDataLoader): ApiUnit {
        val (pkg, shortName) = PackageMapping.splitFqn(tmpl.name)
        val promptsPkg = KotlinNaming.promptsPackage(pkg)

        val symbols = mutableListOf<ApiSymbol>()
        val payloadVo = payloadValueObject(tmpl, loader)
        val format = (tmpl.format ?: "").lowercase()

        if (payloadVo != null) {
            // PAYLOAD — the @Serializable typed payload data class the parser/render bind to.
            val payload = KotlinNaming.payloadName(shortName)
            symbols.add(
                ApiSymbol(
                    name = payload,
                    kind = ApiSymbolKind.PAYLOAD,
                    importLine = importLine(promptsPkg, payload),
                    signature = "data class $payload",
                    usage = "the typed payload projection bound to the template",
                    fields = payloadFields(payloadVo),
                )
            )

            // RENDER — the typed render helper wrapping the JVM render engine.
            val render = KotlinNaming.renderHelperName(shortName)
            symbols.add(
                ApiSymbol(
                    name = render,
                    kind = ApiSymbolKind.RENDER,
                    importLine = importLine(promptsPkg, render),
                    signature = "object $render",
                    usage = "renders the output template against a typed payload",
                    returns = if (isEmailKind(tmpl)) "EmailDocument" else "String",
                )
            )

            // OUTPUT_PARSER — the typed parse<Name> / safeParse<Name> back into the payload.
            val parser = KotlinNaming.parserName(shortName)
            symbols.add(
                ApiSymbol(
                    name = parser,
                    kind = ApiSymbolKind.OUTPUT_PARSER,
                    importLine = importLine(promptsPkg, parser),
                    signature = "object $parser",
                    usage = "parses model output back into the typed payload",
                    returns = KotlinNaming.payloadName(shortName),
                )
            )

            // PROMPT + EXTRACTOR — only for json/xml output templates.
            if (format in STRUCTURED_FORMATS) {
                val prompt = KotlinNaming.promptName(shortName)
                symbols.add(
                    ApiSymbol(
                        name = prompt,
                        kind = ApiSymbolKind.PROMPT,
                        importLine = importLine(promptsPkg, prompt),
                        signature = "object $prompt",
                        usage = "builds the output-format prompt fragment",
                        returns = "String",
                    )
                )
                val extractor = KotlinNaming.extractorName(shortName)
                symbols.add(
                    ApiSymbol(
                        name = extractor,
                        kind = ApiSymbolKind.EXTRACTOR,
                        importLine = importLine(promptsPkg, extractor),
                        signature = "object $extractor",
                        usage = "extracts the strict typed payload from dirty model output",
                        returns = KotlinNaming.payloadName(shortName),
                    )
                )
            }
        }

        return ApiUnit(shortName, pkg, "template", symbols)
    }

    // ----- field shapes -------------------------------------------------------

    /**
     * The entity's documented scalar/enum field shapes — one row per field the data class maps
     * (object-typed fields are owned-type navs, not a scalar documented shape). Types via
     * [KotlinTypeMapper.kotlinTypeName]; required = the SAME [KotlinGenUtil.isRequiredField]
     * boundary the entity generator's nullability uses.
     */
    private fun modelFields(entity: MetaObject): List<FieldShape> {
        val rows = mutableListOf<FieldShape>()
        for (f in entity.metaFields) {
            if (f is ObjectField) continue
            val type = kotlinTypeLabel(f, entity)
            var note: String? = null
            if (f is EnumField) {
                val values = enumValues(f)
                if (values.isNotEmpty()) note = "allowed: " + values.joinToString(" | ")
            }
            rows.add(FieldShape(f.name, type, optional = !KotlinGenUtil.isRequiredField(f), note = note))
        }
        return rows
    }

    /**
     * The payload data class's documented field shapes — one row per field of the `@payloadRef`
     * value object. The payload generator emits every field NON-NULLABLE, so optionality is
     * reported from the field's own `@required` (matching the documented shape, not the strict
     * payload's all-required construction).
     */
    private fun payloadFields(vo: MetaObject): List<FieldShape> {
        val rows = mutableListOf<FieldShape>()
        for (f in vo.metaFields) {
            if (f is ObjectField) continue
            rows.add(FieldShape(f.name, kotlinTypeLabel(f, vo), optional = !KotlinGenUtil.isRequiredField(f)))
        }
        return rows
    }

    /** The simple Kotlin type label for a documented field (enum → generated enum class name). */
    private fun kotlinTypeLabel(field: MetaField<*>, owner: MetaObject): String {
        KotlinTypeMapper.enumTypeName(field, owner)?.let { enumType ->
            val simple = enumType.simpleName
            return if (field.isArrayType) "List<$simple>" else simple
        }
        val tn = KotlinTypeMapper.kotlinTypeName(field)
        val simple = (tn as? com.squareup.kotlinpoet.ClassName)?.simpleName ?: tn.toString()
        return if (field.isArrayType) "List<$simple>" else simple
    }

    /**
     * Read a `field.enum`'s `@values` (inheritance-aware), mirroring the private reader in
     * `KotlinEnumEmitter` (a field extending an abstract enum super carries its members on the
     * super). Used only to annotate the documented enum field with its allowed values.
     */
    private fun enumValues(field: EnumField): List<String> {
        if (!field.hasMetaAttr(EnumField.ATTR_VALUES)) return emptyList()
        val raw = runCatching { field.getMetaAttr(EnumField.ATTR_VALUES).value }.getOrNull()
        return when (raw) {
            is List<*> -> raw.mapNotNull { it?.toString() }
            else -> emptyList()
        }
    }

    // ----- helpers -----------------------------------------------------------

    /** The Kotlin import line a consumer writes to reach `pkg.name` (bare `name` when no package). */
    private fun importLine(pkg: String, name: String): String =
        if (pkg.isEmpty()) "import $name" else "import $pkg.$name"

    /** The `@payloadRef` value object a template resolves to (rejects entities), or null. */
    private fun payloadValueObject(tmpl: MetaTemplate, loader: MetaDataLoader): MetaObject? {
        val ref = tmpl.payloadRef
        if (ref.isNullOrEmpty()) return null
        return KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref)
            ?.takeIf { it.subType == MetaObject.SUBTYPE_VALUE }
    }

    private fun isEmailKind(tmpl: MetaTemplate): Boolean {
        if (!tmpl.hasMetaAttr(TemplateConstants.ATTR_KIND, false)) return false
        val v = runCatching { tmpl.getMetaAttr(TemplateConstants.ATTR_KIND, false).valueAsString }.getOrNull()
        return TemplateConstants.KIND_EMAIL.equals(v, ignoreCase = true)
    }
}

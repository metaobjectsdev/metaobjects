package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DecimalField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.FloatField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MapField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimeField
import com.metaobjects.field.TimestampField
import com.metaobjects.field.UuidField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.identity.MetaIdentity
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.source.MetaSource
import com.metaobjects.source.RdbSource
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.slf4j.LoggerFactory
import com.metaobjects.generator.util.RestSurfaceGate
import com.metaobjects.generator.util.GeneratedFileWriter

/**
 * Generator: one Spring `@RestController` Kotlin file per `object.entity` that has a
 * `source.rdb` child with `@kind="table"` (writable; the default). View and
 * materializedView kinds are skipped (read-only — would need a separate read-only
 * controller); storedProc kind is skipped (already covered by
 * [KotlinStoredProcGenerator]); tableFunction is skipped with a warning.
 *
 * <p>Conforms to the cross-port REST API contract
 * (see {@code docs/features/api-contract.md}):
 * <ul>
 *   <li>Routes: {@code /api/<entity-name snake_cased, then pluralized>} (e.g.
 *       {@code /api/authors}, {@code /api/post_categories} — the one cross-port
 *       collection-URL rule, via [KotlinNaming.controllerPath]).</li>
 *   <li>5 CRUD verbs: GET list, GET by id, POST create, PATCH+PUT update, DELETE.</li>
 *   <li>{@code ?withCount=1} switches list response to {@code { rows, total }}.</li>
 *   <li>{@code ?sort=field:asc|desc} parsed via a static per-entity allowlist (HTTP 400
 *       on unknown field).</li>
 *   <li>{@code ?limit=N&offset=N} pagination with defaults (limit=50, offset=0).</li>
 *   <li>HTTP 404 envelope: {@code { "error": "not_found" }}.</li>
 *   <li>HTTP 400 envelope: {@code { "error": "invalid_<thing>" }}.</li>
 * </ul>
 *
 * <p>FR-009 filter operators ({@code eq / ne / gt / gte / lt / lte / in /
 * like / isNull}) ship via the {@code <Entity>FilterAllowlist} constant
 * emitted by {@link KotlinFilterAllowlistGenerator}. The controller emits an
 * inline {@code parse<Entity>Filter} + {@code <Entity>WhereOp} helper pair —
 * the former parses the bracketed-qs grammar against the allowlist, the
 * latter translates each predicate into an Exposed {@code Op<Boolean>}
 * bound against the generated {@code <Entity>Table}. Multiple predicates
 * AND together; error envelopes are the cross-port
 * {@code invalid_filter_field / invalid_filter_op / invalid_filter_value}.
 *
 * <p>The generated controller delegates to the {@code <Entity>Table} Exposed object
 * emitted by {@link KotlinExposedTableGenerator}, wrapped in {@code transaction { }}
 * blocks. The consumer's Spring {@code @Configuration} (from
 * {@link KotlinSpringConfigGenerator}) wires {@code Database.connect()}; the controller
 * does not own a {@code DataSource} itself.
 *
 * <p>Substrate justification (hand-rolled string builder rather than KotlinPoet): same
 * trade-off as {@link KotlinExposedTableGenerator}. Spring annotations + the Exposed DSL
 * (e.g. {@code AuthorTable.selectAll().where { AuthorTable.id eq id }}) don't translate
 * cleanly to KotlinPoet's {@code PropertySpec}/{@code FunSpec} APIs without a verbose
 * dance of {@code %T} placeholders; the syntactic surface is small (~80 lines per file)
 * and matches the idiomatic Kotlin/Spring style.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
open class KotlinSpringControllerGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        for (entity in loader.metaObjects) {
            // Abstract entities are inheritance scaffolding — never emit a CRUD controller.
            if (KotlinGenUtil.isAbstractEntity(entity)) continue
            // FR-017 TPH: a subtype is folded into its base's single table + base controller (it
            // also carries no own source.rdb, so the guard below would skip it too).
            if (KotlinTphPlan.isTphSubtype(entity)) continue
            // ADR-0039: resolving source lookup (inherited source.rdb via extends).
            val sourceRdb = KotlinGenUtil.firstRdbSource(entity) ?: continue
            val kind = sourceRdb.effectiveKind
            // THE shared gate (codegen-base RestSurfaceGate), the same CALL
            // KotlinFilterAllowlistGenerator makes — the generated controller references
            // <Short>FilterAllowlist by name, so two predicates that merely agree today are
            // a compile failure waiting for one of them to move. It admits a writable table
            // entity, a write-through entity (detected order-independently, NEVER
            // firstRdbSource — the pre-#214 gate used that and skipped a view-source-first
            // one), and since F22 a view-kind object.projection.
            if (!RestSurfaceGate.emitsRestSurface(entity)) {
                when (kind) {
                    // A read-only kind reaching here is a projection the gate declined (a
                    // proc-kind one) or an ENTITY over a view — ADR-0028 forbids the latter,
                    // but the message stays accurate either way.
                    MetaSource.KIND_VIEW, MetaSource.KIND_MATERIALIZED_VIEW -> {
                        LOG.debug(
                            "skipping controller for {} — source.rdb @kind='{}' is read-only and this is not a projection",
                            entity.name, kind
                        )
                    }
                    MetaSource.KIND_STORED_PROC -> {
                        LOG.debug(
                            "skipping controller for {} — source.rdb @kind='storedProc' is handled by KotlinStoredProcGenerator",
                            entity.name
                        )
                    }
                    else -> {
                        LOG.warn(
                            "skipping controller for {} — source.rdb @kind='{}' has no controller generator yet",
                            entity.name, kind
                        )
                    }
                }
                continue
            }
            // F22 — a view-only projection gets a READ-ONLY controller: reads served, every
            // write verb answering the cross-port 405 envelope.
            if (RestSurfaceGate.isReadOnly(entity)) {
                emitReadOnly(entity, outRoot, loader)
                continue
            }
            // FR-017 TPH: a discriminator base emits ONE controller mounting the polymorphic
            // collection routes plus a full per-subtype CRUD set scoped by the discriminator.
            val tph = KotlinTphPlan.planFor(entity, loader)
            if (tph != null) emitTph(entity, tph, outRoot, loader) else emit(entity, outRoot, loader)
        }
    }

    protected open fun emit(entity: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val tableObjectName = KotlinNaming.tableObjectName(shortName)
        // #214 FR-024 §7: writes (create / update / delete) target the write `<Short>Table`; reads
        // (rowTo, list, get, the filter + sort surface, and the create/update re-reads) route to the
        // `<Short>View` for a write-through entity so the derived fields come back. For a vanilla
        // entity readObj == tableObjectName, so the emitted controller is byte-identical.
        val writeThrough = entity.isWriteThrough
        val readObj = if (writeThrough) KotlinNaming.viewObjectName(shortName) else tableObjectName
        val routeBase = KotlinNaming.controllerPath(shortName)

        // Primary key: single-field PKs only for v1. Composite PKs are uncommon for HTTP
        // CRUD (you'd need a URL grammar for composite ids — out of scope; the C# port
        // degrades to collection-GET-only there). The by-id route signatures bind the PK
        // FIELD's OWN Kotlin type (uuid → UUID, long → Long, int → Int, string → String)
        // — a hard-coded Long against a uuid-PK entity's Exposed Column<UUID> does not
        // compile. Fallback when no single-field PK resolves: "id" : Long (the
        // historical default).
        // ADR-0039: identities are inheritable — an entity may inherit its primary
        // identity from a BaseEntity via extends. RESOLVE via getIdentities(true);
        // entity.children (own-only) would miss it.
        val primary = entity.getIdentities(true)
            .filterIsInstance<MetaIdentity>()
            .firstOrNull { it.isPrimary }
        val pkFieldName = primary?.fields?.firstOrNull() ?: DEFAULT_PK_FIELD
        val pkParamType = primaryKeyParamType(entity, pkFieldName)

        // FR-035: the PATCH-settable columns = scalar + value-object fields minus the PK. Program D:
        // a field.object value-object jsonb column IS settable — bound via Jackson treeToValue into
        // the generated VO record / List<VO> and validated (spec §0). Still EXCLUDED: MapField
        // (dict-of-VO, staged out) and the `field.string @dbColumnType=jsonb` open bag (its
        // in-process type is a kotlinx JsonElement the raw-JsonNode patch path can't bind — a
        // create-only column, see KNOWN_GAPS).
        // When this is EMPTY (a PK + only map/open-bag columns) the controller emits no ObjectMapper
        // ctor param / TypeReference import (they'd be unused → allWarningsAsErrors).
        val patchSettableFields = entity.metaFields.filter {
            it !is MapField && it.name != pkFieldName &&
                !KotlinTypeMapper.isJsonbOpenBag(it) &&
                // Program D: only a jsonb value-object column is settable. A flattened object
                // field (@storage:flattened) is materialised by the Exposed table as per-subfield
                // columns — there is no single `Table.<field>` to bind — so it stays excluded.
                (it !is ObjectField || isJsonbObjectColumn(it)) &&
                // #214: a DERIVED (origin.*) field on a write-through entity has no column on the
                // write table — it is computed by the read view — so it is never a write/patch target.
                !(writeThrough && KotlinGenUtil.isDerivedField(it)) &&
                // #203/ADR-0045: an @autoSet column is server-owned — the generated controller
                // stamps it (the API surface owns the write semantic); a caller cannot set it via PATCH.
                !KotlinGenUtil.isAutoSetField(it) &&
                // FR-037 R1: both non-readWrite @mutability modes leave the PATCH settable set —
                // `readOnly` is never written at all, `writeOnce` is frozen after create. A value
                // presented for one is STRIPPED (it is simply not in the settable set), not 400'd:
                // that is the uniform behaviour of every excluded key on this path, and the
                // generated edit form submits every registered field.
                !KotlinGenUtil.isReadOnlyMutability(it) &&
                !KotlinGenUtil.isWriteOnceMutability(it)
        }
        val hasPatchFields = patchSettableFields.isNotEmpty()

        // #203/ADR-0045: @autoSet columns are stamped by the generated controller, not bound from
        // the caller. insert stamps BOTH onCreate+onUpdate (a fresh row's updatedAt == createdAt —
        // captured from ONE now() per temporal type so they are exactly equal); a patch re-stamps
        // onUpdate on EVERY write (even an empty body) and never rewrites onCreate. An @autoSet
        // field is a real write-table column (never derived), so only the PK / write-through-derived
        // guards apply.
        val insertAutoSetFields = entity.metaFields.filter {
            KotlinGenUtil.isAutoSetField(it) && it.name != pkFieldName &&
                !(writeThrough && KotlinGenUtil.isDerivedField(it))
        }
        val onUpdateAutoSetFields = insertAutoSetFields.filter {
            KotlinGenUtil.autoSetPolicy(it) == KotlinGenUtil.AUTO_SET_ON_UPDATE
        }
        // One captured now()-val per distinct temporal type, so all same-type @autoSet columns in a
        // single insert receive the identical value (createdAt == updatedAt exactly).
        val insertNowVal = LinkedHashMap<String, String>() // nowExpr → local val name
        insertAutoSetFields.forEach { f ->
            insertNowVal.getOrPut(KotlinTypeMapper.nowExpr(f)) { "autoSetNow${insertNowVal.size}" }
        }

        // Sort allowlist: every scalar field is sortable. Skip ObjectField (no SQL column
        // surface on the Exposed Table; @storage controls a separate column shape) and the
        // `field.string @dbColumnType=jsonb` open bag — a JSONB value is not a scalar sort
        // target (its in-process type is a kotlinx JsonElement, not a comparable scalar).
        val sortFields = entity.metaFields
            .filterNot { it is ObjectField || it is MapField || KotlinTypeMapper.isJsonbOpenBag(it) }
            .map { it.name }

        // Per-field dispatch map (filter dispatch); only used inside the generated
        // file. Each entry carries the field name, its subtype (drives the dispatch arm
        // shape + value-coercion path) and the Exposed column's element Kotlin type
        // (drives the eq/ne/in value cast — Exposed's typed `Column<T>.eq` rejects a bare
        // `Any?`, so each predicate value is cast to the column's element type).
        // The `field.string @dbColumnType=jsonb` open bag is excluded: it is not @filterable
        // (so the FilterAllowlist omits it) AND its column element type is a kotlinx
        // JsonElement — emitting a filter-dispatch arm (`p.value as JsonElement`) would
        // reference an un-imported type and produce a controller that does not compile.
        val scalarFields: List<ScalarFieldSpec> = entity.metaFields
            .filterNot { it is ObjectField || it is MapField || KotlinTypeMapper.isJsonbOpenBag(it) }
            .map { ScalarFieldSpec(it.name, it.subType, columnElementType(it), intBackedEnumType(it, entity)) }

        val allowlistName = "${shortName}FilterAllowlist"
        // FR-018: M:N navs declared on this entity (derived junction FK fields via the
        // cross-port SSOT). Drives the GET /{id}/<relationName> traversal sub-resources.
        val m2mNavs = KotlinM2mSupport.resolve(entity, loader)
        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import org.jetbrains.exposed.sql.Op\n")
            append("import org.jetbrains.exposed.sql.SortOrder\n")
            append("import org.jetbrains.exposed.sql.ResultRow\n")
            append("import org.jetbrains.exposed.sql.SqlExpressionBuilder\n")
            append("import org.jetbrains.exposed.sql.and\n")
            append("import org.jetbrains.exposed.sql.deleteWhere\n")
            append("import org.jetbrains.exposed.sql.insert\n")
            append("import org.jetbrains.exposed.sql.selectAll\n")
            append("import org.jetbrains.exposed.sql.update\n")
            append("import org.jetbrains.exposed.sql.transactions.transaction\n")
            append("import com.fasterxml.jackson.databind.JsonNode\n")
            // ObjectMapper + TypeReference are used ONLY by the per-field patch bind, which is
            // emitted only when there ARE settable fields — omit them otherwise (unused import /
            // ctor param would fail the module's allWarningsAsErrors compile).
            if (hasPatchFields) {
                append("import com.fasterxml.jackson.core.type.TypeReference\n")
                append("import com.fasterxml.jackson.databind.ObjectMapper\n")
            }
            // FR-036: the controller enforces the entity's field constraints over HTTP through a
            // jakarta Validator (POST body + present PATCH values) — always injected in this
            // writable-table path (a read-only projection controller never reaches emit()).
            append("import jakarta.validation.Validator\n")
            append("import org.springframework.http.HttpStatus\n")
            append("import org.springframework.http.ResponseEntity\n")
            append("import org.springframework.web.bind.annotation.DeleteMapping\n")
            append("import org.springframework.web.bind.annotation.ExceptionHandler\n")
            append("import org.springframework.web.bind.annotation.GetMapping\n")
            append("import org.springframework.web.bind.annotation.PathVariable\n")
            append("import org.springframework.web.bind.annotation.PostMapping\n")
            append("import org.springframework.web.bind.annotation.RequestBody\n")
            append("import org.springframework.web.bind.annotation.RequestMapping\n")
            append("import org.springframework.web.bind.annotation.RequestMethod\n")
            append("import org.springframework.web.bind.annotation.RequestParam\n")
            append("import org.springframework.web.bind.annotation.RestController\n")
            append("import jakarta.servlet.http.HttpServletRequest\n")
            append("import java.io.ByteArrayOutputStream\n")
            append("import java.nio.charset.StandardCharsets\n")
            append("import java.sql.Timestamp\n")
            // ADR-0036 Wave 2: a default field.timestamp column maps to java.time.Instant
            // (the WHERE-arm casts `p.value as Instant`); import it only when such a column
            // is present so entities without one stay byte-identical.
            if (scalarFields.any { it.elementType == "Instant" }) {
                append("import java.time.Instant\n")
            }
            // A uuid PK / uuid scalar column surfaces java.util.UUID in the by-id route
            // signatures and the filter-dispatch casts; import it only when present so
            // uuid-free entities stay byte-identical.
            if (pkParamType == "UUID" || scalarFields.any { it.elementType == "UUID" }) {
                append("import java.util.UUID\n")
            }
            // FR-009 (#179): a filterable enum column is compared as its stored string via
            // `col.castTo<String>(TextColumnType())`; import both only when such a column exists
            // so entities without a filterable enum stay byte-identical.
            if (scalarFields.any { it.subType == EnumField.SUBTYPE_ENUM }) {
                append("import org.jetbrains.exposed.sql.TextColumnType\n")
                append("import org.jetbrains.exposed.sql.castTo\n")
            }
            append("import java.time.LocalDate\n")
            append("import java.time.LocalDateTime\n")
            append("import java.time.LocalTime\n")
            append("import java.time.format.DateTimeFormatter\n")
            append("\n")
            appendSortSurface(this, shortName, entity, sortFields)

            // FR-009 filter pipeline. Three stages:
            //   1. data class ${shortName}FilterPredicate — parsed + validated one
            //      filter[<f>][<op>]=<v> entry (value already coerced to a Kotlin type).
            //   2. parse${shortName}Filter — walks the raw query string (decoded per
            //      component, tolerating a malformed escape), matching the grammar against
            //      ${allowlistName}.FIELDS + .OPS_BY_FIELD. Returns either predicates or
            //      one of the cross-port error envelope keys.
            //   3. ${shortName}WhereOp — converts the predicate list into an Exposed
            //      Op<Boolean> bound against ${tableObjectName}'s columns. Multiple
            //      predicates AND together. Per-field arms know each column's Kotlin
            //      type at compile time (no reflection / runtime cast surprises).
            // #214: the filter + sort surface reads through the READ object (the view for a
            // write-through entity), so its per-field Exposed dispatch binds against `readObj`.
            emitFilterPipeline(this, shortName, readObj, allowlistName, scalarFields)

            appendRowToMapper(this, shortName, entity, readObj)

            append("/** GENERATED — REST controller for ${shortName} entity. Implements the cross-port API contract. */\n")
            append("@RestController\n")
            append("@RequestMapping(\"$routeBase\")\n")
            // FR-036: `validator` is always injected (POST + present-PATCH-value enforcement).
            // FR-035 present-key PATCH: the update handler binds the RAW JsonNode (not a
            // @Valid data class, which cannot see absent-vs-null) and per-field-binds present
            // values via the Spring-configured ObjectMapper — injected only when there ARE
            // settable fields (a PK + only object/jsonb columns needs no mapper).
            if (hasPatchFields) {
                append("class ${shortName}Controller(private val objectMapper: ObjectMapper, private val validator: Validator) {\n\n")
            } else {
                append("class ${shortName}Controller(private val validator: Validator) {\n\n")
            }

            appendListHandler(this, shortName, readObj, sortFields)

            appendGetHandler(this, shortName, readObj, pkFieldName, pkParamType)

            // POST — create. FR-036: validate the bound body through the jakarta Validator and
            // 400 with the cross-port envelope on any violation BEFORE the insert. (@Valid's
            // default 400 body is NOT the cross-port {error:"validation"} shape and does not fire
            // under MockMvc standaloneSetup — so the check is explicit here.)
            append("    @PostMapping\n")
            append("    fun create(@RequestBody dto: ${shortName}): ResponseEntity<Any> = transaction {\n")
            append("        if (validator.validate(dto).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
            // #203/ADR-0045: capture one now() per temporal type so createdAt == updatedAt exactly.
            for ((expr, valName) in insertNowVal) append("        val $valName = $expr\n")
            append("        val newId = ${tableObjectName}.insert {\n")
            // A `@generation: uuid` key is minted HERE, not left to the column's database default:
            // Exposed hands back `[Table.id]` only for a value it inserted or an autoIncrement
            // column, so a DB-defaulted uuid key read back as "id is not in record set" on every
            // driver that will not return it. Minting app-side is what the TS runtime does too.
            if (uuidGeneratedPk(entity, pkFieldName)) append("            it[${pkFieldName}] = java.util.UUID.randomUUID()\n")
            for (field in entity.metaFields) {
                // Program D: a field.object value-object jsonb column IS written on create — the
                // DTO property is the typed VO (record / List<VO>) and the Exposed Column<VO> codec
                // encodes it to jsonb. MapField (dict-of-VO) stays skipped (staged out); a flattened
                // object field (no single `Table.<field>`) is skipped too.
                if (field is MapField || (field is ObjectField && !isJsonbObjectColumn(field))) continue
                // Skip the PK column on insert — the table's @generation=increment owns it.
                // If the entity has no auto-incrementing PK the consumer can override the
                // generated handler; this is the 95% case.
                if (field.name == pkFieldName) continue
                // #214: a DERIVED (origin.*) field on a write-through entity has no column on the
                // write table (computed by the view), so it is never written on create.
                if (writeThrough && KotlinGenUtil.isDerivedField(field)) continue
                // #203/ADR-0045: insert stamps onCreate+onUpdate @autoSet columns from the captured
                // now() (the caller's value is ignored — never bound from the dto).
                if (KotlinGenUtil.isAutoSetField(field)) {
                    append("            it[${field.name}] = ${insertNowVal[KotlinTypeMapper.nowExpr(field)]}\n")
                    continue
                }
                // NOTE: a `field.string @dbColumnType=jsonb` open bag IS written here (create
                // binds it from the @Valid DTO's kotlinx JsonElement property, gated by the
                // jsonb-open-bag-roundtrip corpus). PATCH cannot (the raw-JsonNode path can't bind
                // a JsonElement without surfacing the un-imported type the #179 guard forbids), so
                // an open bag is a create-only column on the generated CRUD — see KNOWN_GAPS.
                append("            it[${field.name}] = dto.${field.name}\n")
            }
            append("        }[${tableObjectName}.${pkFieldName}]\n")
            // #214: re-read the persisted row through the READ object (the view for a write-through
            // entity) by PK so the returned entity carries the derived fields (read-your-writes).
            append("        val saved = ${readObj}.selectAll().where { ${readObj}.${pkFieldName} eq newId }.single()\n")
            append("        ResponseEntity.status(HttpStatus.CREATED).body(rowTo${shortName}(saved) as Any)\n")
            append("    }\n\n")

            // PATCH + PUT — single handler (per API contract; same body shape both verbs).
            // Both verbs MUST be expressed on one @RequestMapping with method=[PATCH, PUT].
            // Stacking @PatchMapping + @PutMapping on the same method does NOT register both
            // in Spring MVC — only one composed @RequestMapping per method is honored, so the
            // other verb 405s. (Surfaced by the SP-F generated-controller HTTP lane.)
            // FR-035 present-key tristate: bind the RAW JsonNode so absent-vs-null is visible.
            // A non-object body, or an explicit null on a @required field, is a 400; an explicit
            // null on a nullable field CLEARS it; an omitted field is untouched; a present value
            // binds through the configured ObjectMapper (same codecs as create). An empty
            // effective patch is a no-op read-back (avoids Exposed's empty-SET error).
            // Settable columns are `patchSettableFields` (computed up top): scalar + value-object
            // fields minus the PK, EXCLUDING map/jsonb-open-bag (an open bag is a create-only CRUD
            // column — PATCH can't bind a kotlinx JsonElement; see KNOWN_GAPS). Program D: a present
            // field.object VO binds via Jackson treeToValue and is validated in FULL (spec §0).
            // When empty, no update{} block is emitted (an empty Exposed SET throws) — a no-op read-back.
            append("    @RequestMapping(value = [\"/{id}\"], method = [RequestMethod.PATCH, RequestMethod.PUT])\n")
            append("    fun update(@PathVariable id: $pkParamType, @RequestBody body: JsonNode): ResponseEntity<Any> = transaction {\n")
            append("        if (!body.isObject) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
            for (field in patchSettableFields) {
                if (KotlinGenUtil.isRequiredField(field)) {
                    append("        if (body.has(\"${field.name}\") && body.get(\"${field.name}\").isNull) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                }
            }
            val mustStampOnUpdate = onUpdateAutoSetFields.isNotEmpty()
            if (hasPatchFields) {
                val settableNamesList = patchSettableFields.joinToString(", ") { "\"${it.name}\"" }
                // #203/ADR-0045: with onUpdate @autoSet columns the update must run on EVERY patch
                // (to bump them) — no "any present" guard; otherwise the guard keeps the update out
                // when the caller sent no settable field (byte-identical to the pre-#203 output).
                if (!mustStampOnUpdate) append("        if (listOf($settableNamesList).any { body.has(it) }) {\n")
                // A present value that cannot bind to its column's Kotlin type (e.g. a JSON object
                // for a String column) throws from treeToValue — map that to 400, not a 500. Catch
                // the specific Jackson JsonMappingException so no unrelated exception is swallowed.
                append("            try {\n")
                // FR-036: bind each PRESENT value into a typed local, then validate present NON-NULL
                // values against the entity's field constraints (validator.validateValue) — a bind
                // failure OR a constraint violation → 400 BEFORE any write. Binding happens here (not
                // inside the Exposed update{} lambda) so `return@transaction` on a violation is legal
                // (a qualified return cannot cross the non-inline update{} lambda). present-null on a
                // @required field was already 400'd above; present-null on a nullable field clears it
                // (no bind, no validation).
                for (field in patchSettableFields) {
                    // The DATA-CLASS element type: a field.enum's materialized enum class; a
                    // field.object's referenced value-object record (Program D — bound via Jackson
                    // treeToValue into the VO / List<VO>); else the scalar Kotlin type — so the bound
                    // value matches the Exposed Column<E>. A VO type is emitted fully-qualified so the
                    // controller needs no extra import (mirrors the Exposed column codec).
                    val elem: String = if (field is ObjectField) {
                        voElementTypeFqn(field, loader)
                    } else {
                        (KotlinTypeMapper.enumTypeName(field, entity) ?: KotlinTypeMapper.kotlinTypeName(field)).toString()
                    }
                    val ktType = if (field.isArrayType) "kotlin.collections.List<$elem>" else elem
                    val fn = field.name
                    val cap = capitalizeFirst(fn)
                    append("                val has$cap = body.has(\"$fn\")\n")
                    if (KotlinGenUtil.isRequiredField(field)) {
                        // required: present ⇒ non-null (present-null was 400'd above).
                        append("                val v$cap: $ktType? = if (has$cap) objectMapper.treeToValue(body.get(\"$fn\"), object : TypeReference<$ktType>() {}) else null\n")
                        append("                if (has$cap && validator.validateValue(${shortName}::class.java, \"$fn\", v$cap).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                    } else {
                        append("                val null$cap = has$cap && body.get(\"$fn\").isNull\n")
                        append("                val v$cap: $ktType? = if (has$cap && !null$cap) objectMapper.treeToValue(body.get(\"$fn\"), object : TypeReference<$ktType>() {}) else null\n")
                        append("                if (has$cap && !null$cap && validator.validateValue(${shortName}::class.java, \"$fn\", v$cap).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                    }
                    // Program D (spec §0): jakarta validateValue does NOT cascade @Valid into a nested
                    // value-object's constraints, so a present VO is validated EXPLICITLY —
                    // validator.validate(voElement) per element (single VO whole; array VO per element),
                    // 400 on any violation. (A present-null / cleared value is already handled above.)
                    if (field is ObjectField) {
                        if (field.isArrayType) {
                            append("                if (v$cap != null && v$cap.any { validator.validate(it).isNotEmpty() }) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                        } else {
                            append("                if (v$cap != null && validator.validate(v$cap).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                        }
                    }
                }
                // Apply the already-bound + validated values. Columns are qualified (`Table.col`)
                // so a field named like the `body`/`id` params can't shadow them.
                append("                ${tableObjectName}.update({ ${tableObjectName}.${pkFieldName} eq id }) {\n")
                // #203/ADR-0045: bump every onUpdate @autoSet column first (server-owned); onCreate
                // columns are never touched on update (createdAt is immutable).
                for (field in onUpdateAutoSetFields) {
                    append("                    it[${tableObjectName}.${field.name}] = ${KotlinTypeMapper.nowExpr(field)}\n")
                }
                for (field in patchSettableFields) {
                    val fn = field.name
                    val cap = capitalizeFirst(fn)
                    val col = "$tableObjectName.$fn"
                    if (KotlinGenUtil.isRequiredField(field)) {
                        append("                    if (has$cap) it[$col] = v$cap!!\n")
                    } else {
                        append("                    if (has$cap) { if (null$cap) it[$col] = null else it[$col] = v$cap }\n")
                    }
                }
                append("                }\n")
                append("            } catch (e: com.fasterxml.jackson.databind.JsonMappingException) {\n")
                append("                return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                append("            }\n")
                // Close the "any present" guard only when it was opened (see mustStampOnUpdate above).
                if (!mustStampOnUpdate) append("        }\n")
            } else if (mustStampOnUpdate) {
                // No caller-settable columns, but onUpdate @autoSet must still bump on every patch.
                append("        ${tableObjectName}.update({ ${tableObjectName}.${pkFieldName} eq id }) {\n")
                for (field in onUpdateAutoSetFields) {
                    append("            it[${tableObjectName}.${field.name}] = ${KotlinTypeMapper.nowExpr(field)}\n")
                }
                append("        }\n")
            }
            // #214: read the (possibly-updated) row back through the READ object so the response
            // carries the derived fields; the write above targeted the write table.
            append("        val row = ${readObj}.selectAll().where { ${readObj}.${pkFieldName} eq id }.singleOrNull()\n")
            append("        if (row == null) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
            append("        else ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
            append("    }\n\n")

            // DELETE — Exposed's `deleteWhere` is an extension fn on Table; the import
            // above pulls it in. 204 No Content on success, 404 envelope on miss.
            // The `eq` op must be resolved through SqlExpressionBuilder: deleteWhere's
            // lambda receiver does NOT bring the comparison ops into scope on its own
            // (unlike `selectAll().where { }`), so a bare `Table.id eq id` is an
            // "Unresolved reference: eq" compile error. (Surfaced by the SP-F
            // generated-controller HTTP lane; mirrors the hand-rolled reference server.)
            append("    @DeleteMapping(\"/{id}\")\n")
            append("    fun delete(@PathVariable id: $pkParamType): ResponseEntity<Any> = transaction {\n")
            append("        val deleted = ${tableObjectName}.deleteWhere { with(SqlExpressionBuilder) { ${tableObjectName}.${pkFieldName} eq id } }\n")
            append("        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
            append("        else ResponseEntity.noContent().build<Any>()\n")
            append("    }\n")

            // FR-018 M:N traversal — GET /{id}/<relationName> exposes each
            // @cardinality:"many" + @through relationship as a sub-resource of the source,
            // returning the related target rows. The source URL segment is the entity name
            // pluralized (handled by @RequestMapping above; getShortName() drives the
            // segment, NOT the physical @table); the relation segment is the relationship
            // name. Related-row order is not contractual. The traversal delegates to the
            // <Source>Table.<relationName>Query(id) Exposed join helper emitted by
            // KotlinRelationsGenerator (hetero / directed self-join / symmetric union-on-read,
            // junction FK fields derived via the cross-port M2MFields SSOT).
            for (nav in m2mNavs) {
                emitM2mEndpoint(this, pkg, shortName, nav, pkParamType)
            }

            appendConstraintHandler()
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("${shortName}Controller.kt")
        GeneratedFileWriter.write(outFile, source)
    }

    /**
     * FR-017 TPH: emit the discriminator-base controller — ONE self-contained `@RestController`
     * at `/api/<base-plural>` mounting the polymorphic collection (`GET /`, `GET /{id}`) plus, per
     * subtype `<seg>` (the `@discriminatorValue` lowercased), a full CRUD set scoped by the
     * discriminator: `GET /<seg>` (subtype list), `GET /<seg>/{id}` (404 cross-subtype),
     * `POST /<seg>` (discriminator injected from the URL — never the body),
     * `PATCH|PUT /<seg>/{id}` (partial patch; discriminator immutable; 404 cross-subtype),
     * `DELETE /<seg>/{id}` (404 cross-subtype).
     *
     * Every endpoint trades the base `<Base>` data class — for a TPH base that class is the UNION
     * of subtype columns (folded nullable by [KotlinEntityGenerator]), so a polymorphic row surfaces
     * its subtype values and a per-subtype POST/PATCH body binds its own columns. The controller
     * embeds Exposed against the union `<Base>Table` ([KotlinExposedTableGenerator]); the
     * discriminator is the generated enum, so `type` is scoped/injected as `<Enum>.<Value>`.
     */
    protected open fun emitTph(base: MetaObject, plan: KotlinTphPlan.Plan, outRoot: Path, loader: MetaDataLoader) {
        val (pkg, shortName) = PackageMapping.splitFqn(base.name)
        val table = shortName + "Table"
        val routeBase = KotlinNaming.controllerPath(shortName)
        // The single TPH table is keyed by the BASE's primary identity — every polymorphic
        // + per-subtype by-id route binds the PK field's OWN Kotlin type (uuid → UUID, …),
        // matching the Exposed Column<T> it is compared against (a hard-coded Long does
        // not compile against a uuid PK). Same fallback policy as the vanilla emit.
        val pkFieldName = base.getIdentities(true)
            .filterIsInstance<MetaIdentity>()
            .firstOrNull { it.isPrimary }?.fields?.firstOrNull() ?: DEFAULT_PK_FIELD
        val pkParamType = primaryKeyParamType(base, pkFieldName)
        val discField = base.metaFields.first { it.name == plan.discriminatorField }
        val discEnum = KotlinTypeMapper.enumTypeName(discField, base)?.simpleName
            ?: error("TPH base ${base.name}: discriminator field '${plan.discriminatorField}' is not an enum")
        // The controller scopes/injects the discriminator as `<Enum>.<Value>` (an enum constant), so
        // every @discriminatorValue MUST be a valid Kotlin identifier — fail loud at generation with a
        // clear message rather than emit code that won't compile (the Java lane uses string literals
        // and has no such constraint).
        for (st in plan.subtypes) {
            require(st.value.matches(Regex("[A-Za-z_][A-Za-z0-9_]*"))) {
                "FR-017 TPH base ${base.name}: @discriminatorValue '${st.value}' on ${st.entity.name} is not a valid " +
                    "Kotlin enum-constant identifier; the generated $discEnum.${st.value} reference would not compile."
            }
        }

        // Union scalar fields (base own + subtype-only), in the data class / table order.
        val scalarFields = (base.metaFields.filterNot { it is ObjectField || it is MapField } +
            KotlinTphPlan.collectSubtypeFields(base, plan).filterNot { it is ObjectField || it is MapField })
        val sortFields = base.metaFields
            .filterNot { it is ObjectField || it is MapField || KotlinTypeMapper.isJsonbOpenBag(it) }
            .map { it.name }
        val baseFieldNames = base.metaFields.map { it.name }.toSet()
        val allowlistName = "${shortName}FilterAllowlist"
        // Union filter-dispatch specs (base + subtype columns) for the FR-009 pipeline — EXCLUDING the
        // discriminator (route-addressable; enum column), decimal columns (outside the cross-port
        // HTTP filter contract) and the `field.string @dbColumnType=jsonb` open bag (a JSONB value is
        // not a scalar filter target; its element type is an un-imported kotlinx JsonElement). Mirrors
        // the allowlist's exclusions, so the dispatch never references a cast the generic pipeline
        // can't coerce. (scalarFields itself is left intact — rowTo<Base> reuses it to map every column.)
        // The discriminator stays IN: the base allowlist admits it (FR-017), so it needs a
        // coercion + WHERE arm like any filterable enum column.
        val filterSpecs = scalarFields
            .filter { it !is com.metaobjects.field.DecimalField && !KotlinTypeMapper.isJsonbOpenBag(it) }
            .map { ScalarFieldSpec(it.name, it.subType, columnElementType(it), intBackedEnumType(it, base)) }
        // #203/ADR-0045: @autoSet columns on the union table are stamped by the controller, never bound
        // from the per-subtype create body. Same computation as the vanilla emit() (lines ~195-207); the
        // columns live on the BASE (shared by every subtype row in the single table) — a TPH subtype
        // never declares its own @autoSet column.
        val insertAutoSetFields = base.metaFields.filter {
            KotlinGenUtil.isAutoSetField(it) && it.name != pkFieldName
        }
        val onUpdateAutoSetFields = insertAutoSetFields.filter {
            KotlinGenUtil.autoSetPolicy(it) == KotlinGenUtil.AUTO_SET_ON_UPDATE
        }
        val autoSetNames = insertAutoSetFields.map { it.name }.toSet()
        // One captured now()-val per distinct temporal type, so all same-type @autoSet columns in a
        // single per-subtype insert receive the identical value (createdAt == updatedAt exactly).
        val insertNowVal = LinkedHashMap<String, String>() // nowExpr -> local val name
        insertAutoSetFields.forEach { f ->
            insertNowVal.getOrPut(KotlinTypeMapper.nowExpr(f)) { "autoSetNow${insertNowVal.size}" }
        }

        // Non-discriminator, non-PK, non-@autoSet columns the create handler writes from the body.
        val writableFields = scalarFields.map { it.name }
            .filter { it != plan.discriminatorField && it != pkFieldName && it !in autoSetNames }

        // FR-035/FR-036 Program B: the per-subtype settable columns = the subtype's EFFECTIVE scalar
        // fields (base + own, resolved via extends) minus the PK and the discriminator, EXCLUDING
        // object/map/jsonb-open-bag (an open bag is a create-only column, see KNOWN_GAPS). Delegated to
        // [KotlinTphPlan.subtypeSettableFields] — the SSOT the entity generator's <Sub>Validation shape
        // is built from, so the create/PATCH validated set never drifts from the annotated class. This
        // is per-subtype so a PriorAuth patch never touches a Bridge-only column.
        fun subtypePatchFields(st: KotlinTphPlan.Subtype) =
            KotlinTphPlan.subtypeSettableFields(st.entity)

        // FW-8 x FR-017: M:N traversal inside a TPH hierarchy. A relationship declared on the
        // BASE is legitimate for every row of the shared table — mounted once, unscoped, exactly
        // like a vanilla entity's (see emitM2mEndpoint). Every relationship a SUBTYPE resolves —
        // its own, or inherited from the base — is ALSO mounted under that subtype's segment,
        // scoped by a Stage-0 discriminator check (see emitTphSubtypeM2mEndpoint): a subtype
        // resource carries the same sub-resources as any other, and the junction FK addresses
        // the shared base table, so without that check a sibling's id would traverse it too.
        val baseM2mNavs = KotlinM2mSupport.resolve(base, loader)
        fun subtypeM2mNavs(st: KotlinTphPlan.Subtype) = KotlinM2mSupport.resolve(st.entity, loader)
        // FW-8 follow-up: the TPH-group-wide query-helper NAME for every distinct nav shape
        // (base's own + every subtype's own) — the SAME decision KotlinRelationsGenerator makes
        // for AuthRelations.kt (KotlinM2mSupport.tphQueryFnNames), keyed by structural M2mNav
        // equality so a nav resolved here and the identical nav resolved there agree on the
        // helper to call. A subtype that SHADOWS a relation name with a genuinely different nav
        // (own children shadow super on (type, name), ADR-0039) gets its OWN disambiguated entry.
        val m2mHelperNames = KotlinM2mSupport.tphQueryFnNames(base, plan, loader)
        // When NO subtype has a settable column (a PK + discriminator + only object/jsonb columns) the
        // controller emits no ObjectMapper/Validator ctor param or TypeReference import (they would be
        // unused → allWarningsAsErrors). A real TPH base always contributes ≥1 base scalar, so this is
        // true in practice; the guard keeps the pathological hierarchy byte-clean.
        val anyPatchFields = plan.subtypes.any { subtypePatchFields(it).isNotEmpty() }

        val src = buildString {
            if (pkg.isNotEmpty()) append("package $pkg\n\n")
            append("import org.jetbrains.exposed.sql.Op\n")
            append("import org.jetbrains.exposed.sql.ResultRow\n")
            append("import org.jetbrains.exposed.sql.SortOrder\n")
            append("import org.jetbrains.exposed.sql.SqlExpressionBuilder\n")
            append("import org.jetbrains.exposed.sql.and\n")
            append("import org.jetbrains.exposed.sql.deleteWhere\n")
            append("import org.jetbrains.exposed.sql.insert\n")
            append("import org.jetbrains.exposed.sql.selectAll\n")
            append("import org.jetbrains.exposed.sql.update\n")
            append("import org.jetbrains.exposed.sql.transactions.transaction\n")
            // FR-035 present-key PATCH: the per-subtype update handler binds the RAW JsonNode (not the
            // union data class, which cannot see absent-vs-null) so the tristate (omitted / present-null
            // / present-value) is visible.
            append("import com.fasterxml.jackson.databind.JsonNode\n")
            // FR-036: each present PATCH value binds via the Spring-configured ObjectMapper and is
            // validated through a jakarta Validator — imported only when at least one subtype has a
            // settable column (an unused import/ctor param would fail the module's allWarningsAsErrors
            // compile).
            if (anyPatchFields) {
                append("import com.fasterxml.jackson.core.type.TypeReference\n")
                append("import com.fasterxml.jackson.databind.ObjectMapper\n")
                append("import jakarta.validation.Validator\n")
            }
            append("import org.springframework.http.HttpStatus\n")
            append("import org.springframework.http.ResponseEntity\n")
            append("import org.springframework.web.bind.annotation.DeleteMapping\n")
            append("import org.springframework.web.bind.annotation.ExceptionHandler\n")
            append("import org.springframework.web.bind.annotation.GetMapping\n")
            append("import org.springframework.web.bind.annotation.PathVariable\n")
            append("import org.springframework.web.bind.annotation.PostMapping\n")
            append("import org.springframework.web.bind.annotation.RequestBody\n")
            append("import org.springframework.web.bind.annotation.RequestMapping\n")
            append("import org.springframework.web.bind.annotation.RequestMethod\n")
            append("import org.springframework.web.bind.annotation.RequestParam\n")
            append("import org.springframework.web.bind.annotation.RestController\n")
            // FR-009 filter pipeline support (mirrors the vanilla controller's import set).
            append("import jakarta.servlet.http.HttpServletRequest\n")
            append("import java.io.ByteArrayOutputStream\n")
            append("import java.nio.charset.StandardCharsets\n")
            append("import java.sql.Timestamp\n")
            // ADR-0036 Wave 2: import java.time.Instant only when a default field.timestamp
            // column (→ Instant) is in the filter surface — keeps Instant-free entities
            // byte-identical.
            if (filterSpecs.any { it.elementType == "Instant" }) {
                append("import java.time.Instant\n")
            }
            // A uuid PK / uuid union column surfaces java.util.UUID in the by-id route
            // signatures and the filter-dispatch casts — same conditional import as the
            // vanilla controller, so uuid-free hierarchies stay byte-identical.
            if (pkParamType == "UUID" || filterSpecs.any { it.elementType == "UUID" }) {
                append("import java.util.UUID\n")
            }
            // FR-009 (#179): a filterable enum in the union — the discriminator included — is
            // compared as its stored string via `col.castTo<String>(TextColumnType())`; same
            // conditional imports as the vanilla controller.
            if (filterSpecs.any { it.subType == EnumField.SUBTYPE_ENUM }) {
                append("import org.jetbrains.exposed.sql.TextColumnType\n")
                append("import org.jetbrains.exposed.sql.castTo\n")
            }
            append("import java.time.LocalDate\n")
            append("import java.time.LocalDateTime\n")
            append("import java.time.LocalTime\n")
            append("import java.time.format.DateTimeFormatter\n\n")

            // sort allowlist (base scalar columns — the polymorphic sort surface)
            append("/** GENERATED — sort allowlist for $shortName (cross-port API contract). */\n")
            append("private val ${shortName}SortAllowlist = setOf(\n")
            for (f in sortFields) append("    \"$f\",\n")
            append(")\n\n")
            // The polymorphic sort surface is the BASE's own columns, so the declared
            // orders are read off the base too — same owner the allowlist came from.
            appendSortDefaultOrders(this, shortName, base, sortFields)
            append("private fun parse${shortName}Sort(raw: String): Pair<String, SortOrder>? {\n")
            append("    val parts = raw.split(\":\", limit = 2)\n")
            append("    val field = parts.getOrNull(0) ?: return null\n")
            append("    if (field !in ${shortName}SortAllowlist) return null\n")
            append("    val dir = when (parts.getOrNull(1)?.lowercase()\n")
            append("        ?: ${shortName}SortDefaultOrder[field] ?: \"asc\") {\n")
            append("        \"asc\" -> SortOrder.ASC\n")
            append("        \"desc\" -> SortOrder.DESC\n")
            append("        else -> return null\n")
            append("    }\n")
            append("    return field to dir\n")
            append("}\n\n")

            // FR-009 filter pipeline over the UNION columns (parse + per-field Exposed Op dispatch),
            // shared by the polymorphic + per-subtype list handlers — matches the Python/TS TPH lanes.
            emitFilterPipeline(this, shortName, table, allowlistName, filterSpecs)

            // rowTo<Base>: union ResultRow → data class
            append("/** GENERATED — map an Exposed ResultRow to the union $shortName data class. */\n")
            append("private fun rowTo${shortName}(row: ResultRow): $shortName = $shortName(\n")
            for (field in scalarFields) append("    ${field.name} = row[$table.${field.name}],\n")
            append(")\n\n")

            append("/** GENERATED — TPH discriminator-base controller for $shortName (polymorphic + per-subtype CRUD). */\n")
            append("@RestController\n")
            append("@RequestMapping(\"$routeBase\")\n")
            // FR-036: the per-subtype PATCH tristate binds present values through the Spring-configured
            // ObjectMapper and validates them via the jakarta Validator — both injected only when a
            // subtype has a settable column (else a no-arg controller, keeping unused params out).
            if (anyPatchFields) {
                append("class ${shortName}Controller(private val objectMapper: ObjectMapper, private val validator: Validator) {\n\n")
            } else {
                append("class ${shortName}Controller {\n\n")
            }

            // polymorphic list
            append("    @GetMapping\n")
            append("    fun list(\n")
            append("        @RequestParam(required = false) limit: Int?,\n")
            append("        @RequestParam(required = false) offset: Int?,\n")
            append("        @RequestParam(required = false) sort: String?,\n")
            append("        @RequestParam(required = false, name = \"withCount\") withCount: Int?,\n")
            append("        request: HttpServletRequest,\n")
            append("    ): ResponseEntity<Any> = transaction {\n")
            append("        val filterResult = parse${shortName}Filter(request.queryString)\n")
            append("        if (filterResult.error != null) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to filterResult.error, \"field\" to filterResult.field) as Any)\n")
            append("        val whereOp = ${shortName}WhereOp(filterResult.predicates)\n")
            append("        var q = if (whereOp != null) $table.selectAll().where { whereOp } else $table.selectAll()\n")
            append("        if (sort != null) {\n")
            append("            val parsed = parse${shortName}Sort(sort)\n")
            append("                ?: return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"invalid_sort\", \"field\" to sort.substringBefore(':')) as Any)\n")
            append("            val (field, dir) = parsed\n")
            append("            q = q.orderBy(${sortColumnExpr(table, shortName, sortFields)} to dir)\n")
            append("        }\n")
            append("        val total: Long = if (withCount == 1) q.count() else -1L\n")
            append("        val rows = q.limit(limit ?: 50, (offset ?: 0).toLong()).map { rowTo${shortName}(it) }\n")
            append("        if (withCount == 1) ResponseEntity.ok(mapOf(\"rows\" to rows, \"total\" to total) as Any)\n")
            append("        else ResponseEntity.ok(rows as Any)\n")
            append("    }\n\n")

            // polymorphic get
            append("    @GetMapping(\"/{id}\")\n")
            append("    fun get(@PathVariable id: $pkParamType): ResponseEntity<Any> = transaction {\n")
            append("        val row = $table.selectAll().where { $table.$pkFieldName eq id }.singleOrNull()\n")
            append("            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
            append("        ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
            append("    }\n\n")

            // Base-declared M:N — unscoped, same shape emitM2mEndpoint gives a vanilla entity.
            for (nav in baseM2mNavs) {
                emitM2mEndpoint(this, pkg, shortName, nav, pkParamType, m2mHelperNames.getValue(nav))
            }

            for (st in plan.subtypes) {
                val seg = st.routeSegment
                val disc = "$discEnum.${st.value}"   // e.g. AuthType.Bridge
                val sfx = capitalizeFirst(st.value)   // method-name suffix, e.g. Bridge
                // FR-036: the annotated <Sub>Validation shape (emitted by KotlinEntityGenerator) that
                // the per-subtype POST + PATCH validate present values against — the bound union base
                // data class is annotation-free. Referenced FQN-qualified when the subtype lives in a
                // different package (this hand-rolled builder owns no import machinery, like emitM2m*),
                // else bare.
                val (stPkg, stShort) = PackageMapping.splitFqn(st.entity.name)
                val validationRef = KotlinNaming.tphSubtypeValidationName(stShort).let { cls ->
                    if (stPkg == pkg || stPkg.isEmpty()) cls else "$stPkg.$cls"
                }
                // The subtype's settable columns (SSOT shared with the <Sub>Validation shape) — the
                // create body + present PATCH values are both validated against exactly this set.
                val stPatch = subtypePatchFields(st)

                append("    // --- subtype ${st.value} (segment /$seg) ---\n")

                // per-subtype list (discriminator scope AND'd with the FR-009 filter)
                append("    @GetMapping(\"/$seg\")\n")
                append("    fun list$sfx(\n")
                append("        @RequestParam(required = false) limit: Int?,\n")
                append("        @RequestParam(required = false) offset: Int?,\n")
                append("        @RequestParam(required = false) sort: String?,\n")
                append("        request: HttpServletRequest,\n")
                append("    ): ResponseEntity<Any> = transaction {\n")
                append("        val filterResult = parse${shortName}Filter(request.queryString)\n")
                append("        if (filterResult.error != null) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to filterResult.error, \"field\" to filterResult.field) as Any)\n")
                append("        val whereOp = ${shortName}WhereOp(filterResult.predicates)\n")
                append("        var q = $table.selectAll().where {\n")
                append("            val d = $table.${plan.discriminatorField} eq $disc\n")
                append("            if (whereOp != null) d and whereOp else d\n")
                append("        }\n")
                append("        if (sort != null) {\n")
                append("            val parsed = parse${shortName}Sort(sort)\n")
                append("                ?: return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"invalid_sort\", \"field\" to sort.substringBefore(':')) as Any)\n")
                append("            val (field, dir) = parsed\n")
                append("            q = q.orderBy(${sortColumnExpr(table, shortName, sortFields)} to dir)\n")
                append("        }\n")
                append("        val rows = q.limit(limit ?: 50, (offset ?: 0).toLong()).map { rowTo${shortName}(it) }\n")
                append("        ResponseEntity.ok(rows as Any)\n")
                append("    }\n\n")

                // per-subtype get
                append("    @GetMapping(\"/$seg/{id}\")\n")
                append("    fun get$sfx(@PathVariable id: $pkParamType): ResponseEntity<Any> = transaction {\n")
                append("        val row = $table.selectAll().where { ($table.$pkFieldName eq id) and ($table.${plan.discriminatorField} eq $disc) }.singleOrNull()\n")
                append("            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
                append("        ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
                append("    }\n\n")

                // per-subtype create (discriminator injected from URL). FR-036: validate each body
                // value against the subtype's ANNOTATED <Sub>Validation constraints BEFORE persisting,
                // 400ing with the cross-port {"error":"validation"} envelope on any violation (an
                // over-@maxLength or missing-@required column is a 400, not a silent 201). The bound
                // body stays the union base data class (the shape the insert consumes), but the union is
                // annotation-free — so validation runs PER FIELD against <Sub>Validation, the SAME
                // annotated shape + field set the per-subtype PATCH validates. validateValue applies
                // @NotNull to a null value, so an absent @required column 400s too — mirroring the
                // vanilla create's whole-bean validate, scoped to this subtype.
                append("    @PostMapping(\"/$seg\")\n")
                append("    fun create$sfx(@RequestBody dto: $shortName): ResponseEntity<Any> = transaction {\n")
                for (field in stPatch) {
                    append("        if (validator.validateValue($validationRef::class.java, \"${field.name}\", dto.${field.name}).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                }
                // #203/ADR-0045: capture one now() per temporal type so createdAt == updatedAt exactly.
                for ((expr, valName) in insertNowVal) append("        val $valName = $expr\n")
                append("        val newId = $table.insert {\n")
                append("            it[${plan.discriminatorField}] = $disc\n")
                // `@generation: uuid` key minted app-side — see the vanilla create.
                if (uuidGeneratedPk(base, pkFieldName)) append("            it[$pkFieldName] = java.util.UUID.randomUUID()\n")
                for (f in writableFields) {
                    // A column is non-null in the union table iff it is a BASE @required field
                    // (subtype-only columns are folded NULLABLE). For a non-null column the union
                    // DTO field is still nullable, so force non-null on create (create bodies for
                    // that subtype always supply it); nullable columns bind the nullable value as-is.
                    val colNonNull = baseFieldNames.contains(f) && KotlinGenUtil.isRequiredField(scalarFields.first { it.name == f })
                    if (colNonNull) append("            it[$f] = dto.$f!!\n")
                    else append("            it[$f] = dto.$f\n")
                }
                // #203/ADR-0045: insert stamps onCreate+onUpdate @autoSet columns from the captured
                // now() (the caller's dto value is ignored — never bound).
                for (f in insertAutoSetFields) {
                    append("            it[${f.name}] = ${insertNowVal[KotlinTypeMapper.nowExpr(f)]}\n")
                }
                append("        }[$table.$pkFieldName]\n")
                append("        val saved = $table.selectAll().where { $table.$pkFieldName eq newId }.single()\n")
                append("        ResponseEntity.status(HttpStatus.CREATED).body(rowTo${shortName}(saved) as Any)\n")
                append("    }\n\n")

                // per-subtype update — FR-035/FR-036 present-key PATCH tristate (mirrors the vanilla
                // update handler), scoped to THIS subtype's own effective columns; discriminator immutable;
                // 404 cross-subtype via the discriminator-scoped read-back. Bind the RAW JsonNode so
                // absent-vs-null is visible: a non-object body, or an explicit null on a @required column
                // (base or subtype), is a 400; an explicit null on a nullable column CLEARS it; an omitted
                // column is untouched; a present value binds through the ObjectMapper (same codecs as
                // create) and its present non-null value is validated via the jakarta Validator against the
                // subtype's ANNOTATED <Sub>Validation shape (the folded union base data class is
                // annotation-free — so an over-@maxLength present value is a 400, matching the vanilla
                // path + the per-subtype create). Binding + validation run at the transaction-lambda top
                // level (a qualified return@transaction cannot cross the non-inline Exposed update{}
                // lambda). An empty effective patch skips the update{} (Exposed rejects an empty SET) — a
                // no-op read-back.
                append("    @RequestMapping(value = [\"/$seg/{id}\"], method = [RequestMethod.PATCH, RequestMethod.PUT])\n")
                append("    fun update$sfx(@PathVariable id: $pkParamType, @RequestBody body: JsonNode): ResponseEntity<Any> = transaction {\n")
                append("        if (!body.isObject) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                for (field in stPatch) {
                    if (KotlinGenUtil.isRequiredField(field)) {
                        append("        if (body.has(\"${field.name}\") && body.get(\"${field.name}\").isNull) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                    }
                }
                // #203/ADR-0045: mirrors the vanilla update handler's mustStampOnUpdate control flow —
                // an onUpdate @autoSet column must bump on EVERY patch, so the "any present" guard is
                // dropped when one exists (else the guard would keep a no-settable-field patch from
                // bumping it); with no caller-settable columns at all, a standalone update{} still bumps.
                val mustStampOnUpdate = onUpdateAutoSetFields.isNotEmpty()
                if (stPatch.isNotEmpty()) {
                    val settableNamesList = stPatch.joinToString(", ") { "\"${it.name}\"" }
                    if (!mustStampOnUpdate) append("        if (listOf($settableNamesList).any { body.has(it) }) {\n")
                    append("            try {\n")
                    for (field in stPatch) {
                        // The union column's element type — a field.enum's materialized enum class resolved
                        // with the BASE as owner (exactly as the union data class + table type the folded
                        // column), NOT the wire String — so the bound value matches Exposed's Column<E?>.
                        val elem = KotlinTypeMapper.enumTypeName(field, base) ?: KotlinTypeMapper.kotlinTypeName(field)
                        val ktType = if (field.isArrayType) "kotlin.collections.List<$elem>" else "$elem"
                        val fn = field.name
                        val cap = capitalizeFirst(fn)
                        append("                val has$cap = body.has(\"$fn\")\n")
                        if (KotlinGenUtil.isRequiredField(field)) {
                            // required: present ⇒ non-null (present-null was 400'd above).
                            append("                val v$cap: $ktType? = if (has$cap) objectMapper.treeToValue(body.get(\"$fn\"), object : TypeReference<$ktType>() {}) else null\n")
                            append("                if (has$cap && validator.validateValue($validationRef::class.java, \"$fn\", v$cap).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                        } else {
                            append("                val null$cap = has$cap && body.get(\"$fn\").isNull\n")
                            append("                val v$cap: $ktType? = if (has$cap && !null$cap) objectMapper.treeToValue(body.get(\"$fn\"), object : TypeReference<$ktType>() {}) else null\n")
                            append("                if (has$cap && !null$cap && validator.validateValue($validationRef::class.java, \"$fn\", v$cap).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                        }
                    }
                    // Apply the already-bound + validated values, scoped to (pk eq id) and (disc eq value).
                    // Columns are qualified ($table.col) so a field named like the body/id params can't shadow.
                    append("                $table.update({ ($table.$pkFieldName eq id) and ($table.${plan.discriminatorField} eq $disc) }) {\n")
                    // #203/ADR-0045: bump every onUpdate @autoSet column first (server-owned); onCreate
                    // columns are never touched on update (createdAt is immutable).
                    for (field in onUpdateAutoSetFields) {
                        append("                    it[$table.${field.name}] = ${KotlinTypeMapper.nowExpr(field)}\n")
                    }
                    for (field in stPatch) {
                        val fn = field.name
                        val cap = capitalizeFirst(fn)
                        val col = "$table.$fn"
                        if (KotlinGenUtil.isRequiredField(field)) {
                            append("                    if (has$cap) it[$col] = v$cap!!\n")
                        } else {
                            append("                    if (has$cap) { if (null$cap) it[$col] = null else it[$col] = v$cap }\n")
                        }
                    }
                    append("                }\n")
                    append("            } catch (e: com.fasterxml.jackson.databind.JsonMappingException) {\n")
                    append("                return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"validation\") as Any)\n")
                    append("            }\n")
                    // Close the "any present" guard only when it was opened (see mustStampOnUpdate above).
                    if (!mustStampOnUpdate) append("        }\n")
                } else if (mustStampOnUpdate) {
                    // No caller-settable columns for this subtype, but onUpdate @autoSet must still bump.
                    append("        $table.update({ ($table.$pkFieldName eq id) and ($table.${plan.discriminatorField} eq $disc) }) {\n")
                    for (field in onUpdateAutoSetFields) {
                        append("            it[$table.${field.name}] = ${KotlinTypeMapper.nowExpr(field)}\n")
                    }
                    append("        }\n")
                }
                append("        val row = $table.selectAll().where { ($table.$pkFieldName eq id) and ($table.${plan.discriminatorField} eq $disc) }.singleOrNull()\n")
                append("        if (row == null) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
                append("        else ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
                append("    }\n\n")

                // per-subtype delete (404 cross-subtype)
                append("    @DeleteMapping(\"/$seg/{id}\")\n")
                append("    fun delete$sfx(@PathVariable id: $pkParamType): ResponseEntity<Any> = transaction {\n")
                append("        val deleted = $table.deleteWhere { with(SqlExpressionBuilder) { ($table.$pkFieldName eq id) and ($table.${plan.discriminatorField} eq $disc) } }\n")
                append("        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
                append("        else ResponseEntity.noContent().build<Any>()\n")
                append("    }\n\n")

                // M:N traversal scoped to THIS subtype — every relationship it resolves,
                // inherited ones (e.g. a base-declared relationship) included.
                for (nav in subtypeM2mNavs(st)) {
                    emitTphSubtypeM2mEndpoint(
                        this, pkg, table, pkFieldName, plan.discriminatorField, disc, seg, sfx, nav, pkParamType,
                        m2mHelperNames.getValue(nav),
                    )
                }
            }
            appendConstraintHandler()
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("${shortName}Controller.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        GeneratedFileWriter.write(outFile, src)
    }


    /**
     * Emits the constraint-violation handler every generated controller carries.
     *
     * An `@ExceptionHandler` rather than a try/catch per write verb, and that is a
     * correctness choice, not a brevity one: an Exposed `transaction { }` that throws must be
     * allowed to ROLL BACK. Catching inside the lambda and returning a value would have Exposed
     * commit a transaction whose statement already failed, which Postgres rejects outright
     * ("current transaction is aborted"). Letting the exception leave the transaction block and
     * handling it here rolls back first, then answers.
     *
     * It also covers every write verb at once — vanilla and per-subtype, and any added later —
     * where a per-handler wrapper is six edits that a seventh handler silently misses.
     *
     * The classification is the same algorithm as runtime-ts's `constraint-errors.ts`, C#'s
     * and Java's `ConstraintErrors`: codes first, constraint-name vocabulary as fallback, 409
     * for referential/uniqueness conflicts with existing state and 400 for a value the request
     * got wrong. It is emitted INLINE rather than imported, because a generated Kotlin
     * controller carries no compile-time MetaObjects dependency — the same reason this port
     * emits its filter parser inline instead of calling a shared runtime one.
     *
     * An unrecognised throwable is RETHROWN, so the operator keeps the full diagnostic and the
     * caller gets a plain 500 carrying none of it.
     */
    private fun StringBuilder.appendConstraintHandler() {
        append("\n")
        append("    /**\n")
        append("     * A database constraint violation is a CLIENT error, not a 500: the\n")
        append("     * identity.reference / identity.secondary that declare these constraints are the\n")
        append("     * same metadata this controller already validates against. Anything else is\n")
        append("     * rethrown, so the operator keeps the diagnostic and the caller gets none of it.\n")
        append("     */\n")
        // java.sql.SQLException TOO, not RuntimeException alone: Exposed raises a violation as
        // ExposedSQLException, which extends the CHECKED java.sql.SQLException, so a handler for
        // RuntimeException never matched and Spring answered every conflict with a 500.
        append("    @ExceptionHandler(RuntimeException::class, java.sql.SQLException::class)\n")
        append("    fun handleConstraintViolation(e: Exception): ResponseEntity<Any> {\n")
        // Depth-bounded and self-reference-guarded: a wrapper whose cause is itself is legal.
        // SQLState is read via the JDK's own java.sql.SQLException (FQN inline — the #179 guard
        // forbids surfacing an un-imported type), so no driver is referenced.
        append("        val text = generateSequence<Throwable>(e) { if (it.cause === it) null else it.cause }\n")
        append("            .take(8)\n")
        append("            .flatMap { t -> sequenceOf((t as? java.sql.SQLException)?.sqlState, t.message) }\n")
        append("            .filterNotNull()\n")
        append("            .joinToString(\" \")\n")
        append("            .uppercase()\n")
        append("        val kind = when {\n")
        append("            \"23503\" in text || \"FOREIGN KEY\" in text || \"SQLITE_CONSTRAINT_FOREIGNKEY\" in text -> \"foreign_key\"\n")
        append("            \"23505\" in text || \"UNIQUE CONSTRAINT\" in text || \"SQLITE_CONSTRAINT_UNIQUE\" in text -> \"unique\"\n")
        append("            \"23514\" in text || \"CHECK CONSTRAINT\" in text || \"SQLITE_CONSTRAINT_CHECK\" in text -> \"check\"\n")
        append("            \"23502\" in text || \"NOT NULL\" in text || \"SQLITE_CONSTRAINT_NOTNULL\" in text -> \"not_null\"\n")
        append("            else -> throw e\n")
        append("        }\n")
        append("        val status = if (kind == \"foreign_key\" || kind == \"unique\") HttpStatus.CONFLICT else HttpStatus.BAD_REQUEST\n")
        append("        return ResponseEntity.status(status).body(mapOf(\"error\" to \"constraint_violation\", \"constraint\" to kind) as Any)\n")
        append("    }\n\n")
    }

    /** Capitalize the first char (method-name suffix from a discriminator value). */
    private fun capitalizeFirst(s: String): String =
        if (s.isEmpty()) s else s[0].uppercaseChar() + s.substring(1)

    /**
     * Emit the three-piece FR-009 filter pipeline (data class + parse function +
     * Exposed dispatch function) into [out]. The dispatcher uses
     * {@code SqlExpressionBuilder.{eq,less,greater,inList,like}} extension functions
     * — these resolve against the generated {@code <Entity>Table}'s typed
     * {@code Column<T>} members so each per-field arm is type-safe at compile time.
     *
     * <p>[scalarFields] is the {@code (name, subType)} pair list filtered to scalar
     * columns (no [ObjectField]). The subtype drives:
     * <ul>
     *   <li>which value-coercion path runs in {@code parse<Entity>Filter}
     *       (string passthrough vs {@code Long.parseLong} vs {@code Timestamp.valueOf}
     *       vs {@code Boolean} parse, etc.);</li>
     *   <li>the dispatch arm shape in {@code <Entity>WhereOp} (a {@code Long} field
     *       handles {@code gt/gte/lt/lte} via Exposed's overload-on-T comparison
     *       extensions; a {@code String} field only handles {@code like}).</li>
     * </ul>
     */
    protected open fun emitFilterPipeline(
        out: StringBuilder,
        shortName: String,
        tableObjectName: String,
        allowlistName: String,
        scalarFields: List<ScalarFieldSpec>,
    ) {
        // Cross-port cap on `in`-list size — a larger list is rejected with the
        // `filter.in_too_large` envelope, matching the TS runtime-ts parser's
        // DEFAULT_MAX_IN_LIST. Emitted as a file-private const so parse<Entity>Filter
        // can reference it unqualified.
        out.append("/** GENERATED — cross-port cap on `in`-list size (matches TS DEFAULT_MAX_IN_LIST). */\n")
        out.append("private const val MAX_IN_LIST = 100\n\n")

        out.append("/** GENERATED — single parsed + validated FR-009 filter predicate. */\n")
        out.append("private data class ${shortName}FilterPredicate(val field: String, val op: String, val value: Any?)\n\n")

        out.append("/** GENERATED — parse outcome: predicates, or a cross-port error envelope key + the field it rejected. */\n")
        // `field` is non-null exactly when `error` is — every cross-port filter
        // envelope names the field it rejected, so the controller can put it
        // straight into the 400 body.
        out.append("private data class ${shortName}FilterResult(val predicates: List<${shortName}FilterPredicate>, val error: String?, val field: String? = null)\n\n")

        // Parser — walks the RAW query string (not Spring's decoded parameter map) and
        // matches each filter[<f>][<op>]=<v> key against the per-entity FIELDS +
        // OPS_BY_FIELD allowlist. coerce<X>Value() lookups own the per-subtype value
        // coercion. Raw, because Tomcat DROPS a parameter whose value holds a malformed
        // escape ("Character decoding failed ... has been ignored") — so a browser's
        // `?filter[name][like]=A%` reached the map without its filter and the list came
        // back unfiltered with a 200. Same input as the Java port's FilterParser.parse.
        out.append("/**\n")
        out.append(" * GENERATED — decode one query component, keeping a malformed escape as written:\n")
        out.append(" * {@code %XX} is a byte (runs decode as UTF-8), {@code +} is a space, and a {@code %}\n")
        out.append(" * not followed by two hex digits stays a literal {@code %} — what the TypeScript, C#\n")
        out.append(" * and Python servers do, where {@code URLDecoder} would throw.\n")
        out.append(" */\n")
        out.append("private fun decodeQueryComponent(raw: String): String {\n")
        out.append("    if ('%' !in raw && '+' !in raw) return raw\n")
        out.append("    val out = StringBuilder(raw.length)\n")
        out.append("    val bytes = ByteArrayOutputStream()\n")
        out.append("    var i = 0\n")
        out.append("    while (i < raw.length) {\n")
        out.append("        val c = raw[i]\n")
        out.append("        if (c == '%' && i + 2 < raw.length && raw[i + 1].isHexDigitAscii() && raw[i + 2].isHexDigitAscii()) {\n")
        out.append("            bytes.write(raw.substring(i + 1, i + 3).toInt(16))\n")
        out.append("            i += 3\n")
        out.append("            continue\n")
        out.append("        }\n")
        out.append("        if (bytes.size() > 0) { out.append(bytes.toString(StandardCharsets.UTF_8)); bytes.reset() }\n")
        out.append("        out.append(if (c == '+') ' ' else c)\n")
        out.append("        i++\n")
        out.append("    }\n")
        out.append("    if (bytes.size() > 0) out.append(bytes.toString(StandardCharsets.UTF_8))\n")
        out.append("    return out.toString()\n")
        out.append("}\n\n")
        out.append("private fun Char.isHexDigitAscii(): Boolean = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'\n\n")
        out.append("/**\n")
        out.append(" * GENERATED — parse the bracketed-qs FR-009 filter grammar from the raw query\n")
        out.append(" * string. Returns either a list of validated predicates or one of\n")
        out.append(" * the cross-port error envelope keys ({@code invalid_filter_field /\n")
        out.append(" * invalid_filter_op / invalid_filter_value / filter.in_too_large}) plus the\n")
        out.append(" * field each one is about.\n")
        out.append(" */\n")
        out.append("private fun parse${shortName}Filter(rawQuery: String?): ${shortName}FilterResult {\n")
        out.append("    val out = mutableListOf<${shortName}FilterPredicate>()\n")
        out.append("    for (pair in rawQuery.orEmpty().split('&')) {\n")
        out.append("        if (pair.isEmpty()) continue\n")
        out.append("        val eq = pair.indexOf('=')\n")
        out.append("        val rawKey = decodeQueryComponent(if (eq < 0) pair else pair.substring(0, eq))\n")
        out.append("        val value = decodeQueryComponent(if (eq < 0) \"\" else pair.substring(eq + 1))\n")
        out.append("        if (!rawKey.startsWith(\"filter[\")) continue\n")
        out.append("        val firstClose = rawKey.indexOf(']', 7)\n")
        out.append("        if (firstClose < 0) continue\n")
        out.append("        val field = rawKey.substring(7, firstClose)\n")
        out.append("        val rest = firstClose + 1\n")
        out.append("        val op: String = when {\n")
        out.append("            rest >= rawKey.length -> \"eq\"\n")
        out.append("            rawKey[rest] == '[' -> {\n")
        out.append("                val secondClose = rawKey.indexOf(']', rest + 1)\n")
        out.append("                if (secondClose < 0) continue\n")
        out.append("                rawKey.substring(rest + 1, secondClose)\n")
        out.append("            }\n")
        out.append("            else -> continue\n")
        out.append("        }\n")
        out.append("        if (field !in ${allowlistName}.FIELDS) return ${shortName}FilterResult(emptyList(), \"invalid_filter_field\", field)\n")
        out.append("        val ops = ${allowlistName}.OPS_BY_FIELD[field]\n")
        out.append("        if (ops == null || op !in ops) return ${shortName}FilterResult(emptyList(), \"invalid_filter_op\", field)\n")
        out.append("        val coerced = coerce${shortName}Value(field, op, value)\n")
        out.append("            ?: return ${shortName}FilterResult(emptyList(), \"invalid_filter_value\", field)\n")
        out.append("        val coercedValue = coerced.value\n")
        out.append("        if (op == \"in\" && coercedValue is List<*> && coercedValue.size > MAX_IN_LIST) {\n")
        out.append("            return ${shortName}FilterResult(emptyList(), \"filter.in_too_large\", field)\n")
        out.append("        }\n")
        out.append("        out.add(${shortName}FilterPredicate(field, op, coercedValue))\n")
        out.append("    }\n")
        out.append("    return ${shortName}FilterResult(out, null)\n")
        out.append("}\n\n")

        // Boxed result so we can distinguish "coercion failed" (null return) from
        // "valid null value" (Box(null)).
        out.append("/** Box result: null = invalid; Box(value) = coerced. Distinguishes failure from a legitimate null. */\n")
        out.append("private data class ${shortName}CoercedValue(val value: Any?)\n\n")

        // Value coercion — split by field then by op. `isNull` is universal (true/false).
        // `in` returns a List<T>. Scalar ops return the bare Kotlin type for that field.
        out.append("private fun coerce${shortName}Value(field: String, op: String, raw: String): ${shortName}CoercedValue? {\n")
        out.append("    if (op == \"isNull\") return when (raw) {\n")
        out.append("        \"true\" -> ${shortName}CoercedValue(true)\n")
        out.append("        \"false\" -> ${shortName}CoercedValue(false)\n")
        out.append("        else -> null\n")
        out.append("    }\n")
        out.append("    return when (field) {\n")
        for ((fname, subType) in scalarFields) {
            out.append("        \"$fname\" -> ")
            when (subType) {
                StringField.SUBTYPE_STRING, EnumField.SUBTYPE_ENUM ->
                    out.append("if (op == \"in\") ${shortName}CoercedValue(raw.split(\",\").map { it.trim() }) else ${shortName}CoercedValue(raw)\n")
                IntegerField.SUBTYPE_INT ->
                    out.append("coerce${shortName}Int(op, raw)\n")
                LongField.SUBTYPE_LONG, CurrencyField.SUBTYPE_CURRENCY ->
                    out.append("coerce${shortName}Long(op, raw)\n")
                FloatField.SUBTYPE_FLOAT, DoubleField.SUBTYPE_DOUBLE, DecimalField.SUBTYPE_DECIMAL ->
                    out.append("coerce${shortName}Double(op, raw)\n")
                BooleanField.SUBTYPE_BOOLEAN ->
                    out.append("coerce${shortName}Boolean(op, raw)\n")
                DateField.SUBTYPE_DATE ->
                    out.append("coerce${shortName}Date(op, raw)\n")
                TimestampField.SUBTYPE_TIMESTAMP ->
                    out.append("coerce${shortName}Timestamp(op, raw)\n")
                TimeField.SUBTYPE_TIME ->
                    out.append("coerce${shortName}Time(op, raw)\n")
                // uuid columns are Column<UUID> — the dispatch arm casts `p.value as UUID`,
                // so the coerced value MUST be a java.util.UUID (allowlist band:
                // eq/ne/in/isNull). A string passthrough would ClassCastException at runtime.
                UuidField.SUBTYPE_UUID ->
                    out.append("coerce${shortName}Uuid(op, raw)\n")
                else ->
                    // Unrecognized subtype — fall through to a string pass-through. This branch
                    // is unreachable for fields that are actually @filterable (those subtypes
                    // would have been rejected by the allowlist's op gating already) but covers
                    // the dispatch's `when` exhaustiveness.
                    out.append("if (op == \"in\") ${shortName}CoercedValue(raw.split(\",\").map { it.trim() }) else ${shortName}CoercedValue(raw)\n")
            }
        }
        out.append("        else -> null\n")
        out.append("    }\n")
        out.append("}\n\n")

        // Per-type coercion helpers. Each tolerates the `in` operator (returns List<T>)
        // and the scalar comparison ops (returns the bare type). Parse failure
        // → null → bubbled up as `invalid_filter_value`.
        emitTypedCoercer(out, shortName, "Long", "java.lang.Long.parseLong")
        emitTypedCoercer(out, shortName, "Int", "java.lang.Integer.parseInt")
        emitTypedCoercer(out, shortName, "Double", "java.lang.Double.parseDouble")
        emitTypedCoercer(out, shortName, "Date", "LocalDate.parse")
        emitTypedCoercer(out, shortName, "Time", "LocalTime.parse")
        // uuid coercer — emitted only when a uuid column exists (its `UUID.fromString`
        // needs the conditional java.util.UUID import) so uuid-free entities stay
        // byte-identical to pre-uuid output.
        if (scalarFields.any { it.subType == UuidField.SUBTYPE_UUID }) {
            emitTypedCoercer(out, shortName, "Uuid", "UUID.fromString")
        }
        // Timestamp coercer. ADR-0036 Wave 2: a default `field.timestamp` column is an
        // absolute `java.time.Instant` (its WHERE-arm casts `p.value as Instant`), so the
        // coerced value MUST be an Instant — coercing into LocalDateTime would ClassCastException
        // at the dispatch cast. The cross-port wire form is offset-less wall-clock
        // ('yyyy-MM-dd'T'HH:mm:ss', no zone); an offset-less value is interpreted as UTC
        // (append `Z`) before Instant.parse. The `@localTime:true` opt-out column is a naive
        // `LocalDateTime` and uses the zone-less formatter directly.
        // No timestamp field present → the coercer is dead scaffolding; keep its historical
        // LocalDateTime shape so Instant-free entities stay byte-identical (and don't
        // reference the un-imported Instant).
        val timestampElementType = scalarFields
            .firstOrNull { it.subType == TimestampField.SUBTYPE_TIMESTAMP }
            ?.elementType
            ?: "LocalDateTime"
        out.append("private val ${shortName}TimestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern(\"yyyy-MM-dd'T'HH:mm:ss\")\n\n")
        out.append("private fun coerce${shortName}Timestamp(op: String, raw: String): ${shortName}CoercedValue? {\n")
        if (timestampElementType == "Instant") {
            out.append("    val parse: (String) -> Instant? = { s ->\n")
            out.append("        val withZone = if (s.endsWith(\"Z\") || s.contains(\"+\")) s else s + \"Z\"\n")
            out.append("        runCatching { Instant.parse(withZone) }.getOrNull()\n")
            out.append("    }\n")
        } else {
            out.append("    val parse: (String) -> LocalDateTime? = { s -> runCatching { LocalDateTime.parse(s, ${shortName}TimestampFmt) }.getOrNull() }\n")
        }
        out.append("    if (op == \"in\") {\n")
        out.append("        val parts = raw.split(\",\").map { it.trim() }\n")
        out.append("        val list = parts.map { parse(it) ?: return null }\n")
        out.append("        return ${shortName}CoercedValue(list)\n")
        out.append("    }\n")
        out.append("    return ${shortName}CoercedValue(parse(raw) ?: return null)\n")
        out.append("}\n\n")
        // Boolean has its own non-throwing parse (when/else) — can't ride on
        // runCatching, which would convert a malformed input to a thrown
        // IllegalArgumentException then swallow it.
        out.append("private fun coerce${shortName}Boolean(op: String, raw: String): ${shortName}CoercedValue? {\n")
        out.append("    val parse: (String) -> Boolean? = { s -> when (s) { \"true\" -> true; \"false\" -> false; else -> null } }\n")
        out.append("    if (op == \"in\") {\n")
        out.append("        val parts = raw.split(\",\").map { it.trim() }\n")
        out.append("        val list = parts.map { parse(it) ?: return null }\n")
        out.append("        return ${shortName}CoercedValue(list)\n")
        out.append("    }\n")
        out.append("    return ${shortName}CoercedValue(parse(raw) ?: return null)\n")
        out.append("}\n\n")

        // Exposed `Op<Boolean>` dispatch. Per-field arm is inlined directly in
        // <Entity>WhereOp under a single `with(SqlExpressionBuilder)` block. This
        // keeps the column reference's compile-time Column<T> type and gives each
        // arm access to the typed eq/less/greater/inList/like extension functions
        // without needing context receivers (which would require an experimental
        // compiler flag).
        out.append("/**\n")
        out.append(" * GENERATED — fold a list of validated predicates into an Exposed\n")
        out.append(" * {@code Op<Boolean>}, AND-combining each predicate's column-op-value triple\n")
        out.append(" * against ${tableObjectName}. Returns null when [predicates] is empty so the\n")
        out.append(" * caller can elide the WHERE clause entirely.\n")
        out.append(" */\n")
        out.append("@Suppress(\"UNCHECKED_CAST\")\n")
        out.append("private fun ${shortName}WhereOp(predicates: List<${shortName}FilterPredicate>): Op<Boolean>? {\n")
        out.append("    if (predicates.isEmpty()) return null\n")
        out.append("    return with(SqlExpressionBuilder) {\n")
        out.append("        var combined: Op<Boolean>? = null\n")
        out.append("        for (p in predicates) {\n")
        out.append("            val op: Op<Boolean> = when (p.field) {\n")
        for ((fname, subType, elementType, intBackedEnumType) in scalarFields) {
            val isStringLike = (subType == StringField.SUBTYPE_STRING || subType == EnumField.SUBTYPE_ENUM)
            val isBoolean = (subType == BooleanField.SUBTYPE_BOOLEAN)
            emitPerFieldDispatchArm(
                out,
                tableObjectName = tableObjectName,
                fieldName = fname,
                elementType = elementType,
                isStringLike = isStringLike,
                isBoolean = isBoolean,
                isEnum = (subType == EnumField.SUBTYPE_ENUM),
                intBackedEnumType = intBackedEnumType,
            )
        }
        out.append("                else -> continue\n")
        out.append("            }\n")
        out.append("            combined = combined?.and(op) ?: op\n")
        out.append("        }\n")
        out.append("        combined\n")
        out.append("    }\n")
        out.append("}\n\n")
    }

    /**
     * Emit one per-field arm of the {@code <Entity>WhereOp}'s {@code when (p.field)}.
     * Each arm opens a nested {@code when (p.op)} on the 9 FR-009 ops, gated by
     * field subtype shape: string-like fields skip the comparison ops; booleans
     * skip everything but eq/isNull.
     */
    protected open fun emitPerFieldDispatchArm(
        out: StringBuilder,
        tableObjectName: String,
        fieldName: String,
        elementType: String,
        isStringLike: Boolean,
        isBoolean: Boolean,
        isEnum: Boolean,
        intBackedEnumType: String? = null,
    ) {
        // An INT-BACKED enum (@intValueMap) stores the member's declared INTEGER, so the CAST(col AS
        // text) comparison below — right for a string-backed enum — compared '30' to 'DELIVERED':
        // eq/in matched nothing and ne matched everything, all with a 200. Compare through the
        // enum-typed column instead, whose codec writes the declared integer. A symbol that names no
        // member matches no row (ne: every non-null row), as the string comparison did. The
        // int-backed band has no `like` (the allowlist omits it), so no arm is emitted for it.
        if (intBackedEnumType != null) {
            val member = "$intBackedEnumType.entries.firstOrNull { it.name == (p.value as String) }"
            val col = "${tableObjectName}.${fieldName}"
            out.append("                \"$fieldName\" -> when (p.op) {\n")
            out.append("                    \"eq\" -> $member?.let { $col eq it } ?: Op.FALSE\n")
            out.append("                    \"ne\" -> $member?.let { $col neq it } ?: $col.isNotNull()\n")
            out.append("                    \"in\" -> $col inList (p.value as List<String>).mapNotNull { s -> $intBackedEnumType.entries.firstOrNull { it.name == s } }\n")
            out.append("                    \"isNull\" -> if (p.value as Boolean) $col.isNull() else $col.isNotNull()\n")
            out.append("                    else -> throw IllegalStateException(\"unsupported op for $fieldName: \" + p.op)\n")
            out.append("                }\n")
            return
        }
        // Exposed's typed `Column<T>.eq(t: T)` / `.neq` / `.inList(Iterable<T>)` reject a
        // bare `Any?` — cast each predicate value to the column's element Kotlin type so
        // the comparison resolves. (Surfaced by the SP-F generated-controller HTTP lane:
        // `(p.value as Any?)` was an `Unresolved reference: eq` compile error.) The
        // coercer already produced a value of exactly this type; the cast is total.
        //
        // FR-009 enum columns (#179): an Exposed enum column is typed `Column<Enum>`, so a
        // String-valued predicate would not resolve `eq`/`like`. Filter it by its STORED STRING
        // via `CAST(col AS text)` (`.castTo<String>(TextColumnType())`) — matching every other
        // port's string-band enum-filter semantics — so eq/ne/in/like all compare Strings.
        // (`isNull` still checks the raw column's nullability.)
        val col = if (isEnum) "${tableObjectName}.${fieldName}.castTo<String>(TextColumnType())"
                  else "${tableObjectName}.${fieldName}"
        out.append("                \"$fieldName\" -> when (p.op) {\n")
        out.append("                    \"eq\" -> $col eq (p.value as $elementType)\n")
        if (!isBoolean) {
            out.append("                    \"ne\" -> $col neq (p.value as $elementType)\n")
        }
        if (!isStringLike && !isBoolean) {
            out.append("                    \"gt\" -> $col greater (p.value as $elementType)\n")
            out.append("                    \"gte\" -> $col greaterEq (p.value as $elementType)\n")
            out.append("                    \"lt\" -> $col less (p.value as $elementType)\n")
            out.append("                    \"lte\" -> $col lessEq (p.value as $elementType)\n")
        }
        if (!isBoolean) {
            out.append("                    \"in\" -> $col inList (p.value as List<$elementType>)\n")
        }
        if (isStringLike) {
            out.append("                    \"like\" -> $col like (p.value as String)\n")
        }
        out.append("                    \"isNull\" -> if (p.value as Boolean) ${tableObjectName}.${fieldName}.isNull() else ${tableObjectName}.${fieldName}.isNotNull()\n")
        out.append("                    else -> throw IllegalStateException(\"unsupported op for $fieldName: \" + p.op)\n")
        out.append("                }\n")
    }

    /**
     * Emit a generic-shaped value coercer (handles both scalar ops and `in`) named
     * {@code coerce<Entity><TypeSuffix>(op, raw)} that uses [parseFn] to parse a
     * single string into the target type. Parse failure → null → propagates as
     * {@code invalid_filter_value}.
     */
    protected open fun emitTypedCoercer(
        out: StringBuilder,
        shortName: String,
        typeSuffix: String,
        parseFn: String,
    ) {
        out.append("private fun coerce${shortName}${typeSuffix}(op: String, raw: String): ${shortName}CoercedValue? {\n")
        out.append("    val parse: (String) -> Any? = { s -> runCatching { $parseFn(s) }.getOrNull() }\n")
        out.append("    if (op == \"in\") {\n")
        out.append("        val parts = raw.split(\",\").map { it.trim() }\n")
        out.append("        val list = parts.map { parse(it) ?: return null }\n")
        out.append("        return ${shortName}CoercedValue(list)\n")
        out.append("    }\n")
        out.append("    return ${shortName}CoercedValue(parse(raw) ?: return null)\n")
        out.append("}\n\n")
    }

    /**
     * Emit one M:N traversal sub-resource: {@code GET /{id}/<relationName>} returning
     * the related target rows as the target's data class. Delegates the junction
     * traversal to the {@code <Source>Table.<queryFnName>(id)} Exposed join helper
     * (emitted by [KotlinRelationsGenerator] under that exact name — [queryFnName] defaults to
     * [KotlinM2mSupport.defaultQueryFnName], `<relationName>Query`, the only name a non-TPH
     * caller or a TPH base's own mount ever needs); maps each returned {@link ResultRow} to the
     * target data class inline (the target's per-controller {@code rowTo<Target>} mapper
     * is file-private, so the mapping is inlined here against the target's scalar fields).
     *
     * The target data class is referenced unqualified when it shares the source's package
     * (the common case), else fully package-qualified so the generated file compiles across
     * packages.
     */
    protected open fun emitM2mEndpoint(
        out: StringBuilder,
        sourcePkg: String,
        sourceShort: String,
        nav: KotlinM2mSupport.M2mNav,
        pkParamType: String,
        queryFnName: String = KotlinM2mSupport.defaultQueryFnName(nav.relationName),
    ) {
        val sourceTable = sourceShort + "Table"
        // FW-3: the data class rows are mapped into is the STORAGE object's type (`nav.targetType`
        // — e.g. `Auth`, the union type, when the declared target is a TPH subtype), never
        // `nav.targetShortName` (the DECLARED target's name, e.g. `BridgeAuth`) — a TPH subtype
        // has no data class of its own to reference.
        val targetType = if (nav.targetPackage == sourcePkg || nav.targetPackage.isEmpty()) {
            nav.targetType
        } else {
            nav.targetPackage + "." + nav.targetType
        }
        val symMarker = if (nav.symmetric) " (symmetric — union on read)" else ""
        out.append("\n")
        out.append("    /** M:N traversal: the ${nav.targetShortName} rows related to this $sourceShort through ${nav.junctionShortName}$symMarker. */\n")
        out.append("    @GetMapping(\"/{id}/${nav.relationName}\")\n")
        out.append("    fun ${nav.relationName}(@PathVariable id: $pkParamType): ResponseEntity<List<$targetType>> = transaction {\n")
        out.append("        val rows = $sourceTable.$queryFnName(id).map { row ->\n")
        out.append("            $targetType(\n")
        for (fname in nav.targetScalarFields) {
            out.append("                $fname = row[${nav.targetTableObj}.$fname],\n")
        }
        out.append("            )\n")
        out.append("        }\n")
        out.append("        ResponseEntity.ok(rows)\n")
        out.append("    }\n")
    }

    /**
     * FW-8 x FR-017 — emit one M:N traversal sub-resource SCOPED to a TPH subtype:
     * `GET /<seg>/{id}/<relationName>`. Stage 0 reads the source row's OWN discriminator column
     * and returns an EMPTY list (HTTP 200 — not 404, not the query below) when [id] does not name
     * a row of [discExpr]'s subtype, THEN delegates to [queryFnName] — the `<Base>Table.<fn>(id)`
     * Exposed helper [KotlinRelationsGenerator] emitted for [nav]'s exact shape. In the common
     * case that is the SAME helper every other mount of this relation NAME calls (the base's own
     * mount, or a sibling subtype's, when [nav] is inherited unchanged); when the calling subtype
     * instead SHADOWS the name with a genuinely different nav (own children shadow super on
     * `(type, name)`, ADR-0039), [queryFnName] names ITS OWN disambiguated helper — see
     * [KotlinM2mSupport.tphQueryFnNames]. Either way, the junction FK addresses the shared base
     * table and cannot itself tell the subtypes apart, so without the Stage-0 gate a sibling's id
     * would traverse it just as well and the `/<seg>` segment would be decorative.
     */
    protected open fun emitTphSubtypeM2mEndpoint(
        out: StringBuilder,
        sourcePkg: String,
        table: String,
        pkFieldName: String,
        discField: String,
        discExpr: String,
        seg: String,
        sfx: String,
        nav: KotlinM2mSupport.M2mNav,
        pkParamType: String,
        queryFnName: String = KotlinM2mSupport.defaultQueryFnName(nav.relationName),
    ) {
        val targetType = if (nav.targetPackage == sourcePkg || nav.targetPackage.isEmpty()) {
            nav.targetType
        } else {
            nav.targetPackage + "." + nav.targetType
        }
        val symMarker = if (nav.symmetric) " (symmetric — union on read)" else ""
        out.append("\n")
        out.append("    /** M:N traversal scoped to $discExpr: the ${nav.targetShortName} rows related to this $discExpr through ${nav.junctionShortName}$symMarker. Verifies id names a $discExpr row, returning [] (not the sibling's rows) when it does not. */\n")
        out.append("    @GetMapping(\"/$seg/{id}/${nav.relationName}\")\n")
        out.append("    fun ${nav.relationName}$sfx(@PathVariable id: $pkParamType): ResponseEntity<List<$targetType>> = transaction {\n")
        out.append("        if ($table.selectAll().where { ($table.$pkFieldName eq id) and ($table.$discField eq $discExpr) }.singleOrNull() == null) {\n")
        out.append("            return@transaction ResponseEntity.ok(emptyList<$targetType>())\n")
        out.append("        }\n")
        out.append("        val rows = $table.$queryFnName(id).map { row ->\n")
        out.append("            $targetType(\n")
        for (fname in nav.targetScalarFields) {
            out.append("                $fname = row[${nav.targetTableObj}.$fname],\n")
        }
        out.append("            )\n")
        out.append("        }\n")
        out.append("        ResponseEntity.ok(rows)\n")
        out.append("    }\n")
    }

    /**
     * A scalar (non-[ObjectField]) field's filter-dispatch metadata. [subType] drives the
     * arm shape + value-coercion path; [elementType] is the Exposed column's element Kotlin
     * type name, used to cast each predicate value in the `Column<T>.eq/neq/inList` calls
     * (Exposed's typed comparison ops reject a bare `Any?`).
     */
    /**
     * [intBackedEnumType] is the fully-qualified Kotlin enum class of an INT-BACKED `field.enum`
     * (`@intValueMap`) — null for every other field, including a string-backed enum.
     */
    protected data class ScalarFieldSpec(
        val name: String,
        val subType: String?,
        val elementType: String,
        val intBackedEnumType: String? = null,
    )

    /** The enum class an int-backed [field] maps to, or null — see [ScalarFieldSpec]. */
    private fun intBackedEnumType(field: com.metaobjects.field.MetaField<*>, owner: MetaObject): String? =
        if (KotlinGenUtil.isIntBackedEnum(field)) KotlinTypeMapper.enumTypeName(field, owner)?.canonicalName else null

    /**
     * The element Kotlin type the generated `<Entity>Table`'s column for [field] holds —
     * the cast target for the eq/ne/in predicate value. For scalar fields this is the same
     * simple type name the DTO property uses ([KotlinTypeMapper.kotlinTypeName]); for an
     * [EnumField] it is `String`, since the column is filtered by its stored string
     * (a CAST-to-text — see [emitPerFieldDispatchArm]).
     */
    /**
     * The Kotlin simple-name type of [entity]'s by-id route parameter — the PK FIELD's
     * own type via [KotlinTypeMapper.kotlinTypeName] (uuid → `UUID`, long → `Long`,
     * int → `Int`, string → `String`), so `@PathVariable id` matches the Exposed
     * `Column<T>` it is compared against. Falls back to `Long` (the historical default)
     * when the field can't be resolved or mapped — the same lossy-tolerant policy as
     * [KotlinRelationsGenerator.primaryKeyKotlinType].
     */
    protected fun primaryKeyParamType(entity: MetaObject, pkFieldName: String): String {
        // ADR-0039: resolving field lookup (the PK field may be inherited via extends).
        val pkField = entity.metaFields.firstOrNull { it.name == pkFieldName } ?: return "Long"
        return runCatching { KotlinTypeMapper.kotlinTypeName(pkField) }
            .map { tn -> (tn as? com.squareup.kotlinpoet.ClassName)?.simpleName ?: tn.toString() }
            .getOrDefault("Long")
    }

    private fun columnElementType(field: com.metaobjects.field.MetaField<*>): String {
        // FR-009 (#179): an enum column is filtered by its stored string (compared against a
        // `CAST(col AS text)` in the WHERE arm — see emitPerFieldDispatchArm), so the predicate
        // VALUE type is String. The coercer already produces String / List<String> for enums.
        if (field is EnumField) return "String"
        return KotlinTypeMapper.kotlinTypeName(field).let { tn ->
            (tn as? com.squareup.kotlinpoet.ClassName)?.simpleName ?: tn.toString()
        }
    }

    /** Read the `@objectRef` attr off a value-object [field] (resolving); null when absent. */
    private fun readObjectRef(field: ObjectField): String? {
        if (!field.hasMetaAttr(ObjectField.ATTR_OBJECTREF, true)) return null
        return runCatching { field.getMetaAttr(ObjectField.ATTR_OBJECTREF, true).valueAsString }.getOrNull()
    }

    /**
     * True iff [field] is a `field.object` stored as a single jsonb column (`@storage` != flattened,
     * the default). The Exposed table emits one `Table.<field>` column only for these — a flattened
     * object field is materialised as per-subfield columns, so the controller must NOT reference
     * `Table.<field>` for it (it is skipped, defaulting to null in the data class). Mirrors
     * [KotlinExposedTableGenerator]'s `readStorage != STORAGE_FLATTENED` column check.
     */
    private fun isJsonbObjectColumn(field: ObjectField): Boolean {
        if (!field.hasMetaAttr(ObjectField.ATTR_STORAGE, true)) return true   // default = single jsonb column
        val storage = runCatching { field.getMetaAttr(ObjectField.ATTR_STORAGE, true).valueAsString }.getOrNull()
        return !STORAGE_FLATTENED.equals(storage?.trim(), ignoreCase = true)
    }

    /**
     * The fully-qualified Kotlin type of the value object a [field] `field.object` references
     * (e.g. `acme.store.Marker`) — the Jackson bind target for the PATCH TypeReference. Emitted
     * fully-qualified so the generated controller needs no extra import (mirrors the Exposed
     * column codec in [KotlinExposedTableGenerator]). Falls back to a Jackson `JsonNode` when the
     * `@objectRef` cannot resolve (defensive — the loader gates the attr's presence).
     */
    private fun voElementTypeFqn(field: ObjectField, loader: MetaDataLoader): String {
        val target = readObjectRef(field)?.let { KotlinGenUtil.resolveObjectByShortOrFqn(loader, it) }
        return target?.let { PackageMapping.toKotlin(it.name) }
            ?: "com.fasterxml.jackson.databind.JsonNode"
    }


    /**
     * F22 — emit the READ-ONLY controller for a view-only `object.projection`: GET list +
     * GET by id, with `POST` on the collection and `PATCH` / `PUT` / `DELETE` on the item
     * each answering `405 {"error": "method_not_allowed"}`.
     *
     * 405 and not 404: the resource plainly exists — the same path answers GET — and a 404
     * would tell a caller the collection is absent when it is merely not writable. The verbs
     * are mounted EXPLICITLY. They cannot be left to Spring, and they cannot be routed
     * through this port's `@ExceptionHandler`: Spring signals an unmatched verb with
     * `HttpRequestMethodNotSupportedException`, which extends `ServletException` and so is
     * never caught by the `@ExceptionHandler(RuntimeException::class)` the writable
     * controller carries. What Spring answers unaided is a 405 with an EMPTY body — a fifth
     * body shape on a wire the other four ports spell one way.
     *
     * A SEPARATE assembly rather than `if (writable)` branches through [emit]. That method
     * carries the FR-035 present-key patch bind, `@autoSet` stamping, the FR-037 frozen-field
     * strip, DTO validation and constraint classification — none of which a projection can
     * ever run. What the two genuinely share (the sort surface, the filter pipeline, rowTo,
     * list, get) they share by calling the same emitters.
     *
     * The item verbs follow the item GET: a projection's identity is OPTIONAL (ADR-0028),
     * and a keyless one mounts no `/{id}` read, so it refuses only the collection verb
     * rather than advertising an address it never serves.
     */
    protected open fun emitReadOnly(entity: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val readObj = KotlinNaming.tableObjectName(shortName)
        val routeBase = KotlinNaming.controllerPath(shortName)

        // ADR-0039: resolving — a projection's identity.primary typically EXTENDS the base
        // entity's, and an own-only read would silently drop GET /{id} from the controller.
        val primary = entity.getIdentities(true)
            .filterIsInstance<MetaIdentity>()
            .firstOrNull { it.isPrimary }
        val hasItem = RestSurfaceGate.hasItemRoute(entity)
        val pkFieldName = primary?.fields?.firstOrNull() ?: DEFAULT_PK_FIELD
        val pkParamType = primaryKeyParamType(entity, pkFieldName)

        val sortFields = entity.metaFields
            .filterNot { it is ObjectField || it is MapField || KotlinTypeMapper.isJsonbOpenBag(it) }
            .map { it.name }
        val scalarFields: List<ScalarFieldSpec> = entity.metaFields
            .filterNot { it is ObjectField || it is MapField || KotlinTypeMapper.isJsonbOpenBag(it) }
            .map { ScalarFieldSpec(it.name, it.subType, columnElementType(it)) }
        val allowlistName = "${shortName}FilterAllowlist"

        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            // The same import set the writable controller emits, MINUS everything only a
            // write path reaches (insert / update / deleteWhere, the Jackson patch bind, the
            // Validator, DeleteMapping / RequestBody, and the constraint @ExceptionHandler).
            // Kept in the same order so a reader diffing the two files sees only the absences.
            append("import org.jetbrains.exposed.sql.Op\n")
            append("import org.jetbrains.exposed.sql.SortOrder\n")
            append("import org.jetbrains.exposed.sql.ResultRow\n")
            append("import org.jetbrains.exposed.sql.SqlExpressionBuilder\n")
            append("import org.jetbrains.exposed.sql.and\n")
            append("import org.jetbrains.exposed.sql.selectAll\n")
            append("import org.jetbrains.exposed.sql.transactions.transaction\n")
            append("import org.springframework.http.HttpStatus\n")
            append("import org.springframework.http.ResponseEntity\n")
            append("import org.springframework.web.bind.annotation.GetMapping\n")
            if (hasItem) {
                append("import org.springframework.web.bind.annotation.PathVariable\n")
            }
            append("import org.springframework.web.bind.annotation.PostMapping\n")
            append("import org.springframework.web.bind.annotation.RequestMapping\n")
            if (hasItem) {
                append("import org.springframework.web.bind.annotation.RequestMethod\n")
            }
            append("import org.springframework.web.bind.annotation.RequestParam\n")
            append("import org.springframework.web.bind.annotation.RestController\n")
            append("import jakarta.servlet.http.HttpServletRequest\n")
            append("import java.io.ByteArrayOutputStream\n")
            append("import java.nio.charset.StandardCharsets\n")
            append("import java.sql.Timestamp\n")
            if (scalarFields.any { it.elementType == "Instant" }) {
                append("import java.time.Instant\n")
            }
            if (pkParamType == "UUID" || scalarFields.any { it.elementType == "UUID" }) {
                append("import java.util.UUID\n")
            }
            if (scalarFields.any { it.subType == EnumField.SUBTYPE_ENUM }) {
                append("import org.jetbrains.exposed.sql.TextColumnType\n")
                append("import org.jetbrains.exposed.sql.castTo\n")
            }
            append("import java.time.LocalDate\n")
            append("import java.time.LocalDateTime\n")
            append("import java.time.LocalTime\n")
            append("import java.time.format.DateTimeFormatter\n")
            append("\n")

            appendSortSurface(this, shortName, entity, sortFields)
            emitFilterPipeline(this, shortName, readObj, allowlistName, scalarFields)
            appendRowToMapper(this, shortName, entity, readObj)

            append("/** GENERATED — READ-ONLY REST controller for the ${shortName} projection. */\n")
            append("@RestController\n")
            append("@RequestMapping(\"$routeBase\")\n")
            // No constructor at all: nothing here binds a request body, so injecting an
            // ObjectMapper or a Validator would make a consumer wire beans this controller
            // can never use.
            append("class ${shortName}Controller {\n\n")

            appendListHandler(this, shortName, readObj, sortFields)
            if (hasItem) {
                appendGetHandler(this, shortName, readObj, pkFieldName, pkParamType)
            }

            append("    @PostMapping\n")
            append("    fun create(): ResponseEntity<Any> = methodNotAllowed()\n\n")
            if (hasItem) {
                // One mapping for all three item verbs: the bodies are identical. Stacking
                // @PatchMapping + @PutMapping on one method does NOT register both in Spring
                // MVC (see emit()), so the method= list is the form that works. The path
                // variable is deliberately unbound — the row is never read.
                append("    @RequestMapping(value = [\"/{id}\"], method = [RequestMethod.PATCH, RequestMethod.PUT, RequestMethod.DELETE])\n")
                append("    fun rejectItemWrite(): ResponseEntity<Any> = methodNotAllowed()\n\n")
            }
            // `message` is free prose and deliberately outside the asserted contract, so this
            // port spells it once rather than threading the verb through every handler.
            append("    private fun methodNotAllowed(): ResponseEntity<Any> =\n")
            append("        ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(\n")
            append("            mapOf(\n")
            append("                \"error\" to \"method_not_allowed\",\n")
            append("                \"message\" to \"writes are not supported on a projection (read-only).\",\n")
            append("            ) as Any\n")
            append("        )\n")
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/'))
            .resolve(KotlinNaming.controllerName(shortName) + ".kt")
        GeneratedFileWriter.write(outFile, source)
    }

    // -----------------------------------------------------------------------
    // Emitters shared by the WRITABLE controller (emit) and the READ-ONLY one
    // (emitReadOnly). Extracted verbatim from emit(), split at exactly the points that
    // keep its output byte-identical — the snapshot fixtures under
    // src/test/resources/snapshots/ are the proof of that.
    //
    // A read-only projection serves the same list + get + sort + rowTo surface a table
    // entity does, and the F22 change must not be able to reword one of them and not the
    // other. emitTph() keeps its own copies: a TPH base's list and get are
    // DISCRIMINATOR-scoped, so they are not the same emitter wearing a flag.
    // -----------------------------------------------------------------------

    /** The file-level sort allowlist + declared-default map + `parse<Entity>Sort` helper. */
    private fun appendSortSurface(
        sb: StringBuilder, shortName: String, entity: MetaObject, sortFields: List<String>
    ) = with(sb) {
        // Sort allowlist — static set; unknown fields → 400. Emitted at file level so it
        // remains accessible to the handler functions without polluting the controller's
        // surface.
        append("/** GENERATED — sort allowlist for ${shortName} (cross-port API contract). */\n")
        append("private val ${shortName}SortAllowlist = setOf(\n")
        for (field in sortFields) {
            append("    \"$field\",\n")
        }
        append(")\n\n")
        appendSortDefaultOrders(this, shortName, entity, sortFields)

        // parseSort: returns (field, asc|desc) or null for malformed/disallowed input.
        // Returning null lets the handler emit the 400 envelope itself rather than
        // throwing — cleaner separation. Inlined per-entity so the allowlist closes
        // over the right set without a runtime parameter.
        append("private fun parse${shortName}Sort(raw: String): Pair<String, SortOrder>? {\n")
        append("    val parts = raw.split(\":\", limit = 2)\n")
        append("    val field = parts.getOrNull(0) ?: return null\n")
        append("    if (field !in ${shortName}SortAllowlist) return null\n")
        // `?sort=field` with no `:order` takes the field's DECLARED @sortableDefaultOrder.
        // The "asc" fallback stays at the READ, one place per port.
        append("    val dirRaw = parts.getOrNull(1)?.lowercase()\n")
        append("        ?: ${shortName}SortDefaultOrder[field] ?: \"asc\"\n")
        append("    val dir = when (dirRaw) {\n")
        append("        \"asc\" -> SortOrder.ASC\n")
        append("        \"desc\" -> SortOrder.DESC\n")
        append("        else -> return null\n")
        append("    }\n")
        append("    return field to dir\n")
        append("}\n\n")
    }

    /** `rowTo<Entity>` — an Exposed ResultRow mapped to the generated data class. */
    private fun appendRowToMapper(
        sb: StringBuilder, shortName: String, entity: MetaObject, readObj: String
    ) = with(sb) {
        // rowTo<Entity>: ResultRow → data class. Program D: a field.object value-object jsonb
        // column IS read here — the Exposed Column<VO> codec (the shared Jackson metaJsonbMapper)
        // already decodes the jsonb text to the VO record / List<VO>, so `row[Table.col]` yields
        // the typed value the data-class property expects. MapField (dict-of-VO) stays skipped
        // (staged out). The `field.string @dbColumnType=jsonb` open bag is a StringField, so it is
        // read here too (its column decodes to a kotlinx JsonElement).
        // #214: reads route to `readObj` (the view for a write-through entity), which carries the
        // DERIVED columns — so a derived scalar field (a StringField / etc.) maps here too.
        append("/** GENERATED — map an Exposed ResultRow to the ${shortName} data class. */\n")
        append("private fun rowTo${shortName}(row: ResultRow): ${shortName} = ${shortName}(\n")
        for (field in entity.metaFields) {
            // MapField (staged out) and a flattened object field (materialised as per-subfield
            // columns, no single `Table.<field>`) are skipped — the data class defaults them.
            if (field is MapField || (field is ObjectField && !isJsonbObjectColumn(field))) continue
            append("    ${field.name} = row[${readObj}.${field.name}],\n")
        }
        append(")\n\n")
    }

    /** GET (list) — pagination + sort + withCount + the FR-009 filter operators. */
    private fun appendListHandler(
        sb: StringBuilder, shortName: String, readObj: String, sortFields: List<String>
    ) = with(sb) {
        // List handler — pagination + sort + withCount + FR-009 filter operators.
        //
        // The filter reads `request.queryString` raw rather than Spring's parameter map:
        // Tomcat drops a parameter holding a malformed escape, which silently unfiltered
        // the list (see parse<Entity>Filter).
        append("    @GetMapping\n")
        append("    fun list(\n")
        append("        @RequestParam(required = false) limit: Int?,\n")
        append("        @RequestParam(required = false) offset: Int?,\n")
        append("        @RequestParam(required = false) sort: String?,\n")
        append("        @RequestParam(required = false, name = \"withCount\") withCount: Int?,\n")
        append("        request: HttpServletRequest,\n")
        append("    ): ResponseEntity<Any> = transaction {\n")
        append("        // FR-009 filter operators — short-circuit 400 on invalid field/op/value.\n")
        append("        val filterResult = parse${shortName}Filter(request.queryString)\n")
        append("        if (filterResult.error != null) {\n")
        append("            return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to filterResult.error, \"field\" to filterResult.field) as Any)\n")
        append("        }\n")
        append("        val whereOp = ${shortName}WhereOp(filterResult.predicates)\n")
        append("        var q = if (whereOp != null) ${readObj}.selectAll().where { whereOp } else ${readObj}.selectAll()\n")
        append("        if (sort != null) {\n")
        append("            val parsed = parse${shortName}Sort(sort)\n")
        append("                ?: return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"invalid_sort\", \"field\" to sort.substringBefore(':')) as Any)\n")
        append("            val (field, dir) = parsed\n")
        append("            q = q.orderBy(${sortColumnExpr(readObj, shortName, sortFields)} to dir)\n")
        append("        }\n")
        append("        val total: Long = if (withCount == 1) q.count() else -1L\n")
        append("        val effectiveLimit = limit ?: 50\n")
        append("        val effectiveOffset = (offset ?: 0).toLong()\n")
        append("        val rows = q.limit(effectiveLimit, effectiveOffset).map { rowTo${shortName}(it) }\n")
        append("        if (withCount == 1) ResponseEntity.ok(mapOf(\"rows\" to rows, \"total\" to total) as Any)\n")
        append("        else ResponseEntity.ok(rows as Any)\n")
        append("    }\n\n")
    }

    /** GET /{id} — single row by primary key, 404 envelope on a miss. */
    private fun appendGetHandler(
        sb: StringBuilder, shortName: String, readObj: String, pkFieldName: String, pkParamType: String
    ) = with(sb) {
        // GET /{id}
        append("    @GetMapping(\"/{id}\")\n")
        append("    fun get(@PathVariable id: $pkParamType): ResponseEntity<Any> = transaction {\n")
        append("        val row = ${readObj}.selectAll().where { ${readObj}.${pkFieldName} eq id }.singleOrNull()\n")
        append("            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
        append("        ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
        append("    }\n\n")
    }

    /** A single-field `identity.primary @generation: uuid` key — the one the create handler mints. */
    private fun uuidGeneratedPk(entity: MetaObject, pkFieldName: String): Boolean {
        val pk = entity.primaryIdentity ?: return false
        return pk.isUuid && pk.fields.singleOrNull() == pkFieldName
    }

    private companion object {
        /** Default primary-key field name when the entity declares no identity.primary. */
        const val DEFAULT_PK_FIELD = "id"

        /** `@storage:flattened` on a field.object — the one storage mode the controller excludes
         *  (materialised as per-subfield columns, not a single jsonb `Table.<field>`). Cross-language
         *  @storage vocabulary; mirrors KotlinExposedTableGenerator's constant. */
        const val STORAGE_FLATTENED = "flattened"

        @JvmStatic
        val LOG = LoggerFactory.getLogger(KotlinSpringControllerGenerator::class.java)
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun <T : GeneratorIOWriter<*>?> getSingleWriter(
        loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?
    ): T? = null
    override fun <T : GeneratorIOWriter<*>?> getFinalWriter(
        loader: MetaDataLoader?, out: OutputStream?
    ): T? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).first.replace('.', '/')
    override fun getSingleOutputFilename(md: MetaObject): String =
        KotlinNaming.controllerName(PackageMapping.splitFqn(md.name).second) + ".kt"
}

/**
 * Emit the per-entity `<Entity>SortDefaultOrder` map the generated `parse<Entity>Sort` reads
 * for a `?sort=field` carrying no `:order`.
 *
 * Carries DECLARED orders only — a field with no `@sortableDefaultOrder` is absent and the
 * generated read supplies `"asc"`. That split matches the other four ports: one place per
 * port spells the fallback, so no port can drift by baking a different default into its map.
 *
 * ADR-0039: resolving accessor — `@sortableDefaultOrder` may be inherited via `extends`.
 */
private fun appendSortDefaultOrders(
    sb: StringBuilder,
    shortName: String,
    owner: MetaObject,
    sortFields: List<String>,
) {
    val declared = sortFields.mapNotNull { name ->
        val f = owner.metaFields.firstOrNull { it.name == name } ?: return@mapNotNull null
        if (!f.hasMetaAttr(MetaField.ATTR_SORTABLE_DEFAULT_ORDER)) return@mapNotNull null
        val v = f.getMetaAttr(MetaField.ATTR_SORTABLE_DEFAULT_ORDER).valueAsString
        if (v == "asc" || v == "desc") name to v else null
    }
    sb.append("/** GENERATED — declared @sortableDefaultOrder per field for $shortName. */\n")
    // The type is STATED, not inferred. `mapOf()` with zero pairs leaves K and V with
    // nothing to resolve and Kotlin refuses to compile — and the common case is zero
    // pairs, because most models declare no @sortableDefaultOrder at all. A text-golden
    // snapshot cannot see this: it pins the emitted characters, and `mapOf(\n)` is a
    // perfectly ordinary-looking string. Only compiling the output catches it, which is
    // what the integration lane is for.
    sb.append("private val ${shortName}SortDefaultOrder: Map<String, String> = mapOf(\n")
    for ((name, v) in declared) sb.append("    \"$name\" to \"$v\",\n")
    sb.append(")\n\n")
}

/**
 * The generated Kotlin expression resolving a sort FIELD NAME to its Exposed column.
 *
 * Deliberately NOT `$table.columns.first { it.name == field }`. Exposed's `Column.name` is
 * the PHYSICAL SQL identifier — `created_at` under the default snake_case strategy — while
 * the query string carries the METADATA field name, `createdAt`. Comparing the two threw
 * `NoSuchElementException: Collection contains no element matching the predicate` out of the
 * request handler, i.e. an HTTP 500 on `?sort=<field>` for every multi-word sortable field.
 * The api-contract corpus never caught it because its only sort scenario sorted on `name`,
 * a single word where both spellings coincide.
 *
 * The dispatch pairs each name with `$table.<prop>` using the SAME
 * [KotlinNaming.safeColumnProperty] the table generator uses to emit that property, so the
 * two cannot drift, and `@column` overrides need no special case — the reference is the
 * property itself, never a name string.
 *
 * The `else` arm is unreachable by construction: the sort allowlist `parse${shortName}Sort`
 * gates against is built from this same `sortFields` list. It throws rather than returning
 * `null` so a future divergence between the two surfaces a generator bug instead of
 * answering a valid request with a 400.
 */
private fun sortColumnExpr(tableVar: String, shortName: String, sortFields: List<String>): String {
    if (sortFields.isEmpty()) return "error(\"$shortName has no sortable fields\")"
    val sb = StringBuilder("when (field) {\n")
    for (name in sortFields) {
        val prop = KotlinNaming.safeColumnProperty(name)
        sb.append("                \"").append(name).append("\" -> ")
          .append(tableVar).append(".").append(prop).append("\n")
    }
    sb.append("                else -> error(\"").append(shortName)
      .append(": sort field has no column (generator drift): \" + field)\n")
    sb.append("            }")
    return sb.toString()
}

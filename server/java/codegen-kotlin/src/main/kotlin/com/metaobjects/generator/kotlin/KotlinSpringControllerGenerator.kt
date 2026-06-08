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
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimeField
import com.metaobjects.field.TimestampField
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
 *   <li>Routes: {@code /api/<entity-plural-lowercase>} (e.g. {@code /api/authors}).</li>
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
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            // Abstract entities are inheritance scaffolding — never emit a CRUD controller.
            if (KotlinGenUtil.isAbstractEntity(entity)) continue
            // FR-017 TPH: a subtype is folded into its base's single table + base controller (it
            // also carries no own source.rdb, so the guard below would skip it too).
            if (KotlinTphPlan.isTphSubtype(entity)) continue
            val sourceRdb = entity.children.filterIsInstance<RdbSource>().firstOrNull() ?: continue
            val kind = sourceRdb.effectiveKind
            // Only writable tables get a CRUD controller. View / materializedView are
            // read-only (would need a different controller shape — list + get only);
            // storedProc is handled by KotlinStoredProcGenerator; tableFunction has no
            // dedicated controller story today.
            if (kind != MetaSource.KIND_TABLE) {
                when (kind) {
                    MetaSource.KIND_VIEW, MetaSource.KIND_MATERIALIZED_VIEW -> {
                        LOG.debug(
                            "skipping controller for {} — source.rdb @kind='{}' is read-only",
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
            // FR-017 TPH: a discriminator base emits ONE controller mounting the polymorphic
            // collection routes plus a full per-subtype CRUD set scoped by the discriminator.
            val tph = KotlinTphPlan.planFor(entity, loader)
            if (tph != null) emitTph(entity, tph, outRoot) else emit(entity, outRoot, loader)
        }
    }

    protected open fun emit(entity: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val tableObjectName = shortName + "Table"
        val routePath = pluralLowercase(shortName)
        val routeBase = "/api/$routePath"

        // Primary key: single-field PKs only for v1. Composite PKs are uncommon for HTTP
        // CRUD (you'd need a URL grammar for composite ids — out of scope). When the
        // entity lacks a single-field PK, skip get/update/delete (list+create still work)
        // — but for v1 we just default to "id" : Long for the route signatures since the
        // canonical Author/BaseEntity convention is a single Long PK.
        val primary = entity.children
            .filterIsInstance<MetaIdentity>()
            .firstOrNull { it.isPrimary }
        val pkFieldName = primary?.fields?.firstOrNull() ?: DEFAULT_PK_FIELD

        // Sort allowlist: every scalar field is sortable. Skip ObjectField (no SQL column
        // surface on the Exposed Table; @storage controls a separate column shape).
        val sortFields = entity.metaFields
            .filterNot { it is ObjectField }
            .map { it.name }

        // Per-field dispatch map (filter dispatch); only used inside the generated
        // file. Each entry carries the field name, its subtype (drives the dispatch arm
        // shape + value-coercion path) and the Exposed column's element Kotlin type
        // (drives the eq/ne/in value cast — Exposed's typed `Column<T>.eq` rejects a bare
        // `Any?`, so each predicate value is cast to the column's element type).
        val scalarFields: List<ScalarFieldSpec> = entity.metaFields
            .filterNot { it is ObjectField }
            .map { ScalarFieldSpec(it.name, it.subType, columnElementType(it)) }

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
            append("import jakarta.validation.Valid\n")
            append("import org.springframework.http.HttpStatus\n")
            append("import org.springframework.http.ResponseEntity\n")
            append("import org.springframework.web.bind.annotation.DeleteMapping\n")
            append("import org.springframework.web.bind.annotation.GetMapping\n")
            append("import org.springframework.web.bind.annotation.PathVariable\n")
            append("import org.springframework.web.bind.annotation.PostMapping\n")
            append("import org.springframework.web.bind.annotation.RequestBody\n")
            append("import org.springframework.web.bind.annotation.RequestMapping\n")
            append("import org.springframework.web.bind.annotation.RequestMethod\n")
            append("import org.springframework.web.bind.annotation.RequestParam\n")
            append("import org.springframework.web.bind.annotation.RestController\n")
            append("import java.net.URLDecoder\n")
            append("import java.nio.charset.StandardCharsets\n")
            append("import java.sql.Timestamp\n")
            append("import java.time.LocalDate\n")
            append("import java.time.LocalDateTime\n")
            append("import java.time.LocalTime\n")
            append("import java.time.format.DateTimeFormatter\n")
            append("\n")
            // Sort allowlist — static set; unknown fields → 400. Emitted at file level so it
            // remains accessible to the handler functions without polluting the controller's
            // surface.
            append("/** GENERATED — sort allowlist for ${shortName} (cross-port API contract). */\n")
            append("private val ${shortName}SortAllowlist = setOf(\n")
            for (field in sortFields) {
                append("    \"$field\",\n")
            }
            append(")\n\n")

            // parseSort: returns (field, asc|desc) or null for malformed/disallowed input.
            // Returning null lets the handler emit the 400 envelope itself rather than
            // throwing — cleaner separation. Inlined per-entity so the allowlist closes
            // over the right set without a runtime parameter.
            append("private fun parse${shortName}Sort(raw: String): Pair<String, SortOrder>? {\n")
            append("    val parts = raw.split(\":\", limit = 2)\n")
            append("    val field = parts.getOrNull(0) ?: return null\n")
            append("    if (field !in ${shortName}SortAllowlist) return null\n")
            append("    val dirRaw = parts.getOrNull(1)?.lowercase() ?: \"asc\"\n")
            append("    val dir = when (dirRaw) {\n")
            append("        \"asc\" -> SortOrder.ASC\n")
            append("        \"desc\" -> SortOrder.DESC\n")
            append("        else -> return null\n")
            append("    }\n")
            append("    return field to dir\n")
            append("}\n\n")

            // FR-009 filter pipeline. Three stages:
            //   1. data class ${shortName}FilterPredicate — parsed + validated one
            //      filter[<f>][<op>]=<v> entry (value already coerced to a Kotlin type).
            //   2. parse${shortName}Filter — walks the raw key→value map (each key is
            //      URL-decoded by Spring), matching the bracketed grammar against
            //      ${allowlistName}.FIELDS + .OPS_BY_FIELD. Returns either predicates or
            //      one of the cross-port error envelope keys.
            //   3. ${shortName}WhereOp — converts the predicate list into an Exposed
            //      Op<Boolean> bound against ${tableObjectName}'s columns. Multiple
            //      predicates AND together. Per-field arms know each column's Kotlin
            //      type at compile time (no reflection / runtime cast surprises).
            emitFilterPipeline(this, shortName, tableObjectName, allowlistName, scalarFields)

            // rowTo<Entity>: ResultRow → data class. Scalar fields only; ObjectField is
            // skipped here for the same reason as the sort allowlist (the Table object's
            // jsonb/flattened column shape would require type-specific deserialization
            // which is generator-future work).
            append("/** GENERATED — map an Exposed ResultRow to the ${shortName} data class. */\n")
            append("private fun rowTo${shortName}(row: ResultRow): ${shortName} = ${shortName}(\n")
            for (field in entity.metaFields) {
                if (field is ObjectField) continue
                append("    ${field.name} = row[${tableObjectName}.${field.name}],\n")
            }
            append(")\n\n")

            append("/** GENERATED — REST controller for ${shortName} entity. Implements the cross-port API contract. */\n")
            append("@RestController\n")
            append("@RequestMapping(\"$routeBase\")\n")
            append("class ${shortName}Controller {\n\n")

            // List handler — pagination + sort + withCount + FR-009 filter operators.
            //
            // `allParams: Map<String, String>` is Spring's collapsed view of every query
            // parameter; the bracketed filter keys survive (Spring does not strip [ ] /
            // they are URL-decoded but otherwise opaque). Same-key collisions in repeat
            // params would only retain one value — none of the cross-port FR-009
            // scenarios exercise that case (each filter[<f>][<op>] occurs at most once
            // per request).
            append("    @GetMapping\n")
            append("    fun list(\n")
            append("        @RequestParam(required = false) limit: Int?,\n")
            append("        @RequestParam(required = false) offset: Int?,\n")
            append("        @RequestParam(required = false) sort: String?,\n")
            append("        @RequestParam(required = false, name = \"withCount\") withCount: Int?,\n")
            append("        @RequestParam allParams: Map<String, String>,\n")
            append("    ): ResponseEntity<Any> = transaction {\n")
            append("        // FR-009 filter operators — short-circuit 400 on invalid field/op/value.\n")
            append("        val filterResult = parse${shortName}Filter(allParams)\n")
            append("        if (filterResult.error != null) {\n")
            append("            return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to filterResult.error) as Any)\n")
            append("        }\n")
            append("        val whereOp = ${shortName}WhereOp(filterResult.predicates)\n")
            append("        var q = if (whereOp != null) ${tableObjectName}.selectAll().where { whereOp } else ${tableObjectName}.selectAll()\n")
            append("        if (sort != null) {\n")
            append("            val parsed = parse${shortName}Sort(sort)\n")
            append("                ?: return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"invalid_sort\") as Any)\n")
            append("            val (field, dir) = parsed\n")
            append("            q = q.orderBy(${tableObjectName}.columns.first { it.name == field } to dir)\n")
            append("        }\n")
            append("        val total: Long = if (withCount == 1) q.count() else -1L\n")
            append("        val effectiveLimit = limit ?: 50\n")
            append("        val effectiveOffset = (offset ?: 0).toLong()\n")
            append("        val rows = q.limit(effectiveLimit, effectiveOffset).map { rowTo${shortName}(it) }\n")
            append("        if (withCount == 1) ResponseEntity.ok(mapOf(\"rows\" to rows, \"total\" to total) as Any)\n")
            append("        else ResponseEntity.ok(rows as Any)\n")
            append("    }\n\n")

            // GET /{id}
            append("    @GetMapping(\"/{id}\")\n")
            append("    fun get(@PathVariable id: Long): ResponseEntity<Any> = transaction {\n")
            append("        val row = ${tableObjectName}.selectAll().where { ${tableObjectName}.${pkFieldName} eq id }.singleOrNull()\n")
            append("            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
            append("        ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
            append("    }\n\n")

            // POST — create
            append("    @PostMapping\n")
            append("    fun create(@Valid @RequestBody dto: ${shortName}): ResponseEntity<${shortName}> = transaction {\n")
            append("        val newId = ${tableObjectName}.insert {\n")
            for (field in entity.metaFields) {
                if (field is ObjectField) continue
                // Skip the PK column on insert — the table's @generation=increment owns it.
                // If the entity has no auto-incrementing PK the consumer can override the
                // generated handler; this is the 95% case.
                if (field.name == pkFieldName) continue
                append("            it[${field.name}] = dto.${field.name}\n")
            }
            append("        }[${tableObjectName}.${pkFieldName}]\n")
            append("        val saved = ${tableObjectName}.selectAll().where { ${tableObjectName}.${pkFieldName} eq newId }.single()\n")
            append("        ResponseEntity.status(HttpStatus.CREATED).body(rowTo${shortName}(saved))\n")
            append("    }\n\n")

            // PATCH + PUT — single handler (per API contract; same body shape both verbs).
            // Both verbs MUST be expressed on one @RequestMapping with method=[PATCH, PUT].
            // Stacking @PatchMapping + @PutMapping on the same method does NOT register both
            // in Spring MVC — only one composed @RequestMapping per method is honored, so the
            // other verb 405s. (Surfaced by the SP-F generated-controller HTTP lane.)
            append("    @RequestMapping(value = [\"/{id}\"], method = [RequestMethod.PATCH, RequestMethod.PUT])\n")
            append("    fun update(@PathVariable id: Long, @Valid @RequestBody dto: ${shortName}): ResponseEntity<Any> = transaction {\n")
            append("        val updated = ${tableObjectName}.update({ ${tableObjectName}.${pkFieldName} eq id }) {\n")
            for (field in entity.metaFields) {
                if (field is ObjectField) continue
                if (field.name == pkFieldName) continue
                append("            it[${field.name}] = dto.${field.name}\n")
            }
            append("        }\n")
            append("        if (updated == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
            append("        else {\n")
            append("            val row = ${tableObjectName}.selectAll().where { ${tableObjectName}.${pkFieldName} eq id }.single()\n")
            append("            ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
            append("        }\n")
            append("    }\n\n")

            // DELETE — Exposed's `deleteWhere` is an extension fn on Table; the import
            // above pulls it in. 204 No Content on success, 404 envelope on miss.
            // The `eq` op must be resolved through SqlExpressionBuilder: deleteWhere's
            // lambda receiver does NOT bring the comparison ops into scope on its own
            // (unlike `selectAll().where { }`), so a bare `Table.id eq id` is an
            // "Unresolved reference: eq" compile error. (Surfaced by the SP-F
            // generated-controller HTTP lane; mirrors the hand-rolled reference server.)
            append("    @DeleteMapping(\"/{id}\")\n")
            append("    fun delete(@PathVariable id: Long): ResponseEntity<Any> = transaction {\n")
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
                emitM2mEndpoint(this, pkg, shortName, nav)
            }

            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("${shortName}Controller.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, source)
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
    protected open fun emitTph(base: MetaObject, plan: KotlinTphPlan.Plan, outRoot: Path) {
        val (pkg, shortName) = PackageMapping.splitFqn(base.name)
        val table = shortName + "Table"
        val routeBase = "/api/" + pluralLowercase(shortName)
        val discField = base.metaFields.first { it.name == plan.discriminatorField }
        val discEnum = KotlinTypeMapper.enumTypeName(discField, base)?.simpleName
            ?: error("TPH base ${base.name}: discriminator field '${plan.discriminatorField}' is not an enum")

        // Union scalar fields (base own + subtype-only), in the data class / table order.
        val scalarFields = (base.metaFields.filterNot { it is ObjectField } +
            KotlinTphPlan.collectSubtypeFields(base, plan).filterNot { it is ObjectField })
        val sortFields = base.metaFields.filterNot { it is ObjectField }.map { it.name }
        val baseFieldNames = base.metaFields.map { it.name }.toSet()
        // Non-discriminator, non-PK columns the create/update handlers write from the body.
        val writableFields = scalarFields.map { it.name }
            .filter { it != plan.discriminatorField && it != "id" }

        val src = buildString {
            if (pkg.isNotEmpty()) append("package $pkg\n\n")
            append("import org.jetbrains.exposed.sql.ResultRow\n")
            append("import org.jetbrains.exposed.sql.SortOrder\n")
            append("import org.jetbrains.exposed.sql.SqlExpressionBuilder\n")
            append("import org.jetbrains.exposed.sql.and\n")
            append("import org.jetbrains.exposed.sql.deleteWhere\n")
            append("import org.jetbrains.exposed.sql.insert\n")
            append("import org.jetbrains.exposed.sql.selectAll\n")
            append("import org.jetbrains.exposed.sql.update\n")
            append("import org.jetbrains.exposed.sql.transactions.transaction\n")
            append("import org.springframework.http.HttpStatus\n")
            append("import org.springframework.http.ResponseEntity\n")
            append("import org.springframework.web.bind.annotation.DeleteMapping\n")
            append("import org.springframework.web.bind.annotation.GetMapping\n")
            append("import org.springframework.web.bind.annotation.PathVariable\n")
            append("import org.springframework.web.bind.annotation.PostMapping\n")
            append("import org.springframework.web.bind.annotation.RequestBody\n")
            append("import org.springframework.web.bind.annotation.RequestMapping\n")
            append("import org.springframework.web.bind.annotation.RequestMethod\n")
            append("import org.springframework.web.bind.annotation.RequestParam\n")
            append("import org.springframework.web.bind.annotation.RestController\n\n")

            // sort allowlist (base scalar columns — the polymorphic sort surface)
            append("/** GENERATED — sort allowlist for $shortName (cross-port API contract). */\n")
            append("private val ${shortName}SortAllowlist = setOf(\n")
            for (f in sortFields) append("    \"$f\",\n")
            append(")\n\n")
            append("private fun parse${shortName}Sort(raw: String): Pair<String, SortOrder>? {\n")
            append("    val parts = raw.split(\":\", limit = 2)\n")
            append("    val field = parts.getOrNull(0) ?: return null\n")
            append("    if (field !in ${shortName}SortAllowlist) return null\n")
            append("    val dir = when (parts.getOrNull(1)?.lowercase() ?: \"asc\") {\n")
            append("        \"asc\" -> SortOrder.ASC\n")
            append("        \"desc\" -> SortOrder.DESC\n")
            append("        else -> return null\n")
            append("    }\n")
            append("    return field to dir\n")
            append("}\n\n")

            // rowTo<Base>: union ResultRow → data class
            append("/** GENERATED — map an Exposed ResultRow to the union $shortName data class. */\n")
            append("private fun rowTo${shortName}(row: ResultRow): $shortName = $shortName(\n")
            for (field in scalarFields) append("    ${field.name} = row[$table.${field.name}],\n")
            append(")\n\n")

            append("/** GENERATED — TPH discriminator-base controller for $shortName (polymorphic + per-subtype CRUD). */\n")
            append("@RestController\n")
            append("@RequestMapping(\"$routeBase\")\n")
            append("class ${shortName}Controller {\n\n")

            // polymorphic list
            append("    @GetMapping\n")
            append("    fun list(\n")
            append("        @RequestParam(required = false) limit: Int?,\n")
            append("        @RequestParam(required = false) offset: Int?,\n")
            append("        @RequestParam(required = false) sort: String?,\n")
            append("        @RequestParam(required = false, name = \"withCount\") withCount: Int?,\n")
            append("    ): ResponseEntity<Any> = transaction {\n")
            append("        var q = $table.selectAll()\n")
            append("        if (sort != null) {\n")
            append("            val parsed = parse${shortName}Sort(sort)\n")
            append("                ?: return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"invalid_sort\") as Any)\n")
            append("            val (field, dir) = parsed\n")
            append("            q = q.orderBy($table.columns.first { it.name == field } to dir)\n")
            append("        }\n")
            append("        val total: Long = if (withCount == 1) q.count() else -1L\n")
            append("        val rows = q.limit(limit ?: 50, (offset ?: 0).toLong()).map { rowTo${shortName}(it) }\n")
            append("        if (withCount == 1) ResponseEntity.ok(mapOf(\"rows\" to rows, \"total\" to total) as Any)\n")
            append("        else ResponseEntity.ok(rows as Any)\n")
            append("    }\n\n")

            // polymorphic get
            append("    @GetMapping(\"/{id}\")\n")
            append("    fun get(@PathVariable id: Long): ResponseEntity<Any> = transaction {\n")
            append("        val row = $table.selectAll().where { $table.id eq id }.singleOrNull()\n")
            append("            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
            append("        ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
            append("    }\n\n")

            for (st in plan.subtypes) {
                val seg = st.routeSegment
                val disc = "$discEnum.${st.value}"   // e.g. AuthType.Bridge
                val sfx = capitalizeFirst(st.value)   // method-name suffix, e.g. Bridge

                append("    // --- subtype ${st.value} (segment /$seg) ---\n")

                // per-subtype list
                append("    @GetMapping(\"/$seg\")\n")
                append("    fun list$sfx(\n")
                append("        @RequestParam(required = false) limit: Int?,\n")
                append("        @RequestParam(required = false) offset: Int?,\n")
                append("        @RequestParam(required = false) sort: String?,\n")
                append("    ): ResponseEntity<Any> = transaction {\n")
                append("        var q = $table.selectAll().where { $table.${plan.discriminatorField} eq $disc }\n")
                append("        if (sort != null) {\n")
                append("            val parsed = parse${shortName}Sort(sort)\n")
                append("                ?: return@transaction ResponseEntity.badRequest().body(mapOf(\"error\" to \"invalid_sort\") as Any)\n")
                append("            val (field, dir) = parsed\n")
                append("            q = q.orderBy($table.columns.first { it.name == field } to dir)\n")
                append("        }\n")
                append("        val rows = q.limit(limit ?: 50, (offset ?: 0).toLong()).map { rowTo${shortName}(it) }\n")
                append("        ResponseEntity.ok(rows as Any)\n")
                append("    }\n\n")

                // per-subtype get
                append("    @GetMapping(\"/$seg/{id}\")\n")
                append("    fun get$sfx(@PathVariable id: Long): ResponseEntity<Any> = transaction {\n")
                append("        val row = $table.selectAll().where { ($table.id eq id) and ($table.${plan.discriminatorField} eq $disc) }.singleOrNull()\n")
                append("            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
                append("        ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
                append("    }\n\n")

                // per-subtype create (discriminator injected from URL)
                append("    @PostMapping(\"/$seg\")\n")
                append("    fun create$sfx(@RequestBody dto: $shortName): ResponseEntity<$shortName> = transaction {\n")
                append("        val newId = $table.insert {\n")
                append("            it[${plan.discriminatorField}] = $disc\n")
                for (f in writableFields) {
                    // A column is non-null in the union table iff it is a BASE @required field
                    // (subtype-only columns are folded NULLABLE). For a non-null column the union
                    // DTO field is still nullable, so force non-null on create (create bodies for
                    // that subtype always supply it); nullable columns bind the nullable value as-is.
                    val colNonNull = baseFieldNames.contains(f) && KotlinGenUtil.isRequiredField(scalarFields.first { it.name == f })
                    if (colNonNull) append("            it[$f] = dto.$f!!\n")
                    else append("            it[$f] = dto.$f\n")
                }
                append("        }[$table.id]\n")
                append("        val saved = $table.selectAll().where { $table.id eq newId }.single()\n")
                append("        ResponseEntity.status(HttpStatus.CREATED).body(rowTo${shortName}(saved))\n")
                append("    }\n\n")

                // per-subtype update (partial patch; discriminator immutable; 404 cross-subtype)
                append("    @RequestMapping(value = [\"/$seg/{id}\"], method = [RequestMethod.PATCH, RequestMethod.PUT])\n")
                append("    fun update$sfx(@PathVariable id: Long, @RequestBody dto: $shortName): ResponseEntity<Any> = transaction {\n")
                append("        val updated = $table.update({ ($table.id eq id) and ($table.${plan.discriminatorField} eq $disc) }) {\n")
                for (f in writableFields) {
                    append("            if (dto.$f != null) it[$f] = dto.$f\n")
                }
                append("        }\n")
                append("        if (updated == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
                append("        else {\n")
                append("            val row = $table.selectAll().where { ($table.id eq id) and ($table.${plan.discriminatorField} eq $disc) }.single()\n")
                append("            ResponseEntity.ok(rowTo${shortName}(row) as Any)\n")
                append("        }\n")
                append("    }\n\n")

                // per-subtype delete (404 cross-subtype)
                append("    @DeleteMapping(\"/$seg/{id}\")\n")
                append("    fun delete$sfx(@PathVariable id: Long): ResponseEntity<Any> = transaction {\n")
                append("        val deleted = $table.deleteWhere { with(SqlExpressionBuilder) { ($table.id eq id) and ($table.${plan.discriminatorField} eq $disc) } }\n")
                append("        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
                append("        else ResponseEntity.noContent().build<Any>()\n")
                append("    }\n\n")
            }
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("${shortName}Controller.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, src)
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
        out.append("/** GENERATED — single parsed + validated FR-009 filter predicate. */\n")
        out.append("private data class ${shortName}FilterPredicate(val field: String, val op: String, val value: Any?)\n\n")

        out.append("/** GENERATED — parse outcome: either a list of predicates or a cross-port error envelope key. */\n")
        out.append("private data class ${shortName}FilterResult(val predicates: List<${shortName}FilterPredicate>, val error: String?)\n\n")

        // Parser — walks the URL-decoded Map<String, String> and matches each
        // filter[<f>][<op>]=<v> key against the per-entity FIELDS + OPS_BY_FIELD
        // allowlist. coerce<X>Value() lookups own the per-subtype value coercion.
        out.append("/**\n")
        out.append(" * GENERATED — parse the bracketed-qs FR-009 filter grammar from a URL-decoded\n")
        out.append(" * {@code allParams} map. Returns either a list of validated predicates or one of\n")
        out.append(" * the cross-port error envelope keys ({@code invalid_filter_field /\n")
        out.append(" * invalid_filter_op / invalid_filter_value}).\n")
        out.append(" */\n")
        out.append("private fun parse${shortName}Filter(allParams: Map<String, String>): ${shortName}FilterResult {\n")
        out.append("    val out = mutableListOf<${shortName}FilterPredicate>()\n")
        out.append("    for ((rawKey, value) in allParams) {\n")
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
        out.append("        if (field !in ${allowlistName}.FIELDS) return ${shortName}FilterResult(emptyList(), \"invalid_filter_field\")\n")
        out.append("        val ops = ${allowlistName}.OPS_BY_FIELD[field]\n")
        out.append("        if (ops == null || op !in ops) return ${shortName}FilterResult(emptyList(), \"invalid_filter_op\")\n")
        out.append("        val coerced = coerce${shortName}Value(field, op, value)\n")
        out.append("            ?: return ${shortName}FilterResult(emptyList(), \"invalid_filter_value\")\n")
        out.append("        out.add(${shortName}FilterPredicate(field, op, coerced.value))\n")
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
        // Timestamp needs a per-entity formatter (the cross-port wire form is
        // 'yyyy-MM-dd\'T\'HH:mm:ss' without a zone), so it can't share the simple
        // single-arg parse-fn path of emitTypedCoercer.
        out.append("private val ${shortName}TimestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern(\"yyyy-MM-dd'T'HH:mm:ss\")\n\n")
        out.append("private fun coerce${shortName}Timestamp(op: String, raw: String): ${shortName}CoercedValue? {\n")
        out.append("    val parse: (String) -> LocalDateTime? = { s -> runCatching { LocalDateTime.parse(s, ${shortName}TimestampFmt) }.getOrNull() }\n")
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
        for ((fname, subType, elementType) in scalarFields) {
            val isStringLike = (subType == StringField.SUBTYPE_STRING || subType == EnumField.SUBTYPE_ENUM)
            val isBoolean = (subType == BooleanField.SUBTYPE_BOOLEAN)
            emitPerFieldDispatchArm(
                out,
                tableObjectName = tableObjectName,
                fieldName = fname,
                elementType = elementType,
                isStringLike = isStringLike,
                isBoolean = isBoolean,
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
    ) {
        // Exposed's typed `Column<T>.eq(t: T)` / `.neq` / `.inList(Iterable<T>)` reject a
        // bare `Any?` — cast each predicate value to the column's element Kotlin type so
        // the comparison resolves. (Surfaced by the SP-F generated-controller HTTP lane:
        // `(p.value as Any?)` was an `Unresolved reference: eq` compile error.) The
        // coercer already produced a value of exactly this type; the cast is total.
        out.append("                \"$fieldName\" -> when (p.op) {\n")
        out.append("                    \"eq\" -> ${tableObjectName}.${fieldName} eq (p.value as $elementType)\n")
        if (!isBoolean) {
            out.append("                    \"ne\" -> ${tableObjectName}.${fieldName} neq (p.value as $elementType)\n")
        }
        if (!isStringLike && !isBoolean) {
            out.append("                    \"gt\" -> ${tableObjectName}.${fieldName} greater (p.value as $elementType)\n")
            out.append("                    \"gte\" -> ${tableObjectName}.${fieldName} greaterEq (p.value as $elementType)\n")
            out.append("                    \"lt\" -> ${tableObjectName}.${fieldName} less (p.value as $elementType)\n")
            out.append("                    \"lte\" -> ${tableObjectName}.${fieldName} lessEq (p.value as $elementType)\n")
        }
        if (!isBoolean) {
            out.append("                    \"in\" -> ${tableObjectName}.${fieldName} inList (p.value as List<$elementType>)\n")
        }
        if (isStringLike) {
            out.append("                    \"like\" -> ${tableObjectName}.${fieldName} like (p.value as String)\n")
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
     * Naive pluralization: lowercase + "s". Matches the cross-port reference (TS / C#
     * use the same trivial rule for the default route segment). Consumers needing
     * irregular plurals (e.g. {@code Person} → {@code people}) can override the
     * generated {@code @RequestMapping} value by hand-editing the file — the
     * {@code GENERATED} banner is advisory, not a hard merge gate, since
     * regeneration overwrites.
     */
    private fun pluralLowercase(shortName: String): String =
        shortName.lowercase() + "s"

    /**
     * Emit one M:N traversal sub-resource: {@code GET /{id}/<relationName>} returning
     * the related target rows as the target's data class. Delegates the junction
     * traversal to the {@code <Source>Table.<relationName>Query(id)} Exposed join helper
     * (emitted by [KotlinRelationsGenerator]); maps each returned {@link ResultRow} to the
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
    ) {
        val sourceTable = sourceShort + "Table"
        val targetType = if (nav.targetPackage == sourcePkg || nav.targetPackage.isEmpty()) {
            nav.targetShortName
        } else {
            nav.targetPackage + "." + nav.targetShortName
        }
        val symMarker = if (nav.symmetric) " (symmetric — union on read)" else ""
        out.append("\n")
        out.append("    /** M:N traversal: the ${nav.targetShortName} rows related to this $sourceShort through ${nav.junctionShortName}$symMarker. */\n")
        out.append("    @GetMapping(\"/{id}/${nav.relationName}\")\n")
        out.append("    fun ${nav.relationName}(@PathVariable id: Long): ResponseEntity<List<$targetType>> = transaction {\n")
        out.append("        val rows = $sourceTable.${nav.relationName}Query(id).map { row ->\n")
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
    protected data class ScalarFieldSpec(val name: String, val subType: String?, val elementType: String)

    /**
     * The element Kotlin type the generated `<Entity>Table`'s column for [field] holds —
     * the cast target for the eq/ne/in predicate value. For scalar fields this is the same
     * simple type name the DTO property uses ([KotlinTypeMapper.kotlinTypeName]); for an
     * [EnumField] it is the generated typed enum class (the column is
     * `enumerationByName(..., <Enum>::class)`), keeping the cast aligned with the column type.
     */
    private fun columnElementType(field: com.metaobjects.field.MetaField<*>): String {
        KotlinTypeMapper.enumTypeName(field, null)?.let { return it.simpleName }
        return KotlinTypeMapper.kotlinTypeName(field).let { tn ->
            (tn as? com.squareup.kotlinpoet.ClassName)?.simpleName ?: tn.toString()
        }
    }

    private companion object {
        /** Default primary-key field name when the entity declares no identity.primary. */
        const val DEFAULT_PK_FIELD = "id"

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
        PackageMapping.splitFqn(md.name).second + "Controller.kt"
}

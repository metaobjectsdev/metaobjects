package com.metaobjects.generator.kotlin

import com.metaobjects.field.ObjectField
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
 * <p>Filter operators ({@code eq/ne/gt/...}) are a known gap, mirroring the C# port's
 * {@code Generators/KNOWN_GAPS.md}; only sort/pagination/withCount are honoured today.
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
class KotlinSpringControllerGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
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
            emit(entity, outRoot)
        }
    }

    private fun emit(entity: MetaObject, outRoot: Path) {
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

        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import org.jetbrains.exposed.sql.SortOrder\n")
            append("import org.jetbrains.exposed.sql.ResultRow\n")
            append("import org.jetbrains.exposed.sql.deleteWhere\n")
            append("import org.jetbrains.exposed.sql.insert\n")
            append("import org.jetbrains.exposed.sql.selectAll\n")
            append("import org.jetbrains.exposed.sql.update\n")
            append("import org.jetbrains.exposed.sql.transactions.transaction\n")
            append("import org.springframework.http.HttpStatus\n")
            append("import org.springframework.http.ResponseEntity\n")
            append("import org.springframework.web.bind.annotation.DeleteMapping\n")
            append("import org.springframework.web.bind.annotation.GetMapping\n")
            append("import org.springframework.web.bind.annotation.PatchMapping\n")
            append("import org.springframework.web.bind.annotation.PathVariable\n")
            append("import org.springframework.web.bind.annotation.PostMapping\n")
            append("import org.springframework.web.bind.annotation.PutMapping\n")
            append("import org.springframework.web.bind.annotation.RequestBody\n")
            append("import org.springframework.web.bind.annotation.RequestMapping\n")
            append("import org.springframework.web.bind.annotation.RequestParam\n")
            append("import org.springframework.web.bind.annotation.RestController\n")
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

            // List handler — pagination + sort + withCount.
            append("    @GetMapping\n")
            append("    fun list(\n")
            append("        @RequestParam(required = false) limit: Int?,\n")
            append("        @RequestParam(required = false) offset: Int?,\n")
            append("        @RequestParam(required = false) sort: String?,\n")
            append("        @RequestParam(required = false, name = \"withCount\") withCount: Int?,\n")
            append("    ): ResponseEntity<Any> = transaction {\n")
            append("        var q = ${tableObjectName}.selectAll()\n")
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
            append("    fun create(@RequestBody dto: ${shortName}): ResponseEntity<${shortName}> = transaction {\n")
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

            // PATCH + PUT — same handler (per API contract).
            append("    @PatchMapping(\"/{id}\")\n")
            append("    @PutMapping(\"/{id}\")\n")
            append("    fun update(@PathVariable id: Long, @RequestBody dto: ${shortName}): ResponseEntity<Any> = transaction {\n")
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
            append("    @DeleteMapping(\"/{id}\")\n")
            append("    fun delete(@PathVariable id: Long): ResponseEntity<Any> = transaction {\n")
            append("        val deleted = ${tableObjectName}.deleteWhere { ${tableObjectName}.${pkFieldName} eq id }\n")
            append("        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf(\"error\" to \"not_found\") as Any)\n")
            append("        else ResponseEntity.noContent().build<Any>()\n")
            append("    }\n")
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("${shortName}Controller.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, source)
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

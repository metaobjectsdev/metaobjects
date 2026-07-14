package com.metaobjects.generator.kotlin

import com.metaobjects.field.MapField
import com.metaobjects.field.ObjectField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.identity.MetaIdentity
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.source.MetaSource
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.slf4j.LoggerFactory

/**
 * FR-035 Phase 2 — one `open class <Entity>RepositoryBase` per concrete writable entity: the
 * persistence seam #197 says Kotlin adopters have to hand-write. It carries the row-mapper plus a
 * CRUD + patch surface with Exposed bodies, so an adopter extends it (or wires it directly) instead
 * of re-implementing the column mapping by hand — which is exactly where dropped-column drift comes
 * from. Java already ships `SpringRepositoryGenerator` (an interface); this is its Kotlin peer, with
 * bodies.
 *
 * The class is deliberately NOT annotated `@Repository` (§8.2 of the FR-035 design): a consumer
 * subclass would then create an ambiguous second bean. It is a plain `open` persistence base;
 * controller delegation + `@ConditionalOnMissingBean` wiring is Phase 3 (the controller keeps its
 * own inline bodies for now).
 *
 * ## v1 method surface (mirrors Java's `SpringRepositoryGenerator`, with bodies)
 *  - `rowTo<Entity>(row): <Entity>` — ResultRow → data class (the mapper #197 says adopters lose).
 *  - `findById(id): <Entity>?`
 *  - `insert(dto): <Entity>` — branches on `identity.primary @generation`:
 *      * `increment` → skip the PK, capture the DB-assigned key, return the populated entity;
 *      * `uuid`      → CLIENT-generate `UUID.randomUUID()` and return it (deterministic + engine-
 *                     portable; the repo does not depend on the driver returning a server-DEFAULT
 *                     uuid via getGeneratedKeys, which no engine in this repo is proven to do);
 *      * `assigned`/absent → write the caller's PK.
 *    This also fixes in passing the "generator never reads @generation" gap noted in #197's
 *    re-verification — the controller unconditionally skips the PK; the repository branches.
 *  - `update(id, dto): <Entity>?` — full-row present-non-null merge (required written
 *    unconditionally; OPTIONAL fields null-guarded, matching the controller's PATCH fix — a guard on
 *    a non-null required prop would be an always-true `-Werror` warning).
 *  - `patch(id) { it[Table.col] = v }: <Entity>?` — the Exposed statement-lambda: touches only the
 *    named columns, and a renamed/dropped column is a COMPILE error, not a silently skipped write.
 *  - `delete(id): Boolean`
 *
 * ## Deferred to a Phase-2 follow-up (each SKIPPED with a log below):
 *   - `list`/`count` with the FR-009 filter + sort pipeline;
 *   - FR-018 M:N finders and ADR-0038 reverse finders;
 *   - the TPH polymorphic + per-subtype-scoped repository variant;
 *   - a read-only repository for `@kind: view` / `materializedView`;
 *   - composite (multi-field) primary keys.
 */
open class KotlinRepositoryGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            if (KotlinGenUtil.isAbstractEntity(entity)) continue
            // TODO(FR-035 Phase 2): a TPH subtype folds into its base's table — the base's
            // repository would own the polymorphic + per-subtype-scoped surface (not built yet).
            if (KotlinTphPlan.isTphSubtype(entity)) continue
            // ADR-0039: resolving source lookup (inherited source.rdb via extends).
            val sourceRdb = KotlinGenUtil.firstRdbSource(entity) ?: continue
            val kind = sourceRdb.effectiveKind
            if (kind != MetaSource.KIND_TABLE) {
                // TODO(FR-035 Phase 2): view / materializedView → a read-only repository (mapper +
                // finders only); storedProc/tableFunction are callables (no repository).
                LOG.debug(
                    "skipping repository for {} — source.rdb @kind='{}' is not a writable table",
                    entity.name, kind
                )
                continue
            }
            // TODO(FR-035 Phase 2): a TPH discriminator base needs the polymorphic + per-subtype
            // repository variant (mirroring the controller's emitTph). Not built yet.
            if (KotlinTphPlan.planFor(entity, loader) != null) {
                LOG.debug("skipping repository for {} — TPH base variant is a Phase-2 follow-up", entity.name)
                continue
            }

            val primary = entity.getIdentities(true)
                .filterIsInstance<MetaIdentity>()
                .firstOrNull { it.isPrimary }
            // TODO(FR-035 Phase 2): composite PKs need a by-id grammar (same v1 limit as the
            // controller). Skip until then rather than emit a wrong single-column by-id surface.
            if (primary != null && primary.fields.size > 1) {
                LOG.debug("skipping repository for {} — composite primary key (Phase-2 follow-up)", entity.name)
                continue
            }

            emit(entity, outRoot, primary)
        }
    }

    private fun emit(entity: MetaObject, outRoot: Path, primary: MetaIdentity?) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val table = KotlinNaming.tableObjectName(shortName)
        val repoName = KotlinNaming.repositoryBaseName(shortName)
        val pkFieldName = primary?.fields?.firstOrNull() ?: DEFAULT_PK_FIELD
        val pkParamType = primaryKeyParamType(entity, pkFieldName)

        // Scalar columns only — ObjectField / MapField carry a jsonb/flattened shape the mapper
        // does not handle in v1 (the controller's rowTo makes the same exclusion).
        val scalarFields = entity.metaFields.filter { it !is ObjectField && it !is MapField }
        val hasUuidColumn = scalarFields.any { columnElementType(it) == "UUID" }
        val uuidPk = primary?.isUuid == true
        val incrementPk = primary?.isIncrement == true

        val src = buildString {
            if (pkg.isNotEmpty()) append("package $pkg\n\n")

            append("import org.jetbrains.exposed.sql.ResultRow\n")
            append("import org.jetbrains.exposed.sql.SqlExpressionBuilder\n")
            append("import org.jetbrains.exposed.sql.deleteWhere\n")
            append("import org.jetbrains.exposed.sql.insert\n")
            append("import org.jetbrains.exposed.sql.selectAll\n")
            append("import org.jetbrains.exposed.sql.statements.UpdateStatement\n")
            append("import org.jetbrains.exposed.sql.update\n")
            append("import org.jetbrains.exposed.sql.transactions.transaction\n")
            // java.util.UUID surfaces when the PK is a client-generated uuid, or any column is uuid.
            if (uuidPk || hasUuidColumn) append("import java.util.UUID\n")
            append("\n")

            append("/**\n")
            append(" * GENERATED — persistence repository base for $shortName. Do not hand-edit.\n")
            append(" *\n")
            append(" * `open` so a consumer can subclass and override; NOT `@Repository` (a subclass\n")
            append(" * would create an ambiguous bean — wiring is the consumer's, per FR-035 §8.2).\n")
            append(" */\n")
            append("open class $repoName {\n\n")

            // --- row-mapper (verbatim shape from the controller's rowTo) ---
            append("    /** Map an Exposed ResultRow to the $shortName data class. */\n")
            append("    open fun rowTo$shortName(row: ResultRow): $shortName = $shortName(\n")
            for (field in scalarFields) {
                append("        ${field.name} = row[$table.${field.name}],\n")
            }
            append("    )\n\n")

            // --- findById ---
            append("    /** The $shortName with this primary key, or null. */\n")
            append("    open fun findById(id: $pkParamType): $shortName? = transaction {\n")
            append("        $table.selectAll().where { $table.$pkFieldName eq id }.singleOrNull()?.let(::rowTo$shortName)\n")
            append("    }\n\n")

            // --- insert (branches on @generation) ---
            append("    /** Insert a $shortName and return it with the persisted primary key. */\n")
            append("    open fun insert(dto: $shortName): $shortName = transaction {\n")
            when {
                incrementPk -> {
                    // DB owns the key (autoIncrement column) — skip it on write, capture the
                    // generated value, re-read. Same pattern the generated controller's create uses,
                    // proven by the api-contract create-201 (hasId) lane on H2.
                    append("        val newId = $table.insert {\n")
                    for (field in scalarFields) {
                        if (field.name == pkFieldName) continue
                        append("            it[$table.${field.name}] = dto.${field.name}\n")
                    }
                    append("        }[$table.$pkFieldName]\n")
                    append("        $table.selectAll().where { $table.$pkFieldName eq newId }.single().let(::rowTo$shortName)\n")
                }
                uuidPk -> {
                    // Client-generate the uuid so the insert deterministically returns the assigned
                    // key on any engine — it does NOT rely on the driver reporting a server-DEFAULT
                    // gen_random_uuid() value back through getGeneratedKeys (unproven here). An
                    // explicit INSERT value simply wins over the column's DEFAULT in production.
                    append("        val newId = UUID.randomUUID()\n")
                    append("        $table.insert {\n")
                    append("            it[$table.$pkFieldName] = newId\n")
                    for (field in scalarFields) {
                        if (field.name == pkFieldName) continue
                        append("            it[$table.${field.name}] = dto.${field.name}\n")
                    }
                    append("        }\n")
                    append("        $table.selectAll().where { $table.$pkFieldName eq newId }.single().let(::rowTo$shortName)\n")
                }
                else -> {
                    // @generation: assigned (or absent) — the caller supplies the key. This is the
                    // branch the controller never had (it unconditionally skipped the PK); writing
                    // the caller's PK here is the #197 "never reads @generation" fix.
                    append("        $table.insert {\n")
                    append("            it[$table.$pkFieldName] = dto.$pkFieldName\n")
                    for (field in scalarFields) {
                        if (field.name == pkFieldName) continue
                        append("            it[$table.${field.name}] = dto.${field.name}\n")
                    }
                    append("        }\n")
                    append("        $table.selectAll().where { $table.$pkFieldName eq dto.$pkFieldName }.single().let(::rowTo$shortName)\n")
                }
            }
            append("    }\n\n")

            // --- update (full-row, present-non-null) ---
            append("    /** Overwrite every column of the row (present-non-null merge). Null if no such row. */\n")
            append("    open fun update(id: $pkParamType, dto: $shortName): $shortName? = transaction {\n")
            append("        val n = $table.update({ $table.$pkFieldName eq id }) {\n")
            for (field in scalarFields) {
                if (field.name == pkFieldName) continue
                // Required fields are non-null in the DTO → write unconditionally (a null-guard would
                // be an always-true `-Werror` warning). Optional fields are nullable → guard, so an
                // absent value does not clobber the stored one. Matches the controller PATCH fix.
                if (KotlinGenUtil.isRequiredField(field)) {
                    append("            it[$table.${field.name}] = dto.${field.name}\n")
                } else {
                    append("            if (dto.${field.name} != null) it[$table.${field.name}] = dto.${field.name}\n")
                }
            }
            append("        }\n")
            append("        if (n == 0) null else $table.selectAll().where { $table.$pkFieldName eq id }.single().let(::rowTo$shortName)\n")
            append("    }\n\n")

            // --- patch (Exposed statement-lambda) ---
            append("    /**\n")
            append("     * Partial update — the block sets only the columns it names, e.g.\n")
            append("     * `repo.patch(id) { it[${table}.<col>] = value }`. A renamed or dropped column is a\n")
            append("     * COMPILE error, not a silently skipped write. Null if no such row.\n")
            append("     */\n")
            append("    open fun patch(id: $pkParamType, block: $table.(UpdateStatement) -> Unit): $shortName? = transaction {\n")
            append("        val n = $table.update({ $table.$pkFieldName eq id }, body = block)\n")
            append("        if (n == 0) null else $table.selectAll().where { $table.$pkFieldName eq id }.single().let(::rowTo$shortName)\n")
            append("    }\n\n")

            // --- delete ---
            append("    /** Delete by primary key; true if a row was removed. */\n")
            append("    open fun delete(id: $pkParamType): Boolean = transaction {\n")
            // `eq` must resolve through SqlExpressionBuilder inside deleteWhere's receiver (same
            // gotcha the controller documents — a bare `Table.pk eq id` is "Unresolved reference: eq").
            append("        $table.deleteWhere { with(SqlExpressionBuilder) { $table.$pkFieldName eq id } } > 0\n")
            append("    }\n")

            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$repoName.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, src)
    }

    /**
     * The Kotlin simple-name type of [entity]'s PK route parameter — the PK FIELD's own type via
     * [KotlinTypeMapper.kotlinTypeName] (uuid → `UUID`, long → `Long`, …), so a by-id parameter
     * matches the Exposed `Column<T>` it is compared against. Falls back to `Long` (historical
     * default) when the field can't be resolved. Mirrors the controller's helper of the same name.
     */
    private fun primaryKeyParamType(entity: MetaObject, pkFieldName: String): String {
        val pkField = entity.metaFields.firstOrNull { it.name == pkFieldName } ?: return "Long"
        return runCatching { KotlinTypeMapper.kotlinTypeName(pkField) }
            .map { tn -> (tn as? com.squareup.kotlinpoet.ClassName)?.simpleName ?: tn.toString() }
            .getOrDefault("Long")
    }

    private fun columnElementType(field: com.metaobjects.field.MetaField<*>): String =
        KotlinTypeMapper.kotlinTypeName(field).let { tn ->
            (tn as? com.squareup.kotlinpoet.ClassName)?.simpleName ?: tn.toString()
        }

    private companion object {
        const val DEFAULT_PK_FIELD = "id"

        @JvmStatic
        val LOG = LoggerFactory.getLogger(KotlinRepositoryGenerator::class.java)
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs (unused — emit() writes directly) ===
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
        KotlinNaming.repositoryBaseName(PackageMapping.splitFqn(md.name).second) + ".kt"
}

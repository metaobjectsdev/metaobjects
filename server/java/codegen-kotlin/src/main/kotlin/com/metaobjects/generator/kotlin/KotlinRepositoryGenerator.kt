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
            // #214 FR-024 §7: a write-through entity read-view is writable (own table source), so it
            // GETS a repository — writes target the `<Short>Table`, reads (mapper / findById /
            // re-reads) route to the `<Short>View`. Detected order-independently (NEVER
            // firstRdbSource). A plain view/materializedView projection stays a Phase-2 read-only
            // follow-up (skipped below).
            val writeThrough = entity.isWriteThrough
            if (!writeThrough) {
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

            emit(entity, outRoot, primary, writeThrough)
        }
    }

    private fun emit(entity: MetaObject, outRoot: Path, primary: MetaIdentity?, writeThrough: Boolean) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        // #214: writes target the `<Short>Table`; reads (rowTo / findById / the post-insert +
        // post-update re-reads) route to the `<Short>View`. For a vanilla entity both are the
        // table object, so the emitted repository is byte-identical.
        val writeObj = KotlinNaming.tableObjectName(shortName)
        val readObj = if (writeThrough) KotlinNaming.viewObjectName(shortName) else writeObj
        val repoName = KotlinNaming.repositoryBaseName(shortName)
        val pkFieldName = primary?.fields?.firstOrNull() ?: DEFAULT_PK_FIELD
        val pkParamType = primaryKeyParamType(entity, pkFieldName)

        // Scalar columns only — ObjectField / MapField carry a jsonb/flattened shape the mapper
        // does not handle in v1 (the controller's rowTo makes the same exclusion).
        // #214 read/write split: the READ set (rowTo, mapping the view row) carries ALL scalars
        // incl. derived; the WRITE set (insert / update / patch / @autoSet) EXCLUDES derived
        // fields — they have no column on the write table (computed by the view). Vanilla entity =
        // no derived fields, so the two sets are equal → byte-identical output.
        val readScalarFields = entity.metaFields.filter { it !is ObjectField && it !is MapField }
        val scalarFields = readScalarFields.filterNot { writeThrough && KotlinGenUtil.isDerivedField(it) }
        val hasUuidColumn = readScalarFields.any { columnElementType(it) == "UUID" }
        val uuidPk = primary?.isUuid == true
        val incrementPk = primary?.isIncrement == true

        // Issue #203: `@autoSet` timestamp columns are OWNED by the CRUD layer — the caller does
        // not supply them. onCreate columns are stamped once at insert (never rewritten); onUpdate
        // columns are stamped at every write (insert / update / patch). They are excluded from the
        // regular column loops and written by the shared `applyAutoSetColumns` helper instead.
        val autoSetFields = scalarFields.filter {
            it.name != pkFieldName && KotlinGenUtil.isAutoSetField(it)
        }
        val onCreateFields = autoSetFields.filter {
            KotlinGenUtil.autoSetPolicy(it) == KotlinGenUtil.AUTO_SET_ON_CREATE
        }
        val onUpdateFields = autoSetFields.filter {
            KotlinGenUtil.autoSetPolicy(it) == KotlinGenUtil.AUTO_SET_ON_UPDATE
        }
        val autoSetNames = autoSetFields.map { it.name }.toSet()
        val hasAutoSet = autoSetFields.isNotEmpty()
        val hasOnUpdate = onUpdateFields.isNotEmpty()

        // Emit the non-PK, non-autoSet ("regular") columns of an insert into the current builder,
        // then (when present) the shared autoSet stamping. `preserve` == insertPreserving: write
        // the autoSet columns verbatim from the dto rather than stamping now().
        fun StringBuilder.appendInsertColumns(preserve: Boolean) {
            for (field in scalarFields) {
                if (field.name == pkFieldName) continue
                if (field.name in autoSetNames) continue
                append("            it[$writeObj.${field.name}] = dto.${field.name}\n")
            }
            if (hasAutoSet) {
                append("            applyAutoSetColumns(it${if (preserve) ", dto, stampAutoSet = false" else ""})\n")
            }
        }

        // The whole insert transaction body, branching on `identity.primary @generation`. Shared by
        // `insert` (preserve=false → stamp) and `insertPreserving` (preserve=true → verbatim) so the
        // PK/read-back logic has one definition.
        fun StringBuilder.appendInsertBody(preserve: Boolean) {
            // Writes target the write table; the by-PK read-back routes to the read object
            // (the view for a write-through entity) so the returned entity carries derived fields.
            // #214 cross-port notes: (D4) the re-read keys on the SINGLE primary key
            // ($pkFieldName) — a write-through entity with a composite PK is out of scope here
            // (this repository already skips composite-PK entities), matching the other ports'
            // single-PK re-read. (D1) the re-read uses `.single()` — it assumes the replica view
            // surfaces the just-written row, TRUE for a plain `@kind:view` (a live query over the
            // table). A `@kind:materializedView` (unrefreshed) or a filtered replica that does not
            // surface the row throws here; that is an unsupported write-through replica shape (the
            // data-oriented ports degrade to the table row instead) — a documented limitation.
            when {
                incrementPk -> {
                    append("        val newId = $writeObj.insert {\n")
                    appendInsertColumns(preserve)
                    append("        }[$writeObj.$pkFieldName]\n")
                    append("        $readObj.selectAll().where { $readObj.$pkFieldName eq newId }.single().let(::rowTo$shortName)\n")
                }
                uuidPk -> {
                    append("        val newId = UUID.randomUUID()\n")
                    append("        $writeObj.insert {\n")
                    append("            it[$writeObj.$pkFieldName] = newId\n")
                    appendInsertColumns(preserve)
                    append("        }\n")
                    append("        $readObj.selectAll().where { $readObj.$pkFieldName eq newId }.single().let(::rowTo$shortName)\n")
                }
                else -> {
                    append("        $writeObj.insert {\n")
                    append("            it[$writeObj.$pkFieldName] = dto.$pkFieldName\n")
                    appendInsertColumns(preserve)
                    append("        }\n")
                    append("        $readObj.selectAll().where { $readObj.$pkFieldName eq dto.$pkFieldName }.single().let(::rowTo$shortName)\n")
                }
            }
        }

        val src = buildString {
            if (pkg.isNotEmpty()) append("package $pkg\n\n")

            append("import org.jetbrains.exposed.sql.ResultRow\n")
            append("import org.jetbrains.exposed.sql.SqlExpressionBuilder\n")
            append("import org.jetbrains.exposed.sql.deleteWhere\n")
            append("import org.jetbrains.exposed.sql.insert\n")
            append("import org.jetbrains.exposed.sql.selectAll\n")
            // The @autoSet stamping helper writes through the common insert/update supertype.
            if (hasAutoSet) append("import org.jetbrains.exposed.sql.statements.UpdateBuilder\n")
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
            // Reads the READ object's row (the view for a write-through entity) and maps ALL scalar
            // fields incl. derived — the derived columns live only on the view.
            append("    /** Map an Exposed ResultRow to the $shortName data class. */\n")
            append("    open fun rowTo$shortName(row: ResultRow): $shortName = $shortName(\n")
            for (field in readScalarFields) {
                append("        ${field.name} = row[$readObj.${field.name}],\n")
            }
            append("    )\n\n")

            // --- findById ---
            append("    /** The $shortName with this primary key, or null. */\n")
            append("    open fun findById(id: $pkParamType): $shortName? = transaction {\n")
            append("        $readObj.selectAll().where { $readObj.$pkFieldName eq id }.singleOrNull()?.let(::rowTo$shortName)\n")
            append("    }\n\n")

            // --- @autoSet stamping (issue #203) ---
            if (hasAutoSet) {
                append("    /**\n")
                append("     * Write the `@autoSet` timestamp columns of $shortName into an insert/update builder\n")
                append("     * (the CRUD layer owns them — the caller does not supply them). ONE column-list\n")
                append("     * definition shared by insert / insertPreserving / update / patch:\n")
                append("     *  - `stampAutoSet` — stamp `now()` (base CRUD) vs. write the [dto] value verbatim\n")
                append("     *    (insertPreserving, for import/restore/replication that keep original timestamps);\n")
                append("     *  - `includeOnCreate` — write the write-once onCreate columns (insert) or skip them\n")
                append("     *    (update/patch never rewrite created_at — the latent lost-update bug otherwise).\n")
                append("     * [dto] is only read on the verbatim path, so the stamping callers pass null.\n")
                append("     * `now()` is keyed off each COLUMN's temporal type, so it generalizes beyond Instant.\n")
                append("     */\n")
                append("    protected open fun applyAutoSetColumns(\n")
                append("        stmt: UpdateBuilder<*>,\n")
                append("        dto: $shortName? = null,\n")
                append("        stampAutoSet: Boolean = true,\n")
                append("        includeOnCreate: Boolean = true,\n")
                append("    ) {\n")
                if (onCreateFields.isNotEmpty()) {
                    append("        if (includeOnCreate) {\n")
                    for (field in onCreateFields) {
                        append("            stmt[$writeObj.${field.name}] = if (stampAutoSet) ${nowExpr(field)} else dto!!.${field.name}\n")
                    }
                    append("        }\n")
                }
                for (field in onUpdateFields) {
                    append("        stmt[$writeObj.${field.name}] = if (stampAutoSet) ${nowExpr(field)} else dto!!.${field.name}\n")
                }
                append("    }\n\n")
            }

            // --- insert (branches on @generation) ---
            // @autoSet columns are stamped now() by applyAutoSetColumns — a fresh row's onUpdate
            // column equals its onCreate column, and the dto's value for them is ignored (#203).
            append("    /** Insert a $shortName and return it with the persisted primary key. */\n")
            append("    open fun insert(dto: $shortName): $shortName = transaction {\n")
            appendInsertBody(preserve = false)
            append("    }\n\n")

            // --- insertPreserving (escape hatch; only when the entity declares @autoSet fields) ---
            if (hasAutoSet) {
                append("    /**\n")
                append("     * Insert a $shortName writing its `@autoSet` timestamp columns VERBATIM from the dto\n")
                append("     * instead of stamping `now()` — the import / restore / replication escape hatch that\n")
                append("     * must keep the original timestamps. Primary-key handling matches [insert].\n")
                append("     */\n")
                append("    open fun insertPreserving(dto: $shortName): $shortName = transaction {\n")
                appendInsertBody(preserve = true)
                append("    }\n\n")
            }

            // --- update (full-row, present-non-null) ---
            // @autoSet onUpdate columns are stamped now(); onCreate columns are SKIPPED entirely —
            // a full-row update never rewrites created_at from the dto's (possibly stale) value (#203).
            append("    /** Overwrite every column of the row (present-non-null merge). Null if no such row. */\n")
            append("    open fun update(id: $pkParamType, dto: $shortName): $shortName? = transaction {\n")
            append("        val n = $writeObj.update({ $writeObj.$pkFieldName eq id }) {\n")
            for (field in scalarFields) {
                if (field.name == pkFieldName) continue
                // @autoSet columns are owned by applyAutoSetColumns (onUpdate stamped, onCreate
                // skipped) — never in the caller-value merge loop.
                if (field.name in autoSetNames) continue
                // Required fields are non-null in the DTO → write unconditionally (a null-guard would
                // be an always-true `-Werror` warning). Optional fields are nullable → guard, so an
                // absent value does not clobber the stored one. Matches the controller PATCH fix.
                if (KotlinGenUtil.isRequiredField(field)) {
                    append("            it[$writeObj.${field.name}] = dto.${field.name}\n")
                } else {
                    append("            if (dto.${field.name} != null) it[$writeObj.${field.name}] = dto.${field.name}\n")
                }
            }
            if (hasOnUpdate) {
                append("            applyAutoSetColumns(it, includeOnCreate = false)\n")
            }
            append("        }\n")
            append("        if (n == 0) null else $readObj.selectAll().where { $readObj.$pkFieldName eq id }.single().let(::rowTo$shortName)\n")
            append("    }\n\n")

            // --- patch (Exposed statement-lambda) ---
            append("    /**\n")
            append("     * Partial update — the block sets only the columns it names, e.g.\n")
            append("     * `repo.patch(id) { it[${writeObj}.<col>] = value }`. A renamed or dropped column is a\n")
            append("     * COMPILE error, not a silently skipped write. Null if no such row.\n")
            if (hasOnUpdate) {
                append("     * `@autoSet` onUpdate columns are stamped BEFORE the block runs, so a partial\n")
                append("     * update still bumps them even if the block does not name them (#203).\n")
            }
            append("     */\n")
            append("    open fun patch(id: $pkParamType, block: $writeObj.(UpdateStatement) -> Unit): $shortName? = transaction {\n")
            if (hasOnUpdate) {
                // Stamp onUpdate first, then let the caller's block win on any column it names.
                append("        val n = $writeObj.update({ $writeObj.$pkFieldName eq id }) {\n")
                append("            applyAutoSetColumns(it, includeOnCreate = false)\n")
                append("            this.block(it)\n")
                append("        }\n")
            } else {
                append("        val n = $writeObj.update({ $writeObj.$pkFieldName eq id }, body = block)\n")
            }
            append("        if (n == 0) null else $readObj.selectAll().where { $readObj.$pkFieldName eq id }.single().let(::rowTo$shortName)\n")
            append("    }\n\n")

            // --- delete ---
            append("    /** Delete by primary key; true if a row was removed. */\n")
            append("    open fun delete(id: $pkParamType): Boolean = transaction {\n")
            // `eq` must resolve through SqlExpressionBuilder inside deleteWhere's receiver (same
            // gotcha the controller documents — a bare `Table.pk eq id` is "Unresolved reference: eq").
            append("        $writeObj.deleteWhere { with(SqlExpressionBuilder) { $writeObj.$pkFieldName eq id } } > 0\n")
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

    /**
     * The `now()` expression for [field]'s temporal COLUMN type (issue #203) — keyed off the
     * column, not any parameter, so it generalizes across every temporal subtype: `field.timestamp`
     * (default) → `java.time.Instant.now()`, `@localTime` → `java.time.LocalDateTime.now()`,
     * `field.date` → `java.time.LocalDate.now()`, `field.time` → `java.time.LocalTime.now()`. Each of
     * those `java.time` types exposes a static `now()`. Fully-qualified so no import bookkeeping is
     * needed (the four types would otherwise collide on simple names across generated repositories).
     */
    private fun nowExpr(field: com.metaobjects.field.MetaField<*>): String {
        val tn = KotlinTypeMapper.kotlinTypeName(field)
        val fqn = (tn as? com.squareup.kotlinpoet.ClassName)?.canonicalName ?: tn.toString()
        return "$fqn.now()"
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

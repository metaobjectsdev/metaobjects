package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.ExposedApi
import com.metaobjects.generator.util.GeneratorUtil
import com.metaobjects.generator.kotlin.ExposedImports
import com.metaobjects.generator.kotlin.KotlinGenUtil
import com.metaobjects.generator.kotlin.KotlinNaming
import com.metaobjects.generator.kotlin.KotlinTphPlan
import com.metaobjects.generator.kotlin.KotlinTypeMapper
import com.metaobjects.generator.kotlin.PackageMapping
import com.metaobjects.generator.kotlin.writer.KotlinWriter
import com.metaobjects.generator.writer.CodeWriter

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
import java.nio.file.Path
import java.nio.file.Paths
import org.slf4j.LoggerFactory
import com.metaobjects.generator.util.GeneratedFileWriter

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

    /**
     * Exposed output-API version (issue #390) — `0` (default) emits Exposed 0.x
     * (`org.jetbrains.exposed.sql.*`, byte-identical to every release before this arg
     * existed); `1` emits Exposed 1.x (`org.jetbrains.exposed.v1.*`). From the
     * `exposedApi` generator arg (`<args><exposedApi>1</exposedApi></args>` in the pom).
     */
    protected fun exposedApi(): ExposedApi = ExposedApi.parse(getArg(ExposedApi.ARG_EXPOSED_API))

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        for (entity in GeneratorUtil.ownMetaObjects(loader)) {
            if (!isSelected(entity)) continue
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
        val api = exposedApi()
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        // #214: writes target the `<Short>Table`; reads (rowTo / findById / the post-insert +
        // post-update re-reads) route to the `<Short>View`. For a vanilla entity both are the
        // table object, so the emitted repository is byte-identical.
        val writeObj = KotlinNaming.tableObjectName(shortName)
        val readObj = if (writeThrough) KotlinNaming.viewObjectName(shortName) else writeObj
        val repoName = KotlinNaming.repositoryBaseName(shortName)
        val pkFieldName = primary?.let { KotlinGenUtil.keyFields(entity, it).firstOrNull() } ?: DEFAULT_PK_FIELD
        val pkParamType = primaryKeyParamType(entity, pkFieldName)

        // Scalar columns only — ObjectField / MapField carry a jsonb/flattened shape the mapper
        // does not handle in v1 (the controller's rowTo makes the same exclusion).
        // #214 read/write split: the READ set (rowTo, mapping the view row) carries ALL scalars
        // incl. derived; the WRITE set (insert / update / patch / @autoSet) EXCLUDES derived
        // fields — they have no column on the write table (computed by the view). Vanilla entity =
        // no derived fields, so the two sets are equal → byte-identical output.
        val readScalarFields = KotlinGenUtil.columnFields(entity).filter { it !is ObjectField && it !is MapField }
        val scalarFields = readScalarFields.filterNot { KotlinGenUtil.isDerivedField(it) }
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

        val w = KotlinWriter().packageName(pkg)

        // Emit the non-PK, non-autoSet ("regular") columns of an insert into the current block,
        // then (when present) the shared autoSet stamping. `preserve` == insertPreserving: write
        // the autoSet columns verbatim from the dto rather than stamping now().
        fun insertColumns(preserve: Boolean) {
            for (field in scalarFields) {
                if (field.name == pkFieldName) continue
                if (field.name in autoSetNames) continue
                w.line("it[$writeObj.${field.name}] = dto.${field.name}")
            }
            if (hasAutoSet) {
                w.line("applyAutoSetColumns(it", if (preserve) ", dto, stampAutoSet = false" else "", ")")
            }
        }

        // The whole insert transaction body, branching on `identity.primary @generation`. Shared by
        // `insert` (preserve=false → stamp) and `insertPreserving` (preserve=true → verbatim) so the
        // PK/read-back logic has one definition.
        fun insertBody(preserve: Boolean) {
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
                    w.block("val newId = $writeObj.insert {", "}[$writeObj.$pkFieldName]") { insertColumns(preserve) }
                    w.line("$readObj.selectAll().where { $readObj.$pkFieldName eq newId }.single().let(::rowTo$shortName)")
                }
                uuidPk -> {
                    w.line("val newId = UUID.randomUUID()")
                    w.block("$writeObj.insert {") {
                        w.line("it[$writeObj.$pkFieldName] = newId")
                        insertColumns(preserve)
                    }
                    w.line("$readObj.selectAll().where { $readObj.$pkFieldName eq newId }.single().let(::rowTo$shortName)")
                }
                else -> {
                    w.block("$writeObj.insert {") {
                        w.line("it[$writeObj.$pkFieldName] = dto.$pkFieldName")
                        insertColumns(preserve)
                    }
                    w.line("$readObj.selectAll().where { $readObj.$pkFieldName eq dto.$pkFieldName }.single().let(::rowTo$shortName)")
                }
            }
        }

        w.use(ExposedImports.core(api, "ResultRow"))
        // issue #390: under 1.x, SqlExpressionBuilder is gone from the operators'
        // perspective — eq/and/... are top-level imports and deleteWhere's lambda no
        // longer provides SqlExpressionBuilder as an implicit receiver (see [delete]).
        if (api == ExposedApi.V1) w.use(ExposedImports.core(api, "eq"))
        else w.use(ExposedImports.core(api, "SqlExpressionBuilder"))
        w.use(ExposedImports.jdbc(api, "deleteWhere"))
        w.use(ExposedImports.jdbc(api, "insert"))
        w.use(ExposedImports.jdbc(api, "selectAll"))
        // The @autoSet stamping helper writes through the common insert/update supertype.
        if (hasAutoSet) w.use(ExposedImports.statements(api, "UpdateBuilder"))
        w.use(ExposedImports.statements(api, "UpdateStatement"))
        w.use(ExposedImports.jdbc(api, "update"))
        w.use(ExposedImports.transactions(api, "transaction"))
        // java.util.UUID surfaces when the PK is a client-generated uuid, or any column is uuid.
        if (uuidPk || hasUuidColumn) w.use("java.util.UUID")

        w.doc(
            "GENERATED — persistence repository base for $shortName. Do not hand-edit.",
            "",
            "`open` so a consumer can subclass and override; NOT `@Repository` (a subclass",
            "would create an ambiguous bean — wiring is the consumer's, per FR-035 §8.2).",
        )
        w.block("open class $repoName {") {
            // --- row-mapper (verbatim shape from the controller's rowTo) ---
            // Reads the READ object's row (the view for a write-through entity) and maps ALL scalar
            // fields incl. derived — the derived columns live only on the view.
            w.doc("Map an Exposed ResultRow to the $shortName data class.")
            w.block("open fun rowTo$shortName(row: ResultRow): $shortName = $shortName(", ")") {
                for (field in readScalarFields) {
                    w.line("${field.name} = row[$readObj.${field.name}],")
                }
            }
            w.blank()

            // --- findById ---
            w.doc("The $shortName with this primary key, or null.")
            w.block("open fun findById(id: $pkParamType): $shortName? = transaction {") {
                w.line("$readObj.selectAll().where { $readObj.$pkFieldName eq id }.singleOrNull()?.let(::rowTo$shortName)")
            }
            w.blank()

            // --- @autoSet stamping (issue #203) ---
            if (hasAutoSet) {
                w.text(
                    """
                    /**
                     * Write the `@autoSet` timestamp columns of $shortName into an insert/update builder
                     * (the CRUD layer owns them — the caller does not supply them). ONE column-list
                     * definition shared by insert / insertPreserving / update / patch:
                     *  - `stampAutoSet` — stamp `now()` (base CRUD) vs. write the [dto] value verbatim
                     *    (insertPreserving, for import/restore/replication that keep original timestamps);
                     *  - `includeOnCreate` — write the write-once onCreate columns (insert) or skip them
                     *    (update/patch never rewrite created_at — the latent lost-update bug otherwise).
                     * [dto] is only read on the verbatim path, so the stamping callers pass null.
                     * `now()` is keyed off each COLUMN's temporal type, so it generalizes beyond Instant.
                     */
                    """
                )
                val params = CodeWriter.list(
                    "(",
                    listOf(
                        "stmt: UpdateBuilder<*>", "dto: $shortName? = null",
                        "stampAutoSet: Boolean = true", "includeOnCreate: Boolean = true",
                    ),
                    ")",
                )
                w.block(listOf("protected open fun applyAutoSetColumns", params, " {")) {
                    if (onCreateFields.isNotEmpty()) {
                        w.block("if (includeOnCreate) {") {
                            for (field in onCreateFields) {
                                w.line("stmt[$writeObj.${field.name}] = if (stampAutoSet) ${nowExpr(field)} else dto!!.${field.name}")
                            }
                        }
                    }
                    for (field in onUpdateFields) {
                        w.line("stmt[$writeObj.${field.name}] = if (stampAutoSet) ${nowExpr(field)} else dto!!.${field.name}")
                    }
                }
                w.blank()
            }

            // --- insert (branches on @generation) ---
            // @autoSet columns are stamped now() by applyAutoSetColumns — a fresh row's onUpdate
            // column equals its onCreate column, and the dto's value for them is ignored (#203).
            w.doc("Insert a $shortName and return it with the persisted primary key.")
            w.block("open fun insert(dto: $shortName): $shortName = transaction {") { insertBody(preserve = false) }
            w.blank()

            // --- insertPreserving (escape hatch; only when the entity declares @autoSet fields) ---
            if (hasAutoSet) {
                w.doc(
                    "Insert a $shortName writing its `@autoSet` timestamp columns VERBATIM from the dto",
                    "instead of stamping `now()` — the import / restore / replication escape hatch that",
                    "must keep the original timestamps. Primary-key handling matches [insert].",
                )
                w.block("open fun insertPreserving(dto: $shortName): $shortName = transaction {") { insertBody(preserve = true) }
                w.blank()
            }

            // --- update (full-row, present-non-null) ---
            // @autoSet onUpdate columns are stamped now(); onCreate columns are SKIPPED entirely —
            // a full-row update never rewrites created_at from the dto's (possibly stale) value (#203).
            w.doc("Overwrite every column of the row (present-non-null merge). Null if no such row.")
            w.block("open fun update(id: $pkParamType, dto: $shortName): $shortName? = transaction {") {
                w.block("val n = $writeObj.update({ $writeObj.$pkFieldName eq id }) {") {
                    for (field in scalarFields) {
                        if (field.name == pkFieldName) continue
                        // @autoSet columns are owned by applyAutoSetColumns (onUpdate stamped, onCreate
                        // skipped) — never in the caller-value merge loop.
                        if (field.name in autoSetNames) continue
                        // Required fields are non-null in the DTO → write unconditionally (a null-guard would
                        // be an always-true `-Werror` warning). Optional fields are nullable → guard, so an
                        // absent value does not clobber the stored one. Matches the controller PATCH fix.
                        if (KotlinGenUtil.isRequiredField(field)) {
                            w.line("it[$writeObj.${field.name}] = dto.${field.name}")
                        } else {
                            w.line("if (dto.${field.name} != null) it[$writeObj.${field.name}] = dto.${field.name}")
                        }
                    }
                    if (hasOnUpdate) w.line("applyAutoSetColumns(it, includeOnCreate = false)")
                }
                w.line("if (n == 0) null else $readObj.selectAll().where { $readObj.$pkFieldName eq id }.single().let(::rowTo$shortName)")
            }
            w.blank()

            // --- patch (Exposed statement-lambda) ---
            val patchDoc = mutableListOf(
                "Partial update — the block sets only the columns it names, e.g.",
                "`repo.patch(id) { it[$writeObj.<col>] = value }`. A renamed or dropped column is a",
                "COMPILE error, not a silently skipped write. Null if no such row.",
            )
            if (hasOnUpdate) {
                patchDoc += "`@autoSet` onUpdate columns are stamped BEFORE the block runs, so a partial"
                patchDoc += "update still bumps them even if the block does not name them (#203)."
            }
            w.doc(*patchDoc.toTypedArray())
            w.block("open fun patch(id: $pkParamType, block: $writeObj.(UpdateStatement) -> Unit): $shortName? = transaction {") {
                if (hasOnUpdate) {
                    // Stamp onUpdate first, then let the caller's block win on any column it names.
                    w.block("val n = $writeObj.update({ $writeObj.$pkFieldName eq id }) {") {
                        w.line("applyAutoSetColumns(it, includeOnCreate = false)")
                        w.line("this.block(it)")
                    }
                } else {
                    w.line("val n = $writeObj.update({ $writeObj.$pkFieldName eq id }, body = block)")
                }
                w.line("if (n == 0) null else $readObj.selectAll().where { $readObj.$pkFieldName eq id }.single().let(::rowTo$shortName)")
            }
            w.blank()

            // --- delete ---
            w.doc("Delete by primary key; true if a row was removed.")
            w.block("open fun delete(id: $pkParamType): Boolean = transaction {") {
                if (api == ExposedApi.V1) {
                    // issue #390: under 1.x `eq` is a plain top-level import — deleteWhere's lambda
                    // no longer provides an implicit SqlExpressionBuilder receiver, so the `with(...)`
                    // wrapper 0.x needed is both unnecessary and unavailable (SqlExpressionBuilder
                    // is not imported in this file under V1 — see the import block above).
                    w.line("$writeObj.deleteWhere { $writeObj.$pkFieldName eq id } > 0")
                } else {
                    // `eq` must resolve through SqlExpressionBuilder inside deleteWhere's receiver (same
                    // gotcha the controller documents — a bare `Table.pk eq id` is "Unresolved reference: eq").
                    w.line("$writeObj.deleteWhere { with(SqlExpressionBuilder) { $writeObj.$pkFieldName eq id } } > 0")
                }
            }
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$repoName.kt")
        GeneratedFileWriter.write(outFile, w.toString())
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
            .map { tn -> (tn as? com.metaobjects.generator.kotlin.writer.KotlinClassName)?.simpleName ?: tn.toString() }
            .getOrDefault("Long")
    }

    private fun columnElementType(field: com.metaobjects.field.MetaField<*>): String =
        KotlinTypeMapper.kotlinTypeName(field).let { tn ->
            (tn as? com.metaobjects.generator.kotlin.writer.KotlinClassName)?.simpleName ?: tn.toString()
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
        val fqn = (tn as? com.metaobjects.generator.kotlin.writer.KotlinClassName)?.canonicalName ?: tn.toString()
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

package com.metaobjects.generator.kotlin

import com.metaobjects.database.CoreDBMetaDataProvider
import com.metaobjects.field.EnumField
import com.metaobjects.field.ObjectField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.identity.MetaIdentity
import com.metaobjects.identity.ReferenceIdentity
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.CompositionRelationship
import com.metaobjects.relationship.MetaRelationship
import com.metaobjects.source.MetaSource
import com.metaobjects.source.RdbSource
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.slf4j.LoggerFactory

/**
 * Generator: one Exposed Table `object` per `object.entity` that has a `source.rdb` child.
 * Entities without source.rdb are skipped (no persistence layer).
 *
 * <p>Exposed's `Column<T>` types are inferred by the Kotlin compiler from the initialiser
 * expressions (e.g., `val name = varchar("name", 100)`). KotlinPoet's [com.squareup.kotlinpoet.PropertySpec]
 * requires an explicit type, which would force `val name: Column<String> = ...` — verbose and
 * brittle. Rather than fight the API, this generator hand-rolls the file body as a string;
 * the syntactic surface is small (~20 lines per file) and matches the idiomatic Exposed style.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
class KotlinExposedTableGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        // Pass 1a: identity.reference decorations — per-entity field→FK target
        // metadata used to decorate the field column with `.references(...)`
        // inline (rather than emit a separate FK row, which would duplicate the
        // field's regular column emission).
        val refDecorMap = buildIdentityReferenceDecorations(loader)

        // Pass 1b: compute FK columns globally across all entities so the "many"
        // side (`relationship.composition @cardinality: many`) on Author can
        // contribute the FK column to PostTable even when Post has no reciprocal.
        val fkMap = buildGlobalFkMap(loader, refDecorMap)

        // Pass 2: emit one Table per entity using its own metadata + the
        // inbound FKs accumulated in Pass 1.
        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            val sourceRdb = entity.children.filterIsInstance<RdbSource>().firstOrNull() ?: continue
            val kind = sourceRdb.effectiveKind
            // table + view + materializedView → emit; view-like kinds are emitted read-only.
            // storedProc → skip; consumer should wire KotlinStoredProcGenerator for those entities.
            // tableFunction → skip with a warning (no dedicated generator yet).
            if (kind != MetaSource.KIND_TABLE && !isViewKind(sourceRdb)) {
                if (kind == MetaSource.KIND_STORED_PROC) {
                    LOG.warn(
                        "skipping {} — source.rdb @kind='storedProc' is not handled by KotlinExposedTableGenerator; use KotlinStoredProcGenerator for stored procs",
                        entity.name
                    )
                } else {
                    LOG.warn(
                        "skipping {} — source.rdb @kind='{}' is not supported by KotlinExposedTableGenerator (table/view/materializedView only)",
                        entity.name, kind
                    )
                }
                continue
            }
            val fkColumns = if (isViewKind(sourceRdb)) emptyList() else fkMap[entity.name].orEmpty()
            val refDecorations =
                if (isViewKind(sourceRdb)) emptyMap() else refDecorMap[entity.name].orEmpty()
            emit(entity, sourceRdb, outRoot, loader, fkColumns, refDecorations)
        }
    }

    /**
     * True when {@code source.rdb @kind} names a view-like construct
     * (view / materializedView). View-like sources are read-only: the generator
     * emits the Table declaration without auto-increment on the PK and without
     * FK constraints (views inherit FKs from their underlying tables; declaring
     * them again on the view confuses Exposed and serves no purpose).
     */
    private fun isViewKind(sourceRdb: RdbSource): Boolean {
        val k = sourceRdb.effectiveKind
        return k == MetaSource.KIND_VIEW || k == MetaSource.KIND_MATERIALIZED_VIEW
    }

    private fun emit(
        entity: MetaObject,
        sourceRdb: RdbSource,
        outRoot: Path,
        loader: MetaDataLoader,
        fkColumns: List<FkColumnSpec>,
        refDecorations: Map<String, RefDecoration>,
    ) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val isView = isViewKind(sourceRdb)
        val tableObjectName = shortName + "Table"
        val tableName = sourceRdb.tableName ?: (shortName.lowercase() + "s")

        val primary = entity.children
            .filterIsInstance<MetaIdentity>()
            .firstOrNull { it.isPrimary }
        val primaryFieldName = primary?.fields?.firstOrNull()
        // Views inherit PKs from underlying tables — never emit autoIncrement on a
        // view column, even when @generation=increment is declared on the primary
        // identity (a relic of the parent entity's declaration).
        val incrementPk = primary?.isIncrement == true && !isView

        val objectColumns = buildObjectColumns(entity, primaryFieldName, loader)
        val needsJsonbImport = objectColumns.any { it.kind == ObjectColumnKind.JSONB }
        val needsRefOptForDecor = refDecorations.values.any { it.hasReferenceOption }

        // Walk every field that will actually become a Table column and collect the
        // imports its column function requires. Member functions on Table (varchar,
        // integer, long, etc.) return null and are skipped; extension functions from
        // org.jetbrains.exposed.sql.javatime (date / timestampWithTimeZone / ...)
        // return their FQN so the generated file imports them. Without this the
        // generated tables compile-fail with unresolved-reference errors. Flattened
        // object sub-fields are walked too — they emit columns of their own.
        val columnFunctionImports = sortedSetOf<String>()
        for (field in entity.metaFields) {
            if (field is ObjectField) continue
            // EnumField uses enumerationByName (a Table member) when generated, regardless
            // of what the type-mapper would return for a bare column emission — skip it
            // here so it doesn't accidentally drag in a non-applicable import.
            if (field is EnumField) continue
            KotlinTypeMapper.exposedColumnImport(field)?.let { columnFunctionImports += it }
        }
        // Flattened object sub-columns also contribute column functions (and thus
        // potentially imports). Walk the field.object children's referenced object.value
        // sub-fields the same way buildObjectColumns does.
        for (field in entity.metaFields) {
            if (field !is ObjectField) continue
            if (readStorage(field) != STORAGE_FLATTENED) continue
            val ref = readObjectRef(field) ?: continue
            val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref) ?: continue
            for (subField in target.metaFields) {
                if (subField is EnumField) continue
                KotlinTypeMapper.exposedColumnImport(subField)?.let { columnFunctionImports += it }
            }
        }

        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import org.jetbrains.exposed.sql.Table\n")
            if (fkColumns.any { it.hasReferenceOption } || needsRefOptForDecor) {
                append("import org.jetbrains.exposed.sql.ReferenceOption\n")
            }
            for (imp in columnFunctionImports) {
                append("import $imp\n")
            }
            if (needsJsonbImport) {
                append("import org.jetbrains.exposed.sql.json.jsonb\n")
                append("import kotlinx.serialization.json.Json\n")
            }
            append("\n")
            if (isView) {
                append("/** READ-ONLY VIEW — generated from view metadata; do not insert/update/delete directly. */\n")
            }
            append("/** GENERATED — do not hand-edit. Regenerated from metadata. */\n")
            append("object $tableObjectName : Table(\"$tableName\") {\n")
            for (field in entity.metaFields) {
                // ObjectField columns are produced by buildObjectColumns() so we can emit
                // @storage flattened (N columns) or jsonb (1 column) uniformly.
                if (field is ObjectField) continue
                val isPk = field.name == primaryFieldName
                val nullable = !isPk && !KotlinGenUtil.isRequiredField(field)
                val baseSpec = if (field is EnumField) {
                    // field.enum → typed Exposed enumerationByName column referencing the
                    // generated enum class. Length matches the historical VARCHAR fallback
                    // (KotlinTypeMapper.ENUM_VARCHAR_LEN). Same-package class reference, so
                    // no import is required.
                    val enumName = KotlinTypeMapper.enumTypeName(field, entity)?.simpleName
                        ?: error("enumTypeName returned null for EnumField '${field.name}' on ${entity.name}")
                    "enumerationByName(\"${field.name}\", ${KotlinTypeMapper.ENUM_VARCHAR_LEN}, $enumName::class)"
                } else {
                    KotlinTypeMapper.exposedColumnSpec(field)
                }
                val withAuto = if (isPk && incrementPk) "$baseSpec.autoIncrement()" else baseSpec
                // Decorate with .references(TargetTable.id[, onDelete=..., onUpdate=...])
                // when an identity.reference on this entity names this field. The FK
                // decoration applies BEFORE .nullable() so the chain reads naturally.
                val decorated = refDecorations[field.name]?.let { d ->
                    "$withAuto.references(${d.targetTable}.id${d.refSuffix})"
                } ?: withAuto
                val full = if (nullable) "$decorated.nullable()" else decorated
                append("    val ${field.name} = $full\n")
            }
            for (oc in objectColumns) {
                append("    val ${oc.propertyName} = ${oc.columnExpr}\n")
            }
            for (fk in fkColumns) {
                append("    val ${fk.propertyName} = ${fk.columnExpr}\n")
            }
            if (primaryFieldName != null) {
                append("\n    override val primaryKey = PrimaryKey($primaryFieldName)\n")
            }
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$tableObjectName.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, source)
    }

    // === field.object + @storage column emission ============================

    private enum class ObjectColumnKind { FLATTENED, JSONB }

    /** A single Exposed column derived from a `field.object` (one per flattened sub-field, or one total for jsonb). */
    private data class ObjectColumnSpec(
        val propertyName: String,
        val columnExpr: String,
        val kind: ObjectColumnKind,
    )

    /**
     * Build the Exposed columns contributed by each `field.object` on [entity].
     *
     * <ul>
     *   <li>{@code @storage="flattened"}: one column per field of the referenced
     *       `object.value`, with property name {@code <parentField><SubFieldCap>} and
     *       physical column {@code <parentField>_<subField>} (snake-joined). Nullable
     *       sub-fields → nullable columns.</li>
     *   <li>{@code @storage="jsonb"} or absent (default-to-jsonb per CLAUDE.md):
     *       one {@code jsonb(name, encoder, decoder)} column using kotlinx.serialization Json.</li>
     * </ul>
     *
     * Skips field.object children whose `@objectRef` cannot be resolved (defensive — the loader's
     * validation phase already gates the attr being present).
     */
    private fun buildObjectColumns(
        entity: MetaObject,
        primaryFieldName: String?,
        loader: MetaDataLoader,
    ): List<ObjectColumnSpec> {
        val result = mutableListOf<ObjectColumnSpec>()
        for (field in entity.metaFields) {
            if (field !is ObjectField) continue
            val parentName = field.name
            val parentNullable = parentName != primaryFieldName && !KotlinGenUtil.isRequiredField(field)
            val storage = readStorage(field)        // null → default to jsonb
            if (storage == STORAGE_FLATTENED) {
                val ref = readObjectRef(field) ?: continue
                val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref) ?: continue
                for (subField in target.metaFields) {
                    val propertyName = parentName + subField.name.replaceFirstChar { it.uppercase() }
                    val colName = parentName + "_" + subField.name
                    val baseSpec = KotlinTypeMapper.exposedColumnSpec(subField, colName)
                    // Sub-column is nullable iff the parent is nullable OR the sub-field itself is.
                    val nullable = parentNullable || !KotlinGenUtil.isRequiredField(subField)
                    val full = if (nullable) "$baseSpec.nullable()" else baseSpec
                    result.add(ObjectColumnSpec(propertyName, full, ObjectColumnKind.FLATTENED))
                }
            } else {
                // jsonb (explicit) OR absent (default per CLAUDE.md back-compat rule).
                val expr = "jsonb(\"$parentName\", { Json.encodeToString(it) }, { Json.decodeFromString(it) })"
                val full = if (parentNullable) "$expr.nullable()" else expr
                result.add(ObjectColumnSpec(parentName, full, ObjectColumnKind.JSONB))
            }
        }
        return result
    }

    /** Read the `@storage` attr (own-only); null when absent. */
    private fun readStorage(field: ObjectField): String? {
        if (!field.hasMetaAttr(ATTR_STORAGE, false)) return null
        return runCatching { field.getMetaAttr(ATTR_STORAGE, false).valueAsString }.getOrNull()
    }

    /** Read the `@objectRef` attr (own-only); null when absent. */
    private fun readObjectRef(field: ObjectField): String? {
        if (!field.hasMetaAttr(ObjectField.ATTR_OBJECTREF, false)) return null
        return runCatching { field.getMetaAttr(ObjectField.ATTR_OBJECTREF, false).valueAsString }
            .getOrNull()
    }

    private companion object {
        /** Cross-language @storage attr on field.object — values: flattened | jsonb (default). */
        const val ATTR_STORAGE = "storage"
        const val STORAGE_FLATTENED = "flattened"

        @JvmStatic
        val LOG = LoggerFactory.getLogger(KotlinExposedTableGenerator::class.java)
    }

    // === FK column emission from relationship.composition ====================

    /** A foreign-key column derived from a `relationship.composition` child. */
    private data class FkColumnSpec(
        val propertyName: String,
        val columnExpr: String,
        val hasReferenceOption: Boolean,
        /**
         * `true` when authored directly on the FK-owning entity (to-one side);
         * `false` when inferred from the inverse to-many declaration on the
         * other entity. Declared specs take precedence over inferred specs
         * pointing at the same target table.
         */
        val declared: Boolean,
        /**
         * Target table object the FK references (e.g. {@code "AuthorTable"}).
         * Used to suppress an inferred FK when a declared FK already covers
         * the same target table — the FK-owning side has already named the
         * relationship physically (possibly with a custom column name) and we
         * must not double-emit a second FK to the same parent.
         */
        val targetTable: String,
    )

    /**
     * Pass 1: build a global FK map keyed by FQN of the entity that should
     * carry the column. Combines two sources:
     *
     * <ul>
     *   <li><b>Declared</b> — every `relationship.composition @cardinality: one` (default)
     *       child on entity X contributes a column to {@code X}'s table pointing at
     *       {@code @objectRef}'s table. Same behavior as the old per-entity scan.</li>
     *   <li><b>Inferred</b> — every `relationship.composition @cardinality: many` on
     *       entity X contributes a column to the {@code @objectRef} entity's table
     *       (since the FK in a one-to-many lives on the many side). Column name
     *       defaults to {@code <X.shortNameLowercased>Id}; {@code @onDelete} /
     *       {@code @onUpdate} propagate so the side that authored the lifecycle
     *       intent (e.g. {@code "the parent cascades into its children"}) shapes
     *       the inferred FK.</li>
     * </ul>
     *
     * Dedup: when a column name on a given target entity is contributed by both
     * a declared (to-one) spec and an inferred (inverse to-many) spec, the
     * declared spec wins — the FK-owning entity authored its own physical name
     * and we don't double-emit.
     */
    private fun buildGlobalFkMap(
        loader: MetaDataLoader,
        refDecorMap: Map<String, Map<String, RefDecoration>>,
    ): Map<String, List<FkColumnSpec>> {
        // Use list-per-entity so the emit order is deterministic (insertion-ordered).
        val acc = linkedMapOf<String, MutableList<FkColumnSpec>>()

        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            for (child in entity.children) {
                if (child !is MetaRelationship) continue
                if (child.subType != CompositionRelationship.SUBTYPE_COMPOSITION) continue

                val objectRef = child.objectRef ?: continue
                val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, objectRef) ?: continue

                if (child.cardinality == MetaRelationship.CARDINALITY_MANY) {
                    // Inferred: FK belongs on `target`, pointing back at `entity`.
                    val spec = buildInverseFkSpec(entity, target, child) ?: continue
                    acc.getOrPut(target.name) { mutableListOf() }.add(spec)
                } else {
                    // Declared (cardinality "one" or unspecified): FK belongs on `entity`.
                    val spec = buildDeclaredFkSpec(target, child) ?: continue
                    acc.getOrPut(entity.name) { mutableListOf() }.add(spec)
                }
            }
        }

        // Dedup pass 1: a declared (to-one) FK suppresses any inferred FK pointing at
        // the same target table. Catches both shapes:
        //   (a) declared + inferred share a property name (rare but possible
        //       when the user picks `<owner>Id` themselves).
        //   (b) declared uses a custom column name (e.g. `creatorId`) — the
        //       inferred `<owner>Id` (e.g. `authorId`) must NOT also be
        //       emitted; the FK-owning side already named the relationship.
        // Dedup pass 2: an identity.reference decoration on a field column ALSO
        // suppresses any inferred FK to the same target table — the canonical
        // shape (Program many→Week, Week identity.reference→Program) would
        // otherwise emit `programId` twice on WeekTable (once as the decorated
        // field column, once as a separate FK row).
        return acc.mapValues { (entityName, specs) ->
            val declaredTargets = specs.filter { it.declared }.map { it.targetTable }.toSet()
            val declaredNames = specs.filter { it.declared }.map { it.propertyName }.toSet()
            val decoratedTargets = refDecorMap[entityName].orEmpty().values
                .map { it.targetTable }.toSet()
            val decoratedNames = refDecorMap[entityName].orEmpty().keys
            specs.filterNot { spec ->
                !spec.declared && (
                    spec.targetTable in declaredTargets || spec.propertyName in declaredNames ||
                    spec.targetTable in decoratedTargets || spec.propertyName in decoratedNames
                )
            }
        }
    }

    /**
     * Build the FK spec for a to-one (declared) composition relationship on the
     * FK-owning entity. Returns null when {@code @objectRef} fails to resolve.
     *
     * Naming: property name = {@code @column} attr (verbatim) if present, else
     * literal {@code <relationshipShortName>Id}. {@code shortName} is used
     * because relationship.name is fully-qualified after loading (e.g.
     * "acme::demo::author") and would produce an illegal Kotlin identifier with
     * "::" embedded.
     */
    private fun buildDeclaredFkSpec(target: MetaObject, rel: MetaRelationship): FkColumnSpec? {
        val targetTable = PackageMapping.splitFqn(target.name).second + "Table"
        val relShortName = rel.shortName ?: rel.name
        val propertyName = readColumnAttr(rel) ?: (relShortName + "Id")
        val refArgs = buildReferenceOptionArgs(rel)
        val expr = "long(\"$propertyName\").references($targetTable.id${refArgs.first})"
        return FkColumnSpec(
            propertyName = propertyName,
            columnExpr = expr,
            hasReferenceOption = refArgs.second,
            declared = true,
            targetTable = targetTable,
        )
    }

    /**
     * Build the FK spec for the inverse side of a to-many composition
     * relationship: when entity X declares `cardinality: many` to Y, Y's table
     * carries a column pointing back at X's table.
     *
     * Naming: column = {@code <ownerShortName.lowercased()>Id} (e.g. Author →
     * {@code "authorId"}). The to-many side is the lifecycle authority, so its
     * {@code @onDelete} / {@code @onUpdate} attrs propagate into the inferred
     * FK's ReferenceOption arguments.
     */
    private fun buildInverseFkSpec(
        owner: MetaObject,
        target: MetaObject,
        rel: MetaRelationship,
    ): FkColumnSpec? {
        val ownerShort = PackageMapping.splitFqn(owner.name).second
        val ownerTable = ownerShort + "Table"
        // Verify the same-named Table exists in the loader; we don't strictly need it,
        // but we want a deterministic skip when the owner entity has no source.rdb.
        if (owner.children.filterIsInstance<RdbSource>().firstOrNull() == null) return null
        val propertyName = ownerShort.replaceFirstChar { it.lowercaseChar() } + "Id"
        val refArgs = buildReferenceOptionArgs(rel)
        val expr = "long(\"$propertyName\").references($ownerTable.id${refArgs.first})"
        // `target` reference is kept in the signature for parity with the declared path
        // and to allow future per-target customization (e.g. nullability inference).
        @Suppress("UNUSED_PARAMETER") target
        return FkColumnSpec(
            propertyName = propertyName,
            columnExpr = expr,
            hasReferenceOption = refArgs.second,
            declared = false,
            targetTable = ownerTable,
        )
    }

    /**
     * Lower a relationship's {@code @onDelete} / {@code @onUpdate} into the
     * suffix portion of an Exposed {@code .references(...)} call.
     *
     * Returns {@code (suffix, hasReferenceOption)}. Suffix is either "" (no
     * options) or {@code ", onDelete = ..., onUpdate = ..."} ready to splice
     * after the target column.
     */
    private fun buildReferenceOptionArgs(rel: MetaRelationship): Pair<String, Boolean> {
        val refParts = mutableListOf<String>()
        val onDelete = rel.onDeleteRaw?.let { mapReferentialAction(it) }
        val onUpdate = rel.onUpdateRaw?.let { mapReferentialAction(it) }
        if (onDelete != null) refParts += "onDelete = ReferenceOption.$onDelete"
        if (onUpdate != null) refParts += "onUpdate = ReferenceOption.$onUpdate"
        val suffix = if (refParts.isEmpty()) "" else ", " + refParts.joinToString(", ")
        return suffix to refParts.isNotEmpty()
    }

    // === identity.reference FK decoration ====================================

    /**
     * Decoration applied to a regular field column when an `identity.reference`
     * names that field. The codegen appends `.references(targetTable.id[, refSuffix])`
     * to the field's column initializer (rather than emitting a separate FK row,
     * which would duplicate the column).
     */
    private data class RefDecoration(
        /** Target table object name (e.g. {@code "ProgramTable"}). */
        val targetTable: String,
        /** Suffix portion after the target column — either "" or {@code ", onDelete = ..., onUpdate = ..."}. */
        val refSuffix: String,
        /** True when {@code refSuffix} mentions a ReferenceOption (drives the import). */
        val hasReferenceOption: Boolean,
    )

    /**
     * Pass 1a: walk every entity's `identity.reference` children and build a
     * map of {@code entity.name -> (fieldName -> RefDecoration)} so the column
     * emission pass can decorate the matching field column inline.
     *
     * Single-field references only for v1; multi-field composite FKs ({@code @fields: "a,b"})
     * are deferred — they require Exposed's compound-FK API and are uncommon in practice.
     * The decoration silently skips such references (a future enhancement will warn).
     */
    private fun buildIdentityReferenceDecorations(
        loader: MetaDataLoader,
    ): Map<String, Map<String, RefDecoration>> {
        val acc = linkedMapOf<String, MutableMap<String, RefDecoration>>()
        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            for (child in entity.children) {
                if (child !is ReferenceIdentity) continue
                // Skip references that won't be physically enforced.
                if (!child.isEnforced) continue
                val fields = child.fields
                if (fields.size != 1) continue  // composite FK deferred
                val fieldName = fields[0]
                val targetEntityName = child.targetEntity ?: continue
                val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, targetEntityName) ?: continue
                // Skip when the target has no rdb source — Exposed cannot reference a non-table.
                if (target.children.filterIsInstance<RdbSource>().firstOrNull() == null) continue
                val targetTable = PackageMapping.splitFqn(target.name).second + "Table"
                val (suffix, hasRefOpt) = buildIdentityReferenceArgs(child)
                acc.getOrPut(entity.name) { linkedMapOf() }[fieldName] =
                    RefDecoration(targetTable, suffix, hasRefOpt)
            }
        }
        return acc
    }

    /**
     * Lower a {@link ReferenceIdentity}'s {@code @onDelete} / {@code @onUpdate}
     * attrs into the suffix portion of an Exposed {@code .references(...)} call.
     * Parallel to {@link #buildReferenceOptionArgs} for relationship.composition.
     */
    private fun buildIdentityReferenceArgs(ref: ReferenceIdentity): Pair<String, Boolean> {
        val refParts = mutableListOf<String>()
        val onDelete = ref.onDeleteRaw?.let { mapReferentialAction(it) }
        val onUpdate = ref.onUpdateRaw?.let { mapReferentialAction(it) }
        if (onDelete != null) refParts += "onDelete = ReferenceOption.$onDelete"
        if (onUpdate != null) refParts += "onUpdate = ReferenceOption.$onUpdate"
        val suffix = if (refParts.isEmpty()) "" else ", " + refParts.joinToString(", ")
        return suffix to refParts.isNotEmpty()
    }

    /** Read the `@column` attr on a relationship (inheritance allowed); null when absent. */
    private fun readColumnAttr(rel: MetaRelationship): String? {
        if (!rel.hasMetaAttr(CoreDBMetaDataProvider.COLUMN, true)) return null
        return runCatching { rel.getMetaAttr(CoreDBMetaDataProvider.COLUMN, true).valueAsString }
            .getOrNull()
    }

    /**
     * Map a kebab-case metadata referential action to Exposed's `ReferenceOption` name.
     * Metadata: `cascade | set-null | restrict | no-action` (per MetaRelationship).
     * Exposed: `CASCADE | SET_NULL | RESTRICT | NO_ACTION | SET_DEFAULT`.
     * Returns null for unknown values rather than throwing — keeps codegen resilient
     * against future-vocabulary metadata; the loader already validates the enum set.
     */
    private fun mapReferentialAction(kebab: String): String? = when (kebab) {
        MetaRelationship.ACTION_CASCADE    -> "CASCADE"
        MetaRelationship.ACTION_SET_NULL   -> "SET_NULL"
        MetaRelationship.ACTION_RESTRICT   -> "RESTRICT"
        MetaRelationship.ACTION_NO_ACTION  -> "NO_ACTION"
        else -> null
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
        PackageMapping.splitFqn(md.name).second + "Table.kt"
}

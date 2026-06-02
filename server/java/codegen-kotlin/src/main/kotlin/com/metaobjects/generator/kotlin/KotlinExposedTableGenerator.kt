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
        val refDecorationMap = buildIdentityReferenceDecorations(loader)

        // Pass 1b: compute FK columns globally across all entities so the "many"
        // side (`relationship.composition @cardinality: many`) on Author can
        // contribute the FK column to PostTable even when Post has no reciprocal.
        val fkMap = buildGlobalFkMap(loader, refDecorationMap)

        // Pass 2: emit one Table per entity using its own metadata + the
        // inbound FKs accumulated in Pass 1.
        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            // Abstract entities are inheritance scaffolding — never emit a persistence table.
            if (KotlinGenUtil.isAbstractEntity(entity)) continue
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
                if (isViewKind(sourceRdb)) emptyMap() else refDecorationMap[entity.name].orEmpty()
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
        // FR-016: getPhysicalName() implements the four-step rule (kind-matching
        // alias -> legacy @table -> snake_case(source.name) -> pluralize(snake_case(entity))),
        // so it returns a valid name for any rdb @kind. The local fallback is
        // kept as a defensive default for synthetic sources with no parent.
        val tableName = sourceRdb.physicalName?.takeIf { it.isNotEmpty() }
            ?: (shortName.lowercase() + "s")

        // Walk the `extends` chain so identities declared on an abstract base
        // entity (the BaseEntity pattern: `identity.primary` on `id`) are
        // picked up by tables for concrete entities that extend it. Own-only
        // collection misses inherited primary identities and the generated
        // table comes out with no `override val primaryKey = PrimaryKey(...)`
        // declaration. `getIdentities(true)` returns own + super-chain (with
        // MetaData's dedupe by type+name letting an own-declared identity
        // override an inherited one of the same name).
        val allIdentities = entity.getIdentities(true)
        val primary = allIdentities.firstOrNull { it.isPrimary }
        // Secondary identities → Exposed `uniqueIndex(name, col1, ...)` calls.
        // Views inherit uniqueness from their underlying tables; never emit
        // uniqueIndex on a view (Exposed can't add indexes to a view object).
        // Walks the `extends` chain via the same `getIdentities(true)` path
        // used for the primary identity so secondaries on an abstract base
        // entity (e.g. `Named` with `identity.secondary by_name`) are picked
        // up by concrete child tables. Stable order = declaration order.
        val secondaries = if (isView) emptyList() else allIdentities.filter { it.isSecondary }
        // Composite PKs (e.g. a junction table keyed by (userId, roleId)) must
        // emit `PrimaryKey(userId, roleId)` — earlier code only took the FIRST
        // field and silently truncated. Every PK-member field is non-nullable
        // (it's part of the primary key). autoIncrement only applies to the
        // single-field case; a composite tuple can't be auto-generated, so the
        // generator falls back to the LLM/DB-side default.
        val primaryFieldNames = primary?.fields.orEmpty()
        val primaryFieldSet = primaryFieldNames.toSet()
        val singlePrimaryFieldName = primaryFieldNames.singleOrNull()
        // Views inherit PKs from underlying tables — never emit autoIncrement on a
        // view column, even when @generation=increment is declared on the primary
        // identity (a relic of the parent entity's declaration).
        val incrementPk = primary?.isIncrement == true && !isView && singlePrimaryFieldName != null
        // R6 Plan 2a: a single-field uuid PK with @generation:uuid gets a server-side
        // gen_random_uuid() DEFAULT (the Postgres-side mint). Routed through the SAME
        // generation signal as increment — distinct only in the emitted column suffix.
        // Views never carry a generated default (they inherit the underlying PK).
        val uuidGeneratedPk = primary?.isUuid == true && !isView && singlePrimaryFieldName != null

        val objectColumns = buildObjectColumns(entity, primaryFieldSet, loader)
        val needsJsonbImport = objectColumns.any { it.kind == ObjectColumnKind.JSONB }
        val needsRefOptForDecor = refDecorations.values.any { it.hasReferenceOption }

        // Does any column on this table use the TZ-aware `@dbColumnType=timestamp_with_tz`
        // opt-in? If so the file must carry the file-local `instantWithTimeZone(...)` support
        // helper (a custom `Column<java.time.Instant>` whose DDL is `TIMESTAMP WITH TIME
        // ZONE`). Walk direct fields AND flattened object sub-fields (same surfaces that
        // contribute columns / imports above).
        var needsInstantTzHelper = entity.metaFields.any {
            it !is ObjectField && KotlinTypeMapper.usesInstantWithTimeZone(it)
        }
        if (!needsInstantTzHelper) {
            for (field in entity.metaFields) {
                if (field !is ObjectField) continue
                if (readStorage(field) != STORAGE_FLATTENED) continue
                val ref = readObjectRef(field) ?: continue
                val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref) ?: continue
                if (target.metaFields.any { KotlinTypeMapper.usesInstantWithTimeZone(it) }) {
                    needsInstantTzHelper = true
                    break
                }
            }
        }

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

        // Cross-package FK-target imports: when a `.references(...)` call (from
        // either an `identity.reference` decoration or a `relationship.composition`
        // FK column) points at a table that lives in a different Kotlin package,
        // the generated file must import the target's <TableName> symbol or the
        // bare reference fails to resolve. Same-package targets need no import
        // (the Kotlin compiler resolves them via the file's package). Soft
        // identity.reference decorations (targetFqn == null) emit no
        // `.references(...)` call and so contribute no import.
        val crossPackageTableImports = sortedSetOf<String>().apply {
            fun consider(targetFqn: String?, targetTable: String?) {
                if (targetFqn == null || targetTable == null) return
                val targetPkg = PackageMapping.splitFqn(targetFqn).first
                if (targetPkg.isNotEmpty() && targetPkg != pkg) {
                    add("$targetPkg.$targetTable")
                }
            }
            for (fk in fkColumns) consider(fk.targetFqn, fk.targetTable)
            for (decor in refDecorations.values) consider(decor.targetFqn, decor.targetTable)
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
            for (imp in crossPackageTableImports) {
                append("import $imp\n")
            }
            if (needsJsonbImport) {
                append("import org.jetbrains.exposed.sql.json.jsonb\n")
                append("import kotlinx.serialization.json.Json\n")
            }
            // R6 Plan 2a: the gen_random_uuid() server default uses CustomFunction +
            // UUIDColumnType, which need explicit imports (neither is a Table member).
            if (uuidGeneratedPk) {
                append("import org.jetbrains.exposed.sql.CustomFunction\n")
                append("import org.jetbrains.exposed.sql.UUIDColumnType\n")
            }
            // @dbColumnType=timestamp_with_tz emits a file-local `instantWithTimeZone(...)`
            // extension + custom `ColumnType<Instant>`; those need Column + Instant on import.
            if (needsInstantTzHelper) {
                append("import java.time.Instant\n")
                append("import org.jetbrains.exposed.sql.Column\n")
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
                val isPk = field.name in primaryFieldSet
                val nullable = !isPk && !KotlinGenUtil.isRequiredField(field)
                val baseSpec = if (field is EnumField) {
                    // field.enum → typed Exposed enumerationByName column referencing the
                    // generated enum class. Length matches the historical VARCHAR fallback
                    // (KotlinTypeMapper.ENUM_VARCHAR_LEN). Same-package class reference, so
                    // no import is required. Column name is snake_case-d for Postgres
                    // convention (matches the StringField/varchar path).
                    val enumName = KotlinTypeMapper.enumTypeName(field, entity)?.simpleName
                        ?: error("enumTypeName returned null for EnumField '${field.name}' on ${entity.name}")
                    val colName = KotlinGenUtil.camelToSnake(field.name)
                    "enumerationByName(\"$colName\", ${KotlinTypeMapper.ENUM_VARCHAR_LEN}, $enumName::class)"
                } else {
                    KotlinTypeMapper.exposedColumnSpec(field)
                }
                val withAuto = when {
                    isPk && incrementPk -> "$baseSpec.autoIncrement()"
                    // uuid PK + @generation:uuid → server-side gen_random_uuid() default.
                    isPk && uuidGeneratedPk -> "$baseSpec$GEN_RANDOM_UUID_DEFAULT_SUFFIX"
                    else -> baseSpec
                }
                // Decorate with .references(TargetTable.id[, onDelete=..., onUpdate=...])
                // when an enforced identity.reference on this entity names this field.
                // Soft references (@enforce: false) carry a null targetTable — the dedup
                // pass still uses the entry to suppress an inferred FK, but no physical
                // .references(...) call is emitted here. Decoration applies BEFORE
                // .nullable() so the chain reads naturally.
                val decoration = refDecorations[field.name]
                val decorated = if (decoration != null && decoration.emitsReference)
                    "$withAuto.references(${decoration.targetTable}.id${decoration.refSuffix})" else withAuto
                val full = if (nullable) "$decorated.nullable()" else decorated
                append("    val ${field.name} = $full\n")
            }
            for (oc in objectColumns) {
                append("    val ${oc.propertyName} = ${oc.columnExpr}\n")
            }
            for (fk in fkColumns) {
                append("    val ${fk.propertyName} = ${fk.columnExpr}\n")
            }
            if (primaryFieldNames.isNotEmpty()) {
                append("\n    override val primaryKey = PrimaryKey(${primaryFieldNames.joinToString(", ")})\n")
            }
            // Emit `init { uniqueIndex("<name>", col1, col2, ...) }` for every
            // identity.secondary. Single init block holds all calls so the
            // generated body stays compact. Skips secondaries whose fields list
            // is empty (defensive — the metadata constraint already requires
            // at least one field).
            val emittableSecondaries = secondaries.filter { it.fields.isNotEmpty() }
            if (emittableSecondaries.isNotEmpty()) {
                append("\n    init {\n")
                for (sec in emittableSecondaries) {
                    val cols = sec.fields.joinToString(", ")
                    // shortName strips the package prefix the loader adds
                    // (`acme::demo::by_name` → `by_name`) — same pattern used
                    // for relationship.composition's FK property name above.
                    val indexName = sec.shortName ?: sec.name
                    append("        uniqueIndex(\"$indexName\", $cols)\n")
                }
                append("    }\n")
            }
            append("}\n")

            // File-local support for `@dbColumnType=timestamp_with_tz`: a custom Exposed
            // column type that is a `Column<java.time.Instant>` (matches the Instant data
            // class — zero coercion) whose DDL is `TIMESTAMP WITH TIME ZONE` (preserves the
            // offset→UTC normalization persistence contract). Delegates ALL value / JDBC
            // handling to Exposed's tested `JavaInstantColumnType` and overrides only
            // `sqlType()`. Declared `private` (file-scoped) so multiple tables in one package
            // each carry their own copy without clashing.
            if (needsInstantTzHelper) {
                append(INSTANT_TZ_SUPPORT_BLOCK)
            }
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
        primaryFieldNames: Set<String>,
        loader: MetaDataLoader,
    ): List<ObjectColumnSpec> {
        val result = mutableListOf<ObjectColumnSpec>()
        for (field in entity.metaFields) {
            if (field !is ObjectField) continue
            val parentName = field.name
            val parentNullable = parentName !in primaryFieldNames && !KotlinGenUtil.isRequiredField(field)
            val storage = readStorage(field)        // null → default to jsonb
            if (storage == STORAGE_FLATTENED) {
                val ref = readObjectRef(field) ?: continue
                val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref) ?: continue
                for (subField in target.metaFields) {
                    val propertyName = parentName + subField.name.replaceFirstChar { it.uppercase() }
                    // Physical column name: snake-join parent + sub-field, both snake_case-d.
                    // E.g. parent "homeAddress" + sub "streetLine1" → "home_address_street_line1".
                    val colName = KotlinGenUtil.camelToSnake(parentName) + "_" +
                        KotlinGenUtil.camelToSnake(subField.name)
                    val baseSpec = KotlinTypeMapper.exposedColumnSpec(subField, colName)
                    // Sub-column is nullable iff the parent is nullable OR the sub-field itself is.
                    val nullable = parentNullable || !KotlinGenUtil.isRequiredField(subField)
                    val full = if (nullable) "$baseSpec.nullable()" else baseSpec
                    result.add(ObjectColumnSpec(propertyName, full, ObjectColumnKind.FLATTENED))
                }
            } else {
                // jsonb (explicit) OR absent (default per CLAUDE.md back-compat rule).
                // Physical column name snake_case-d to match the rest of the column emission.
                val colName = KotlinGenUtil.camelToSnake(parentName)
                val expr = "jsonb(\"$colName\", { Json.encodeToString(it) }, { Json.decodeFromString(it) })"
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

        /**
         * Exposed column suffix that renders a Postgres `DEFAULT gen_random_uuid()`
         * server-side mint on a native uuid column (R6 Plan 2a, `@generation: uuid`).
         * `CustomFunction("gen_random_uuid", UUIDColumnType())` emits the bare SQL
         * function call; `.defaultExpression(...)` makes it the column DEFAULT.
         */
        const val GEN_RANDOM_UUID_DEFAULT_SUFFIX =
            ".defaultExpression(CustomFunction(\"gen_random_uuid\", UUIDColumnType()))"

        @JvmStatic
        val LOG = LoggerFactory.getLogger(KotlinExposedTableGenerator::class.java)

        /**
         * File-local support emitted into a generated table file that has at least one
         * `@dbColumnType=timestamp_with_tz` column. Defines:
         *
         *  - `MetaInstantWithTimeZoneColumnType` — a `ColumnType<Instant>` that delegates ALL
         *    value/JDBC handling (read, bind, normalize, millisecond-truncate, wire string) to
         *    Exposed's tested `JavaInstantColumnType`, overriding ONLY `sqlType()` to return the
         *    dialect's `TIMESTAMP WITH TIME ZONE` (Postgres: `timestamp with time zone`). This
         *    yields a `Column<Instant>` — matching the `Instant` data-class property (no
         *    `Instant`↔`OffsetDateTime` coercion) — while keeping the TZ-aware column so the
         *    seeded-offset → read-back-UTC normalization contract holds.
         *  - `Table.instantWithTimeZone(name)` — the column-builder extension the generated
         *    table calls (`val createdAt = instantWithTimeZone("created_at")`).
         *
         * Declared `private` (file-scoped) so two tables in the same package each carry their
         * own copy without a top-level name clash. Note: the GENERATED `$` lines below have no
         * Kotlin string templates, so this trimMargin block is emitted verbatim.
         */
        val INSTANT_TZ_SUPPORT_BLOCK: String = """

            |/**
            | * GENERATED — do not hand-edit.
            | * Custom Exposed column type for `@dbColumnType=timestamp_with_tz`: a
            | * `Column<java.time.Instant>` whose SQL DDL is `TIMESTAMP WITH TIME ZONE`.
            | * Delegates all value/JDBC handling to Exposed's `JavaInstantColumnType` and
            | * overrides only `sqlType()`, so the column type matches the `Instant` data-class
            | * property (no Instant↔OffsetDateTime coercion) while staying timezone-aware.
            | */
            |private class MetaInstantWithTimeZoneColumnType :
            |    org.jetbrains.exposed.sql.ColumnType<Instant>(),
            |    org.jetbrains.exposed.sql.IDateColumnType {
            |    private val delegate = org.jetbrains.exposed.sql.javatime.JavaInstantColumnType()
            |    override val hasTimePart: Boolean get() = delegate.hasTimePart
            |    override fun sqlType(): String =
            |        org.jetbrains.exposed.sql.vendors.currentDialect.dataTypeProvider.timestampWithTimeZoneType()
            |    override fun valueFromDB(value: Any): Instant? = delegate.valueFromDB(value)
            |    override fun notNullValueToDB(value: Instant): Any = delegate.notNullValueToDB(value)
            |    override fun nonNullValueToString(value: Instant): String = delegate.nonNullValueToString(value)
            |    override fun nonNullValueAsDefaultString(value: Instant): String =
            |        delegate.nonNullValueAsDefaultString(value)
            |    override fun readObject(rs: java.sql.ResultSet, index: Int): Any? = delegate.readObject(rs, index)
            |    override fun setParameter(
            |        stmt: org.jetbrains.exposed.sql.statements.api.PreparedStatementApi,
            |        index: Int,
            |        value: Any?,
            |    ) = delegate.setParameter(stmt, index, value)
            |}
            |
            |/**
            | * Column builder for `@dbColumnType=timestamp_with_tz`: a `Column<Instant>` backed by
            | * a `TIMESTAMP WITH TIME ZONE` Postgres column (see [MetaInstantWithTimeZoneColumnType]).
            | */
            |private fun org.jetbrains.exposed.sql.Table.instantWithTimeZone(name: String): Column<Instant> =
            |    registerColumn(name, MetaInstantWithTimeZoneColumnType())
            |""".trimMargin()
    }

    // === FK column emission from relationship.composition ====================

    /** A foreign-key column derived from a `relationship.composition` child. */
    private data class FkColumnSpec(
        val propertyName: String,
        val columnExpr: String,
        /**
         * Suffix appended after the target column inside `.references(...)`; either
         * "" or {@code ", onDelete = ..., onUpdate = ..."}. Non-empty implies the
         * file must import {@code ReferenceOption}.
         */
        val refSuffix: String,
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
        /**
         * Metadata FQN of the target entity (e.g. {@code "acme::blog::Author"}).
         * Used by the emit pass to add a cross-package Kotlin import when the
         * target table lives in a different package than the entity owning the FK.
         */
        val targetFqn: String,
    ) {
        /** True when {@link #refSuffix} mentions a ReferenceOption (drives the import). */
        val hasReferenceOption: Boolean get() = refSuffix.isNotEmpty()
    }

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
        refDecorationMap: Map<String, Map<String, RefDecoration>>,
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
                    val spec = buildInverseFkSpec(entity, child) ?: continue
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
        // field column, once as a separate FK row). Soft references (no targetTable)
        // still suppress by FIELD NAME — the field column already exists so the
        // inferred FK row would duplicate the column.
        return acc.mapValues { (entityName, specs) ->
            val declaredTargets = specs.asSequence().filter { it.declared }.map { it.targetTable }.toSet()
            val declaredNames = specs.asSequence().filter { it.declared }.map { it.propertyName }.toSet()
            val decorations = refDecorationMap[entityName].orEmpty()
            val decoratedTargets = decorations.values.mapNotNull { it.targetTable }.toSet()
            val decoratedNames = decorations.keys
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
        val colName = KotlinGenUtil.camelToSnake(propertyName)
        val refSuffix = referentialActionSuffix(rel.onDeleteRaw, rel.onUpdateRaw)
        return FkColumnSpec(
            propertyName = propertyName,
            columnExpr = "long(\"$colName\").references($targetTable.id$refSuffix)",
            refSuffix = refSuffix,
            declared = true,
            targetTable = targetTable,
            targetFqn = target.name,
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
    private fun buildInverseFkSpec(owner: MetaObject, rel: MetaRelationship): FkColumnSpec? {
        // Skip when the owner has no rdb source — there would be no OwnerTable to reference.
        if (owner.children.filterIsInstance<RdbSource>().firstOrNull() == null) return null
        val ownerShort = PackageMapping.splitFqn(owner.name).second
        val ownerTable = ownerShort + "Table"
        val propertyName = ownerShort.replaceFirstChar { it.lowercaseChar() } + "Id"
        val colName = KotlinGenUtil.camelToSnake(propertyName)
        val refSuffix = referentialActionSuffix(rel.onDeleteRaw, rel.onUpdateRaw)
        return FkColumnSpec(
            propertyName = propertyName,
            columnExpr = "long(\"$colName\").references($ownerTable.id$refSuffix)",
            refSuffix = refSuffix,
            declared = false,
            targetTable = ownerTable,
            targetFqn = owner.name,
        )
    }

    /**
     * Lower a pair of {@code @onDelete} / {@code @onUpdate} raw attr values
     * (kebab-case per the metamodel, e.g. {@code "cascade"} / {@code "set-null"})
     * into the suffix portion of an Exposed {@code .references(...)} call.
     *
     * Returns either "" (no options) or {@code ", onDelete = ..., onUpdate = ..."}
     * ready to splice after the target column. Shared by both
     * `relationship.composition` (declared + inferred) and `identity.reference`
     * paths so the lowering rules stay in lockstep.
     */
    private fun referentialActionSuffix(onDeleteRaw: String?, onUpdateRaw: String?): String {
        val parts = mutableListOf<String>()
        onDeleteRaw?.let { mapReferentialAction(it) }?.let { parts += "onDelete = ReferenceOption.$it" }
        onUpdateRaw?.let { mapReferentialAction(it) }?.let { parts += "onUpdate = ReferenceOption.$it" }
        return if (parts.isEmpty()) "" else ", " + parts.joinToString(", ")
    }

    // === identity.reference FK decoration ====================================

    /**
     * Decoration applied to a regular field column when an `identity.reference`
     * names that field. The codegen appends `.references(targetTable.id[, refSuffix])`
     * to the field's column initializer (rather than emitting a separate FK row,
     * which would duplicate the column).
     *
     * A {@code null} {@link #targetTable} indicates a soft reference (`@enforce: false`):
     * the entry still occupies the field-name key so dedup against an inferred FK works,
     * but the column emission pass skips the `.references(...)` decoration.
     */
    private data class RefDecoration(
        /** Target table object name (e.g. {@code "ProgramTable"}); null for soft refs. */
        val targetTable: String?,
        /** Suffix portion after the target column — either "" or {@code ", onDelete = ..., onUpdate = ..."}. */
        val refSuffix: String,
        /**
         * Metadata FQN of the target entity (e.g. {@code "acme::edu::Program"}); null for soft refs.
         * Used by the emit pass to add a cross-package Kotlin import when the target table lives
         * in a different package than the entity owning the decorated field.
         */
        val targetFqn: String?,
    ) {
        /** True when {@link #refSuffix} mentions a ReferenceOption (drives the import). */
        val hasReferenceOption: Boolean get() = refSuffix.isNotEmpty()
        /** True when this decoration emits a `.references(...)` call (enforced + resolvable). */
        val emitsReference: Boolean get() = targetTable != null
    }

    /**
     * Pass 1a: walk every entity's `identity.reference` children and build a
     * map of {@code entity.name -> (fieldName -> RefDecoration)} so the column
     * emission pass can decorate the matching field column inline.
     *
     * Single-field references only for v1; multi-field composite FKs
     * ({@code @fields: "a,b"}) are deferred — they require Exposed's compound-FK
     * API and are uncommon in practice. Skipped composites are logged as a WARN
     * so a user authoring `@fields: ["a", "b"]` isn't silently ignored.
     *
     * Soft references ({@code @enforce: false}) still register an entry (with
     * {@code targetTable = null}) so the FK-dedup pass can suppress a redundant
     * inferred FK to the same column — but the column emission pass skips
     * decoration so no physical constraint is generated.
     */
    private fun buildIdentityReferenceDecorations(
        loader: MetaDataLoader,
    ): Map<String, Map<String, RefDecoration>> {
        val acc = linkedMapOf<String, MutableMap<String, RefDecoration>>()
        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            for (child in entity.children) {
                if (child !is ReferenceIdentity) continue
                val fields = child.fields
                if (fields.size != 1) {
                    LOG.warn(
                        "skipping identity.reference '{}' on {} — multi-field composite FKs (@fields={}) are not yet supported by KotlinExposedTableGenerator",
                        child.name, entity.name, fields
                    )
                    continue
                }
                val fieldName = fields[0]
                val targetEntityName = child.targetEntity ?: continue
                val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, targetEntityName) ?: continue
                // Skip when the target has no rdb source — Exposed cannot reference a non-table.
                if (target.children.filterIsInstance<RdbSource>().firstOrNull() == null) continue
                // Soft references register a null-targetTable entry so dedup-vs-inferred works,
                // but column emission will skip the `.references(...)` decoration.
                val targetTable = if (child.isEnforced)
                    PackageMapping.splitFqn(target.name).second + "Table" else null
                val targetFqn = if (child.isEnforced) target.name else null
                val refSuffix = if (child.isEnforced)
                    referentialActionSuffix(child.onDeleteRaw, child.onUpdateRaw) else ""
                acc.getOrPut(entity.name) { linkedMapOf() }[fieldName] =
                    RefDecoration(targetTable, refSuffix, targetFqn)
            }
        }
        return acc
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

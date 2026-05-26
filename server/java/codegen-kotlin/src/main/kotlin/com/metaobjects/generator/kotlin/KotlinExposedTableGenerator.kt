package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.identity.MetaIdentity
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.MetaRelationship
import com.metaobjects.source.MetaSource
import com.metaobjects.source.RdbSource
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

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
        for (entity in loader.metaObjects) {
            if (entity.subType != "entity") continue
            val sourceRdb = findRdbSource(entity) ?: continue
            emit(entity, sourceRdb, outRoot, loader)
        }
    }

    private fun emit(entity: MetaObject, sourceRdb: MetaSource, outRoot: Path, loader: MetaDataLoader) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val tableObjectName = shortName + "Table"
        val tableName = sourceRdb.tableName ?: (shortName.lowercase() + "s")

        val primary = findPrimaryIdentity(entity)
        val primaryFieldName = primary?.fields?.firstOrNull()
        val incrementPk = primary?.generation == MetaIdentity.GENERATION_INCREMENT

        val fkColumns = buildFkColumns(entity, loader)
        val objectColumns = buildObjectColumns(entity, primaryFieldName, loader)
        val needsJsonbImport = objectColumns.any { it.kind == ObjectColumnKind.JSONB }

        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import org.jetbrains.exposed.sql.Table\n")
            if (fkColumns.any { it.hasReferenceOption }) {
                append("import org.jetbrains.exposed.sql.ReferenceOption\n")
            }
            if (needsJsonbImport) {
                append("import org.jetbrains.exposed.sql.json.jsonb\n")
                append("import kotlinx.serialization.json.Json\n")
            }
            append("\n")
            append("/** GENERATED — do not hand-edit. Regenerated from metadata. */\n")
            append("object $tableObjectName : Table(\"$tableName\") {\n")
            for (field in entity.metaFields) {
                if (field is ObjectField) {
                    // ObjectField columns are produced by buildObjectColumns() so we can
                    // emit @storage flattened (N columns) or jsonb (1 column) uniformly.
                    continue
                }
                val isPk = field.name == primaryFieldName
                val nullable = !isPk && !isRequired(field)
                val baseSpec = KotlinTypeMapper.exposedColumnSpec(field)
                val withAuto = if (isPk && incrementPk) "$baseSpec.autoIncrement()" else baseSpec
                val full = if (nullable) "$withAuto.nullable()" else withAuto
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
            val storage = readStorage(field)        // null → default to jsonb
            if (storage == STORAGE_FLATTENED) {
                val ref = readObjectRef(field) ?: continue
                val target = resolveObjectByShortOrFqn(loader, ref) ?: continue
                val parentNullable = parentName != primaryFieldName && !isRequired(field)
                for (subField in target.metaFields) {
                    val propertyName = parentName + subField.name.replaceFirstChar { it.uppercase() }
                    val colName = parentName + "_" + subField.name
                    val baseSpec = KotlinTypeMapper.exposedColumnSpec(subField, colName)
                    // Sub-column is nullable iff the parent is nullable OR the sub-field itself is.
                    val nullable = parentNullable || !isRequired(subField)
                    val full = if (nullable) "$baseSpec.nullable()" else baseSpec
                    result.add(ObjectColumnSpec(propertyName, full, ObjectColumnKind.FLATTENED))
                }
            } else {
                // jsonb (explicit) OR absent (default per CLAUDE.md back-compat rule).
                val colName = parentName
                val expr = "jsonb(\"$colName\", { Json.encodeToString(it) }, { Json.decodeFromString(it) })"
                val parentNullable = parentName != primaryFieldName && !isRequired(field)
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

    /** Resolve a MetaObject (entity OR value) by FQN match or short-name match. */
    private fun resolveObjectByShortOrFqn(loader: MetaDataLoader, ref: String): MetaObject? {
        for (child in loader.metaObjects) {
            val short = child.name.substringAfterLast("::")
            if (child.name == ref || short == ref) return child
        }
        return null
    }

    private companion object {
        /** Cross-language @storage attr on field.object — values: flattened | jsonb (default). */
        const val ATTR_STORAGE = "storage"
        const val STORAGE_FLATTENED = "flattened"
    }

    // === FK column emission from relationship.composition ====================

    /** A foreign-key column derived from a `relationship.composition` child. */
    private data class FkColumnSpec(
        val propertyName: String,
        val columnExpr: String,
        val hasReferenceOption: Boolean,
    )

    /**
     * Build one FK column per `relationship.composition` to-one child.
     *
     * <ul>
     *   <li>Cardinality "many" (one-to-many) ⇒ FK lives on the OTHER side; skip here.</li>
     *   <li>Default cardinality is "one" (per {@link MetaRelationship#getCardinality()}).</li>
     *   <li>Property name = literal {@code <relationshipName>Id} (camelCase, matches the
     *       Kotlin property style). An explicit {@code @column} attr overrides it
     *       verbatim — the user has named the physical column themselves.</li>
     *   <li>Target table object = {@code <TargetShortName>Table} — looked up by short
     *       name in the loader (Exposed objects are forward-referenceable at the JVM
     *       level, so out-of-file references work without import bookkeeping when the
     *       generated package is consistent).</li>
     *   <li>{@code @onDelete} / {@code @onUpdate} (kebab-case in metadata, e.g.
     *       {@code "set-null"}) lower to Exposed's SCREAMING_SNAKE
     *       {@code ReferenceOption} enum.</li>
     * </ul>
     */
    private fun buildFkColumns(entity: MetaObject, loader: MetaDataLoader): List<FkColumnSpec> {
        val result = mutableListOf<FkColumnSpec>()
        for (child in entity.children) {
            if (child !is MetaRelationship) continue
            if (child.subType != "composition") continue
            // Skip the "many" side — FK lives on the other entity.
            if (child.cardinality == MetaRelationship.CARDINALITY_MANY) continue

            val objectRef = child.objectRef ?: continue
            val targetShortName = resolveTargetShortName(objectRef, loader) ?: continue
            val targetTable = targetShortName + "Table"

            // Use shortName: relationship.name is fully-qualified after loading
            // (e.g., "acme::demo::author"), which would produce an illegal Kotlin
            // identifier with "::" embedded. shortName is the leaf authored token.
            val relShortName = child.shortName ?: child.name
            val propertyName = if (child.hasMetaAttr(com.metaobjects.database.CoreDBMetaDataProvider.COLUMN, true)) {
                runCatching { child.getMetaAttr(com.metaobjects.database.CoreDBMetaDataProvider.COLUMN, true).valueAsString }
                    .getOrNull() ?: (relShortName + "Id")
            } else {
                relShortName + "Id"
            }

            // Default Exposed FK is `long(...)`; refine later if other PK types appear.
            val parts = StringBuilder("long(\"$propertyName\").references($targetTable.id")
            var hasOption = false
            val onDelete = child.onDeleteRaw?.let { mapReferentialAction(it) }
            val onUpdate = child.onUpdateRaw?.let { mapReferentialAction(it) }
            if (onDelete != null) {
                parts.append(", onDelete = ReferenceOption.$onDelete")
                hasOption = true
            }
            if (onUpdate != null) {
                parts.append(", onUpdate = ReferenceOption.$onUpdate")
                hasOption = true
            }
            parts.append(')')
            result.add(FkColumnSpec(propertyName, parts.toString(), hasOption))
        }
        return result
    }

    /** Resolve `@objectRef` (short name OR fully-qualified) to the target entity's short name. */
    private fun resolveTargetShortName(objectRef: String, loader: MetaDataLoader): String? {
        // Try exact match first (FQN), then by short name across all entities.
        val direct = loader.metaObjects.firstOrNull { it.name == objectRef }
        if (direct != null) return PackageMapping.splitFqn(direct.name).second
        val byShortName = loader.metaObjects.firstOrNull {
            PackageMapping.splitFqn(it.name).second == objectRef
        }
        return byShortName?.let { PackageMapping.splitFqn(it.name).second }
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

    private fun findRdbSource(entity: MetaObject): MetaSource? =
        entity.children.firstOrNull { it is RdbSource } as? MetaSource

    private fun findPrimaryIdentity(entity: MetaObject): MetaIdentity? {
        for (child in entity.children) {
            if (child is MetaIdentity && child.subType == "primary") return child
        }
        return null
    }

    private fun isRequired(field: MetaField<*>): Boolean {
        if (!field.hasMetaAttr(MetaField.ATTR_REQUIRED, true)) return false
        val raw = runCatching { field.getMetaAttr(MetaField.ATTR_REQUIRED, true).value }.getOrNull()
        return when (raw) {
            is Boolean -> raw
            is String -> raw.equals("true", ignoreCase = true)
            else -> false
        }
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

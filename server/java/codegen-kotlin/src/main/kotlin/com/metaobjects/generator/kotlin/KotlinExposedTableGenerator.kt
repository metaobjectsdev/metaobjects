package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
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
            emit(entity, sourceRdb, outRoot)
        }
    }

    private fun emit(entity: MetaObject, sourceRdb: MetaSource, outRoot: Path) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val tableObjectName = shortName + "Table"
        val tableName = sourceRdb.tableName ?: (shortName.lowercase() + "s")

        val primary = findPrimaryIdentity(entity)
        val primaryFieldName = primary?.fields?.firstOrNull()
        val incrementPk = primary?.generation == MetaIdentity.GENERATION_INCREMENT

        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import org.jetbrains.exposed.sql.Table\n\n")
            append("/** GENERATED — do not hand-edit. Regenerated from metadata. */\n")
            append("object $tableObjectName : Table(\"$tableName\") {\n")
            for (field in entity.metaFields) {
                val isPk = field.name == primaryFieldName
                val nullable = !isPk && !isRequired(field)
                val baseSpec = KotlinTypeMapper.exposedColumnSpec(field)
                val withAuto = if (isPk && incrementPk) "$baseSpec.autoIncrement()" else baseSpec
                val full = if (nullable) "$withAuto.nullable()" else withAuto
                append("    val ${field.name} = $full\n")
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

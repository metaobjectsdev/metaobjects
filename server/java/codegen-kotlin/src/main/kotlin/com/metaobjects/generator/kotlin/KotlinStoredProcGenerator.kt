package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.source.MetaSource
import com.metaobjects.source.RdbSource
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Paths
import org.slf4j.LoggerFactory

/**
 * Generator: one Kotlin `object` stub per `object.entity` that has a `source.rdb`
 * child with `@kind="storedProc"`. The entity's fields are taken to describe the
 * procedure's **result-row shape** — the corresponding `KotlinEntityGenerator`
 * output supplies the typed data class consumers map rows into.
 *
 * <p>Stored procedure parameter handling is genuinely consumer-specific (Exposed
 * lacks a fully typed parameter-binding surface for arbitrary procs), so this
 * Day 1 generator emits a **documented stub** — a `<EntityName>Proc` object
 * carrying a `PROC_NAME` constant plus a KDoc-embedded example wrapper that
 * the consumer fills in. The companion {@link KotlinEntityGenerator} already
 * emits the result-row data class; this generator owns the proc-name binding
 * and the wrapper-shape documentation.
 *
 * <p>Proc-name resolution order (first non-null wins):
 * <ol>
 *   <li>{@code source.rdb @procName} — explicit binding.</li>
 *   <li>{@code source.rdb @table} — re-uses the table-name slot.</li>
 *   <li>The entity's lowercased short name — last-resort fallback.</li>
 * </ol>
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
class KotlinStoredProcGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            val sourceRdb = entity.children.filterIsInstance<RdbSource>().firstOrNull() ?: continue
            if (sourceRdb.effectiveKind != MetaSource.KIND_STORED_PROC) continue
            emit(entity, sourceRdb, outRoot)
        }
    }

    private fun emit(
        entity: MetaObject,
        sourceRdb: RdbSource,
        outRoot: java.nio.file.Path,
    ) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val objectName = shortName + "Proc"
        val procName = resolveProcName(sourceRdb, shortName)

        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import org.jetbrains.exposed.sql.Transaction\n\n")
            append("/**\n")
            append(" * GENERATED — stub for stored procedure `$procName`.\n")
            append(" *\n")
            append(" * The $shortName entity declares the result-row shape; consumers map rows into\n")
            append(" * the generated $shortName data class. Stored-procedure parameter binding is\n")
            append(" * consumer-specific, so this generator only owns the proc-name constant + the\n")
            append(" * wrapper-shape documentation; the call signature + body live in your code.\n")
            append(" *\n")
            append(" * Fill in the call signature + body with your procedure's parameter set:\n")
            append(" *\n")
            append(" * fun Transaction.call$shortName(/* params */): List<$shortName> {\n")
            append(" *     val results = mutableListOf<$shortName>()\n")
            append(" *     exec(\"SELECT * FROM ${'$'}{${objectName}.PROC_NAME}(?)\") { rs ->\n")
            append(" *         while (rs.next()) results.add($shortName(/* map fields */))\n")
            append(" *     }\n")
            append(" *     return results\n")
            append(" * }\n")
            append(" */\n")
            append("object $objectName {\n")
            append("    const val PROC_NAME = \"$procName\"\n")
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$objectName.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, source)
    }

    /**
     * Resolve the SQL proc name from (in order): {@code @procName} → {@code @table}
     * → the entity's lowercased short name.
     */
    private fun resolveProcName(sourceRdb: RdbSource, entityShortName: String): String {
        readAttr(sourceRdb, ATTR_PROC_NAME)?.let { return it }
        sourceRdb.tableName?.let { return it }
        return entityShortName.lowercase()
    }

    /** Read an own-only string attr; null when absent or unreadable. */
    private fun readAttr(rdb: RdbSource, attrName: String): String? {
        if (!rdb.hasMetaAttr(attrName, false)) return null
        return runCatching { rdb.getMetaAttr(attrName, false).valueAsString }.getOrNull()
    }

    private companion object {
        /** Attr on `source.rdb` naming the SQL procedure to call. */
        const val ATTR_PROC_NAME = "procName"

        @JvmStatic
        val LOG = LoggerFactory.getLogger(KotlinStoredProcGenerator::class.java)
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
        PackageMapping.splitFqn(md.name).second + "Proc.kt"
}

package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: emits two files per project:
 *  - MetadataStartupValidator.kt — registry of (FQN, Table) pairs + a validate(loader) entry point
 *  - ExposedTableValidator.kt — substrate-specific helper that compares one MetaObject to one Table
 *
 * <p>Output is emitted as hand-rolled Kotlin source (rather than KotlinPoet) to keep
 * generated-code template-string escapes readable and to avoid wrestling with
 * `ParameterizedTypeName` quoting for `List<Pair<String, Table>>`.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required)</li>
 *   <li>{@code packageName} (required) — the Kotlin package both files live in</li>
 * </ul>
 */
open class KotlinValidatorGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val pkg = getArg("packageName")
            ?: throw GeneratorException("packageName is required")
        val outRoot = Paths.get(outDir.absolutePath)

        val entries = loader.metaObjects
            .filter { it.subType == MetaObject.SUBTYPE_ENTITY }
            // Abstract entities are inheritance scaffolding — never register a validator for them.
            .filter { !KotlinGenUtil.isAbstractEntity(it) }
            // FR-017 TPH: a subtype folds into its base's single table — never register a per-
            // subtype table (it no longer exists). Mirror the table/controller skip.
            .filter { !KotlinTphPlan.isTphSubtype(it) }
            // ADR-0039: resolving source lookup (inherited source.rdb via extends).
            .filter { KotlinGenUtil.hasRdbSource(it) }
            .map { entity ->
                val (tablePkg, shortName) = PackageMapping.splitFqn(entity.name)
                // (metadata FQN, Table object name, Table's Kotlin package)
                Triple(entity.name, "${shortName}Table", tablePkg)
            }

        emitValidator(pkg, entries, outRoot)
        emitHelper(pkg, outRoot)
    }

    protected open fun emitValidator(pkg: String, entries: List<Triple<String, String, String>>, outRoot: Path) {
        val registry = entries.joinToString(",\n        ") { (fqn, table, _) -> "\"$fqn\" to $table" }
        // The Table objects live in their entity's own package; import any that
        // are NOT in this validator's package or the bare reference won't resolve.
        val tableImports = entries
            .filter { (_, _, tablePkg) -> tablePkg.isNotEmpty() && tablePkg != pkg }
            .map { (_, table, tablePkg) -> "$tablePkg.$table" }
            .toSortedSet()

        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import com.metaobjects.loader.MetaDataLoader\n")
            append("import com.metaobjects.metadata.ktx.metaObjectOrNull\n")
            append("import org.jetbrains.exposed.sql.Table\n")
            for (imp in tableImports) append("import $imp\n")
            append("\n")
            append("/**\n")
            append(" * GENERATED — runtime drift gate. Call [validate] from a Spring `@PostConstruct` or\n")
            append(" * `ApplicationReadyEvent` listener to fail-fast when generated Tables drift from metadata.\n")
            append(" */\n")
            append("object MetadataStartupValidator {\n\n")
            append("    private val tablesToValidate: List<Pair<String, Table>> = listOf(\n        ")
            append(registry)
            append("\n    )\n\n")
            append("    fun validate(loader: MetaDataLoader) {\n")
            append("        val errors = mutableListOf<String>()\n")
            append("        for ((fqn, table) in tablesToValidate) {\n")
            append("            val obj = loader.metaObjectOrNull(fqn)\n")
            append("            if (obj == null) {\n")
            append("                errors.add(\"metadata missing \$fqn (generated table: \${table.tableName})\")\n")
            append("                continue\n")
            append("            }\n")
            append("            ExposedTableValidator.check(obj, table, errors)\n")
            append("        }\n")
            append("        check(errors.isEmpty()) {\n")
            append("            \"MetadataStartupValidator: \${errors.size} drift(s):\\n  - \" +\n")
            append("                errors.joinToString(\"\\n  - \")\n")
            append("        }\n")
            append("    }\n")
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("MetadataStartupValidator.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, source)
    }

    protected open fun emitHelper(pkg: String, outRoot: Path) {
        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import com.metaobjects.`object`.MetaObject\n")
            append("import com.metaobjects.field.MetaField\n")
            append("import org.jetbrains.exposed.sql.Table\n\n")
            append("/**\n")
            append(" * GENERATED — compares a [MetaObject]'s field set vs an Exposed [Table]'s column set\n")
            append(" * and records any discrepancies into the supplied `errors` list.\n")
            append(" */\n")
            append("object ExposedTableValidator {\n\n")
            append("    fun check(obj: MetaObject, table: Table, errors: MutableList<String>) {\n")
            append("        val expectedCols = obj.metaFields.map { it.name }.toSet()\n")
            append("        val actualCols = table.columns.map { it.name }.toSet()\n")
            append("        val missing = expectedCols - actualCols\n")
            append("        val extra = actualCols - expectedCols\n")
            append("        if (missing.isNotEmpty()) {\n")
            append("            errors.add(\"\${obj.name}: metadata declares fields not in generated table: \$missing\")\n")
            append("        }\n")
            append("        if (extra.isNotEmpty()) {\n")
            append("            errors.add(\"\${obj.name}: generated table has columns not in metadata: \$extra\")\n")
            append("        }\n")
            append("    }\n")
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("ExposedTableValidator.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, source)
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
    override fun getSingleOutputFilePath(md: MetaObject): String = ""
    override fun getSingleOutputFilename(md: MetaObject): String = ""
}

package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one `<Entity>Names.kt` per object with a declared (or inherited) primary
 * `source.rdb` (#248) — GENERATED per-object physical database name `const val`s a
 * hand-written consumer references instead of a string literal.
 *
 * `const val`, mirroring the shape [KotlinStoredProcGenerator] already emits and
 * consumes for `PROC_NAME`. `const` is legal only on String/primitive properties,
 * never a `Map`, so `COLUMNS_BY_FIELD` is a plain `val` — the same reason
 * [KotlinFilterAllowlistGenerator]'s `FIELDS` is `val`, not `const val`.
 *
 * Mirrors the shipped C# `NamesGenerator` / `CSharpNaming.ResolveObjectNames` and the
 * TS reference (`codegen-ts/src/names.ts` + `templates/names-decl.ts`) member for
 * member, with Kotlin casing (SCREAMING_SNAKE per-field members instead of PascalCase).
 *
 * Task 6 (a separate task in this program, not this generator) is expected to make
 * [KotlinExposedTableGenerator] consume these constants instead of re-deriving the
 * same names independently.
 *
 * Args:
 *  - `outputDir` (required): output directory root.
 *  - `columnNaming` (optional): the column-naming strategy — the SAME generator arg
 *    [KotlinExposedTableGenerator] reads (via [KotlinGenUtil.ARG_COLUMN_NAMING]), so a
 *    run resolves the column string this artifact declares and the column
 *    [KotlinExposedTableGenerator] binds through the identical resolver + argument.
 */
open class KotlinNamesGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    /** See [KotlinExposedTableGenerator.columnNaming] — same arg, same default. */
    protected fun columnNaming(): String =
        getArg(KotlinGenUtil.ARG_COLUMN_NAMING, KotlinGenUtil.DEFAULT_COLUMN_NAMING)

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        val strategy = columnNaming()
        for (entity in loader.metaObjects) {
            emit(entity, outRoot, strategy)
        }
    }

    protected open fun emit(entity: MetaObject, outRoot: Path, strategy: String) {
        // #248: participation derives from a declared/inherited primary source, never
        // from the object subtype — never gate on isEntity()/abstract/etc.
        // resolveObjectNames returns null when none exists.
        val names = KotlinGenUtil.resolveObjectNames(entity, strategy) ?: return

        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val className = KotlinNaming.namesObjectName(shortName)

        val rows = names.fields.values
            .map { f -> Triple(KotlinNaming.namesMember(f.name), f.name, f.column) }
            .sortedBy { it.second }

        // Two fields whose SCREAMING_SNAKE forms collide would emit duplicate const
        // members. Kotlin would refuse to compile it, but the error would name a
        // generated file and read as a codegen bug. Fail here, naming the model instead.
        rows.groupBy { it.first }.filterValues { it.size > 1 }.forEach { (member, dupes) ->
            throw GeneratorException(
                "${entity.name}: fields ${dupes.joinToString { it.second }} all yield the " +
                    "constant member '$member'. Rename one, or give it an explicit @column.")
        }

        val out = buildString {
            if (pkg.isNotEmpty()) append("package $pkg\n\n")
            append("/**\n")
            append(" * GENERATED — per-object physical database names for $shortName.\n")
            append(" */\n")
            append("object $className {\n")
            append("    const val KIND: String = \"${names.kind}\"\n")
            append("    const val NAME: String = \"${names.name}\"\n")
            // Omitted when absent: `const val SCHEMA: String? = null` does not compile,
            // and an empty string would read as "declared blank" rather than
            // "undeclared".
            if (!names.schema.isNullOrEmpty()) {
                append("    const val SCHEMA: String = \"${names.schema}\"\n")
            }
            append("    const val READ_ONLY: Boolean = ${names.readOnly}\n\n")
            for ((member, field, column) in rows) {
                append("    const val ${member}_FIELD: String = \"$field\"\n")
                append("    const val ${member}_COLUMN: String = \"$column\"\n")
            }
            // The map's values reference the constants rather than repeating the
            // literals -- the artifact must not spell a physical name twice inside itself.
            append("\n    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(\n")
            for ((member, field, _) in rows) {
                append("        \"$field\" to ${member}_COLUMN,\n")
            }
            append("    )\n")
            append("}\n")
        }

        GeneratedFileWriter.write(outRoot.resolve(pkg.replace('.', '/')).resolve("$className.kt"), out)
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
        KotlinNaming.namesObjectName(PackageMapping.splitFqn(md.name).second) + ".kt"
}

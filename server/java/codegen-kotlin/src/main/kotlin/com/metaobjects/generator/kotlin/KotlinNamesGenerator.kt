package com.metaobjects.generator.kotlin

import com.metaobjects.generator.EmitsPhysicalNameConstants
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
 * [KotlinExposedTableGenerator] consumes these constants instead of re-deriving the same
 * names independently. Because this class carries [EmitsPhysicalNameConstants], a run that
 * includes it turns that substitution ON without any project configuration; a run that
 * narrows the suite and drops it goes back to literals rather than emitting a reference to
 * a type nothing generated.
 *
 * Args:
 *  - `outputDir` (required): output directory root.
 *  - `columnNaming` (optional): the column-naming strategy — the SAME generator arg
 *    [KotlinExposedTableGenerator] reads (via [KotlinGenUtil.ARG_COLUMN_NAMING]), so a
 *    run resolves the column string this artifact declares and the column
 *    [KotlinExposedTableGenerator] binds through the identical resolver + argument.
 */
open class KotlinNamesGenerator :
    MultiFileDirectGeneratorBase<MetaObject>(), EmitsPhysicalNameConstants {

    /** See [KotlinExposedTableGenerator.columnNaming] — same arg, same default. */
    protected fun columnNaming(): String =
        getArg(KotlinGenUtil.ARG_COLUMN_NAMING, KotlinGenUtil.DEFAULT_COLUMN_NAMING)

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        val strategy = columnNaming()
        // Pass 1 — every object that participates in the database (#248).
        val emitted = mutableSetOf<String>()
        for (entity in loader.metaObjects) {
            if (emit(entity, outRoot, strategy)) emitted += entity.name
        }
        // Pass 2 — the abstract bases those participants EXTEND, each carrying the columns
        // it declares so a child states them once rather than restating its parent's.
        //
        // Reached by walking UP from a participant, never by scanning for abstracts: that is
        // what keeps #248 intact. A sourceless object nothing persistable extends — an
        // `object.value`, say — is not reached, so it acquires no artifact and no phantom
        // participation.
        for (entity in loader.metaObjects) {
            if (entity.name !in emitted) continue
            var sup = KotlinGenUtil.namesArtifactSuperOf(entity)
            while (sup != null) {
                // Already emitted, and so is everything above it.
                if (!emitted.add(sup.name)) break
                emit(sup, outRoot, strategy, fragment = true)
                sup = KotlinGenUtil.namesArtifactSuperOf(sup)
            }
        }
    }

    /** @return true when a file was written. */
    protected open fun emit(
        entity: MetaObject,
        outRoot: Path,
        strategy: String,
        fragment: Boolean = false,
    ): Boolean {
        // #248: participation derives from a declared/inherited primary source, never
        // from the object subtype — never gate on isEntity()/abstract/etc.
        // resolveObjectNames returns null when none exists.
        val names = (if (fragment) KotlinGenUtil.resolveSuperFragmentNames(entity, strategy)
                     else KotlinGenUtil.resolveObjectNames(entity, strategy)) ?: return false

        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val className = KotlinNaming.namesObjectName(shortName)

        // Kotlin has no static inheritance: a subclass's companion does NOT inherit the
        // base's members, and an `object` cannot extend another `object` at all. So an
        // artifact with a super re-exports the inherited constants BY REFERENCE rather than
        // restating their literals — one spelling of each physical name, which is the whole
        // guarantee. (C# and Java use real class inheritance; the emitted shape differs per
        // language, the guarantee does not.)
        val superObj = names.superObject
        val superRef: String? = superObj?.let {
            val (supPkg, supShort) = PackageMapping.splitFqn(it.name)
            val obj = KotlinNaming.namesObjectName(supShort)
            if (supPkg == pkg || supPkg.isEmpty()) obj else "$supPkg.$obj"
        }
        val inheritedRows = if (superRef == null) emptyList() else
            names.fields.values.filter { it.name !in names.ownFields }
                .map { f -> Triple(KotlinNaming.namesMember(f.name), f.name, f.column) }
                .sortedBy { it.second }
        val declared = if (superRef == null) names.fields else names.ownFields

        val rows = declared.values
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
            // A fragment has no source, so no KIND/NAME/SCHEMA/READ_ONLY — it must never
            // acquire a physical name it never declared. A TPH subtype INHERITS its base's
            // source, so those come from the base object by reference rather than being
            // restated.
            if (!fragment) {
                if (names.inheritsSource && superRef != null) {
                    append("    const val KIND: String = $superRef.KIND\n")
                    append("    const val NAME: String = $superRef.NAME\n")
                    if (!names.schema.isNullOrEmpty()) {
                        append("    const val SCHEMA: String = $superRef.SCHEMA\n")
                    }
                    append("    const val READ_ONLY: Boolean = $superRef.READ_ONLY\n\n")
                } else {
                    append("    const val KIND: String = \"${names.kind}\"\n")
                    append("    const val NAME: String = \"${names.name}\"\n")
                    // Omitted when absent: `const val SCHEMA: String? = null` does not
                    // compile, and an empty string would read as "declared blank" rather
                    // than "undeclared".
                    if (!names.schema.isNullOrEmpty()) {
                        append("    const val SCHEMA: String = \"${names.schema}\"\n")
                    }
                    append("    const val READ_ONLY: Boolean = ${names.readOnly}\n\n")
                }
            }
            for ((member, field, column) in rows) {
                append("    const val ${member}_FIELD: String = \"$field\"\n")
                append("    const val ${member}_COLUMN: String = \"$column\"\n")
            }
            // Inherited constants, re-exported by REFERENCE — the literal is spelled once,
            // on the base. `const val` folds the reference at compile time, so a consumer
            // reading `CopayAuthNames.ID_COLUMN` is unaffected by which object declared it.
            for ((member, field, _) in inheritedRows) {
                append("    const val ${member}_FIELD: String = $superRef.${member}_FIELD\n")
                append("    const val ${member}_COLUMN: String = $superRef.${member}_COLUMN\n")
            }
            // The map's values reference the constants rather than repeating the
            // literals -- the artifact must not spell a physical name twice inside itself.
            // It stays COMPLETE — every field, inherited included — because it is the
            // lookup surface, and a miss on an inherited field is exactly the
            // fallback-to-literal this artifact removes.
            append("\n    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(\n")
            for ((member, field, _) in (rows + inheritedRows).sortedBy { it.second }) {
                append("        \"$field\" to ${member}_COLUMN,\n")
            }
            append("    )\n")
            append("}\n")
        }

        GeneratedFileWriter.write(outRoot.resolve(pkg.replace('.', '/')).resolve("$className.kt"), out)
        return true
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

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
 * hand-written consumer references instead of a string literal, and which
 * [KotlinExposedTableGenerator] / [KotlinStoredProcGenerator] bind against instead of
 * re-deriving the same names independently.
 *
 * ## The artifact MIRRORS THE METADATA TREE
 *
 * It used to be flat, and one member carried the cost. `NAME` held a table, a view and a
 * stored procedure depending on the object, told apart only by a sibling `KIND`, and in
 * none of them did it hold the object's own name. Every node now carries its own `TYPE`,
 * `SUB_TYPE` and `NAME`, and a physical name sits under the member that says what it IS —
 * `SOURCE_PRIMARY_TABLE`, `SOURCE_REPLICA_VIEW`, `SOURCE_PRIMARY_PROC` — spelled from
 * `MetaSource.PHYSICAL_NAME_ATTR_BY_KIND`, the metamodel's own FR-016/ADR-0018 alias map.
 *
 * Sources are keyed by effective `@role`, and that is what finally gives a WRITE-THROUGH
 * entity's replica view a member of its own. It declares two physical names, the artifact
 * carried one, and [KotlinExposedTableGenerator]'s read-view call had nothing to reference
 * — so it emitted the second in full, under a comment saying there was deliberately no
 * slot for it. There is one now.
 *
 * `TYPE`/`SUB_TYPE` are on every node but a FIELD, and the exception is the point rather
 * than an oversight: a field's subType does not change what its column denotes, while an
 * object's decides table-vs-view and an identity's decides unique-vs-not — ADR-0040 put
 * uniqueness in the type rather than in an attribute, so `IDENTITY_<N>_SUB_TYPE` is the
 * only thing telling a unique alternate key from a non-unique lookup. Fields keep the
 * `<UPPER>_FIELD` / `<UPPER>_COLUMN` pair they always had.
 *
 * `READ_ONLY` is REMOVED rather than relocated. It was never metadata — it is a derivation
 * over `@kind` (`MetaSource.isReadOnly()`) — and a sweep of all five ports found zero
 * consumers, generated or hand-written. A reader who wants read-only-ness asks
 * `SOURCE_<ROLE>_KIND`.
 *
 * ## Shape
 *
 * `const val`, mirroring the shape [KotlinStoredProcGenerator] already emits and consumes
 * for `PROC_NAME`. `const` is legal only on String/primitive properties, never a `Map`, so
 * `COLUMNS_BY_FIELD` is a plain `val` — the same reason [KotlinFilterAllowlistGenerator]'s
 * `FIELDS` is `val`, not `const val`.
 *
 * Mirrors the shipped C# `NamesGenerator` / `CSharpNaming.ResolveObjectNames`, the Java
 * `SpringNamesGenerator` and the TS reference (`codegen-ts/src/names.ts` +
 * `templates/names-decl.ts`) member for member, with Kotlin casing (SCREAMING_SNAKE
 * members instead of PascalCase).
 *
 * Because this class carries [EmitsPhysicalNameConstants], a run that includes it turns
 * that substitution ON without any project configuration; a run that narrows the suite and
 * drops it goes back to literals rather than emitting a reference to a type nothing
 * generated.
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

    /**
     * One emitted constant: its member name, the string it holds, the node path it came
     * from, and the collection it belongs to.
     *
     * [path] is what a collision is reported against — two DISTINCT nodes yielding one
     * member — and [section] exists only so the emitted file keeps the tree's shape
     * visually, one blank line between the object's own identity, its sources, its fields,
     * its identities and its indexes. Neither is read as data.
     */
    protected data class NameConst(
        val member: String,
        val value: String,
        val path: String,
        val section: String,
    )

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

        val resolved = membersOf(names, all = true)
        val own = membersOf(names, all = false)

        // Two nodes whose SCREAMING_SNAKE member forms collide would emit duplicate const
        // members. Kotlin would refuse to compile it, but the error would name a generated
        // file and read as a codegen bug. Fail here, naming the model instead.
        //
        // Checked over the WHOLE resolved member set, never just what this object declares:
        // once a child stopped restating its inherited constants, an own-only check could no
        // longer see a collision that spans the `extends` boundary — and here the two
        // constants land in the SAME object (the child re-exports the inherited one under
        // its own name), so the emitted file would not even compile, blaming a generated
        // file for a model problem.
        //
        // Over the WHOLE member set rather than per collection, too, because the emitted
        // object has ONE flat namespace — a per-collection check would be four checks that
        // each pass while the file still fails to compile. What keeps the collections from
        // colliding with EACH OTHER is not this call but the member prefix, which is derived
        // from the node's own metamodel type (`IDENTITY_`, `INDEX_`, `SOURCE_`) rather than
        // chosen: an identity and an index of the same name land under different prefixes by
        // construction. What this catches beyond fields is two nodes of the SAME type whose
        // names snake-fold together — `by_name` and `byName`, both `IDENTITY_BY_NAME_*`.
        refuseCollidingMembers(entity, resolved)

        val declared = if (superRef == null) resolved else own
        val declaredMembers = declared.mapTo(mutableSetOf()) { it.member }
        val inherited = if (superRef == null) emptyList()
                        else resolved.filter { it.member !in declaredMembers }

        val out = buildString {
            if (pkg.isNotEmpty()) append("package $pkg\n\n")
            append("/**\n")
            append(" * GENERATED — per-object physical database names for $shortName.\n")
            append(" */\n")
            append("object $className {\n")
            var section: String? = null
            for (c in declared) {
                if (section != null && section != c.section) append("\n")
                section = c.section
                append("    const val ${c.member}: String = \"${c.value}\"\n")
            }
            // Inherited constants, re-exported by REFERENCE — the literal is spelled once,
            // on the base. `const val` folds the reference at compile time, so a consumer
            // reading `CopayAuthNames.ID_COLUMN` is unaffected by which object declared it.
            // A TPH subtype's SOURCE members arrive here for the same reason its inherited
            // columns do: it declares no source of its own, so the own set has none.
            if (inherited.isNotEmpty()) append("\n")
            for (c in inherited) {
                append("    const val ${c.member}: String = $superRef.${c.member}\n")
            }
            // The map's values reference the constants rather than repeating the
            // literals -- the artifact must not spell a physical name twice inside itself.
            // It stays COMPLETE — every field, inherited included — because it is the
            // lookup surface, and a miss on an inherited field is exactly the
            // fallback-to-literal this artifact removes.
            append("\n    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(\n")
            for (name in names.fields.keys.sorted()) {
                append("        \"$name\" to ${KotlinNaming.namesMember(name)}_COLUMN,\n")
            }
            append("    )\n")
            append("}\n")
        }

        GeneratedFileWriter.write(outRoot.resolve(pkg.replace('.', '/')).resolve("$className.kt"), out)
        return true
    }

    /**
     * Every constant this artifact describes, in emission order.
     *
     * [all] selects the RESOLVED set (the collision guard, and the declaration set of an
     * object with no super) over the OWN set (what an object with a super declares, the rest
     * being re-exported by reference).
     *
     * The object's own `TYPE`/`SUB_TYPE`/`NAME` are in BOTH, base or no base: they differ
     * per object, so `CarNames.NAME` must say `"Car"` while `VehicleNames.NAME` says
     * `"Vehicle"`. Everything else follows the own/all split, INCLUDING the sources — a TPH
     * subtype declares none of its own, so its source members land in the inherited half and
     * are re-exported, with no `inheritsSource` flag needed to say so.
     */
    protected fun membersOf(names: KotlinGenUtil.KotlinObjectNames, all: Boolean): List<NameConst> {
        val out = mutableListOf<NameConst>()
        val self = names.name
        out += NameConst("TYPE", names.type, self, "self")
        out += NameConst("SUB_TYPE", names.subType, self, "self")
        out += NameConst("NAME", names.name, self, "self")

        val sources = if (all) names.sources else names.ownSources
        for (role in sources.keys.sorted()) {
            val s = sources.getValue(role)
            val prefix = "${KotlinNaming.namesMember(s.type)}_${KotlinNaming.namesMember(role)}_"
            val path = "$self.sources.$role"
            out += NameConst("${prefix}TYPE", s.type, path, "sources")
            out += NameConst("${prefix}SUB_TYPE", s.subType, path, "sources")
            out += NameConst("${prefix}KIND", s.kind, path, "sources")
            // Omitted when absent: `const val SCHEMA: String? = null` does not compile, and
            // an empty string would read as "declared blank" rather than "undeclared".
            s.schema?.let { out += NameConst("${prefix}SCHEMA", it, path, "sources") }
            // No alias means a @kind carrying no physical-name slot. Omitting keeps a future
            // @kind from emitting a member holding "null".
            if (s.alias != null && s.physicalName != null) {
                out += NameConst("$prefix${KotlinNaming.namesMember(s.alias)}", s.physicalName, path, "sources")
            }
        }

        val fields = if (all) names.fields else names.ownFields
        for (name in fields.keys.sorted()) {
            val f = fields.getValue(name)
            val member = KotlinNaming.namesMember(f.name)
            val path = "$self.fields.${f.name}"
            out += NameConst("${member}_FIELD", f.name, path, "fields")
            out += NameConst("${member}_COLUMN", f.column, path, "fields")
        }

        addKeys(out, self, "identities", if (all) names.identities else names.ownIdentities)
        addKeys(out, self, "indexes", if (all) names.indexes else names.ownIndexes)
        return out
    }

    private fun addKeys(
        out: MutableList<NameConst>,
        self: String,
        label: String,
        keys: Map<String, KotlinGenUtil.KotlinKeyNames>,
    ) {
        for (name in keys.keys.sorted()) {
            val k = keys.getValue(name)
            // The prefix comes from the node's own metamodel TYPE — `IDENTITY_`, `INDEX_` —
            // rather than from a literal, so the member and the tree agree by construction.
            val prefix = "${KotlinNaming.namesMember(k.type)}_${KotlinNaming.namesMember(k.name)}_"
            val path = "$self.$label.${k.name}"
            out += NameConst("${prefix}TYPE", k.type, path, label)
            out += NameConst("${prefix}SUB_TYPE", k.subType, path, label)
            out += NameConst("${prefix}NAME", k.name, path, label)
            k.index?.let { out += NameConst("${prefix}INDEX", it, path, label) }
        }
    }

    private fun refuseCollidingMembers(entity: MetaObject, members: List<NameConst>) {
        members.groupBy({ it.member }, { it.path })
            // One node contributes several members and legitimately repeats a path; only TWO
            // DISTINCT nodes yielding one member is a collision.
            .mapValues { (_, paths) -> paths.distinct() }
            .filterValues { it.size > 1 }
            .forEach { (member, paths) ->
                throw GeneratorException(
                    "${entity.name}: ${paths.joinToString()} all yield the constant member " +
                        "'$member'. Rename one, or give a field an explicit @column.")
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
        KotlinNaming.namesObjectName(PackageMapping.splitFqn(md.name).second) + ".kt"
}

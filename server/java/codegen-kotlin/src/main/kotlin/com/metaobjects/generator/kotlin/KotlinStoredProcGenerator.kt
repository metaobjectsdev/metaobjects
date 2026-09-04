package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimestampField
import com.metaobjects.field.UuidField
import com.metaobjects.generator.GeneratorException
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
import com.metaobjects.generator.util.GeneratedFileWriter

/**
 * Generator: one Kotlin `object` per `object.entity` that has a `source.rdb` child with
 * `@kind="storedProc"`. The entity's fields describe BOTH the procedure's typed call
 * parameters AND its result-row shape:
 *
 * <ul>
 *   <li>Fields with `@param` (truthy boolean OR direction string `"in"` / `"out"` /
 *       `"inout"`) become typed parameters of the generated `call(...)` function,
 *       preserving authoring order.</li>
 *   <li>Fields WITHOUT `@param` become result-row columns mapped back to the
 *       companion entity data class via `rs.getX(<column>)` calls, where `<column>` is
 *       the field's PHYSICAL column — its `@column`, else its name through the project's
 *       column-naming strategy — exactly what every other generator in this port binds
 *       for the same field.</li>
 * </ul>
 *
 * <p>Emission shapes (chosen automatically per entity):
 * <ol>
 *   <li><b>Stub only</b> — entity has zero {@code field.*} children: emit only
 *       `PROC_NAME` plus the documented hand-write pattern (backward-compat with the
 *       Phase L stub generator).</li>
 *   <li><b>No-arg call</b> — entity has result-row fields but zero `@param` fields:
 *       emit `fun call(): List<Entity>` invoking `SELECT * FROM ${PROC_NAME}()`.</li>
 *   <li><b>Typed-param call</b> — entity has one or more `@param` fields: emit
 *       `fun call(p1: T1, p2: T2, ...): List<Entity>` invoking
 *       `SELECT * FROM ${PROC_NAME}(?, ?, ...)` with a typed Exposed
 *       parameter-binding list.</li>
 * </ol>
 *
 * <p>The procedure's physical name comes from ONE resolver — [RdbSource.getPhysicalName],
 * the FR-016 four-step rule (`@proc` for `@kind: storedProc` → legacy `@table` → the
 * source's structural `name` via snake_case → `pluralize(snake_case(entity))`) — the same
 * resolver `<Entity>Names.NAME` is built from. This generator used to carry a resolver of
 * its own that read a `@procName` attribute no provider registers (ADR-0018 lists that
 * spelling as rejected; a strict load refuses it as `ERR_UNKNOWN_ATTR`), skipped the
 * structural-name step, and fell back to the lowercased short name where the canonical
 * rule pluralizes — so the wrapper and the names artifact could name two different
 * procedures for one object. A name resolved twice is a name that can disagree with
 * itself; there is one now.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 *   <li>{@code columnNaming} (optional): the column-naming strategy — the SAME arg
 *       [KotlinExposedTableGenerator] and [KotlinNamesGenerator] read, so the column a
 *       result row is read by and the column the names artifact declares resolve through
 *       the identical resolver + argument.</li>
 *   <li>{@code useNames} (optional, derived by the Maven mojo — see
 *       [com.metaobjects.generator.EmitsPhysicalNameConstants]): when the names artifact is
 *       in the run, `PROC_NAME` is initialised from `<Entity>Names.NAME` and each result
 *       column is read through `<Entity>Names.<MEMBER>_COLUMN`, so neither physical name
 *       is spelled a second time.</li>
 * </ul>
 */
open class KotlinStoredProcGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    /** See [KotlinExposedTableGenerator.columnNaming] — same arg, same default. */
    protected fun columnNaming(): String =
        getArg(KotlinGenUtil.ARG_COLUMN_NAMING, KotlinGenUtil.DEFAULT_COLUMN_NAMING)

    /**
     * See [KotlinExposedTableGenerator.useNames] — same arg, same default, same reason for
     * the default: a PRESENCE guard for a direct programmatic call, never a divergence
     * guard. In a Maven run the mojo derives it from the suite.
     */
    protected fun useNames(): Boolean =
        (getArg(KotlinGenUtil.ARG_USE_NAMES, "false") ?: "false").toBoolean()

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        for (entity in loader.metaObjects) {
            // FR-024: a stored-proc binding is gated on the SOURCE @kind, not the object
            // subtype — a proc-backed object.projection (the post-B4b spelling) emits a
            // callable just like the legacy proc-backed entity did.
            if (entity.subType != MetaObject.SUBTYPE_ENTITY &&
                entity.subType != MetaObject.SUBTYPE_PROJECTION) continue
            // Abstract entities are inheritance scaffolding — never emit a stored-proc binding.
            if (KotlinGenUtil.isAbstractEntity(entity)) continue
            // R27 (Task 6): the role-scoped PRIMARY source, resolving through `extends`
            // (ADR-0039) — NOT firstRdbSource's role-blind first-DECLARED pick. This is
            // the SAME selector KotlinGenUtil.resolveObjectNames uses to build
            // <Entity>Names.NAME, so the name this wrapper binds and the constant it
            // references (when useNames) resolve from one source node.
            val sourceRdb = KotlinGenUtil.primaryRdbSource(entity) ?: continue
            if (sourceRdb.effectiveKind != MetaSource.KIND_STORED_PROC) continue
            emit(entity, sourceRdb, outRoot)
        }
    }

    protected open fun emit(
        entity: MetaObject,
        sourceRdb: RdbSource,
        outRoot: java.nio.file.Path,
    ) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val objectName = KotlinNaming.procObjectName(shortName)
        // FR-016: the ONE physical-name resolver (see the class doc). Empty only for a
        // synthetic source with no parent and no name — not a shape the loader produces —
        // and a wrapper around a procedure with no name is not worth emitting.
        val procName = sourceRdb.physicalName?.takeIf { it.isNotEmpty() }
            ?: throw GeneratorException(
                "${entity.name}: its storedProc source.rdb resolves no physical name; " +
                    "declare @proc on the source")

        // Task 6 — the procedure name is spelled ONCE per run: when the names generator
        // is in the run, PROC_NAME is initialised FROM <Entity>Names.NAME (a const val
        // may be initialised from another const val — the compiler folds it), and the
        // KDoc names the constant rather than restating the literal. The literal arm is
        // the documented fallback for a run without the names generator.
        val namesObject = if (useNames()) KotlinNaming.namesObjectName(shortName) else null
        val procNameExpr = if (namesObject != null) "$namesObject.NAME" else "\"$procName\""
        val procNameDoc = if (namesObject != null)
            "the stored procedure named by `$namesObject.NAME`"
        else "stored procedure `$procName`"

        val allFields = entity.metaFields.toList()
        val params = allFields.filter { isParamField(it) }
        val resultFields = allFields.filter { !isParamField(it) }

        // Backward-compat path: no fields at all → emit the documented stub.
        val source = if (allFields.isEmpty()) {
            renderStub(pkg, shortName, objectName, procNameExpr, procNameDoc)
        } else {
            renderCallObject(pkg, shortName, objectName, procNameExpr, procNameDoc, params, resultFields)
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$objectName.kt")
        GeneratedFileWriter.write(outFile, source)
    }

    /**
     * Render the Phase-L documented stub (entity carries metadata only — no fields):
     * just `PROC_NAME` plus a KDoc example showing the hand-write wrapper shape.
     *
     * [procNameExpr] is the Kotlin EXPRESSION `PROC_NAME` is initialised from — a quoted
     * literal, or `<Entity>Names.NAME` — and [procNameDoc] the phrase the KDoc uses for
     * it, so the doc names the constant when the code does.
     */
    protected open fun renderStub(
        pkg: String,
        shortName: String,
        objectName: String,
        procNameExpr: String,
        procNameDoc: String,
    ): String = buildString {
        if (pkg.isNotEmpty()) {
            append("package $pkg\n\n")
        }
        append("import org.jetbrains.exposed.sql.Transaction\n\n")
        append("/**\n")
        append(" * GENERATED — stub for $procNameDoc.\n")
        append(" *\n")
        append(" * The $shortName entity carries no field declarations, so the call signature\n")
        append(" * and row-mapping body are consumer-specific. Fill in the wrapper with your\n")
        append(" * procedure's parameter set:\n")
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
        append("    const val PROC_NAME = $procNameExpr\n")
        append("}\n")
    }

    /**
     * Render the upgraded `<Entity>Proc` object with a real `call(...)` function:
     * typed parameters (from `@param` fields, in authoring order) and a result-row
     * loop that maps each `ResultSet` column back into the companion entity data class.
     * See [renderStub] for [procNameExpr] / [procNameDoc].
     */
    protected open fun renderCallObject(
        pkg: String,
        shortName: String,
        objectName: String,
        procNameExpr: String,
        procNameDoc: String,
        params: List<MetaField<*>>,
        resultFields: List<MetaField<*>>,
    ): String = buildString {
        if (pkg.isNotEmpty()) {
            append("package $pkg\n\n")
        }
        append("import org.jetbrains.exposed.sql.Transaction\n")
        append("import org.jetbrains.exposed.sql.transactions.transaction\n\n")

        append("/** GENERATED — wrapper for $procNameDoc. */\n")
        append("object $objectName {\n")
        append("    const val PROC_NAME = $procNameExpr\n\n")
        append("    /** Call the procedure and map result rows into [$shortName]. */\n")

        // Function signature.
        val paramSig = params.joinToString(", ") { f -> "${f.name}: ${kotlinParamTypeFqn(f)}" }
        append("    fun call($paramSig): List<$shortName> = transaction {\n")
        append("        val results = mutableListOf<$shortName>()\n")

        // SQL + placeholder list — empty parens when no params.
        val placeholders = params.joinToString(", ") { "?" }
        append("        exec(\"SELECT * FROM \${PROC_NAME}($placeholders)\"")
        if (params.isEmpty()) {
            // No-arg path: omit the bindings list entirely; Exposed's `exec(stmt, body)` is fine.
            append(") { rs ->\n")
        } else {
            val bindings = params.joinToString(",\n") { p ->
                "            ${exposedColumnTypeCtor(p)} to ${p.name}"
            }
            append(", listOf(\n")
            append(bindings)
            append("\n        )) { rs ->\n")
        }

        append("            while (rs.next()) {\n")
        if (resultFields.isEmpty()) {
            // Edge case: every field is a @param. Emit a no-arg ctor invocation;
            // if the data class requires arguments this will fail to compile and the
            // author can adjust their metadata. Per spec, we still produce a typed call.
            append("                results.add($shortName())\n")
        } else {
            val rowMapping = resultFields.joinToString(",\n") { rf ->
                "                    ${rf.name} = ${rsGetterCall(rf, columnExpr(shortName, rf))}"
            }
            append("                results.add($shortName(\n")
            append(rowMapping)
            append("\n                ))\n")
        }
        append("            }\n")
        append("        }\n")
        append("        results\n")
        append("    }\n")
        append("}\n")
    }

    /**
     * The column-name EXPRESSION a result-row getter reads by: `<Entity>Names.<MEMBER>_COLUMN`
     * when the names artifact is in the run, else the quoted PHYSICAL column literal —
     * [KotlinGenUtil.resolveColumnName] through the same strategy arg the names artifact is
     * built with, so the two arms name the same column.
     *
     * The same rule as [KotlinExposedTableGenerator.ownColumnExpr]: a result field IS a field
     * of this entity (the proc-backed projection), so its constant lives on this entity's own
     * artifact; the reference and the value it stands for derive from one shared transform
     * ([KotlinNaming.namesMember]).
     */
    private fun columnExpr(shortName: String, field: MetaField<*>): String =
        if (useNames())
            "${KotlinNaming.namesObjectName(shortName)}.${KotlinNaming.namesMember(field.name)}_COLUMN"
        else "\"${KotlinGenUtil.resolveColumnName(field, columnNaming())}\""

    /**
     * Is this field declared as a stored-proc call parameter? Truthy values:
     *   - boolean `true`
     *   - string `"true"`, `"in"`, `"out"`, `"inout"` (case-insensitive)
     * Any other value (false, `"false"`, missing attr) means "result-row column".
     */
    private fun isParamField(field: MetaField<*>): Boolean {
        // ADR-0039: @param is an inheritable effective field property — a concrete
        // field extending an abstract param-field inherits it. RESOLVE (default true).
        if (!field.hasMetaAttr(ATTR_PARAM)) return false
        val raw = runCatching { field.getMetaAttr(ATTR_PARAM).value }.getOrNull()
        return when (raw) {
            is Boolean -> raw
            is String -> {
                val v = raw.trim().lowercase()
                v == "true" || v == "in" || v == "out" || v == "inout"
            }
            else -> false
        }
    }

    /**
     * Fully qualified Kotlin parameter type for a call-parameter field. Uses the
     * same semantic mapping as [KotlinTypeMapper.kotlinTypeName] but emitted as a
     * source-level type reference (no KotlinPoet imports). Date / Instant / UUID
     * are rendered as fully qualified names so the generated source compiles
     * without additional imports.
     */
    private fun kotlinParamTypeFqn(field: MetaField<*>): String = when (field) {
        is StringField    -> "String"
        is IntegerField   -> "Int"
        is LongField      -> "Long"
        is DoubleField    -> "Double"
        is BooleanField   -> "Boolean"
        is DateField      -> "java.time.LocalDate"
        is TimestampField -> "java.time.Instant"
        is CurrencyField  -> "Long"
        is EnumField      -> "String"
        is UuidField      -> "java.util.UUID"
        else -> throw IllegalArgumentException(
            "unsupported Kotlin param type mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /**
     * Exposed `ColumnType` constructor expression for a call-parameter field.
     * Emitted fully qualified so generated source compiles without imports.
     * Mirrors the [KotlinTypeMapper.exposedColumnSpec] vocabulary at the
     * column-type-class level (one rung above the column-builder factory).
     */
    private fun exposedColumnTypeCtor(field: MetaField<*>): String = when (field) {
        is StringField    -> "org.jetbrains.exposed.sql.VarCharColumnType(255)"
        is IntegerField   -> "org.jetbrains.exposed.sql.IntegerColumnType()"
        is LongField      -> "org.jetbrains.exposed.sql.LongColumnType()"
        is DoubleField    -> "org.jetbrains.exposed.sql.DoubleColumnType()"
        is BooleanField   -> "org.jetbrains.exposed.sql.BooleanColumnType()"
        is DateField      -> "org.jetbrains.exposed.sql.javatime.JavaLocalDateColumnType()"
        is TimestampField -> "org.jetbrains.exposed.sql.javatime.JavaInstantColumnType()"
        is CurrencyField  -> "org.jetbrains.exposed.sql.LongColumnType()"
        is EnumField      -> "org.jetbrains.exposed.sql.VarCharColumnType(${KotlinTypeMapper.ENUM_VARCHAR_LEN})"
        is UuidField      -> "org.jetbrains.exposed.sql.UUIDColumnType()"
        else -> throw IllegalArgumentException(
            "unsupported Exposed ColumnType for param ${field::class.simpleName} '${field.name}'"
        )
    }

    /**
     * `ResultSet` getter expression for a result-row field. [colExpr] is the column-name
     * EXPRESSION the getter reads by — see [columnExpr] — the field's PHYSICAL column, so
     * the wrapper asks the result set for the column the procedure actually returns.
     *
     * This used to pass the field's LOGICAL name and document "AS-alias handling" as the
     * consumer's job when the two diverged: a wrapper that asked for `totalCents` on a
     * procedure returning `total_cents` failed at runtime, while the names artifact carried
     * the real column and nothing read it.
     */
    private fun rsGetterCall(field: MetaField<*>, colExpr: String): String = when (field) {
        is StringField    -> "rs.getString($colExpr)"
        is IntegerField   -> "rs.getInt($colExpr)"
        is LongField      -> "rs.getLong($colExpr)"
        is DoubleField    -> "rs.getDouble($colExpr)"
        is BooleanField   -> "rs.getBoolean($colExpr)"
        is DateField      -> "rs.getDate($colExpr).toLocalDate()"
        is TimestampField -> "rs.getTimestamp($colExpr).toInstant()"
        is CurrencyField  -> "rs.getLong($colExpr)"
        is EnumField      -> "rs.getString($colExpr)"
        is UuidField      -> "rs.getObject($colExpr, java.util.UUID::class.java)"
        else -> throw IllegalArgumentException(
            "unsupported ResultSet getter for ${field::class.simpleName} '${field.name}'"
        )
    }

    private companion object {
        /** Attr on a `field.*` declaring it as a stored-proc call parameter. */
        const val ATTR_PARAM = "param"
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

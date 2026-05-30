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
 *       companion entity data class via `rs.getX("col")` calls.</li>
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
            // Abstract entities are inheritance scaffolding — never emit a stored-proc binding.
            if (KotlinGenUtil.isAbstractEntity(entity)) continue
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

        val allFields = entity.metaFields.toList()
        val params = allFields.filter { isParamField(it) }
        val resultFields = allFields.filter { !isParamField(it) }

        // Backward-compat path: no fields at all → emit the documented stub.
        val source = if (allFields.isEmpty()) {
            renderStub(pkg, shortName, objectName, procName)
        } else {
            renderCallObject(pkg, shortName, objectName, procName, params, resultFields)
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$objectName.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, source)
    }

    /**
     * Render the Phase-L documented stub (entity carries metadata only — no fields):
     * just `PROC_NAME` plus a KDoc example showing the hand-write wrapper shape.
     */
    private fun renderStub(
        pkg: String,
        shortName: String,
        objectName: String,
        procName: String,
    ): String = buildString {
        if (pkg.isNotEmpty()) {
            append("package $pkg\n\n")
        }
        append("import org.jetbrains.exposed.sql.Transaction\n\n")
        append("/**\n")
        append(" * GENERATED — stub for stored procedure `$procName`.\n")
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
        append("    const val PROC_NAME = \"$procName\"\n")
        append("}\n")
    }

    /**
     * Render the upgraded `<Entity>Proc` object with a real `call(...)` function:
     * typed parameters (from `@param` fields, in authoring order) and a result-row
     * loop that maps each `ResultSet` column back into the companion entity data class.
     */
    private fun renderCallObject(
        pkg: String,
        shortName: String,
        objectName: String,
        procName: String,
        params: List<MetaField<*>>,
        resultFields: List<MetaField<*>>,
    ): String = buildString {
        if (pkg.isNotEmpty()) {
            append("package $pkg\n\n")
        }
        append("import org.jetbrains.exposed.sql.Transaction\n")
        append("import org.jetbrains.exposed.sql.transactions.transaction\n\n")

        append("/** GENERATED — wrapper for stored procedure `$procName`. */\n")
        append("object $objectName {\n")
        append("    const val PROC_NAME = \"$procName\"\n\n")
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
                "                    ${rf.name} = ${rsGetterCall(rf)}"
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
     * Resolve the SQL proc name from (in order): {@code @procName} → {@code @table}
     * → the entity's lowercased short name.
     */
    private fun resolveProcName(sourceRdb: RdbSource, entityShortName: String): String {
        readStringAttr(sourceRdb, ATTR_PROC_NAME)?.let { return it }
        sourceRdb.tableName?.let { return it }
        return entityShortName.lowercase()
    }

    /**
     * Is this field declared as a stored-proc call parameter? Truthy values:
     *   - boolean `true`
     *   - string `"true"`, `"in"`, `"out"`, `"inout"` (case-insensitive)
     * Any other value (false, `"false"`, missing attr) means "result-row column".
     */
    private fun isParamField(field: MetaField<*>): Boolean {
        if (!field.hasMetaAttr(ATTR_PARAM, false)) return false
        val raw = runCatching { field.getMetaAttr(ATTR_PARAM, false).value }.getOrNull()
        return when (raw) {
            is Boolean -> raw
            is String -> {
                val v = raw.trim().lowercase()
                v == "true" || v == "in" || v == "out" || v == "inout"
            }
            else -> false
        }
    }

    /** Read an own-only string attr; null when absent or unreadable. */
    private fun readStringAttr(rdb: RdbSource, attrName: String): String? {
        if (!rdb.hasMetaAttr(attrName, false)) return null
        return runCatching { rdb.getMetaAttr(attrName, false).valueAsString }.getOrNull()
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
        else -> if (field.subType == SUBTYPE_UUID) "java.util.UUID"
        else throw IllegalArgumentException(
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
        else -> if (field.subType == SUBTYPE_UUID) "org.jetbrains.exposed.sql.UUIDColumnType()"
        else throw IllegalArgumentException(
            "unsupported Exposed ColumnType for param ${field::class.simpleName} '${field.name}'"
        )
    }

    /**
     * `ResultSet` getter expression for a result-row field. The column name passed
     * to `rs.getX("...")` is the field's logical name (matches the data class
     * property); SELECT * + AS-alias handling is the consumer's responsibility if
     * physical column names diverge from logical.
     */
    private fun rsGetterCall(field: MetaField<*>): String {
        val col = field.name
        return when (field) {
            is StringField    -> "rs.getString(\"$col\")"
            is IntegerField   -> "rs.getInt(\"$col\")"
            is LongField      -> "rs.getLong(\"$col\")"
            is DoubleField    -> "rs.getDouble(\"$col\")"
            is BooleanField   -> "rs.getBoolean(\"$col\")"
            is DateField      -> "rs.getDate(\"$col\").toLocalDate()"
            is TimestampField -> "rs.getTimestamp(\"$col\").toInstant()"
            is CurrencyField  -> "rs.getLong(\"$col\")"
            is EnumField      -> "rs.getString(\"$col\")"
            else -> if (field.subType == SUBTYPE_UUID)
                "rs.getObject(\"$col\", java.util.UUID::class.java)"
            else throw IllegalArgumentException(
                "unsupported ResultSet getter for ${field::class.simpleName} '${field.name}'"
            )
        }
    }

    private companion object {
        /** Attr on `source.rdb` naming the SQL procedure to call. */
        const val ATTR_PROC_NAME = "procName"

        /** Attr on a `field.*` declaring it as a stored-proc call parameter. */
        const val ATTR_PARAM = "param"

        /** Metadata subtype name for `field.uuid` (no UuidField JVM class yet). */
        const val SUBTYPE_UUID = "uuid"
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

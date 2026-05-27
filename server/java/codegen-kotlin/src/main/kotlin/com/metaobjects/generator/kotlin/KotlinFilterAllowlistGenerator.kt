package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DecimalField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.FloatField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimeField
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
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one `<Entity>FilterAllowlist.kt` per writable `object.entity`
 * (`source.rdb @kind="table"`) that emits a Kotlin `object` containing the
 * per-entity FR-009 filter allowlist (the set of filterable field names plus
 * the operator vocabulary permitted per field, gated by field subtype).
 *
 * <p>Authoring contract: only fields with `@filterable: true` appear in the
 * allowlist. If no field is marked filterable the file is still emitted (with
 * empty constants) so the generated controller can unconditionally delegate
 * to it without conditional codegen branching.</p>
 *
 * <p>Operators-per-subtype mapping (FR-009 §5, identical across ports):
 * <ul>
 *   <li>`string` / `enum` → `eq, ne, in, like, isNull`</li>
 *   <li>`int / long / float / double / decimal / currency / date / timestamp / time`
 *       → `eq, ne, gt, gte, lt, lte, in, isNull`</li>
 *   <li>`boolean` → `eq, isNull`</li>
 * </ul>
 *
 * <p>{@link ObjectField} children are skipped — they have no SQL column
 * surface that filters can target.</p>
 *
 * <p>Mirrors the Java sibling `SpringFilterAllowlistGenerator` so the
 * authoring contract + emitted shape stay aligned across the JVM ports.</p>
 *
 * <p>Args:
 * <ul>
 *   <li>`outputDir` (required): output directory root.</li>
 * </ul>
 */
class KotlinFilterAllowlistGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            val sourceRdb = entity.children.filterIsInstance<RdbSource>().firstOrNull() ?: continue
            // Only writable tables get a filter allowlist (the controller is also
            // table-only). View / materializedView are read-only; storedProc has its
            // own dispatch; tableFunction has no controller surface today.
            if (sourceRdb.effectiveKind != MetaSource.KIND_TABLE) continue
            emit(entity, outRoot)
        }
    }

    private fun emit(entity: MetaObject, outRoot: Path) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val className = "${shortName}FilterAllowlist"

        val opsByField = computeFilterableOps(entity)

        val src = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("/**\n")
            append(" * GENERATED — per-entity FR-009 filter allowlist for $shortName.\n")
            append(" * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the\n")
            append(" * operator vocabulary for each field by its subtype.\n")
            append(" */\n")
            append("object $className {\n")

            // FIELDS — emit emptySet() / setOf() per Kotlin style. The empty case must use
            // `emptySet<String>()` so the property has an inferable type even when no fields
            // are filterable (the controller's generated parser binds against this).
            append("    val FIELDS: Set<String> = ")
            if (opsByField.isEmpty()) {
                append("emptySet()\n\n")
            } else {
                append("setOf(\n")
                for (f in opsByField.keys) {
                    append("        \"$f\",\n")
                }
                append("    )\n\n")
            }

            // OPS_BY_FIELD — `Map<String, Set<String>>`. Empty map uses `emptyMap()` for
            // the same type-inferability reason; populated case uses mapOf("name" to setOf(...)).
            append("    val OPS_BY_FIELD: Map<String, Set<String>> = ")
            if (opsByField.isEmpty()) {
                append("emptyMap()\n")
            } else {
                append("mapOf(\n")
                val entries = opsByField.entries.toList()
                for ((i, e) in entries.withIndex()) {
                    append("        \"${e.key}\" to setOf(")
                    var firstOp = true
                    for (op in e.value) {
                        if (!firstOp) append(", ")
                        firstOp = false
                        append("\"$op\"")
                    }
                    append(")")
                    if (i < entries.size - 1) append(",")
                    append("\n")
                }
                append("    )\n")
            }
            append("}\n")
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$className.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, src)
    }

    internal companion object {
        /** Metadata attribute marking a field as filterable in the generated allowlist. */
        internal const val ATTR_FILTERABLE: String = "filterable"

        /** Operator set for string-shaped subtypes. */
        private val OPS_STRING: Set<String> = linkedSetOf("eq", "ne", "in", "like", "isNull")

        /** Operator set for numeric / date / timestamp / currency subtypes. */
        private val OPS_NUMERIC: Set<String> = linkedSetOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull")

        /** Operator set for boolean subtype. */
        private val OPS_BOOLEAN: Set<String> = linkedSetOf("eq", "isNull")

        /**
         * Build the `(fieldName → opSet)` map for `entity`. Only fields with
         * `@filterable: true` are included; subtypes outside the FR-009 vocabulary
         * collapse to the empty op-set (defensive — the allowlist becomes an effective
         * "field is unknown" gate).
         */
        internal fun computeFilterableOps(entity: MetaObject): Map<String, Set<String>> {
            val out = linkedMapOf<String, Set<String>>()
            for (field in entity.metaFields) {
                if (field is ObjectField) continue
                if (!isFilterable(field)) continue
                val ops = opsForSubtype(field.subType)
                if (ops.isEmpty()) continue
                out[field.name] = ops
            }
            return out
        }

        /** True iff `field` carries `@filterable: true` as a metadata attribute. */
        private fun isFilterable(field: MetaField<*>): Boolean {
            if (!field.hasMetaAttr(ATTR_FILTERABLE, false)) return false
            val raw = runCatching { field.getMetaAttr(ATTR_FILTERABLE, false).value }.getOrNull()
            return when (raw) {
                is Boolean -> raw
                is String -> raw.equals("true", ignoreCase = true)
                else -> false
            }
        }

        private fun opsForSubtype(subType: String?): Set<String> {
            if (subType == null) return emptySet()
            return when (subType) {
                StringField.SUBTYPE_STRING, EnumField.SUBTYPE_ENUM -> OPS_STRING
                IntegerField.SUBTYPE_INT,
                LongField.SUBTYPE_LONG,
                FloatField.SUBTYPE_FLOAT,
                DoubleField.SUBTYPE_DOUBLE,
                DecimalField.SUBTYPE_DECIMAL,
                CurrencyField.SUBTYPE_CURRENCY,
                DateField.SUBTYPE_DATE,
                TimestampField.SUBTYPE_TIMESTAMP,
                TimeField.SUBTYPE_TIME -> OPS_NUMERIC
                BooleanField.SUBTYPE_BOOLEAN -> OPS_BOOLEAN
                else -> emptySet()
            }
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
        PackageMapping.splitFqn(md.name).second + "FilterAllowlist.kt"
}

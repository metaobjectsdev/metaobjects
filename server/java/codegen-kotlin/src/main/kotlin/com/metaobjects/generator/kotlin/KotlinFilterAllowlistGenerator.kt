package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
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
 *   <li>`uuid` → `eq, ne, in, isNull` (no `like` — not a substring type, no ordering)</li>
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
open class KotlinFilterAllowlistGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

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
            emit(entity, outRoot, loader)
        }
    }

    protected open fun emit(entity: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val className = KotlinNaming.filterAllowlistName(shortName)

        // FR-017 TPH: a discriminator base's allowlist unions its subtype-only filterable columns,
        // but EXCLUDES (a) the discriminator — addressable via the per-subtype route segment, and
        // (b) decimal columns — outside the cross-port HTTP filter/value contract. Keeps the Java +
        // Kotlin filter surface identical (see the Java SpringFilterAllowlistGenerator).
        val opsByField = if (KotlinTphPlan.isTphBase(entity, loader)) {
            val disc = KotlinTphPlan.planFor(entity, loader)!!.discriminatorField
            val union = (entity.metaFields + KotlinTphPlan.collectSubtypeFields(entity, loader))
                .filter { it.name != disc && it !is com.metaobjects.field.DecimalField }
            computeFilterableOps(union)
        } else {
            computeFilterableOps(entity)
        }

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

    private companion object {
        /** Metadata attribute marking a field as filterable in the generated allowlist. */
        const val ATTR_FILTERABLE: String = "filterable"

        /**
         * Build the `(fieldName → opSet)` map for `entity`. Only fields with
         * `@filterable: true` are included; subtypes outside the FR-009 vocabulary
         * collapse to the empty op-set (defensive — the allowlist becomes an effective
         * "field is unknown" gate).
         */
        fun computeFilterableOps(entity: MetaObject): Map<String, Set<String>> =
            computeFilterableOps(entity.metaFields)

        /**
         * [computeFilterableOps] over an explicit field list — used for a TPH base, whose allowlist
         * is the UNION of the base's own + every subtype-only filterable column (so the polymorphic
         * + per-subtype lists can filter on subtype columns, matching the Java/Python/TS lanes).
         */
        fun computeFilterableOps(fields: Iterable<MetaField<*>>): Map<String, Set<String>> {
            val out = linkedMapOf<String, Set<String>>()
            for (field in fields) {
                if (field is ObjectField) continue
                if (!isFilterable(field)) continue
                val ops = opsForSubtype(field.subType)
                if (ops.isEmpty()) continue
                out.putIfAbsent(field.name, ops) // dedup base/subtype column names
            }
            return out
        }

        /** True iff `field` carries `@filterable: true` as a metadata attribute. */
        private fun isFilterable(field: MetaField<*>): Boolean {
            if (!field.hasMetaAttr(ATTR_FILTERABLE, true)) return false
            val raw = runCatching { field.getMetaAttr(ATTR_FILTERABLE, true).value }.getOrNull()
            return when (raw) {
                is Boolean -> raw
                is String -> raw.equals("true", ignoreCase = true)
                else -> false
            }
        }

        // Single source of truth — com.metaobjects.query.FilterOps (the same band
        // the loader's validation path + the Java codegen-spring generator read).
        // Returns a canonical-ordered set so the emitted source is stable; an
        // unbanded subtype → empty set, which computeFilterableOps drops.
        private fun opsForSubtype(subType: String?): Set<String> =
            com.metaobjects.query.FilterOps.opsForSubType(subType)
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
        KotlinNaming.filterAllowlistName(PackageMapping.splitFqn(md.name).second) + ".kt"
}

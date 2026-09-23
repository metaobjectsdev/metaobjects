package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.KotlinNaming
import com.metaobjects.generator.kotlin.KotlinTphPlan
import com.metaobjects.generator.kotlin.PackageMapping

import com.metaobjects.field.MetaField
import com.metaobjects.field.MapField
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
import com.metaobjects.generator.util.RestSurfaceGate
import com.metaobjects.generator.util.GeneratedFileWriter

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
            // FR-017 TPH: a discriminator subtype folds into its base — the base's allowlist
            // (unioned across subtype columns via isTphBase) is the only one the polymorphic
            // controller uses; a per-subtype allowlist is dead. Mirror the controller/table skip.
            if (KotlinTphPlan.isTphSubtype(entity)) continue
            // THE shared gate (codegen-base RestSurfaceGate) — the same predicate
            // KotlinSpringControllerGenerator asks. It must be the same CALL and not merely the
            // same rule: the generated controller references this <Short>FilterAllowlist by
            // name, so a gate widened there and not here emits a controller with an unresolved
            // reference, and codegen still exits 0. It covers the writable arm (table kind, or
            // a write-through entity detected order-independently — NEVER firstRdbSource, which
            // would skip a view-source-first one) AND, since F22, the read-only arm: a view-kind
            // object.projection has a list route, so it filters.
            if (!RestSurfaceGate.emitsRestSurface(entity)) continue
            emit(entity, outRoot, loader)
        }
    }

    protected open fun emit(entity: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val className = KotlinNaming.filterAllowlistName(shortName)

        // FR-017 TPH: a discriminator base's allowlist unions its subtype-only filterable columns
        // and keeps the discriminator, so `GET /<base>?filter[<disc>][in]=A,B` narrows the
        // polymorphic list (FR-017 "Filter allowlists"; TS, C# and Python admit it too). It
        // EXCLUDES decimal columns — outside the cross-port HTTP filter/value contract. Keeps the
        // Java + Kotlin filter surface identical (see the Java SpringFilterAllowlistGenerator).
        //
        // The per-subtype routes share this one allowlist, so `/<base>/<seg>` also accepts the
        // discriminator (AND'd with the route's own, a no-op or an empty list) and another
        // subtype's columns (an empty list). FR-017 gives each subtype its own allowlist that
        // rejects both; only TypeScript emits that. Answers stay truthful either way, so it is
        // left to an adopter who wants the 400 to own this generator: subclass it and name the
        // subclass in the Maven plugin's `<generator><classname>`.
        val opsByField = if (KotlinTphPlan.isTphBase(entity, loader)) {
            val union = (entity.metaFields + KotlinTphPlan.collectSubtypeFields(entity, loader))
                .filter { it !is com.metaobjects.field.DecimalField }
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
        GeneratedFileWriter.write(outFile, src)
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
                // field.object / field.map are jsonb columns with no scalar SQL column —
                // excluded from the filter allowlist (no filter dispatch).
                if (field is ObjectField || field is MapField) continue
                if (!isFilterable(field)) continue
                val ops = opsForField(field)
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
        //
        // Field-level, not subtype-level: an int-backed field.enum (@intValueMap,
        // design D5) stores as an INTEGER column, so `like` — a substring match —
        // is not in its band. Pinned cross-port by
        // fixtures/conformance/filter-ops-matrix (fEnum vs fEnumInt).
        private fun opsForField(field: MetaField<*>): Set<String> =
            com.metaobjects.query.FilterOps.opsForField(field)
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

package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.`object`.MetaObject

/**
 * FR-010 nested gap (codegen-wrapping-runtime): emits the Kotlin SOURCE for the
 * `from<Recovered>(Map)` mapper functions used by the runtime-delegating
 * `recover(loader, text)` overload in [KotlinOutputParserGenerator].
 *
 * <p>The runtime [com.metaobjects.object.recover.MetaObjectRecover] assembles the full
 * nested object graph reflection-free (a `ValueObject`, which IS a `Map<String, Any?>`,
 * with nested `ValueObject` / `List<ValueObject>` values). These generated mappers only
 * TRANSLATE that generic graph into the typed all-nullable Recovered-mirror graph emitted
 * by [KotlinRecoverSchemaEmitter.recoveredClassDeclsNested]:</p>
 * <ul>
 *   <li>scalars / enums / scalar-arrays → via [com.metaobjects.render.recover.RecoverMap];</li>
 *   <li>a single nested object → recurse into its `from<NestedRecovered>` mapper;</li>
 *   <li>an array-of-objects → map each element `Map` via `mapObjectList`.</li>
 * </ul>
 *
 * <p>One mapper is emitted per reachable value-object (root + nested), deduped by FQN —
 * the same dedupe set also stops the emitter from recursing forever on a cyclic graph
 * (cycle/depth bounding of the assembled graph itself is handled upstream by the runtime).</p>
 *
 * <p>Isolated from the generator (and from [KotlinRecoverSchemaEmitter], which owns the
 * mirror declarations) so the mapper-emission logic is independently unit-testable.</p>
 */
internal object KotlinRecoverMapperEmitter {

    /**
     * Emit all `from<Recovered>(Map)` mappers reachable from [rootVo] (mapped to
     * [rootRecoveredClass]) plus the shared `asMap` / `mapObjectList` helpers. Returns the
     * concatenated Kotlin source, each member prefixed with a blank line for readability.
     */
    fun mapperMethods(rootVo: MetaObject, rootRecoveredClass: String): String {
        val out = StringBuilder()
        val emitted = LinkedHashSet<String>()
        emitMapper(rootVo, rootRecoveredClass, out, emitted)
        appendHelpers(out)
        return out.toString()
    }

    private fun emitMapper(
        vo: MetaObject,
        recoveredClass: String,
        out: StringBuilder,
        emitted: LinkedHashSet<String>,
    ) {
        if (!emitted.add(vo.name)) return // dedupe + cycle guard

        val nested = mutableListOf<MetaObject>()
        val args = vo.metaFields.joinToString(",\n") { field ->
            "            ${mapperArgForField(field, nested)}"
        }

        out.append("\n")
        out.append("    /** Map an assembled ValueObject (Map) into a typed [$recoveredClass]; null-tolerant. */\n")
        out.append("    private fun from$recoveredClass(d: Map<String, Any?>?): $recoveredClass? {\n")
        out.append("        if (d == null) return null\n")
        out.append("        return $recoveredClass(\n")
        out.append(args)
        out.append(",\n")
        out.append("        )\n")
        out.append("    }\n")

        // Recurse into nested mappers (post-order, deduped).
        for (nestedVo in nested) {
            emitMapper(nestedVo, KotlinRecoverSchemaEmitter.nestedRecoveredClass(nestedVo), out, emitted)
        }
    }

    /**
     * Build the constructor-argument expression that reads [field] from the assembled
     * `Map<String, Any?> d`. Scalars/enums/scalar-arrays go through `RecoverMap`; a nested
     * object recurses into its generated mapper; an array-of-objects maps each element.
     * Records the discovered nested VO into [nested] so the caller emits its mapper.
     */
    private fun mapperArgForField(field: MetaField<*>, nested: MutableList<MetaObject>): String {
        val name = KotlinRecoverSchemaEmitter.kotlinStringLiteral(field.name)

        // Nested object / array-of-objects (NOT enum — that is a string-backed scalar).
        val target = KotlinRecoverSchemaEmitter.objectRefValueObject(field)
        if (target != null) {
            nested.add(target)
            val nestedClass = KotlinRecoverSchemaEmitter.nestedRecoveredClass(target)
            return if (field.isArrayType()) {
                // List<NestedRecovered>?: map each element Map; the assembled value is a List.
                // `it` is a non-null Map here, so from<Nested> never returns null — `!!` keeps
                // the element type non-null to match the List<NestedRecovered> mirror property.
                "mapObjectList(d, \"$name\") { from$nestedClass(it)!! }"
            } else {
                // Single nested object: cast the element to a Map and recurse.
                "from$nestedClass(asMap(d[\"$name\"]))"
            }
        }

        // Scalar arrays (incl. array-of-enum): List<String>.
        if (field.isArrayType()) {
            return "RecoverMap.asStringList(d, \"$name\")"
        }

        // Enum fields (non-array): string-backed on the wire.
        if (field is EnumField) {
            return "RecoverMap.asString(d, \"$name\")"
        }

        // Scalars.
        return when (field) {
            is IntegerField -> "RecoverMap.asInt(d, \"$name\")"
            is LongField    -> "RecoverMap.asLong(d, \"$name\")"
            is DoubleField  -> "RecoverMap.asDouble(d, \"$name\")"
            is BooleanField -> "RecoverMap.asBool(d, \"$name\")"
            else            -> "RecoverMap.asString(d, \"$name\")"
        }
    }

    /**
     * Append the two shared private helpers the mappers rely on: `asMap` (null-tolerant
     * `Any? -> Map<String, Any?>?` cast — a ValueObject IS a Map) and `mapObjectList`
     * (map each element of an assembled `List` via a per-element function, skipping non-Map
     * elements). Emitted once per parser object.
     */
    private fun appendHelpers(out: StringBuilder) {
        out.append("\n")
        out.append("    /** Null-tolerant cast of an assembled value to a Map (a ValueObject IS a Map). */\n")
        out.append("    @Suppress(\"UNCHECKED_CAST\")\n")
        out.append("    private fun asMap(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>\n")
        out.append("\n")
        out.append("    /** Map each element of an assembled List<Map> via [fn]; null/absent -> null; non-Map elements skipped. */\n")
        out.append("    private fun <T> mapObjectList(d: Map<String, Any?>?, key: String, fn: (Map<String, Any?>) -> T): List<T>? {\n")
        out.append("        val v = d?.get(key) as? List<*> ?: return null\n")
        out.append("        val outList = ArrayList<T>(v.size)\n")
        out.append("        for (elem in v) {\n")
        out.append("            val m = asMap(elem)\n")
        out.append("            if (m != null) outList.add(fn(m))\n")
        out.append("        }\n")
        out.append("        return outList\n")
        out.append("    }\n")
    }
}

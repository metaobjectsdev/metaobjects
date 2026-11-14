package com.metaobjects.generator.kotlin

import com.metaobjects.generator.util.GeneratedFileWriter
import java.nio.file.Path

/**
 * Writes the per-package `MetaUnknownBodyKeys.kt` support file: the cross-port answer
 * `400 {"error": "unknown_fields", "fields": [...]}` for a write body that carries a top-level
 * key the entity does not declare (`api.unknownFields: reject`, the default). The keys are read
 * off the raw `JsonNode` BEFORE the body is bound, so the answer never depends on whether the
 * host's `ObjectMapper` fails on unknown properties. Keys are listed in code-point order.
 *
 * Generated source: the controller imports nothing from MetaObjects at runtime. Written only
 * when the project rejects unknown keys; the content is fixed.
 */
object KotlinUnknownBodyKeysEmitter {

    /** File name (sans `.kt`) and the name of the `internal object` it declares. */
    const val FILE_NAME = "MetaUnknownBodyKeys"

    /** Write `MetaUnknownBodyKeys.kt` into [pkg] under [outRoot]. */
    fun write(pkg: String, outRoot: Path) {
        val header = if (pkg.isEmpty()) "" else "package $pkg\n\n"
        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$FILE_NAME.kt")
        GeneratedFileWriter.write(outFile, header + BODY + "\n")
    }

    /** The fixed body. No Kotlin string templates, so this raw string needs no `$` escaping. */
    val BODY: String = """
        |import com.fasterxml.jackson.databind.JsonNode
        |
        |/**
        | * GENERATED — do not hand-edit. The answer for a write body naming a key the entity does not declare.
        | */
        |internal object MetaUnknownBodyKeys {
        |    /**
        |     * The 400 body for [body]'s top-level keys outside [known], or null when there are none or [body] is not
        |     * a JSON object (a body that is not an object is left to the handler's own reading of it).
        |     */
        |    fun refusal(body: JsonNode, known: Set<String>): Map<String, Any>? {
        |        if (!body.isObject) return null
        |        val unknown = ArrayList<String>()
        |        val names = body.fieldNames()
        |        while (names.hasNext()) {
        |            val name = names.next()
        |            if (name !in known) unknown.add(name)
        |        }
        |        if (unknown.isEmpty()) return null
        |        unknown.sortWith { a, b -> compareCodePoints(a, b) }
        |        return linkedMapOf("error" to "unknown_fields", "fields" to unknown)
        |    }
        |
        |    /** Ordinal order by Unicode code point (not UTF-16 unit), the order every port answers in. */
        |    private fun compareCodePoints(a: String, b: String): Int {
        |        var i = 0
        |        var j = 0
        |        while (i < a.length && j < b.length) {
        |            val ca = a.codePointAt(i)
        |            val cb = b.codePointAt(j)
        |            if (ca != cb) return ca.compareTo(cb)
        |            i += Character.charCount(ca)
        |            j += Character.charCount(cb)
        |        }
        |        return (a.length - i).compareTo(b.length - j)
        |    }
        |}
    """.trimMargin()
}

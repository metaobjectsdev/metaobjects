package acme.blog

import com.fasterxml.jackson.databind.JsonNode

/**
 * GENERATED — do not hand-edit. The answer for a write body naming a key the entity does not declare.
 */
internal object MetaUnknownBodyKeys {
    /**
     * The 400 body for [body]'s top-level keys outside [known], or null when there are none or [body] is not
     * a JSON object (a body that is not an object is left to the handler's own reading of it).
     */
    fun refusal(body: JsonNode, known: Set<String>): Map<String, Any>? {
        if (!body.isObject) return null
        val unknown = ArrayList<String>()
        val names = body.fieldNames()
        while (names.hasNext()) {
            val name = names.next()
            if (name !in known) unknown.add(name)
        }
        if (unknown.isEmpty()) return null
        unknown.sortWith { a, b -> compareCodePoints(a, b) }
        return linkedMapOf("error" to "unknown_fields", "fields" to unknown)
    }

    /** Ordinal order by Unicode code point (not UTF-16 unit), the order every port answers in. */
    private fun compareCodePoints(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val ca = a.codePointAt(i)
            val cb = b.codePointAt(j)
            if (ca != cb) return ca.compareTo(cb)
            i += Character.charCount(ca)
            j += Character.charCount(cb)
        }
        return (a.length - i).compareTo(b.length - j)
    }
}

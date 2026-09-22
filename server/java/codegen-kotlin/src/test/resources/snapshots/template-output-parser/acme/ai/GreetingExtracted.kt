// GENERATED — DO NOT EDIT — lenient extraction mirror of value object `acme::ai::Greeting`
package acme.ai

import com.metaobjects.render.extract.ExtractMap

/**
 * All-nullable mirror of [Greeting] for tolerant extraction: a partial model
 * reply still maps. [toStrict] converts it once no `@required` field was lost.
 */
data class GreetingExtracted(
    val text: String? = null,
) {

    /** The strict [Greeting]. Call only once the extract report shows no lost required field. */
    fun toStrict(): Greeting = Greeting(
        text = text,
    )

    companion object {

        /** Map an assembled ValueObject (a Map) onto the typed mirror; null-tolerant. */
        @JvmStatic
        fun fromMap(d: Map<String, Any?>?): GreetingExtracted? {
            if (d == null) return null
            return GreetingExtracted(
                text = ExtractMap.asString(d, "text"),
            )
        }
    }
}

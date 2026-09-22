// GENERATED — DO NOT EDIT — lenient extraction mirror of value object `acme::ai::OpinionOutputPayload`
package acme.ai

import com.metaobjects.render.extract.ExtractMap

/**
 * All-nullable mirror of [OpinionOutputPayload] for tolerant extraction: a partial model
 * reply still maps. [toStrict] converts it once no `@required` field was lost.
 */
data class OpinionOutputPayloadExtracted(
    val text: String? = null,
    val confidence: String? = null,
    val note: String? = null,
) {

    /** The strict [OpinionOutputPayload]. Call only once the extract report shows no lost required field. */
    fun toStrict(): OpinionOutputPayload = OpinionOutputPayload(
        text = text!!,
        confidence = acme.ai.OpinionOutputPayloadConfidence.valueOf(confidence!!),
        note = note,
    )

    companion object {

        /** Map an assembled ValueObject (a Map) onto the typed mirror; null-tolerant. */
        @JvmStatic
        fun fromMap(d: Map<String, Any?>?): OpinionOutputPayloadExtracted? {
            if (d == null) return null
            return OpinionOutputPayloadExtracted(
                text = ExtractMap.asString(d, "text"),
                confidence = ExtractMap.asString(d, "confidence"),
                note = ExtractMap.asString(d, "note"),
            )
        }
    }
}

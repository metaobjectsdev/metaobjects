// GENERATED — DO NOT EDIT — response parser for template.prompt `acme::ai::Reply`
package acme.ai.prompts

import kotlinx.serialization.json.Json
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.extract.MetaObjectExtractor
import com.metaobjects.render.extract.Format
import com.metaobjects.render.extract.ExtractMap
import com.metaobjects.render.extract.ExtractOptions
import com.metaobjects.render.extract.ExtractionResult

data class ReplyExtracted(
    val text: String? = null,
)

/** Parser for LLM responses matching the `Reply` template.prompt. */
object ReplyParser {

    private val json: Json = Json { ignoreUnknownKeys = false }

    /**
     * Parse an LLM response into a typed [ReplyResponse].
     *
     * @throws kotlinx.serialization.SerializationException when the input is not valid JSON for the response schema.
     */
    fun parseReply(text: String): ReplyResponse =
        json.decodeFromString<ReplyResponse>(text)

    /**
     * Parse with explicit error handling (Result-style — does not throw).
     */
    fun safeParseReply(text: String): Result<ReplyResponse> =
        runCatching { parseReply(text) }

    /** Payload FQN this parser extracts — resolved against the supplied loader at runtime. */
    const val PAYLOAD_FQN: String = "acme::ai::Greeting"

    /**
     * Tolerant best-effort extraction delegating to the runtime MetaObjectExtractor;
     * never throws. Fully populates nested-object and array-of-object components by
     * reading the live metadata directly. Resolves this payload's
     * MetaObject by [PAYLOAD_FQN] from [loader].
     */
    fun extractLenient(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ExtractionResult<ReplyExtracted> {
        val mo = loader.getMetaObjectByName(PAYLOAD_FQN)
        val raw = MetaObjectExtractor.extract(mo, text, Format.JSON, opts)
        // The assembled graph is a ValueObject (a Map<String, Any?>) with nested
        // ValueObjects / List<ValueObject> — map it into the typed Extracted mirror graph.
        @Suppress("UNCHECKED_CAST")
        val d = raw.data as? Map<String, Any?>
        return ExtractionResult(fromReplyExtracted(d), raw.report)
    }

    /** Map an assembled ValueObject (Map) into a typed [ReplyExtracted]; null-tolerant. */
    private fun fromReplyExtracted(d: Map<String, Any?>?): ReplyExtracted? {
        if (d == null) return null
        return ReplyExtracted(
            ExtractMap.asString(d, "text"),
        )
    }

    /** Null-tolerant cast of an assembled value to a Map (a ValueObject IS a Map). */
    @Suppress("UNCHECKED_CAST")
    private fun asMap(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>

    /** Map each element of an assembled List<Map> via [fn]; null/absent -> null; non-Map elements skipped. */
    private fun <T> mapObjectList(d: Map<String, Any?>?, key: String, fn: (Map<String, Any?>) -> T): List<T>? {
        val v = d?.get(key) as? List<*> ?: return null
        val outList = ArrayList<T>(v.size)
        for (elem in v) {
            val m = asMap(elem)
            if (m != null) outList.add(fn(m))
        }
        return outList
    }
}

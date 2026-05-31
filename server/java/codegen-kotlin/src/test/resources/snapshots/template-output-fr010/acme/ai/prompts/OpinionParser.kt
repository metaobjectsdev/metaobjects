// GENERATED — DO NOT EDIT — parser for template.output `acme::ai::Opinion`
package acme.ai.prompts

import kotlinx.serialization.json.Json
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.recover.MetaObjectRecover
import com.metaobjects.render.recover.FieldKind
import com.metaobjects.render.recover.FieldSpec
import com.metaobjects.render.recover.Format
import com.metaobjects.render.recover.Recover
import com.metaobjects.render.recover.RecoverMap
import com.metaobjects.render.recover.RecoverOptions
import com.metaobjects.render.recover.RecoverSchema
import com.metaobjects.render.recover.RecoveryResult

data class OpinionRecovered(
    val text: String? = null,
    val confidence: String? = null,
    val note: String? = null,
)

/** Parser for LLM responses matching the `Opinion` template.output. */
object OpinionParser {

    private val json: Json = Json { ignoreUnknownKeys = false }

    private val RECOVER_SCHEMA: RecoverSchema =
        RecoverSchema(Format.JSON, "OpinionPayload", listOf(FieldSpec.scalar("text", FieldKind.STRING, true), FieldSpec.enumField("confidence", true, listOf("HIGH", "OK", "LOW"), mapOf("medium" to "OK")), FieldSpec.scalar("note", FieldKind.STRING, false)))

    /**
     * Parse an LLM response into a typed [OpinionPayload].
     *
     * @throws kotlinx.serialization.SerializationException when the input is not valid JSON for the payload schema.
     */
    fun parseOpinion(text: String): OpinionPayload =
        json.decodeFromString<OpinionPayload>(text)

    /**
     * Parse with explicit error handling (Result-style — does not throw).
     */
    fun safeParseOpinion(text: String): Result<OpinionPayload> =
        runCatching { parseOpinion(text) }

    /**
     * Self-contained tolerant recovery; never throws. Components are null where
     * lost/malformed. Does NOT populate nested-object / array-of-object components
     * (use the recover(loader, text) overload for full nested recovery).
     */
    fun recover(text: String): RecoveryResult<OpinionRecovered> =
        recover(text, RecoverOptions.defaults())

    fun recover(text: String, opts: RecoverOptions): RecoveryResult<OpinionRecovered> {
        val o = Recover.recover(text, RECOVER_SCHEMA, opts)
        val d = o.data
        return RecoveryResult(OpinionRecovered(RecoverMap.asString(d, "text"), RecoverMap.asString(d, "confidence"), RecoverMap.asString(d, "note")), o.report)
    }

    /** Payload FQN this parser recovers — resolved against the supplied loader at runtime. */
    const val PAYLOAD_FQN: String = "acme::ai::OpinionOutputPayload"

    /**
     * Tolerant best-effort recovery delegating to the runtime MetaObjectRecover;
     * never throws. Fully populates nested-object and array-of-object components
     * (unlike the self-contained recover(text) overload). Resolves this payload's
     * MetaObject by [PAYLOAD_FQN] from [loader].
     */
    fun recover(loader: MetaDataLoader, text: String, opts: RecoverOptions = RecoverOptions.defaults()): RecoveryResult<OpinionRecovered> {
        val mo = loader.getMetaObjectByName(PAYLOAD_FQN)
        val raw = MetaObjectRecover.recover(mo, text, Format.JSON, opts)
        // The assembled graph is a ValueObject (a Map<String, Any?>) with nested
        // ValueObjects / List<ValueObject> — map it into the typed Recovered mirror graph.
        @Suppress("UNCHECKED_CAST")
        val d = raw.data as? Map<String, Any?>
        return RecoveryResult(fromOpinionRecovered(d), raw.report)
    }

    /** Map an assembled ValueObject (Map) into a typed [OpinionRecovered]; null-tolerant. */
    private fun fromOpinionRecovered(d: Map<String, Any?>?): OpinionRecovered? {
        if (d == null) return null
        return OpinionRecovered(
            RecoverMap.asString(d, "text"),
            RecoverMap.asString(d, "confidence"),
            RecoverMap.asString(d, "note"),
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

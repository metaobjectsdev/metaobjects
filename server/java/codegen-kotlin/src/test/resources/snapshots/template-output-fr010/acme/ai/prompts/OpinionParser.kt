// GENERATED — DO NOT EDIT — parser for template.output `acme::ai::Opinion`
package acme.ai.prompts

import kotlinx.serialization.json.Json
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

    /** Tolerant best-effort recovery; never throws. Components are null where lost/malformed. */
    fun recover(text: String): RecoveryResult<OpinionRecovered> =
        recover(text, RecoverOptions.defaults())

    fun recover(text: String, opts: RecoverOptions): RecoveryResult<OpinionRecovered> {
        val o = Recover.recover(text, RECOVER_SCHEMA, opts)
        val d = o.data
        return RecoveryResult(OpinionRecovered(RecoverMap.asString(d, "text"), RecoverMap.asString(d, "confidence"), RecoverMap.asString(d, "note")), o.report)
    }
}

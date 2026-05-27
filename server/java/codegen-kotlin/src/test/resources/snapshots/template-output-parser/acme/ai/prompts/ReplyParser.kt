// GENERATED — DO NOT EDIT — parser for template.output `acme::ai::Reply`
package acme.ai.prompts

import kotlinx.serialization.json.Json

/** Parser for LLM responses matching the `Reply` template.output. */
object ReplyParser {

    private val json: Json = Json { ignoreUnknownKeys = false }

    /**
     * Parse an LLM response into a typed [ReplyPayload].
     *
     * @throws kotlinx.serialization.SerializationException when the input is not valid JSON for the payload schema.
     */
    fun parseReply(text: String): ReplyPayload =
        json.decodeFromString<ReplyPayload>(text)

    /**
     * Parse with explicit error handling (Result-style — does not throw).
     */
    fun safeParseReply(text: String): Result<ReplyPayload> =
        runCatching { parseReply(text) }
}

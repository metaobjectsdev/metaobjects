// GENERATED — DO NOT EDIT — response parser for template.prompt `acme::ai::Opinion`
package acme.ai.prompts

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.extract.MetaObjectExtractor
import com.metaobjects.render.extract.Format
import com.metaobjects.render.extract.ExtractOptions
import com.metaobjects.render.extract.ExtractionResult

/** Parser for LLM responses matching the `Opinion` template.prompt. */
object OpinionParser {

    // Fails on an unknown property: a reply carrying a field the response shape does not
    // declare is a contract break, not something to drop silently.
    private val mapper = jacksonObjectMapper().findAndRegisterModules()

    /**
     * Parse an LLM response into a typed [acme.ai.OpinionOutputPayload].
     *
     * @throws com.fasterxml.jackson.core.JsonProcessingException when the input is not valid JSON for the response shape.
     */
    fun parseOpinion(text: String): acme.ai.OpinionOutputPayload =
        mapper.readValue(text, acme.ai.OpinionOutputPayload::class.java)

    /**
     * Parse with explicit error handling (Result-style — does not throw).
     */
    fun safeParseOpinion(text: String): Result<acme.ai.OpinionOutputPayload> =
        runCatching { parseOpinion(text) }

    /** Payload FQN this parser extracts — resolved against the supplied loader at runtime. */
    const val PAYLOAD_FQN: String = "acme::ai::OpinionOutputPayload"

    /**
     * Tolerant best-effort extraction delegating to the runtime MetaObjectExtractor;
     * never throws. Fully populates nested-object and array-of-object components by
     * reading the live metadata directly. Resolves this payload's
     * MetaObject by [PAYLOAD_FQN] from [loader].
     */
    fun extractLenient(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ExtractionResult<acme.ai.OpinionOutputPayloadExtracted> {
        val mo = loader.getMetaObjectByName(PAYLOAD_FQN)
        val raw = MetaObjectExtractor.extract(mo, text, Format.JSON, opts)
        // The assembled graph is a ValueObject (a Map<String, Any?>) with nested
        // ValueObjects / List<ValueObject> — map it onto the typed mirror graph.
        @Suppress("UNCHECKED_CAST")
        val d = raw.data as? Map<String, Any?>
        return ExtractionResult(acme.ai.OpinionOutputPayloadExtracted.fromMap(d), raw.report)
    }
}

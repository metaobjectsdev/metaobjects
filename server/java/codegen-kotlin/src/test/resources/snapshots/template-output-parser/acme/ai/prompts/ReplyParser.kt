// GENERATED — DO NOT EDIT — response parser for template.prompt `acme::ai::Reply`
package acme.ai.prompts

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.extract.MetaObjectExtractor
import com.metaobjects.render.extract.Format
import com.metaobjects.render.extract.ExtractOptions
import com.metaobjects.render.extract.ExtractionResult

/** Parser for LLM responses matching the `Reply` template.prompt. */
object ReplyParser {

    // Fails on an unknown property: a reply carrying a field the response shape does not
    // declare is a contract break, not something to drop silently.
    private val mapper = jacksonObjectMapper().findAndRegisterModules()

    /**
     * Parse an LLM response into a typed [acme.ai.Greeting].
     *
     * @throws com.fasterxml.jackson.core.JsonProcessingException when the input is not valid JSON for the response shape.
     */
    fun parseReply(text: String): acme.ai.Greeting =
        mapper.readValue(text, acme.ai.Greeting::class.java)

    /**
     * Parse with explicit error handling (Result-style — does not throw).
     */
    fun safeParseReply(text: String): Result<acme.ai.Greeting> =
        runCatching { parseReply(text) }

    /** Payload FQN this parser extracts — resolved against the supplied loader at runtime. */
    const val PAYLOAD_FQN: String = "acme::ai::Greeting"

    /**
     * Tolerant best-effort extraction delegating to the runtime MetaObjectExtractor;
     * never throws. Fully populates nested-object and array-of-object components by
     * reading the live metadata directly. Resolves this payload's
     * MetaObject by [PAYLOAD_FQN] from [loader].
     */
    fun extractLenient(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ExtractionResult<acme.ai.GreetingExtracted> {
        val mo = loader.getMetaObjectByName(PAYLOAD_FQN)
        val raw = MetaObjectExtractor.extract(mo, text, Format.JSON, opts)
        // The assembled graph is a ValueObject (a Map<String, Any?>) with nested
        // ValueObjects / List<ValueObject> — map it onto the typed mirror graph.
        @Suppress("UNCHECKED_CAST")
        val d = raw.data as? Map<String, Any?>
        return ExtractionResult(acme.ai.GreetingExtracted.fromMap(d), raw.report)
    }
}

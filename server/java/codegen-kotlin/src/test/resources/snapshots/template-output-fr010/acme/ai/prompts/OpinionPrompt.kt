// GENERATED — DO NOT EDIT — output-format prompt for template.output `acme::ai::Opinion`
package acme.ai.prompts

import com.metaobjects.render.prompt.OutputFormatRenderer
import com.metaobjects.render.prompt.OutputFormatSpec
import com.metaobjects.render.prompt.PromptField
import com.metaobjects.render.prompt.PromptOverrides
import com.metaobjects.render.prompt.PromptStyle
import com.metaobjects.render.recover.FieldKind
import com.metaobjects.render.recover.Format

/** Output-format prompt fragment for the `Opinion` template.output. */
object OpinionPrompt {
    private val SPEC: OutputFormatSpec =
        OutputFormatSpec(Format.JSON, "OpinionPayload", PromptStyle.GUIDE, listOf(PromptField("text", FieldKind.STRING, true, false, null, null, "A well-reasoned response.", null, null), PromptField("confidence", FieldKind.ENUM, true, false, listOf("HIGH", "OK", "LOW"), mapOf("HIGH" to "Very confident", "LOW" to "Best guess", "OK" to "Reasonably confident"), null, null, null), PromptField("note", FieldKind.STRING, false, false, null, null, null, null, null)))
    fun renderFormat(): String = OutputFormatRenderer.render(SPEC, PromptOverrides.none())
    fun renderFormat(overrides: PromptOverrides): String = OutputFormatRenderer.render(SPEC, overrides)
}

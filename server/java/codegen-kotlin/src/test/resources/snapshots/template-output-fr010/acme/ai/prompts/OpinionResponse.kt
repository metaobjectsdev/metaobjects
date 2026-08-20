package acme.ai.prompts

import acme.ai.OpinionOutputPayloadConfidence
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — response shape for template.prompt `acme::ai::Opinion`.
 */
@Serializable
public data class OpinionResponse(
  public val text: String,
  public val confidence: OpinionOutputPayloadConfidence,
  public val note: String? = null,
)

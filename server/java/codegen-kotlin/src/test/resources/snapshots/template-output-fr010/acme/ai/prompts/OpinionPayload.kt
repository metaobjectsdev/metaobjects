package acme.ai.prompts

import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — payload for template `acme::ai::Opinion`.
 */
@Serializable
public data class OpinionPayload(
  public val text: String,
  public val confidence: String,
  public val note: String,
)

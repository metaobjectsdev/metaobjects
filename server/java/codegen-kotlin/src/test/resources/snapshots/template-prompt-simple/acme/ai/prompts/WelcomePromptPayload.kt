package acme.ai.prompts

import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — payload for template `acme::ai::WelcomePrompt`.
 */
@Serializable
public data class WelcomePromptPayload(
  public val id: Long,
  public val name: String,
)

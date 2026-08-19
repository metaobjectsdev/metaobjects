package acme.ai.prompts

import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — payload for template `acme::ai::AuthorBio`.
 */
@Serializable
public data class AuthorBioPayload(
  public val name: String? = null,
  public val postCount: Long? = null,
)

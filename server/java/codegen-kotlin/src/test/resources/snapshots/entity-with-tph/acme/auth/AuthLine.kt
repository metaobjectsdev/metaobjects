package acme.auth

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class AuthLine(
  public val id: Long? = null,
  @field:Size(max = 40)
  public val label: String? = null,
)

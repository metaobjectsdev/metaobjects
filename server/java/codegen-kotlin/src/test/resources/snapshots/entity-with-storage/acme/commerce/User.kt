package acme.commerce

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class User(
  public val id: Long? = null,
  @field:Size(max = 255)
  public val email: String? = null,
  public val address: Address? = null,
  public val preferences: UserMetadata? = null,
)

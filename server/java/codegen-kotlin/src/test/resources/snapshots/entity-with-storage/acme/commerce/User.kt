package acme.commerce

import jakarta.validation.Valid
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
  @field:Valid
  public val address: Address? = null,
  @field:Valid
  public val preferences: UserMetadata? = null,
)

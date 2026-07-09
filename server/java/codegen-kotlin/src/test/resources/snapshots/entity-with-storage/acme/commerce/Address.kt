package acme.commerce

import jakarta.validation.constraints.Size
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Address(
  @field:Size(max = 200)
  public val street: String? = null,
  @field:Size(max = 100)
  public val city: String? = null,
  @field:Size(max = 20)
  public val zip: String? = null,
)

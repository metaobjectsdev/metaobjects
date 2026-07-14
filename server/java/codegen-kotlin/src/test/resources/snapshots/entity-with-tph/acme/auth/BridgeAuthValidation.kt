package acme.auth

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import kotlin.Int
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 * FR-036 validation-only shape for the BridgeAuth TPH subtype: the base controller's
 * per-subtype POST/PATCH validates present values against these field constraints
 * (the folded union base data class is annotation-free). Never persisted or bound.
 */
public data class BridgeAuthValidation(
  @field:NotNull
  public val quantity: Int? = null,
  @field:NotNull
  @field:Size(min = 1, max = 80)
  public val reference: String? = null,
)

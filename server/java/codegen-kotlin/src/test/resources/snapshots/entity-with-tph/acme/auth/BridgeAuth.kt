package acme.auth

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import kotlin.Int
import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class BridgeAuth(
  @field:NotNull
  public val quantity: Int,
  public val id: Long? = null,
  public val type: BridgeAuthType? = null,
  @field:NotNull
  @field:NotBlank
  @field:Size(max = 80)
  public val reference: String,
)

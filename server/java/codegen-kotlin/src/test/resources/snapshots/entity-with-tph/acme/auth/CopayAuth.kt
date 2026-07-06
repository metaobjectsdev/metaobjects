package acme.auth

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.math.BigDecimal
import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class CopayAuth(
  public val copayAmount: BigDecimal? = null,
  public val id: Long? = null,
  public val type: CopayAuthType? = null,
  @field:NotNull
  @field:NotBlank
  @field:Size(max = 80)
  public val reference: String,
)

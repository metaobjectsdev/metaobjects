package acme.auth

import java.math.BigDecimal
import kotlin.Int
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Auth(
  public val id: Long? = null,
  public val type: AuthType? = null,
  public val reference: String? = null,
  public val quantity: Int? = null,
  public val copayAmount: BigDecimal? = null,
  public val priorAuthNumber: String? = null,
)

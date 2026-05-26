package acme.ops

import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class OrderReport(
  public val orderId: Long? = null,
  public val status: String? = null,
  public val totalCents: Long? = null,
)

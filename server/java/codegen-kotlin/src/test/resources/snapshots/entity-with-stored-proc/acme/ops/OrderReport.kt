package acme.ops

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class OrderReport(
  @field:Size(max = 50)
  public val status: String? = null,
  public val totalCents: Long? = null,
)

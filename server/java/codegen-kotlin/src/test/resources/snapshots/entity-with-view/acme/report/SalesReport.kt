package acme.report

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class SalesReport(
  public val id: Long? = null,
  @field:Size(max = 100)
  public val regionName: String? = null,
  public val totalCents: Long? = null,
)

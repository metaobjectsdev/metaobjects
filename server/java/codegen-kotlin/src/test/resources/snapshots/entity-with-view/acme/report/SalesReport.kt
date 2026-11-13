package acme.report

import com.fasterxml.jackson.`annotation`.JsonIgnoreProperties
import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public data class SalesReport(
  public val id: Long? = null,
  @field:Size(max = 100)
  public val regionName: String? = null,
  public val totalCents: Long? = null,
)

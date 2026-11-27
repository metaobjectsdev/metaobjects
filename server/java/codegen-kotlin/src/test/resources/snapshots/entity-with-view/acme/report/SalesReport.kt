package acme.report

import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
data class SalesReport(
    val id: Long? = null,
    @field:Size(max = 100)
    val regionName: String? = null,
    val totalCents: Long? = null,
)

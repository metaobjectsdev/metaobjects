package acme.ops

import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
data class OrderReport(
    @field:Size(max = 50)
    val status: String? = null,
    val totalCents: Long? = null,
)

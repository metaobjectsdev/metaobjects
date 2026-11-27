package acme.auth

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.math.BigDecimal

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 * FR-036 validation-only shape for the CouponAuth TPH subtype: the base controller's
 * per-subtype POST/PATCH validates present values against these field constraints
 * (the folded union base data class is annotation-free). Never persisted or bound.
 */
data class CouponAuthValidation(
    val couponAmount: BigDecimal? = null,
    @field:NotNull
    @field:Size(min = 1, max = 80)
    val reference: String? = null,
)

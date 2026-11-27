package acme.auth

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.databind.annotation.JsonDeserialize
import java.math.BigDecimal

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Auth(
    val id: Long? = null,
    val type: AuthType? = null,
    val reference: String? = null,
    val quantity: Int? = null,
    @param:JsonDeserialize(using = MetaDecimalWire.Deserializer::class)
    val couponAmount: BigDecimal? = null,
    val permitNumber: String? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var id: Long? = null
        private var type: AuthType? = null
        private var reference: String? = null
        private var quantity: Int? = null
        private var couponAmount: BigDecimal? = null
        private var permitNumber: String? = null

        fun id(v: Long?): Builder {
            this.id = v
            return this
        }

        fun type(v: AuthType?): Builder {
            this.type = v
            return this
        }

        fun reference(v: String?): Builder {
            this.reference = v
            return this
        }

        fun quantity(v: Int?): Builder {
            this.quantity = v
            return this
        }

        fun couponAmount(v: BigDecimal?): Builder {
            this.couponAmount = v
            return this
        }

        fun permitNumber(v: String?): Builder {
            this.permitNumber = v
            return this
        }

        fun build(): Auth = Auth(
            id = id,
            type = type,
            reference = reference,
            quantity = quantity,
            couponAmount = couponAmount,
            permitNumber = permitNumber,
        )
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

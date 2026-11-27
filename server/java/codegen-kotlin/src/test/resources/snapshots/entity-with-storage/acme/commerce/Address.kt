package acme.commerce

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Address(
    @field:Size(max = 200)
    val street: String? = null,
    @field:Size(max = 100)
    val city: String? = null,
    @field:Size(max = 20)
    val zip: String? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var street: String? = null
        private var city: String? = null
        private var zip: String? = null

        fun street(v: String?): Builder {
            this.street = v
            return this
        }

        fun city(v: String?): Builder {
            this.city = v
            return this
        }

        fun zip(v: String?): Builder {
            this.zip = v
            return this
        }

        fun build(): Address = Address(street = street, city = city, zip = zip)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

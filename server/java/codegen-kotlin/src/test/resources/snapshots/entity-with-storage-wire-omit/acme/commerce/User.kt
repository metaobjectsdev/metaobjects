package acme.commerce

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import jakarta.validation.Valid
import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class User(
    val id: Long? = null,
    @field:Size(max = 255)
    val email: String? = null,
    @field:Valid
    val address: Address? = null,
    @field:Valid
    val preferences: UserMetadata? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var id: Long? = null
        private var email: String? = null
        private var address: Address? = null
        private var preferences: UserMetadata? = null

        fun id(v: Long?): Builder {
            this.id = v
            return this
        }

        fun email(v: String?): Builder {
            this.email = v
            return this
        }

        fun address(v: Address?): Builder {
            this.address = v
            return this
        }

        fun preferences(v: UserMetadata?): Builder {
            this.preferences = v
            return this
        }

        fun build(): User = User(id = id, email = email, address = address, preferences = preferences)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

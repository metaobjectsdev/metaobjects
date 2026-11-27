package acme.auth

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class AuthLine(
    val id: Long? = null,
    @field:Size(max = 40)
    val label: String? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var id: Long? = null
        private var label: String? = null

        fun id(v: Long?): Builder {
            this.id = v
            return this
        }

        fun label(v: String?): Builder {
            this.label = v
            return this
        }

        fun build(): AuthLine = AuthLine(id = id, label = label)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

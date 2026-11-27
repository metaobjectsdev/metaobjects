package acme.commerce

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class UserMetadata(
    val locale: String? = null,
    val timezone: String? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var locale: String? = null
        private var timezone: String? = null

        fun locale(v: String?): Builder {
            this.locale = v
            return this
        }

        fun timezone(v: String?): Builder {
            this.timezone = v
            return this
        }

        fun build(): UserMetadata = UserMetadata(locale = locale, timezone = timezone)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

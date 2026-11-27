package acme.blog

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Author(
    val id: Long? = null,
    @field:NotNull
    @field:Size(min = 1, max = 100)
    val name: String,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var id: Long? = null
        private var name: String? = null

        fun id(v: Long?): Builder {
            this.id = v
            return this
        }

        fun name(v: String?): Builder {
            this.name = v
            return this
        }

        fun build(): Author = Author(id = id, name = requireNotNull(name) { "name is required" })
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

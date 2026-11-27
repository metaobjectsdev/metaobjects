package acme.blog

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Author(
    val id: Long? = null,
    @field:Size(max = 100)
    val name: String? = null,
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

        fun build(): Author = Author(id = id, name = name)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

package acme.blog

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Post(
    val id: Long? = null,
    @field:Size(max = 200)
    val title: String? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var id: Long? = null
        private var title: String? = null

        fun id(v: Long?): Builder {
            this.id = v
            return this
        }

        fun title(v: String?): Builder {
            this.title = v
            return this
        }

        fun build(): Post = Post(id = id, title = title)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

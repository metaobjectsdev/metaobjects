package acme.ai

/** GENERATED — do not hand-edit. Regenerated from metadata. */
data class Author(
    val id: Long? = null,
    val name: String? = null,
    val bio: String? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var id: Long? = null
        private var name: String? = null
        private var bio: String? = null

        fun id(v: Long?): Builder {
            this.id = v
            return this
        }

        fun name(v: String?): Builder {
            this.name = v
            return this
        }

        fun bio(v: String?): Builder {
            this.bio = v
            return this
        }

        fun build(): Author = Author(id = id, name = name, bio = bio)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

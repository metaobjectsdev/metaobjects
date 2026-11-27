package acme.ai

/** GENERATED — do not hand-edit. Regenerated from metadata. */
data class Greeting(
    val text: String? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var text: String? = null

        fun text(v: String?): Builder {
            this.text = v
            return this
        }

        fun build(): Greeting = Greeting(text = text)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

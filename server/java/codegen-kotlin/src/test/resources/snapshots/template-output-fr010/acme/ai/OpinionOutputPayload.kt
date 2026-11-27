package acme.ai

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size

/** GENERATED — do not hand-edit. Regenerated from metadata. */
data class OpinionOutputPayload(
    @field:NotNull
    @field:Size(min = 1)
    val text: String,
    @field:NotNull
    val confidence: OpinionOutputPayloadConfidence,
    val note: String? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var text: String? = null
        private var confidence: OpinionOutputPayloadConfidence? = null
        private var note: String? = null

        fun text(v: String?): Builder {
            this.text = v
            return this
        }

        fun confidence(v: OpinionOutputPayloadConfidence?): Builder {
            this.confidence = v
            return this
        }

        fun note(v: String?): Builder {
            this.note = v
            return this
        }

        fun build(): OpinionOutputPayload = OpinionOutputPayload(
            text = requireNotNull(text) { "text is required" },
            confidence = requireNotNull(confidence) { "confidence is required" },
            note = note,
        )
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

package acme.ai

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class OpinionOutputPayload(
  @field:NotNull
  @field:Size(min = 1)
  public val text: String,
  @field:NotNull
  public val confidence: OpinionOutputPayloadConfidence,
  public val note: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var text: String? = null

    private var confidence: OpinionOutputPayloadConfidence? = null

    private var note: String? = null

    public fun text(v: String?): Builder {
      this.text = v
      return this
    }

    public fun confidence(v: OpinionOutputPayloadConfidence?): Builder {
      this.confidence = v
      return this
    }

    public fun note(v: String?): Builder {
      this.note = v
      return this
    }

    public fun build(): OpinionOutputPayload = OpinionOutputPayload(
      text = requireNotNull(text) { "text is required" },
      confidence = requireNotNull(confidence) { "confidence is required" },
      note = note
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

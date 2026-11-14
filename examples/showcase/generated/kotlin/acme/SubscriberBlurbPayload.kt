package acme

import jakarta.validation.constraints.NotNull
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class SubscriberBlurbPayload(
  public val name: String? = null,
  @field:NotNull
  public val status: SubscriberBlurbPayloadStatus,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var name: String? = null

    private var status: SubscriberBlurbPayloadStatus? = null

    public fun name(v: String?): Builder {
      this.name = v
      return this
    }

    public fun status(v: SubscriberBlurbPayloadStatus?): Builder {
      this.status = v
      return this
    }

    public fun build(): SubscriberBlurbPayload = SubscriberBlurbPayload(
      name = name,
      status = requireNotNull(status) { "status is required" }
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

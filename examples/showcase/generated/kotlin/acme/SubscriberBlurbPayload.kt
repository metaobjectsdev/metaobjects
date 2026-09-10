package acme

import jakarta.validation.constraints.NotNull
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class SubscriberBlurbPayload(
  public val name: String? = null,
  @field:NotNull
  public val status: SubscriberBlurbPayloadStatus,
)

package acme

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.time.Instant
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Subscriber(
  public val id: Long? = null,
  @field:NotNull
  @field:Size(min = 1, max = 320)
  public val email: String,
  public val name: String? = null,
  @field:NotNull
  public val status: SubscriberStatus,
  public val createdAt: Instant? = null,
)

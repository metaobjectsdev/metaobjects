package acme

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.time.Instant
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

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
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var email: String? = null

    private var name: String? = null

    private var status: SubscriberStatus? = null

    private var createdAt: Instant? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun email(v: String?): Builder {
      this.email = v
      return this
    }

    public fun name(v: String?): Builder {
      this.name = v
      return this
    }

    public fun status(v: SubscriberStatus?): Builder {
      this.status = v
      return this
    }

    public fun createdAt(v: Instant?): Builder {
      this.createdAt = v
      return this
    }

    public fun build(): Subscriber = Subscriber(
      id = id,
      email = requireNotNull(email) { "email is required" },
      name = name,
      status = requireNotNull(status) { "status is required" },
      createdAt = createdAt
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

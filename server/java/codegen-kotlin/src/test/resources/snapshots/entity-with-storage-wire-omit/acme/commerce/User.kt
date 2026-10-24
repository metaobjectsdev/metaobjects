package acme.commerce

import jakarta.validation.Valid
import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class User(
  public val id: Long? = null,
  @field:Size(max = 255)
  public val email: String? = null,
  @field:Valid
  public val address: Address? = null,
  @field:Valid
  public val preferences: UserMetadata? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var email: String? = null

    private var address: Address? = null

    private var preferences: UserMetadata? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun email(v: String?): Builder {
      this.email = v
      return this
    }

    public fun address(v: Address?): Builder {
      this.address = v
      return this
    }

    public fun preferences(v: UserMetadata?): Builder {
      this.preferences = v
      return this
    }

    public fun build(): User = User(
      id = id,
      email = email,
      address = address,
      preferences = preferences
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

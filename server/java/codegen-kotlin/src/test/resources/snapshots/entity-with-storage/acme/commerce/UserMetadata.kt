package acme.commerce

import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class UserMetadata(
  public val locale: String? = null,
  public val timezone: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var locale: String? = null

    private var timezone: String? = null

    public fun locale(v: String?): Builder {
      this.locale = v
      return this
    }

    public fun timezone(v: String?): Builder {
      this.timezone = v
      return this
    }

    public fun build(): UserMetadata = UserMetadata(
      locale = locale,
      timezone = timezone
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

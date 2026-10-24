package acme.commerce

import jakarta.validation.constraints.Size
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Address(
  @field:Size(max = 200)
  public val street: String? = null,
  @field:Size(max = 100)
  public val city: String? = null,
  @field:Size(max = 20)
  public val zip: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var street: String? = null

    private var city: String? = null

    private var zip: String? = null

    public fun street(v: String?): Builder {
      this.street = v
      return this
    }

    public fun city(v: String?): Builder {
      this.city = v
      return this
    }

    public fun zip(v: String?): Builder {
      this.zip = v
      return this
    }

    public fun build(): Address = Address(
      street = street,
      city = city,
      zip = zip
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

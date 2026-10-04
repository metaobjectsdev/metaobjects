package acme.catalog

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.math.BigDecimal
import kotlin.Float
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Product(
  public val id: Long? = null,
  @field:NotNull
  @field:Size(min = 1, max = 40)
  public val name: String,
  public val price: BigDecimal? = null,
  public val rating: Float? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var name: String? = null

    private var price: BigDecimal? = null

    private var rating: Float? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun name(v: String?): Builder {
      this.name = v
      return this
    }

    public fun price(v: BigDecimal?): Builder {
      this.price = v
      return this
    }

    public fun rating(v: Float?): Builder {
      this.rating = v
      return this
    }

    public fun build(): Product = Product(
      id = id,
      name = requireNotNull(name) { "name is required" },
      price = price,
      rating = rating
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

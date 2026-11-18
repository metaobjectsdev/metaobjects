package acme.auth

import com.fasterxml.jackson.`annotation`.JsonIgnoreProperties
import com.fasterxml.jackson.databind.`annotation`.JsonDeserialize
import java.math.BigDecimal
import kotlin.Int
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public data class Auth(
  public val id: Long? = null,
  public val type: AuthType? = null,
  public val reference: String? = null,
  public val quantity: Int? = null,
  @param:JsonDeserialize(using = MetaDecimalWire.Deserializer::class)
  public val couponAmount: BigDecimal? = null,
  public val permitNumber: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var type: AuthType? = null

    private var reference: String? = null

    private var quantity: Int? = null

    private var couponAmount: BigDecimal? = null

    private var permitNumber: String? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun type(v: AuthType?): Builder {
      this.type = v
      return this
    }

    public fun reference(v: String?): Builder {
      this.reference = v
      return this
    }

    public fun quantity(v: Int?): Builder {
      this.quantity = v
      return this
    }

    public fun couponAmount(v: BigDecimal?): Builder {
      this.couponAmount = v
      return this
    }

    public fun permitNumber(v: String?): Builder {
      this.permitNumber = v
      return this
    }

    public fun build(): Auth = Auth(
      id = id,
      type = type,
      reference = reference,
      quantity = quantity,
      couponAmount = couponAmount,
      permitNumber = permitNumber
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

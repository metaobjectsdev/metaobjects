package acme.auth

import java.math.BigDecimal
import kotlin.Int
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Auth(
  public val id: Long? = null,
  public val type: AuthType? = null,
  public val reference: String? = null,
  public val quantity: Int? = null,
  public val copayAmount: BigDecimal? = null,
  public val priorAuthNumber: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var type: AuthType? = null

    private var reference: String? = null

    private var quantity: Int? = null

    private var copayAmount: BigDecimal? = null

    private var priorAuthNumber: String? = null

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

    public fun copayAmount(v: BigDecimal?): Builder {
      this.copayAmount = v
      return this
    }

    public fun priorAuthNumber(v: String?): Builder {
      this.priorAuthNumber = v
      return this
    }

    public fun build(): Auth = Auth(
      id = id,
      type = type,
      reference = reference,
      quantity = quantity,
      copayAmount = copayAmount,
      priorAuthNumber = priorAuthNumber
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

package acme.ops

import kotlin.Long
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class OrderReportArgs(
  public val orderId: Long? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var orderId: Long? = null

    public fun orderId(v: Long?): Builder {
      this.orderId = v
      return this
    }

    public fun build(): OrderReportArgs = OrderReportArgs(
      orderId = orderId
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

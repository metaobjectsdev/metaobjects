package acme.auth

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class AuthLine(
  public val id: Long? = null,
  @field:Size(max = 40)
  public val label: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var label: String? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun label(v: String?): Builder {
      this.label = v
      return this
    }

    public fun build(): AuthLine = AuthLine(
      id = id,
      label = label
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

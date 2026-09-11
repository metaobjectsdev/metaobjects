package acme.blog

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Author(
  public val id: Long? = null,
  @field:Size(max = 100)
  public val name: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var name: String? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun name(v: String?): Builder {
      this.name = v
      return this
    }

    public fun build(): Author = Author(
      id = id,
      name = name
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

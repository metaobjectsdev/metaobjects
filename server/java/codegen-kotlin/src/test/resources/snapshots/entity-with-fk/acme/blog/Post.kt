package acme.blog

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Post(
  public val id: Long? = null,
  @field:Size(max = 255)
  public val title: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var title: String? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun title(v: String?): Builder {
      this.title = v
      return this
    }

    public fun build(): Post = Post(
      id = id,
      title = title
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

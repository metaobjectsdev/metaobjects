package acme.blog

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Post(
  public val id: Long? = null,
  @field:Size(max = 255)
  public val title: String? = null,
)

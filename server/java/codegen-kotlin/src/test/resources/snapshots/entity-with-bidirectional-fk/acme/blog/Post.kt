package acme.blog

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class Post(
  public val id: Long? = null,
  @field:Size(max = 200)
  public val title: String? = null,
)

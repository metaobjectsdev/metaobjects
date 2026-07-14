package acme.blog

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Author(
  public val id: Long? = null,
  @field:NotNull
  @field:Size(min = 1, max = 100)
  public val name: String,
)

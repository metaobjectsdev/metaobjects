package acme.demo

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.time.Instant
import java.time.LocalDate
import kotlin.Boolean
import kotlin.Double
import kotlin.Int
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Author(
  public val id: Long? = null,
  @field:NotNull
  @field:NotBlank
  @field:Size(max = 100)
  public val name: String,
  public val bio: String? = null,
  public val age: Int? = null,
  public val active: Boolean? = null,
  public val ratio: Double? = null,
  public val birthday: LocalDate? = null,
  public val createdAt: Instant? = null,
)

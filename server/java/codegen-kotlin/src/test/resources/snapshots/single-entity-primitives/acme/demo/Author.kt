package acme.demo

import java.time.Instant
import java.time.LocalDate
import kotlin.Boolean
import kotlin.Double
import kotlin.Int
import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class Author(
  public val id: Long? = null,
  public val name: String,
  public val bio: String? = null,
  public val age: Int? = null,
  public val active: Boolean? = null,
  public val ratio: Double? = null,
  public val birthday: LocalDate? = null,
  public val createdAt: Instant? = null,
)

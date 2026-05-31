package acme.game

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class Player(
  public val id: Long? = null,
  @field:Size(max = 50)
  public val username: String? = null,
  public val status: PlayerStatus? = null,
)

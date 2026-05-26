package acme.game

import kotlin.Long
import kotlin.String
import kotlinx.serialization.Serializable

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@Serializable
public data class Player(
  public val id: Long? = null,
  public val username: String? = null,
  public val status: PlayerStatus? = null,
)

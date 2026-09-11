package acme.game

import jakarta.validation.constraints.Size
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Player(
  public val id: Long? = null,
  @field:Size(max = 50)
  public val username: String? = null,
  public val status: PlayerStatus? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var username: String? = null

    private var status: PlayerStatus? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun username(v: String?): Builder {
      this.username = v
      return this
    }

    public fun status(v: PlayerStatus?): Builder {
      this.status = v
      return this
    }

    public fun build(): Player = Player(
      id = id,
      username = username,
      status = status
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

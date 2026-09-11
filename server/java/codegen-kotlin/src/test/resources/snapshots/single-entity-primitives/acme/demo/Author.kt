package acme.demo

import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.time.Instant
import java.time.LocalDate
import kotlin.Boolean
import kotlin.Double
import kotlin.Int
import kotlin.Long
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Author(
  public val id: Long? = null,
  @field:NotNull
  @field:Size(min = 1, max = 100)
  public val name: String,
  public val bio: String? = null,
  public val age: Int? = null,
  public val active: Boolean? = null,
  public val ratio: Double? = null,
  public val birthday: LocalDate? = null,
  public val createdAt: Instant? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var id: Long? = null

    private var name: String? = null

    private var bio: String? = null

    private var age: Int? = null

    private var active: Boolean? = null

    private var ratio: Double? = null

    private var birthday: LocalDate? = null

    private var createdAt: Instant? = null

    public fun id(v: Long?): Builder {
      this.id = v
      return this
    }

    public fun name(v: String?): Builder {
      this.name = v
      return this
    }

    public fun bio(v: String?): Builder {
      this.bio = v
      return this
    }

    public fun age(v: Int?): Builder {
      this.age = v
      return this
    }

    public fun active(v: Boolean?): Builder {
      this.active = v
      return this
    }

    public fun ratio(v: Double?): Builder {
      this.ratio = v
      return this
    }

    public fun birthday(v: LocalDate?): Builder {
      this.birthday = v
      return this
    }

    public fun createdAt(v: Instant?): Builder {
      this.createdAt = v
      return this
    }

    public fun build(): Author = Author(
      id = id,
      name = requireNotNull(name) { "name is required" },
      bio = bio,
      age = age,
      active = active,
      ratio = ratio,
      birthday = birthday,
      createdAt = createdAt
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

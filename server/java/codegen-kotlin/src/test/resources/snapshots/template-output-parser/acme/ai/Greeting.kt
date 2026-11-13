package acme.ai

import com.fasterxml.jackson.`annotation`.JsonIgnoreProperties
import kotlin.String
import kotlin.jvm.JvmStatic

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public data class Greeting(
  public val text: String? = null,
) {
  /**
   * Fluent builder — lets a JAVA caller set a subset of properties.
   */
  public class Builder {
    private var text: String? = null

    public fun text(v: String?): Builder {
      this.text = v
      return this
    }

    public fun build(): Greeting = Greeting(
      text = text
    )
  }

  public companion object {
    @JvmStatic
    public fun builder(): Builder = Builder()
  }
}

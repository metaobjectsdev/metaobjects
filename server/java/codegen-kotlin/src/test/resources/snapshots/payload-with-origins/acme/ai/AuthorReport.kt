package acme.ai

import com.fasterxml.jackson.`annotation`.JsonIgnoreProperties
import kotlin.Long
import kotlin.String

/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public data class AuthorReport(
  public val name: String? = null,
  public val postCount: Long? = null,
)

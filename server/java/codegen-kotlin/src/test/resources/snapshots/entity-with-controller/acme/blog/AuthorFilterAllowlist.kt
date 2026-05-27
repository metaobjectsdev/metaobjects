package acme.blog

/**
 * GENERATED — per-entity FR-009 filter allowlist for Author.
 * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the
 * operator vocabulary for each field by its subtype.
 */
object AuthorFilterAllowlist {
    val FIELDS: Set<String> = setOf(
        "name",
    )

    val OPS_BY_FIELD: Map<String, Set<String>> = mapOf(
        "name" to setOf("eq", "ne", "in", "like", "isNull")
    )
}

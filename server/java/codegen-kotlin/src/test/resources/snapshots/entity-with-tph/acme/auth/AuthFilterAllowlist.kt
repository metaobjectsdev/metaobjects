package acme.auth

/**
 * GENERATED — per-entity FR-009 filter allowlist for Auth.
 * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the
 * operator vocabulary for each field by its subtype.
 */
object AuthFilterAllowlist {
    val FIELDS: Set<String> = setOf(
        "id",
        "reference",
        "quantity",
        "priorAuthNumber",
    )

    val OPS_BY_FIELD: Map<String, Set<String>> = mapOf(
        "id" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "reference" to setOf("eq", "ne", "in", "like", "isNull"),
        "quantity" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "priorAuthNumber" to setOf("eq", "ne", "in", "like", "isNull")
    )
}

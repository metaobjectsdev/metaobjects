package acme.auth

/**
 * GENERATED — per-entity FR-009 filter allowlist for PriorAuthAuth.
 * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the
 * operator vocabulary for each field by its subtype.
 */
object PriorAuthAuthFilterAllowlist {
    val FIELDS: Set<String> = setOf(
        "priorAuthNumber",
        "id",
        "type",
        "reference",
    )

    val OPS_BY_FIELD: Map<String, Set<String>> = mapOf(
        "priorAuthNumber" to setOf("eq", "ne", "in", "like", "isNull"),
        "id" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "type" to setOf("eq", "ne", "in", "like", "isNull"),
        "reference" to setOf("eq", "ne", "in", "like", "isNull")
    )
}

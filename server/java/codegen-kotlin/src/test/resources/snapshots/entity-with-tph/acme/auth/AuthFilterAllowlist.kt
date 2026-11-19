package acme.auth

/**
 * GENERATED — per-entity FR-009 filter allowlist for Auth.
 * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the
 * operator vocabulary for each field by its subtype.
 */
object AuthFilterAllowlist {
    val FIELDS: Set<String> = setOf(
        "id",
        "type",
        "reference",
        "quantity",
        "couponAmount",
        "permitNumber",
    )

    val OPS_BY_FIELD: Map<String, Set<String>> = mapOf(
        "id" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "type" to setOf("eq", "ne", "in", "like", "isNull"),
        "reference" to setOf("eq", "ne", "in", "like", "isNull"),
        "quantity" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "couponAmount" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "permitNumber" to setOf("eq", "ne", "in", "like", "isNull")
    )
}

package acme.auth

/**
 * GENERATED — per-entity FR-009 filter allowlist for BridgeAuth.
 * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the
 * operator vocabulary for each field by its subtype.
 */
object BridgeAuthFilterAllowlist {
    val FIELDS: Set<String> = setOf(
        "quantity",
        "id",
        "type",
        "reference",
    )

    val OPS_BY_FIELD: Map<String, Set<String>> = mapOf(
        "quantity" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "id" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "type" to setOf("eq", "ne", "in", "like", "isNull"),
        "reference" to setOf("eq", "ne", "in", "like", "isNull")
    )
}

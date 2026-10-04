package acme.catalog

/**
 * GENERATED — per-entity FR-009 filter allowlist for Product.
 * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the
 * operator vocabulary for each field by its subtype.
 */
object ProductFilterAllowlist {
    val FIELDS: Set<String> = setOf(
        "price",
        "rating",
    )

    val OPS_BY_FIELD: Map<String, Set<String>> = mapOf(
        "price" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
        "rating" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull")
    )
}

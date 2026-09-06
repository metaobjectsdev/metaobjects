package acme.demo

/**
 * GENERATED — per-object physical database names for Author.
 */
object AuthorNames {
    const val TYPE: String = "object"
    const val SUB_TYPE: String = "entity"
    const val NAME: String = "Author"

    const val SOURCE_PRIMARY_TYPE: String = "source"
    const val SOURCE_PRIMARY_SUB_TYPE: String = "rdb"
    const val SOURCE_PRIMARY_KIND: String = "table"
    const val SOURCE_PRIMARY_TABLE: String = "authors"

    const val CALL_PURPOSE_FIELD: String = "callPurpose"
    const val CALL_PURPOSE_COLUMN: String = "purpose_code"
    const val ID_FIELD: String = "id"
    const val ID_COLUMN: String = "id"

    const val IDENTITY_PRIMARY_TYPE: String = "identity"
    const val IDENTITY_PRIMARY_SUB_TYPE: String = "primary"
    const val IDENTITY_PRIMARY_NAME: String = "primary"

    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(
        "callPurpose" to CALL_PURPOSE_COLUMN,
        "id" to ID_COLUMN,
    )
}

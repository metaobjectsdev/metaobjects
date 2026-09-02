package acme.demo

/**
 * GENERATED — per-object physical database names for Author.
 */
object AuthorNames {
    const val KIND: String = "table"
    const val NAME: String = "authors"
    const val READ_ONLY: Boolean = false

    const val CALL_PURPOSE_FIELD: String = "callPurpose"
    const val CALL_PURPOSE_COLUMN: String = "purpose_code"
    const val ID_FIELD: String = "id"
    const val ID_COLUMN: String = "id"

    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(
        "callPurpose" to CALL_PURPOSE_COLUMN,
        "id" to ID_COLUMN,
    )
}

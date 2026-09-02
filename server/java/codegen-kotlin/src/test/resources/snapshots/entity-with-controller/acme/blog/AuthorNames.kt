package acme.blog

/**
 * GENERATED — per-object physical database names for Author.
 */
object AuthorNames {
    const val KIND: String = "table"
    const val NAME: String = "authors"
    const val READ_ONLY: Boolean = false

    const val ID_FIELD: String = "id"
    const val ID_COLUMN: String = "id"
    const val NAME_FIELD: String = "name"
    const val NAME_COLUMN: String = "name"

    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(
        "id" to ID_COLUMN,
        "name" to NAME_COLUMN,
    )
}

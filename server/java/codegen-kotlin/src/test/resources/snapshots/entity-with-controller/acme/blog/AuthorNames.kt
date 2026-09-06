package acme.blog

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

    const val ID_FIELD: String = "id"
    const val ID_COLUMN: String = "id"
    const val NAME_FIELD: String = "name"
    const val NAME_COLUMN: String = "name"

    const val IDENTITY_PK_TYPE: String = "identity"
    const val IDENTITY_PK_SUB_TYPE: String = "primary"
    const val IDENTITY_PK_NAME: String = "pk"

    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(
        "id" to ID_COLUMN,
        "name" to NAME_COLUMN,
    )
}

package acme.demo

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object AuthorTable : Table(AuthorNames.SOURCE_PRIMARY_TABLE) {
    val id = long(AuthorNames.ID_COLUMN).autoIncrement()
    val callPurpose = varchar(AuthorNames.CALL_PURPOSE_COLUMN, 40).nullable()

    override val primaryKey = PrimaryKey(id)
}

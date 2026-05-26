package acme.blog

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object AuthorTable : Table("authors") {
    val id = long("id").autoIncrement()
    val name = varchar("name", 100).nullable()

    override val primaryKey = PrimaryKey(id)
}

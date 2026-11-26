package acme.blog

import org.jetbrains.exposed.sql.ReferenceOption
import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object PostTable : Table("posts") {
    val id = long("id").autoIncrement()
    val title = varchar("title", 255).nullable()
    val authorId = long("author_id").references(AuthorTable.id, onDelete = ReferenceOption.CASCADE)

    override val primaryKey = PrimaryKey(id)
}

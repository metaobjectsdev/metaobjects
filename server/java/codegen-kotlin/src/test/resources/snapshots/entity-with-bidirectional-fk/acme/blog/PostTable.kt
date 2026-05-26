package acme.blog

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.ReferenceOption

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object PostTable : Table("posts") {
    val id = long("id").autoIncrement()
    val title = varchar("title", 200).nullable()
    val authorId = long("authorId").references(AuthorTable.id, onDelete = ReferenceOption.CASCADE)

    override val primaryKey = PrimaryKey(id)
}

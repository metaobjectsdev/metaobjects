package acme.demo

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.date
import org.jetbrains.exposed.sql.javatime.timestamp

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object AuthorTable : Table("authors") {
    val id = long("id").autoIncrement()
    val name = varchar("name", 100)
    val bio = varchar("bio", 255).nullable()
    val age = integer("age").nullable()
    val active = bool("active").nullable()
    val ratio = double("ratio").nullable()
    val birthday = date("birthday").nullable()
    val createdAt = timestamp("created_at").nullable()

    override val primaryKey = PrimaryKey(id)
}

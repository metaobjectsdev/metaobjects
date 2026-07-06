package acme.auth

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.ReferenceOption

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object AuthLineTable : Table("auth_lines") {
    val id = long("id").autoIncrement()
    val label = varchar("label", 40).nullable()
    val authId = long("auth_id").references(AuthTable.id, onDelete = ReferenceOption.CASCADE)

    override val primaryKey = PrimaryKey(id)
}

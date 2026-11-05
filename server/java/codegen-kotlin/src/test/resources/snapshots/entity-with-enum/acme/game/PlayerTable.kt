package acme.game

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object PlayerTable : Table("players") {
    val id = long("id").autoIncrement()
    val username = varchar("username", 50).nullable()
    val status = customEnumeration("status", "TEXT", { v -> PlayerStatus.valueOf(v as String) }, { e -> e.name }).nullable()

    override val primaryKey = PrimaryKey(id)
}

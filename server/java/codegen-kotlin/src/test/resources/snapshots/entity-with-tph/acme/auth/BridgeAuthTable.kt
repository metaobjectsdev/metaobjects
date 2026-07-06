package acme.auth

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object BridgeAuthTable : Table("auths") {
    val id = long("id").autoIncrement()
    val quantity = integer("quantity")
    val type = enumerationByName("type", 64, BridgeAuthType::class).nullable()
    val reference = varchar("reference", 80)

    override val primaryKey = PrimaryKey(id)
}

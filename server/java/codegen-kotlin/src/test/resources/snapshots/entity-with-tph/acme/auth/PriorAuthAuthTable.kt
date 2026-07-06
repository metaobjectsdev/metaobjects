package acme.auth

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object PriorAuthAuthTable : Table("auths") {
    val id = long("id").autoIncrement()
    val priorAuthNumber = varchar("prior_auth_number", 80).nullable()
    val type = enumerationByName("type", 64, PriorAuthAuthType::class).nullable()
    val reference = varchar("reference", 80)

    override val primaryKey = PrimaryKey(id)
}

package acme.auth

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object AuthTable : Table("auths") {
    val id = long("id").autoIncrement()
    val type = enumerationByName("type", 64, AuthType::class).nullable()
    val reference = varchar("reference", 80)
    val quantity = integer("quantity").nullable()
    val copayAmount = decimal("copay_amount", 10, 2).nullable()
    val priorAuthNumber = varchar("prior_auth_number", 80).nullable()

    override val primaryKey = PrimaryKey(id)
}

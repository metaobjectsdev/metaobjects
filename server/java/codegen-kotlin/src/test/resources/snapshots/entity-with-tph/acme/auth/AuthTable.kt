package acme.auth

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object AuthTable : Table("auths") {
    val id = long("id").autoIncrement()
    val type = customEnumeration("type", "TEXT", { v -> AuthType.valueOf(v as String) }, { e -> e.name }).nullable()
    val reference = varchar("reference", 80)
    val quantity = integer("quantity").nullable()
    val copayAmount = portableDecimal("copay_amount", 10, 2).nullable()
    val priorAuthNumber = varchar("prior_auth_number", 80).nullable()

    override val primaryKey = PrimaryKey(id)
}

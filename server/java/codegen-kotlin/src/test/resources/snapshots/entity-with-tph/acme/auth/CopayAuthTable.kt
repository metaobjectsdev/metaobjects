package acme.auth

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object CopayAuthTable : Table("auths") {
    val id = long("id").autoIncrement()
    val copayAmount = decimal("copay_amount", 10, 2).nullable()
    val type = enumerationByName("type", 64, CopayAuthType::class).nullable()
    val reference = varchar("reference", 80)

    override val primaryKey = PrimaryKey(id)
}

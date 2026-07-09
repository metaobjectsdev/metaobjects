package acme.commerce

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.json.jsonb

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object UserTable : Table("users") {
    val id = long("id").autoIncrement()
    val email = varchar("email", 255).nullable()
    val addressStreet = varchar("address_street", 200).nullable()
    val addressCity = varchar("address_city", 100).nullable()
    val addressZip = varchar("address_zip", 20).nullable()
    val preferences = jsonb("preferences", { metaJsonbMapper.writeValueAsString(it) }, { metaJsonbMapper.readValue(it, acme.commerce.UserMetadata::class.java) }).nullable()

    override val primaryKey = PrimaryKey(id)
}

package acme.catalog

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Regenerated from metadata. */
object ProductTable : Table("products") {
    val id = long("id").autoIncrement()
    val name = varchar("name", 40)
    val price = decimal("price", 10, 2).nullable()
    val rating = float("rating").nullable()

    override val primaryKey = PrimaryKey(id)
}

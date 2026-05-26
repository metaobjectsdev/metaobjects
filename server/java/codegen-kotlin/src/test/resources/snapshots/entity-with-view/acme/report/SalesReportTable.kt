package acme.report

import org.jetbrains.exposed.sql.Table

/** READ-ONLY VIEW — generated from view metadata; do not insert/update/delete directly. */
/** GENERATED — do not hand-edit. Regenerated from metadata. */
object SalesReportTable : Table("v_sales_report") {
    val id = long("id")
    val regionName = varchar("regionName", 100).nullable()
    val totalCents = long("totalCents").nullable()

    override val primaryKey = PrimaryKey(id)
}

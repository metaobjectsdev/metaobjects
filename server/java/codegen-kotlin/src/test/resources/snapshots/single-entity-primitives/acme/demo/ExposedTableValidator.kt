package acme.demo

import com.metaobjects.`object`.MetaObject
import com.metaobjects.field.MetaField
import org.jetbrains.exposed.sql.Table

/**
 * GENERATED — compares a [MetaObject]'s field set vs an Exposed [Table]'s column set
 * and records any discrepancies into the supplied `errors` list.
 */
object ExposedTableValidator {

    fun check(obj: MetaObject, table: Table, errors: MutableList<String>) {
        val expectedCols = obj.metaFields.map { it.name }.toSet()
        val actualCols = table.columns.map { it.name }.toSet()
        val missing = expectedCols - actualCols
        val extra = actualCols - expectedCols
        if (missing.isNotEmpty()) {
            errors.add("${obj.name}: metadata declares fields not in generated table: $missing")
        }
        if (extra.isNotEmpty()) {
            errors.add("${obj.name}: generated table has columns not in metadata: $extra")
        }
    }
}

package acme.ops

import org.jetbrains.exposed.sql.Transaction
import org.jetbrains.exposed.sql.transactions.transaction

/** GENERATED — wrapper for stored procedure `get_order_report`. */
object OrderReportProc {
    const val PROC_NAME = "get_order_report"

    /** Call the procedure and map result rows into [OrderReport]. */
    fun call(orderId: Long): List<OrderReport> = transaction {
        val results = mutableListOf<OrderReport>()
        exec("SELECT * FROM ${PROC_NAME}(?)", listOf(
            org.jetbrains.exposed.sql.LongColumnType() to orderId
        )) { rs ->
            while (rs.next()) {
                results.add(OrderReport(
                    status = rs.getString("status"),
                    totalCents = rs.getLong("totalCents")
                ))
            }
        }
        results
    }
}

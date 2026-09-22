package acme.report

import org.jetbrains.exposed.sql.Op
import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SqlExpressionBuilder
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import jakarta.servlet.http.HttpServletRequest
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.sql.Timestamp
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/** GENERATED — sort allowlist for SalesReport (cross-port API contract). */
private val SalesReportSortAllowlist = setOf(
    "id",
    "regionName",
    "totalCents",
)

/** GENERATED — declared @sortableDefaultOrder per field for SalesReport. */
private val SalesReportSortDefaultOrder: Map<String, String> = mapOf(
)

private fun parseSalesReportSort(raw: String): Pair<String, SortOrder>? {
    val parts = raw.split(":", limit = 2)
    val field = parts.getOrNull(0) ?: return null
    if (field !in SalesReportSortAllowlist) return null
    val dirRaw = parts.getOrNull(1)?.lowercase()
        ?: SalesReportSortDefaultOrder[field] ?: "asc"
    val dir = when (dirRaw) {
        "asc" -> SortOrder.ASC
        "desc" -> SortOrder.DESC
        else -> return null
    }
    return field to dir
}

/** GENERATED — cross-port cap on `in`-list size (matches TS DEFAULT_MAX_IN_LIST). */
private const val MAX_IN_LIST = 100

/** GENERATED — single parsed + validated FR-009 filter predicate. */
private data class SalesReportFilterPredicate(val field: String, val op: String, val value: Any?)

/** GENERATED — parse outcome: predicates, or a cross-port error envelope key + the field it rejected. */
private data class SalesReportFilterResult(val predicates: List<SalesReportFilterPredicate>, val error: String?, val field: String? = null)

/**
 * GENERATED — decode one query component, keeping a malformed escape as written:
 * {@code %XX} is a byte (runs decode as UTF-8), {@code +} is a space, and a {@code %}
 * not followed by two hex digits stays a literal {@code %} — what the TypeScript, C#
 * and Python servers do, where {@code URLDecoder} would throw.
 */
private fun decodeQueryComponent(raw: String): String {
    if ('%' !in raw && '+' !in raw) return raw
    val out = StringBuilder(raw.length)
    val bytes = ByteArrayOutputStream()
    var i = 0
    while (i < raw.length) {
        val c = raw[i]
        if (c == '%' && i + 2 < raw.length && raw[i + 1].isHexDigitAscii() && raw[i + 2].isHexDigitAscii()) {
            bytes.write(raw.substring(i + 1, i + 3).toInt(16))
            i += 3
            continue
        }
        if (bytes.size() > 0) { out.append(bytes.toString(StandardCharsets.UTF_8)); bytes.reset() }
        out.append(if (c == '+') ' ' else c)
        i++
    }
    if (bytes.size() > 0) out.append(bytes.toString(StandardCharsets.UTF_8))
    return out.toString()
}

private fun Char.isHexDigitAscii(): Boolean = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

/**
 * GENERATED — parse the bracketed-qs FR-009 filter grammar from the raw query
 * string. Returns either a list of validated predicates or one of
 * the cross-port error envelope keys ({@code invalid_filter_field /
 * invalid_filter_op / invalid_filter_value / filter.in_too_large}) plus the
 * field each one is about.
 */
private fun parseSalesReportFilter(rawQuery: String?): SalesReportFilterResult {
    val out = mutableListOf<SalesReportFilterPredicate>()
    for (pair in rawQuery.orEmpty().split('&')) {
        if (pair.isEmpty()) continue
        val eq = pair.indexOf('=')
        val rawKey = decodeQueryComponent(if (eq < 0) pair else pair.substring(0, eq))
        val value = decodeQueryComponent(if (eq < 0) "" else pair.substring(eq + 1))
        if (!rawKey.startsWith("filter[")) continue
        val firstClose = rawKey.indexOf(']', 7)
        if (firstClose < 0) continue
        val field = rawKey.substring(7, firstClose)
        val rest = firstClose + 1
        val op: String = when {
            rest >= rawKey.length -> "eq"
            rawKey[rest] == '[' -> {
                val secondClose = rawKey.indexOf(']', rest + 1)
                if (secondClose < 0) continue
                rawKey.substring(rest + 1, secondClose)
            }
            else -> continue
        }
        if (field !in SalesReportFilterAllowlist.FIELDS) return SalesReportFilterResult(emptyList(), "invalid_filter_field", field)
        val ops = SalesReportFilterAllowlist.OPS_BY_FIELD[field]
        if (ops == null || op !in ops) return SalesReportFilterResult(emptyList(), "invalid_filter_op", field)
        val coerced = coerceSalesReportValue(field, op, value)
            ?: return SalesReportFilterResult(emptyList(), "invalid_filter_value", field)
        val coercedValue = coerced.value
        if (op == "in" && coercedValue is List<*> && coercedValue.size > MAX_IN_LIST) {
            return SalesReportFilterResult(emptyList(), "filter.in_too_large", field)
        }
        out.add(SalesReportFilterPredicate(field, op, coercedValue))
    }
    return SalesReportFilterResult(out, null)
}

/** Box result: null = invalid; Box(value) = coerced. Distinguishes failure from a legitimate null. */
private data class SalesReportCoercedValue(val value: Any?)

private fun coerceSalesReportValue(field: String, op: String, raw: String): SalesReportCoercedValue? {
    if (op == "isNull") return when (raw) {
        "true" -> SalesReportCoercedValue(true)
        "false" -> SalesReportCoercedValue(false)
        else -> null
    }
    return when (field) {
        "id" -> coerceSalesReportLong(op, raw)
        "regionName" -> if (op == "in") SalesReportCoercedValue(raw.split(",").map { it.trim() }) else SalesReportCoercedValue(raw)
        "totalCents" -> coerceSalesReportLong(op, raw)
        else -> null
    }
}

private fun coerceSalesReportLong(op: String, raw: String): SalesReportCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Long.parseLong(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return SalesReportCoercedValue(list)
    }
    return SalesReportCoercedValue(parse(raw) ?: return null)
}

private fun coerceSalesReportInt(op: String, raw: String): SalesReportCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Integer.parseInt(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return SalesReportCoercedValue(list)
    }
    return SalesReportCoercedValue(parse(raw) ?: return null)
}

private fun coerceSalesReportDouble(op: String, raw: String): SalesReportCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Double.parseDouble(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return SalesReportCoercedValue(list)
    }
    return SalesReportCoercedValue(parse(raw) ?: return null)
}

private fun coerceSalesReportDate(op: String, raw: String): SalesReportCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { LocalDate.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return SalesReportCoercedValue(list)
    }
    return SalesReportCoercedValue(parse(raw) ?: return null)
}

private fun coerceSalesReportTime(op: String, raw: String): SalesReportCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { LocalTime.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return SalesReportCoercedValue(list)
    }
    return SalesReportCoercedValue(parse(raw) ?: return null)
}

private val SalesReportTimestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")

private fun coerceSalesReportTimestamp(op: String, raw: String): SalesReportCoercedValue? {
    val parse: (String) -> LocalDateTime? = { s -> runCatching { LocalDateTime.parse(s, SalesReportTimestampFmt) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return SalesReportCoercedValue(list)
    }
    return SalesReportCoercedValue(parse(raw) ?: return null)
}

private fun coerceSalesReportBoolean(op: String, raw: String): SalesReportCoercedValue? {
    val parse: (String) -> Boolean? = { s -> when (s) { "true" -> true; "false" -> false; else -> null } }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return SalesReportCoercedValue(list)
    }
    return SalesReportCoercedValue(parse(raw) ?: return null)
}

/**
 * GENERATED — fold a list of validated predicates into an Exposed
 * {@code Op<Boolean>}, AND-combining each predicate's column-op-value triple
 * against SalesReportTable. Returns null when [predicates] is empty so the
 * caller can elide the WHERE clause entirely.
 */
@Suppress("UNCHECKED_CAST")
private fun SalesReportWhereOp(predicates: List<SalesReportFilterPredicate>): Op<Boolean>? {
    if (predicates.isEmpty()) return null
    return with(SqlExpressionBuilder) {
        var combined: Op<Boolean>? = null
        for (p in predicates) {
            val op: Op<Boolean> = when (p.field) {
                "id" -> when (p.op) {
                    "eq" -> SalesReportTable.id eq (p.value as Long)
                    "ne" -> SalesReportTable.id neq (p.value as Long)
                    "gt" -> SalesReportTable.id greater (p.value as Long)
                    "gte" -> SalesReportTable.id greaterEq (p.value as Long)
                    "lt" -> SalesReportTable.id less (p.value as Long)
                    "lte" -> SalesReportTable.id lessEq (p.value as Long)
                    "in" -> SalesReportTable.id inList (p.value as List<Long>)
                    "isNull" -> if (p.value as Boolean) SalesReportTable.id.isNull() else SalesReportTable.id.isNotNull()
                    else -> throw IllegalStateException("unsupported op for id: " + p.op)
                }
                "regionName" -> when (p.op) {
                    "eq" -> SalesReportTable.regionName eq (p.value as String)
                    "ne" -> SalesReportTable.regionName neq (p.value as String)
                    "in" -> SalesReportTable.regionName inList (p.value as List<String>)
                    "like" -> SalesReportTable.regionName like (p.value as String)
                    "isNull" -> if (p.value as Boolean) SalesReportTable.regionName.isNull() else SalesReportTable.regionName.isNotNull()
                    else -> throw IllegalStateException("unsupported op for regionName: " + p.op)
                }
                "totalCents" -> when (p.op) {
                    "eq" -> SalesReportTable.totalCents eq (p.value as Long)
                    "ne" -> SalesReportTable.totalCents neq (p.value as Long)
                    "gt" -> SalesReportTable.totalCents greater (p.value as Long)
                    "gte" -> SalesReportTable.totalCents greaterEq (p.value as Long)
                    "lt" -> SalesReportTable.totalCents less (p.value as Long)
                    "lte" -> SalesReportTable.totalCents lessEq (p.value as Long)
                    "in" -> SalesReportTable.totalCents inList (p.value as List<Long>)
                    "isNull" -> if (p.value as Boolean) SalesReportTable.totalCents.isNull() else SalesReportTable.totalCents.isNotNull()
                    else -> throw IllegalStateException("unsupported op for totalCents: " + p.op)
                }
                else -> continue
            }
            combined = combined?.and(op) ?: op
        }
        combined
    }
}

/** GENERATED — map an Exposed ResultRow to the SalesReport data class. */
private fun rowToSalesReport(row: ResultRow): SalesReport = SalesReport(
    id = row[SalesReportTable.id],
    regionName = row[SalesReportTable.regionName],
    totalCents = row[SalesReportTable.totalCents],
)

/** GENERATED — READ-ONLY REST controller for the SalesReport projection. */
@RestController
@RequestMapping("/api/sales_reports")
class SalesReportController {

    @GetMapping
    fun list(
        @RequestParam(required = false) limit: Int?,
        @RequestParam(required = false) offset: Int?,
        @RequestParam(required = false) sort: String?,
        @RequestParam(required = false, name = "withCount") withCount: Int?,
        request: HttpServletRequest,
    ): ResponseEntity<Any> = transaction {
        // FR-009 filter operators — short-circuit 400 on invalid field/op/value.
        val filterResult = parseSalesReportFilter(request.queryString)
        if (filterResult.error != null) {
            return@transaction ResponseEntity.badRequest().body(mapOf("error" to filterResult.error, "field" to filterResult.field) as Any)
        }
        val whereOp = SalesReportWhereOp(filterResult.predicates)
        var q = if (whereOp != null) SalesReportTable.selectAll().where { whereOp } else SalesReportTable.selectAll()
        if (sort != null) {
            val parsed = parseSalesReportSort(sort)
                ?: return@transaction ResponseEntity.badRequest().body(mapOf("error" to "invalid_sort", "field" to sort.substringBefore(':')) as Any)
            val (field, dir) = parsed
            q = q.orderBy(when (field) {
                "id" -> SalesReportTable.id
                "regionName" -> SalesReportTable.regionName
                "totalCents" -> SalesReportTable.totalCents
                else -> error("SalesReport: sort field has no column (generator drift): " + field)
            } to dir)
        }
        val total: Long = if (withCount == 1) q.count() else -1L
        val effectiveLimit = limit ?: 50
        val effectiveOffset = (offset ?: 0).toLong()
        val rows = q.limit(effectiveLimit, effectiveOffset).map { rowToSalesReport(it) }
        if (withCount == 1) ResponseEntity.ok(mapOf("rows" to rows, "total" to total) as Any)
        else ResponseEntity.ok(rows as Any)
    }

    @PostMapping
    fun create(): ResponseEntity<Any> = methodNotAllowed()

    private fun methodNotAllowed(): ResponseEntity<Any> =
        ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(
            mapOf(
                "error" to "method_not_allowed",
                "message" to "writes are not supported on a projection (read-only).",
            ) as Any
        )
}

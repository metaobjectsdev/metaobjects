package acme.catalog

import org.jetbrains.exposed.sql.Op
import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SqlExpressionBuilder
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import org.jetbrains.exposed.sql.transactions.transaction
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.validation.Validator
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestMethod
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import jakarta.servlet.http.HttpServletRequest
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.sql.Timestamp
import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/** GENERATED — sort allowlist for Product (cross-port API contract). */
private val ProductSortAllowlist = setOf(
    "id",
    "name",
    "price",
    "rating",
)

/** GENERATED — declared @sortableDefaultOrder per field for Product. */
private val ProductSortDefaultOrder: Map<String, String> = mapOf(
)

private fun parseProductSort(raw: String): Pair<String, SortOrder>? {
    val parts = raw.split(":", limit = 2)
    val field = parts.getOrNull(0) ?: return null
    if (field !in ProductSortAllowlist) return null
    val dirRaw = parts.getOrNull(1)?.lowercase()
        ?: ProductSortDefaultOrder[field] ?: "asc"
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
private data class ProductFilterPredicate(val field: String, val op: String, val value: Any?)

/** GENERATED — parse outcome: predicates, or a cross-port error envelope key + the field it rejected. */
private data class ProductFilterResult(val predicates: List<ProductFilterPredicate>, val error: String?, val field: String? = null)

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
private fun parseProductFilter(rawQuery: String?): ProductFilterResult {
    val out = mutableListOf<ProductFilterPredicate>()
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
        if (field !in ProductFilterAllowlist.FIELDS) return ProductFilterResult(emptyList(), "invalid_filter_field", field)
        val ops = ProductFilterAllowlist.OPS_BY_FIELD[field]
        if (ops == null || op !in ops) return ProductFilterResult(emptyList(), "invalid_filter_op", field)
        val coerced = coerceProductValue(field, op, value)
            ?: return ProductFilterResult(emptyList(), "invalid_filter_value", field)
        val coercedValue = coerced.value
        if (op == "in" && coercedValue is List<*> && coercedValue.size > MAX_IN_LIST) {
            return ProductFilterResult(emptyList(), "filter.in_too_large", field)
        }
        out.add(ProductFilterPredicate(field, op, coercedValue))
    }
    return ProductFilterResult(out, null)
}

/** Box result: null = invalid; Box(value) = coerced. Distinguishes failure from a legitimate null. */
private data class ProductCoercedValue(val value: Any?)

private fun coerceProductValue(field: String, op: String, raw: String): ProductCoercedValue? {
    if (op == "isNull") return when (raw) {
        "true" -> ProductCoercedValue(true)
        "false" -> ProductCoercedValue(false)
        else -> null
    }
    return when (field) {
        "id" -> coerceProductLong(op, raw)
        "name" -> if (op == "in") ProductCoercedValue(raw.split(",").map { it.trim() }) else ProductCoercedValue(raw)
        "price" -> coerceProductDecimal(op, raw)
        "rating" -> coerceProductFloat(op, raw)
        else -> null
    }
}

private fun coerceProductLong(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Long.parseLong(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

private fun coerceProductInt(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Integer.parseInt(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

private fun coerceProductDouble(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Double.parseDouble(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

private fun coerceProductFloat(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Float.parseFloat(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

private fun coerceProductDecimal(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.math.BigDecimal(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

private fun coerceProductDate(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { LocalDate.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

private fun coerceProductTime(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { LocalTime.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

private val ProductTimestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")

private fun coerceProductTimestamp(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> LocalDateTime? = { s -> runCatching { LocalDateTime.parse(s, ProductTimestampFmt) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

private fun coerceProductBoolean(op: String, raw: String): ProductCoercedValue? {
    val parse: (String) -> Boolean? = { s -> when (s) { "true" -> true; "false" -> false; else -> null } }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return ProductCoercedValue(list)
    }
    return ProductCoercedValue(parse(raw) ?: return null)
}

/**
 * GENERATED — fold a list of validated predicates into an Exposed
 * {@code Op<Boolean>}, AND-combining each predicate's column-op-value triple
 * against ProductTable. Returns null when [predicates] is empty so the
 * caller can elide the WHERE clause entirely.
 */
@Suppress("UNCHECKED_CAST")
private fun ProductWhereOp(predicates: List<ProductFilterPredicate>): Op<Boolean>? {
    if (predicates.isEmpty()) return null
    return with(SqlExpressionBuilder) {
        var combined: Op<Boolean>? = null
        for (p in predicates) {
            val op: Op<Boolean> = when (p.field) {
                "id" -> when (p.op) {
                    "eq" -> ProductTable.id eq (p.value as Long)
                    "ne" -> ProductTable.id neq (p.value as Long)
                    "gt" -> ProductTable.id greater (p.value as Long)
                    "gte" -> ProductTable.id greaterEq (p.value as Long)
                    "lt" -> ProductTable.id less (p.value as Long)
                    "lte" -> ProductTable.id lessEq (p.value as Long)
                    "in" -> ProductTable.id inList (p.value as List<Long>)
                    "isNull" -> if (p.value as Boolean) ProductTable.id.isNull() else ProductTable.id.isNotNull()
                    else -> throw IllegalStateException("unsupported op for id: " + p.op)
                }
                "name" -> when (p.op) {
                    "eq" -> ProductTable.name eq (p.value as String)
                    "ne" -> ProductTable.name neq (p.value as String)
                    "in" -> ProductTable.name inList (p.value as List<String>)
                    "like" -> ProductTable.name like (p.value as String)
                    "isNull" -> if (p.value as Boolean) ProductTable.name.isNull() else ProductTable.name.isNotNull()
                    else -> throw IllegalStateException("unsupported op for name: " + p.op)
                }
                "price" -> when (p.op) {
                    "eq" -> ProductTable.price eq (p.value as BigDecimal)
                    "ne" -> ProductTable.price neq (p.value as BigDecimal)
                    "gt" -> ProductTable.price greater (p.value as BigDecimal)
                    "gte" -> ProductTable.price greaterEq (p.value as BigDecimal)
                    "lt" -> ProductTable.price less (p.value as BigDecimal)
                    "lte" -> ProductTable.price lessEq (p.value as BigDecimal)
                    "in" -> ProductTable.price inList (p.value as List<BigDecimal>)
                    "isNull" -> if (p.value as Boolean) ProductTable.price.isNull() else ProductTable.price.isNotNull()
                    else -> throw IllegalStateException("unsupported op for price: " + p.op)
                }
                "rating" -> when (p.op) {
                    "eq" -> ProductTable.rating eq (p.value as Float)
                    "ne" -> ProductTable.rating neq (p.value as Float)
                    "gt" -> ProductTable.rating greater (p.value as Float)
                    "gte" -> ProductTable.rating greaterEq (p.value as Float)
                    "lt" -> ProductTable.rating less (p.value as Float)
                    "lte" -> ProductTable.rating lessEq (p.value as Float)
                    "in" -> ProductTable.rating inList (p.value as List<Float>)
                    "isNull" -> if (p.value as Boolean) ProductTable.rating.isNull() else ProductTable.rating.isNotNull()
                    else -> throw IllegalStateException("unsupported op for rating: " + p.op)
                }
                else -> continue
            }
            combined = combined?.and(op) ?: op
        }
        combined
    }
}

/** GENERATED — map an Exposed ResultRow to the Product data class. */
private fun rowToProduct(row: ResultRow): Product = Product(
    id = row[ProductTable.id],
    name = row[ProductTable.name],
    price = row[ProductTable.price],
    rating = row[ProductTable.rating],
)

/**
 * GENERATED — REST controller for Product entity. Implements the cross-port API contract.
 *
 * Auth: these endpoints are unauthenticated. In your Spring Security config, require
 * authentication for `/api/products` and every path under it (`requestMatchers` + `authenticated()`).
 * A row-ownership rule ("only the owner may read this row") can't be expressed in path
 * config — eject this generator with `mvn metaobjects:eject` and hand-write those endpoints.
 */
@RestController
@RequestMapping("/api/products")
class ProductController(private val objectMapper: ObjectMapper, private val validator: Validator) {

    @GetMapping
    fun list(
        @RequestParam(required = false) limit: Int?,
        @RequestParam(required = false) offset: Int?,
        @RequestParam(required = false) sort: String?,
        @RequestParam(required = false, name = "withCount") withCount: Int?,
        request: HttpServletRequest,
    ): ResponseEntity<Any> = transaction {
        // FR-009 filter operators — short-circuit 400 on invalid field/op/value.
        val filterResult = parseProductFilter(request.queryString)
        if (filterResult.error != null) {
            return@transaction ResponseEntity.badRequest().body(mapOf("error" to filterResult.error, "field" to filterResult.field) as Any)
        }
        val whereOp = ProductWhereOp(filterResult.predicates)
        var q = if (whereOp != null) ProductTable.selectAll().where { whereOp } else ProductTable.selectAll()
        if (sort != null) {
            val parsed = parseProductSort(sort)
                ?: return@transaction ResponseEntity.badRequest().body(mapOf("error" to "invalid_sort", "field" to sort.substringBefore(':')) as Any)
            val (field, dir) = parsed
            q = q.orderBy(when (field) {
                "id" -> ProductTable.id
                "name" -> ProductTable.name
                "price" -> ProductTable.price
                "rating" -> ProductTable.rating
                else -> error("Product: sort field has no column (generator drift): " + field)
            } to dir)
        }
        val total: Long = if (withCount == 1) q.count() else -1L
        val effectiveLimit = limit ?: 50
        val effectiveOffset = (offset ?: 0).toLong()
        val rows = q.limit(effectiveLimit, effectiveOffset).map { rowToProduct(it) }
        if (withCount == 1) ResponseEntity.ok(mapOf("rows" to rows, "total" to total) as Any)
        else ResponseEntity.ok(rows as Any)
    }

    @GetMapping("/{id}")
    fun get(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val row = ProductTable.selectAll().where { ProductTable.id eq id }.singleOrNull()
            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        ResponseEntity.ok(rowToProduct(row) as Any)
    }

    @PostMapping
    fun create(@RequestBody dto: Product): ResponseEntity<Any> = transaction {
        if (validator.validate(dto).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
        val newId = ProductTable.insert {
            it[name] = dto.name
            it[price] = dto.price
            it[rating] = dto.rating
        }[ProductTable.id]
        val saved = ProductTable.selectAll().where { ProductTable.id eq newId }.single()
        ResponseEntity.status(HttpStatus.CREATED).body(rowToProduct(saved) as Any)
    }

    @RequestMapping(value = ["/{id}"], method = [RequestMethod.PATCH, RequestMethod.PUT])
    fun update(@PathVariable id: Long, @RequestBody body: JsonNode): ResponseEntity<Any> = transaction {
        if (!body.isObject) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
        if (body.has("name") && body.get("name").isNull) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
        if (listOf("name", "price", "rating").any { body.has(it) }) {
            try {
                val hasName = body.has("name")
                val vName: kotlin.String? = if (hasName) objectMapper.treeToValue(body.get("name"), object : TypeReference<kotlin.String>() {}) else null
                if (hasName && validator.validateValue(Product::class.java, "name", vName).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
                val hasPrice = body.has("price")
                val nullPrice = hasPrice && body.get("price").isNull
                val vPrice: java.math.BigDecimal? = if (hasPrice && !nullPrice) objectMapper.treeToValue(body.get("price"), object : TypeReference<java.math.BigDecimal>() {}) else null
                if (hasPrice && !nullPrice && validator.validateValue(Product::class.java, "price", vPrice).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
                val hasRating = body.has("rating")
                val nullRating = hasRating && body.get("rating").isNull
                val vRating: kotlin.Float? = if (hasRating && !nullRating) objectMapper.treeToValue(body.get("rating"), object : TypeReference<kotlin.Float>() {}) else null
                if (hasRating && !nullRating && validator.validateValue(Product::class.java, "rating", vRating).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
                ProductTable.update({ ProductTable.id eq id }) {
                    if (hasName) it[ProductTable.name] = vName!!
                    if (hasPrice) { if (nullPrice) it[ProductTable.price] = null else it[ProductTable.price] = vPrice }
                    if (hasRating) { if (nullRating) it[ProductTable.rating] = null else it[ProductTable.rating] = vRating }
                }
            } catch (e: com.fasterxml.jackson.databind.JsonMappingException) {
                return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
            }
        }
        val row = ProductTable.selectAll().where { ProductTable.id eq id }.singleOrNull()
        if (row == null) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else ResponseEntity.ok(rowToProduct(row) as Any)
    }

    @DeleteMapping("/{id}")
    fun delete(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val deleted = ProductTable.deleteWhere { with(SqlExpressionBuilder) { ProductTable.id eq id } }
        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else ResponseEntity.noContent().build<Any>()
    }

    /**
     * A database constraint violation is a CLIENT error, not a 500: the
     * identity.reference / identity.secondary that declare these constraints are the
     * same metadata this controller already validates against. Anything else is
     * rethrown, so the operator keeps the diagnostic and the caller gets none of it.
     */
    @ExceptionHandler(RuntimeException::class, java.sql.SQLException::class)
    fun handleConstraintViolation(e: Exception): ResponseEntity<Any> {
        val text = generateSequence<Throwable>(e) { if (it.cause === it) null else it.cause }
            .take(8)
            .flatMap { t -> sequenceOf((t as? java.sql.SQLException)?.sqlState, t.message) }
            .filterNotNull()
            .joinToString(" ")
            .uppercase()
        val kind = when {
            "23503" in text || "FOREIGN KEY" in text || "SQLITE_CONSTRAINT_FOREIGNKEY" in text -> "foreign_key"
            "23505" in text || "UNIQUE CONSTRAINT" in text || "SQLITE_CONSTRAINT_UNIQUE" in text -> "unique"
            "23514" in text || "CHECK CONSTRAINT" in text || "SQLITE_CONSTRAINT_CHECK" in text -> "check"
            "23502" in text || "NOT NULL" in text || "SQLITE_CONSTRAINT_NOTNULL" in text -> "not_null"
            else -> throw e
        }
        val status = if (kind == "foreign_key" || kind == "unique") HttpStatus.CONFLICT else HttpStatus.BAD_REQUEST
        return ResponseEntity.status(status).body(mapOf("error" to "constraint_violation", "constraint" to kind) as Any)
    }

}

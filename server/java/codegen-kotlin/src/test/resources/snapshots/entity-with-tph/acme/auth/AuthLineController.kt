package acme.auth

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
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestMethod
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.sql.Timestamp
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/** GENERATED — sort allowlist for AuthLine (cross-port API contract). */
private val AuthLineSortAllowlist = setOf(
    "id",
    "label",
)

private fun parseAuthLineSort(raw: String): Pair<String, SortOrder>? {
    val parts = raw.split(":", limit = 2)
    val field = parts.getOrNull(0) ?: return null
    if (field !in AuthLineSortAllowlist) return null
    val dirRaw = parts.getOrNull(1)?.lowercase() ?: "asc"
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
private data class AuthLineFilterPredicate(val field: String, val op: String, val value: Any?)

/** GENERATED — parse outcome: either a list of predicates or a cross-port error envelope key. */
private data class AuthLineFilterResult(val predicates: List<AuthLineFilterPredicate>, val error: String?)

/**
 * GENERATED — parse the bracketed-qs FR-009 filter grammar from a URL-decoded
 * {@code allParams} map. Returns either a list of validated predicates or one of
 * the cross-port error envelope keys ({@code invalid_filter_field /
 * invalid_filter_op / invalid_filter_value / filter.in_too_large}).
 */
private fun parseAuthLineFilter(allParams: Map<String, String>): AuthLineFilterResult {
    val out = mutableListOf<AuthLineFilterPredicate>()
    for ((rawKey, value) in allParams) {
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
        if (field !in AuthLineFilterAllowlist.FIELDS) return AuthLineFilterResult(emptyList(), "invalid_filter_field")
        val ops = AuthLineFilterAllowlist.OPS_BY_FIELD[field]
        if (ops == null || op !in ops) return AuthLineFilterResult(emptyList(), "invalid_filter_op")
        val coerced = coerceAuthLineValue(field, op, value)
            ?: return AuthLineFilterResult(emptyList(), "invalid_filter_value")
        val coercedValue = coerced.value
        if (op == "in" && coercedValue is List<*> && coercedValue.size > MAX_IN_LIST) {
            return AuthLineFilterResult(emptyList(), "filter.in_too_large")
        }
        out.add(AuthLineFilterPredicate(field, op, coercedValue))
    }
    return AuthLineFilterResult(out, null)
}

/** Box result: null = invalid; Box(value) = coerced. Distinguishes failure from a legitimate null. */
private data class AuthLineCoercedValue(val value: Any?)

private fun coerceAuthLineValue(field: String, op: String, raw: String): AuthLineCoercedValue? {
    if (op == "isNull") return when (raw) {
        "true" -> AuthLineCoercedValue(true)
        "false" -> AuthLineCoercedValue(false)
        else -> null
    }
    return when (field) {
        "id" -> coerceAuthLineLong(op, raw)
        "label" -> if (op == "in") AuthLineCoercedValue(raw.split(",").map { it.trim() }) else AuthLineCoercedValue(raw)
        else -> null
    }
}

private fun coerceAuthLineLong(op: String, raw: String): AuthLineCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Long.parseLong(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthLineCoercedValue(list)
    }
    return AuthLineCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthLineInt(op: String, raw: String): AuthLineCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Integer.parseInt(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthLineCoercedValue(list)
    }
    return AuthLineCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthLineDouble(op: String, raw: String): AuthLineCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Double.parseDouble(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthLineCoercedValue(list)
    }
    return AuthLineCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthLineDate(op: String, raw: String): AuthLineCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { LocalDate.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthLineCoercedValue(list)
    }
    return AuthLineCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthLineTime(op: String, raw: String): AuthLineCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { LocalTime.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthLineCoercedValue(list)
    }
    return AuthLineCoercedValue(parse(raw) ?: return null)
}

private val AuthLineTimestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")

private fun coerceAuthLineTimestamp(op: String, raw: String): AuthLineCoercedValue? {
    val parse: (String) -> LocalDateTime? = { s -> runCatching { LocalDateTime.parse(s, AuthLineTimestampFmt) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthLineCoercedValue(list)
    }
    return AuthLineCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthLineBoolean(op: String, raw: String): AuthLineCoercedValue? {
    val parse: (String) -> Boolean? = { s -> when (s) { "true" -> true; "false" -> false; else -> null } }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthLineCoercedValue(list)
    }
    return AuthLineCoercedValue(parse(raw) ?: return null)
}

/**
 * GENERATED — fold a list of validated predicates into an Exposed
 * {@code Op<Boolean>}, AND-combining each predicate's column-op-value triple
 * against AuthLineTable. Returns null when [predicates] is empty so the
 * caller can elide the WHERE clause entirely.
 */
@Suppress("UNCHECKED_CAST")
private fun AuthLineWhereOp(predicates: List<AuthLineFilterPredicate>): Op<Boolean>? {
    if (predicates.isEmpty()) return null
    return with(SqlExpressionBuilder) {
        var combined: Op<Boolean>? = null
        for (p in predicates) {
            val op: Op<Boolean> = when (p.field) {
                "id" -> when (p.op) {
                    "eq" -> AuthLineTable.id eq (p.value as Long)
                    "ne" -> AuthLineTable.id neq (p.value as Long)
                    "gt" -> AuthLineTable.id greater (p.value as Long)
                    "gte" -> AuthLineTable.id greaterEq (p.value as Long)
                    "lt" -> AuthLineTable.id less (p.value as Long)
                    "lte" -> AuthLineTable.id lessEq (p.value as Long)
                    "in" -> AuthLineTable.id inList (p.value as List<Long>)
                    "isNull" -> if (p.value as Boolean) AuthLineTable.id.isNull() else AuthLineTable.id.isNotNull()
                    else -> throw IllegalStateException("unsupported op for id: " + p.op)
                }
                "label" -> when (p.op) {
                    "eq" -> AuthLineTable.label eq (p.value as String)
                    "ne" -> AuthLineTable.label neq (p.value as String)
                    "in" -> AuthLineTable.label inList (p.value as List<String>)
                    "like" -> AuthLineTable.label like (p.value as String)
                    "isNull" -> if (p.value as Boolean) AuthLineTable.label.isNull() else AuthLineTable.label.isNotNull()
                    else -> throw IllegalStateException("unsupported op for label: " + p.op)
                }
                else -> continue
            }
            combined = combined?.and(op) ?: op
        }
        combined
    }
}

/** GENERATED — map an Exposed ResultRow to the AuthLine data class. */
private fun rowToAuthLine(row: ResultRow): AuthLine = AuthLine(
    id = row[AuthLineTable.id],
    label = row[AuthLineTable.label],
)

/** GENERATED — REST controller for AuthLine entity. Implements the cross-port API contract. */
@RestController
@RequestMapping("/api/authlines")
class AuthLineController(private val objectMapper: ObjectMapper, private val validator: Validator) {

    @GetMapping
    fun list(
        @RequestParam(required = false) limit: Int?,
        @RequestParam(required = false) offset: Int?,
        @RequestParam(required = false) sort: String?,
        @RequestParam(required = false, name = "withCount") withCount: Int?,
        @RequestParam allParams: Map<String, String>,
    ): ResponseEntity<Any> = transaction {
        // FR-009 filter operators — short-circuit 400 on invalid field/op/value.
        val filterResult = parseAuthLineFilter(allParams)
        if (filterResult.error != null) {
            return@transaction ResponseEntity.badRequest().body(mapOf("error" to filterResult.error) as Any)
        }
        val whereOp = AuthLineWhereOp(filterResult.predicates)
        var q = if (whereOp != null) AuthLineTable.selectAll().where { whereOp } else AuthLineTable.selectAll()
        if (sort != null) {
            val parsed = parseAuthLineSort(sort)
                ?: return@transaction ResponseEntity.badRequest().body(mapOf("error" to "invalid_sort") as Any)
            val (field, dir) = parsed
            q = q.orderBy(AuthLineTable.columns.first { it.name == field } to dir)
        }
        val total: Long = if (withCount == 1) q.count() else -1L
        val effectiveLimit = limit ?: 50
        val effectiveOffset = (offset ?: 0).toLong()
        val rows = q.limit(effectiveLimit, effectiveOffset).map { rowToAuthLine(it) }
        if (withCount == 1) ResponseEntity.ok(mapOf("rows" to rows, "total" to total) as Any)
        else ResponseEntity.ok(rows as Any)
    }

    @GetMapping("/{id}")
    fun get(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val row = AuthLineTable.selectAll().where { AuthLineTable.id eq id }.singleOrNull()
            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        ResponseEntity.ok(rowToAuthLine(row) as Any)
    }

    @PostMapping
    fun create(@RequestBody dto: AuthLine): ResponseEntity<Any> = transaction {
        if (validator.validate(dto).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
        val newId = AuthLineTable.insert {
            it[label] = dto.label
        }[AuthLineTable.id]
        val saved = AuthLineTable.selectAll().where { AuthLineTable.id eq newId }.single()
        ResponseEntity.status(HttpStatus.CREATED).body(rowToAuthLine(saved) as Any)
    }

    @RequestMapping(value = ["/{id}"], method = [RequestMethod.PATCH, RequestMethod.PUT])
    fun update(@PathVariable id: Long, @RequestBody body: JsonNode): ResponseEntity<Any> = transaction {
        if (!body.isObject) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
        if (listOf("label").any { body.has(it) }) {
            try {
                val hasLabel = body.has("label")
                val nullLabel = hasLabel && body.get("label").isNull
                val vLabel: kotlin.String? = if (hasLabel && !nullLabel) objectMapper.treeToValue(body.get("label"), object : TypeReference<kotlin.String>() {}) else null
                if (hasLabel && !nullLabel && validator.validateValue(AuthLine::class.java, "label", vLabel).isNotEmpty()) return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
                AuthLineTable.update({ AuthLineTable.id eq id }) {
                    if (hasLabel) { if (nullLabel) it[AuthLineTable.label] = null else it[AuthLineTable.label] = vLabel }
                }
            } catch (e: com.fasterxml.jackson.databind.JsonMappingException) {
                return@transaction ResponseEntity.badRequest().body(mapOf("error" to "validation") as Any)
            }
        }
        val row = AuthLineTable.selectAll().where { AuthLineTable.id eq id }.singleOrNull()
        if (row == null) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else ResponseEntity.ok(rowToAuthLine(row) as Any)
    }

    @DeleteMapping("/{id}")
    fun delete(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val deleted = AuthLineTable.deleteWhere { with(SqlExpressionBuilder) { AuthLineTable.id eq id } }
        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else ResponseEntity.noContent().build<Any>()
    }
}

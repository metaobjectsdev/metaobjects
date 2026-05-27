package acme.blog

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
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.sql.Timestamp
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/** GENERATED — sort allowlist for Author (cross-port API contract). */
private val AuthorSortAllowlist = setOf(
    "id",
    "name",
)

private fun parseAuthorSort(raw: String): Pair<String, SortOrder>? {
    val parts = raw.split(":", limit = 2)
    val field = parts.getOrNull(0) ?: return null
    if (field !in AuthorSortAllowlist) return null
    val dirRaw = parts.getOrNull(1)?.lowercase() ?: "asc"
    val dir = when (dirRaw) {
        "asc" -> SortOrder.ASC
        "desc" -> SortOrder.DESC
        else -> return null
    }
    return field to dir
}

/** GENERATED — single parsed + validated FR-009 filter predicate. */
private data class AuthorFilterPredicate(val field: String, val op: String, val value: Any?)

/** GENERATED — parse outcome: either a list of predicates or a cross-port error envelope key. */
private data class AuthorFilterResult(val predicates: List<AuthorFilterPredicate>, val error: String?)

/**
 * GENERATED — parse the bracketed-qs FR-009 filter grammar from a URL-decoded
 * {@code allParams} map. Returns either a list of validated predicates or one of
 * the cross-port error envelope keys ({@code invalid_filter_field /
 * invalid_filter_op / invalid_filter_value}).
 */
private fun parseAuthorFilter(allParams: Map<String, String>): AuthorFilterResult {
    val out = mutableListOf<AuthorFilterPredicate>()
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
        if (field !in AuthorFilterAllowlist.FIELDS) return AuthorFilterResult(emptyList(), "invalid_filter_field")
        val ops = AuthorFilterAllowlist.OPS_BY_FIELD[field]
        if (ops == null || op !in ops) return AuthorFilterResult(emptyList(), "invalid_filter_op")
        val coerced = coerceAuthorValue(field, op, value)
            ?: return AuthorFilterResult(emptyList(), "invalid_filter_value")
        out.add(AuthorFilterPredicate(field, op, coerced.value))
    }
    return AuthorFilterResult(out, null)
}

/** Box result: null = invalid; Box(value) = coerced. Distinguishes failure from a legitimate null. */
private data class AuthorCoercedValue(val value: Any?)

private fun coerceAuthorValue(field: String, op: String, raw: String): AuthorCoercedValue? {
    if (op == "isNull") return when (raw) {
        "true" -> AuthorCoercedValue(true)
        "false" -> AuthorCoercedValue(false)
        else -> null
    }
    return when (field) {
        "id" -> coerceAuthorLong(op, raw)
        "name" -> if (op == "in") AuthorCoercedValue(raw.split(",").map { it.trim() }) else AuthorCoercedValue(raw)
        else -> null
    }
}

private fun coerceAuthorLong(op: String, raw: String): AuthorCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Long.parseLong(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthorCoercedValue(list)
    }
    return AuthorCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthorInt(op: String, raw: String): AuthorCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Integer.parseInt(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthorCoercedValue(list)
    }
    return AuthorCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthorDouble(op: String, raw: String): AuthorCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Double.parseDouble(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthorCoercedValue(list)
    }
    return AuthorCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthorBoolean(op: String, raw: String): AuthorCoercedValue? {
    val parse: (String) -> Boolean? = { s -> when (s) { "true" -> true; "false" -> false; else -> null } }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthorCoercedValue(list)
    }
    return AuthorCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthorDate(op: String, raw: String): AuthorCoercedValue? {
    val parse: (String) -> LocalDate? = { s -> runCatching { LocalDate.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthorCoercedValue(list)
    }
    return AuthorCoercedValue(parse(raw) ?: return null)
}

private val AuthorTimestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")

private fun coerceAuthorTimestamp(op: String, raw: String): AuthorCoercedValue? {
    val parse: (String) -> LocalDateTime? = { s -> runCatching { LocalDateTime.parse(s, AuthorTimestampFmt) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthorCoercedValue(list)
    }
    return AuthorCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthorTime(op: String, raw: String): AuthorCoercedValue? {
    val parse: (String) -> LocalTime? = { s -> runCatching { LocalTime.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthorCoercedValue(list)
    }
    return AuthorCoercedValue(parse(raw) ?: return null)
}

/**
 * GENERATED — fold a list of validated predicates into an Exposed
 * {@code Op<Boolean>}, AND-combining each predicate's column-op-value triple
 * against AuthorTable. Returns null when [predicates] is empty so the
 * caller can elide the WHERE clause entirely.
 */
@Suppress("UNCHECKED_CAST")
private fun AuthorWhereOp(predicates: List<AuthorFilterPredicate>): Op<Boolean>? {
    if (predicates.isEmpty()) return null
    return with(SqlExpressionBuilder) {
        var combined: Op<Boolean>? = null
        for (p in predicates) {
            val op: Op<Boolean> = when (p.field) {
                "id" -> when (p.op) {
                    "eq" -> AuthorTable.id eq (p.value as Any?)
                    "ne" -> AuthorTable.id neq (p.value as Any?)
                    "gt" -> AuthorTable.id greater p.value!!
                    "gte" -> AuthorTable.id greaterEq p.value!!
                    "lt" -> AuthorTable.id less p.value!!
                    "lte" -> AuthorTable.id lessEq p.value!!
                    "in" -> AuthorTable.id inList (p.value as List<Any?>)
                    "isNull" -> if (p.value as Boolean) AuthorTable.id.isNull() else AuthorTable.id.isNotNull()
                    else -> throw IllegalStateException("unsupported op for id: " + p.op)
                }
                "name" -> when (p.op) {
                    "eq" -> AuthorTable.name eq (p.value as Any?)
                    "ne" -> AuthorTable.name neq (p.value as Any?)
                    "in" -> AuthorTable.name inList (p.value as List<Any?>)
                    "like" -> AuthorTable.name like (p.value as String)
                    "isNull" -> if (p.value as Boolean) AuthorTable.name.isNull() else AuthorTable.name.isNotNull()
                    else -> throw IllegalStateException("unsupported op for name: " + p.op)
                }
                else -> continue
            }
            combined = combined?.and(op) ?: op
        }
        combined
    }
}

/** GENERATED — map an Exposed ResultRow to the Author data class. */
private fun rowToAuthor(row: ResultRow): Author = Author(
    id = row[AuthorTable.id],
    name = row[AuthorTable.name],
)

/** GENERATED — REST controller for Author entity. Implements the cross-port API contract. */
@RestController
@RequestMapping("/api/authors")
class AuthorController {

    @GetMapping
    fun list(
        @RequestParam(required = false) limit: Int?,
        @RequestParam(required = false) offset: Int?,
        @RequestParam(required = false) sort: String?,
        @RequestParam(required = false, name = "withCount") withCount: Int?,
        @RequestParam allParams: Map<String, String>,
    ): ResponseEntity<Any> = transaction {
        // FR-009 filter operators — short-circuit 400 on invalid field/op/value.
        val filterResult = parseAuthorFilter(allParams)
        if (filterResult.error != null) {
            return@transaction ResponseEntity.badRequest().body(mapOf("error" to filterResult.error) as Any)
        }
        val whereOp = AuthorWhereOp(filterResult.predicates)
        var q = if (whereOp != null) AuthorTable.selectAll().where { whereOp } else AuthorTable.selectAll()
        if (sort != null) {
            val parsed = parseAuthorSort(sort)
                ?: return@transaction ResponseEntity.badRequest().body(mapOf("error" to "invalid_sort") as Any)
            val (field, dir) = parsed
            q = q.orderBy(AuthorTable.columns.first { it.name == field } to dir)
        }
        val total: Long = if (withCount == 1) q.count() else -1L
        val effectiveLimit = limit ?: 50
        val effectiveOffset = (offset ?: 0).toLong()
        val rows = q.limit(effectiveLimit, effectiveOffset).map { rowToAuthor(it) }
        if (withCount == 1) ResponseEntity.ok(mapOf("rows" to rows, "total" to total) as Any)
        else ResponseEntity.ok(rows as Any)
    }

    @GetMapping("/{id}")
    fun get(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val row = AuthorTable.selectAll().where { AuthorTable.id eq id }.singleOrNull()
            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        ResponseEntity.ok(rowToAuthor(row) as Any)
    }

    @PostMapping
    fun create(@RequestBody dto: Author): ResponseEntity<Author> = transaction {
        val newId = AuthorTable.insert {
            it[name] = dto.name
        }[AuthorTable.id]
        val saved = AuthorTable.selectAll().where { AuthorTable.id eq newId }.single()
        ResponseEntity.status(HttpStatus.CREATED).body(rowToAuthor(saved))
    }

    @PatchMapping("/{id}")
    @PutMapping("/{id}")
    fun update(@PathVariable id: Long, @RequestBody dto: Author): ResponseEntity<Any> = transaction {
        val updated = AuthorTable.update({ AuthorTable.id eq id }) {
            it[name] = dto.name
        }
        if (updated == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else {
            val row = AuthorTable.selectAll().where { AuthorTable.id eq id }.single()
            ResponseEntity.ok(rowToAuthor(row) as Any)
        }
    }

    @DeleteMapping("/{id}")
    fun delete(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val deleted = AuthorTable.deleteWhere { AuthorTable.id eq id }
        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else ResponseEntity.noContent().build<Any>()
    }
}

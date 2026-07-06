package acme.auth

import org.jetbrains.exposed.sql.Op
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SortOrder
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

/** GENERATED — sort allowlist for Auth (cross-port API contract). */
private val AuthSortAllowlist = setOf(
    "id",
    "type",
    "reference",
)

private fun parseAuthSort(raw: String): Pair<String, SortOrder>? {
    val parts = raw.split(":", limit = 2)
    val field = parts.getOrNull(0) ?: return null
    if (field !in AuthSortAllowlist) return null
    val dir = when (parts.getOrNull(1)?.lowercase() ?: "asc") {
        "asc" -> SortOrder.ASC
        "desc" -> SortOrder.DESC
        else -> return null
    }
    return field to dir
}

/** GENERATED — cross-port cap on `in`-list size (matches TS DEFAULT_MAX_IN_LIST). */
private const val MAX_IN_LIST = 100

/** GENERATED — single parsed + validated FR-009 filter predicate. */
private data class AuthFilterPredicate(val field: String, val op: String, val value: Any?)

/** GENERATED — parse outcome: either a list of predicates or a cross-port error envelope key. */
private data class AuthFilterResult(val predicates: List<AuthFilterPredicate>, val error: String?)

/**
 * GENERATED — parse the bracketed-qs FR-009 filter grammar from a URL-decoded
 * {@code allParams} map. Returns either a list of validated predicates or one of
 * the cross-port error envelope keys ({@code invalid_filter_field /
 * invalid_filter_op / invalid_filter_value / filter.in_too_large}).
 */
private fun parseAuthFilter(allParams: Map<String, String>): AuthFilterResult {
    val out = mutableListOf<AuthFilterPredicate>()
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
        if (field !in AuthFilterAllowlist.FIELDS) return AuthFilterResult(emptyList(), "invalid_filter_field")
        val ops = AuthFilterAllowlist.OPS_BY_FIELD[field]
        if (ops == null || op !in ops) return AuthFilterResult(emptyList(), "invalid_filter_op")
        val coerced = coerceAuthValue(field, op, value)
            ?: return AuthFilterResult(emptyList(), "invalid_filter_value")
        val coercedValue = coerced.value
        if (op == "in" && coercedValue is List<*> && coercedValue.size > MAX_IN_LIST) {
            return AuthFilterResult(emptyList(), "filter.in_too_large")
        }
        out.add(AuthFilterPredicate(field, op, coercedValue))
    }
    return AuthFilterResult(out, null)
}

/** Box result: null = invalid; Box(value) = coerced. Distinguishes failure from a legitimate null. */
private data class AuthCoercedValue(val value: Any?)

private fun coerceAuthValue(field: String, op: String, raw: String): AuthCoercedValue? {
    if (op == "isNull") return when (raw) {
        "true" -> AuthCoercedValue(true)
        "false" -> AuthCoercedValue(false)
        else -> null
    }
    return when (field) {
        "id" -> coerceAuthLong(op, raw)
        "reference" -> if (op == "in") AuthCoercedValue(raw.split(",").map { it.trim() }) else AuthCoercedValue(raw)
        "quantity" -> coerceAuthInt(op, raw)
        "priorAuthNumber" -> if (op == "in") AuthCoercedValue(raw.split(",").map { it.trim() }) else AuthCoercedValue(raw)
        else -> null
    }
}

private fun coerceAuthLong(op: String, raw: String): AuthCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Long.parseLong(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthCoercedValue(list)
    }
    return AuthCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthInt(op: String, raw: String): AuthCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Integer.parseInt(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthCoercedValue(list)
    }
    return AuthCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthDouble(op: String, raw: String): AuthCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { java.lang.Double.parseDouble(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthCoercedValue(list)
    }
    return AuthCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthDate(op: String, raw: String): AuthCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { LocalDate.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthCoercedValue(list)
    }
    return AuthCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthTime(op: String, raw: String): AuthCoercedValue? {
    val parse: (String) -> Any? = { s -> runCatching { LocalTime.parse(s) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthCoercedValue(list)
    }
    return AuthCoercedValue(parse(raw) ?: return null)
}

private val AuthTimestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")

private fun coerceAuthTimestamp(op: String, raw: String): AuthCoercedValue? {
    val parse: (String) -> LocalDateTime? = { s -> runCatching { LocalDateTime.parse(s, AuthTimestampFmt) }.getOrNull() }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthCoercedValue(list)
    }
    return AuthCoercedValue(parse(raw) ?: return null)
}

private fun coerceAuthBoolean(op: String, raw: String): AuthCoercedValue? {
    val parse: (String) -> Boolean? = { s -> when (s) { "true" -> true; "false" -> false; else -> null } }
    if (op == "in") {
        val parts = raw.split(",").map { it.trim() }
        val list = parts.map { parse(it) ?: return null }
        return AuthCoercedValue(list)
    }
    return AuthCoercedValue(parse(raw) ?: return null)
}

/**
 * GENERATED — fold a list of validated predicates into an Exposed
 * {@code Op<Boolean>}, AND-combining each predicate's column-op-value triple
 * against AuthTable. Returns null when [predicates] is empty so the
 * caller can elide the WHERE clause entirely.
 */
@Suppress("UNCHECKED_CAST")
private fun AuthWhereOp(predicates: List<AuthFilterPredicate>): Op<Boolean>? {
    if (predicates.isEmpty()) return null
    return with(SqlExpressionBuilder) {
        var combined: Op<Boolean>? = null
        for (p in predicates) {
            val op: Op<Boolean> = when (p.field) {
                "id" -> when (p.op) {
                    "eq" -> AuthTable.id eq (p.value as Long)
                    "ne" -> AuthTable.id neq (p.value as Long)
                    "gt" -> AuthTable.id greater (p.value as Long)
                    "gte" -> AuthTable.id greaterEq (p.value as Long)
                    "lt" -> AuthTable.id less (p.value as Long)
                    "lte" -> AuthTable.id lessEq (p.value as Long)
                    "in" -> AuthTable.id inList (p.value as List<Long>)
                    "isNull" -> if (p.value as Boolean) AuthTable.id.isNull() else AuthTable.id.isNotNull()
                    else -> throw IllegalStateException("unsupported op for id: " + p.op)
                }
                "reference" -> when (p.op) {
                    "eq" -> AuthTable.reference eq (p.value as String)
                    "ne" -> AuthTable.reference neq (p.value as String)
                    "in" -> AuthTable.reference inList (p.value as List<String>)
                    "like" -> AuthTable.reference like (p.value as String)
                    "isNull" -> if (p.value as Boolean) AuthTable.reference.isNull() else AuthTable.reference.isNotNull()
                    else -> throw IllegalStateException("unsupported op for reference: " + p.op)
                }
                "quantity" -> when (p.op) {
                    "eq" -> AuthTable.quantity eq (p.value as Int)
                    "ne" -> AuthTable.quantity neq (p.value as Int)
                    "gt" -> AuthTable.quantity greater (p.value as Int)
                    "gte" -> AuthTable.quantity greaterEq (p.value as Int)
                    "lt" -> AuthTable.quantity less (p.value as Int)
                    "lte" -> AuthTable.quantity lessEq (p.value as Int)
                    "in" -> AuthTable.quantity inList (p.value as List<Int>)
                    "isNull" -> if (p.value as Boolean) AuthTable.quantity.isNull() else AuthTable.quantity.isNotNull()
                    else -> throw IllegalStateException("unsupported op for quantity: " + p.op)
                }
                "priorAuthNumber" -> when (p.op) {
                    "eq" -> AuthTable.priorAuthNumber eq (p.value as String)
                    "ne" -> AuthTable.priorAuthNumber neq (p.value as String)
                    "in" -> AuthTable.priorAuthNumber inList (p.value as List<String>)
                    "like" -> AuthTable.priorAuthNumber like (p.value as String)
                    "isNull" -> if (p.value as Boolean) AuthTable.priorAuthNumber.isNull() else AuthTable.priorAuthNumber.isNotNull()
                    else -> throw IllegalStateException("unsupported op for priorAuthNumber: " + p.op)
                }
                else -> continue
            }
            combined = combined?.and(op) ?: op
        }
        combined
    }
}

/** GENERATED — map an Exposed ResultRow to the union Auth data class. */
private fun rowToAuth(row: ResultRow): Auth = Auth(
    id = row[AuthTable.id],
    type = row[AuthTable.type],
    reference = row[AuthTable.reference],
    quantity = row[AuthTable.quantity],
    copayAmount = row[AuthTable.copayAmount],
    priorAuthNumber = row[AuthTable.priorAuthNumber],
)

/** GENERATED — TPH discriminator-base controller for Auth (polymorphic + per-subtype CRUD). */
@RestController
@RequestMapping("/api/auths")
class AuthController {

    @GetMapping
    fun list(
        @RequestParam(required = false) limit: Int?,
        @RequestParam(required = false) offset: Int?,
        @RequestParam(required = false) sort: String?,
        @RequestParam(required = false, name = "withCount") withCount: Int?,
        @RequestParam allParams: Map<String, String>,
    ): ResponseEntity<Any> = transaction {
        val filterResult = parseAuthFilter(allParams)
        if (filterResult.error != null) return@transaction ResponseEntity.badRequest().body(mapOf("error" to filterResult.error) as Any)
        val whereOp = AuthWhereOp(filterResult.predicates)
        var q = if (whereOp != null) AuthTable.selectAll().where { whereOp } else AuthTable.selectAll()
        if (sort != null) {
            val parsed = parseAuthSort(sort)
                ?: return@transaction ResponseEntity.badRequest().body(mapOf("error" to "invalid_sort") as Any)
            val (field, dir) = parsed
            q = q.orderBy(AuthTable.columns.first { it.name == field } to dir)
        }
        val total: Long = if (withCount == 1) q.count() else -1L
        val rows = q.limit(limit ?: 50, (offset ?: 0).toLong()).map { rowToAuth(it) }
        if (withCount == 1) ResponseEntity.ok(mapOf("rows" to rows, "total" to total) as Any)
        else ResponseEntity.ok(rows as Any)
    }

    @GetMapping("/{id}")
    fun get(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val row = AuthTable.selectAll().where { AuthTable.id eq id }.singleOrNull()
            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        ResponseEntity.ok(rowToAuth(row) as Any)
    }

    // --- subtype Bridge (segment /bridge) ---
    @GetMapping("/bridge")
    fun listBridge(
        @RequestParam(required = false) limit: Int?,
        @RequestParam(required = false) offset: Int?,
        @RequestParam(required = false) sort: String?,
        @RequestParam allParams: Map<String, String>,
    ): ResponseEntity<Any> = transaction {
        val filterResult = parseAuthFilter(allParams)
        if (filterResult.error != null) return@transaction ResponseEntity.badRequest().body(mapOf("error" to filterResult.error) as Any)
        val whereOp = AuthWhereOp(filterResult.predicates)
        var q = AuthTable.selectAll().where {
            val d = AuthTable.type eq AuthType.Bridge
            if (whereOp != null) d and whereOp else d
        }
        if (sort != null) {
            val parsed = parseAuthSort(sort)
                ?: return@transaction ResponseEntity.badRequest().body(mapOf("error" to "invalid_sort") as Any)
            val (field, dir) = parsed
            q = q.orderBy(AuthTable.columns.first { it.name == field } to dir)
        }
        val rows = q.limit(limit ?: 50, (offset ?: 0).toLong()).map { rowToAuth(it) }
        ResponseEntity.ok(rows as Any)
    }

    @GetMapping("/bridge/{id}")
    fun getBridge(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val row = AuthTable.selectAll().where { (AuthTable.id eq id) and (AuthTable.type eq AuthType.Bridge) }.singleOrNull()
            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        ResponseEntity.ok(rowToAuth(row) as Any)
    }

    @PostMapping("/bridge")
    fun createBridge(@RequestBody dto: Auth): ResponseEntity<Auth> = transaction {
        val newId = AuthTable.insert {
            it[type] = AuthType.Bridge
            it[reference] = dto.reference!!
            it[quantity] = dto.quantity
            it[copayAmount] = dto.copayAmount
            it[priorAuthNumber] = dto.priorAuthNumber
        }[AuthTable.id]
        val saved = AuthTable.selectAll().where { AuthTable.id eq newId }.single()
        ResponseEntity.status(HttpStatus.CREATED).body(rowToAuth(saved))
    }

    @RequestMapping(value = ["/bridge/{id}"], method = [RequestMethod.PATCH, RequestMethod.PUT])
    fun updateBridge(@PathVariable id: Long, @RequestBody dto: Auth): ResponseEntity<Any> = transaction {
        val updated = AuthTable.update({ (AuthTable.id eq id) and (AuthTable.type eq AuthType.Bridge) }) {
            if (dto.reference != null) it[reference] = dto.reference
            if (dto.quantity != null) it[quantity] = dto.quantity
            if (dto.copayAmount != null) it[copayAmount] = dto.copayAmount
            if (dto.priorAuthNumber != null) it[priorAuthNumber] = dto.priorAuthNumber
        }
        if (updated == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else {
            val row = AuthTable.selectAll().where { (AuthTable.id eq id) and (AuthTable.type eq AuthType.Bridge) }.single()
            ResponseEntity.ok(rowToAuth(row) as Any)
        }
    }

    @DeleteMapping("/bridge/{id}")
    fun deleteBridge(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val deleted = AuthTable.deleteWhere { with(SqlExpressionBuilder) { (AuthTable.id eq id) and (AuthTable.type eq AuthType.Bridge) } }
        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else ResponseEntity.noContent().build<Any>()
    }

    // --- subtype Copay (segment /copay) ---
    @GetMapping("/copay")
    fun listCopay(
        @RequestParam(required = false) limit: Int?,
        @RequestParam(required = false) offset: Int?,
        @RequestParam(required = false) sort: String?,
        @RequestParam allParams: Map<String, String>,
    ): ResponseEntity<Any> = transaction {
        val filterResult = parseAuthFilter(allParams)
        if (filterResult.error != null) return@transaction ResponseEntity.badRequest().body(mapOf("error" to filterResult.error) as Any)
        val whereOp = AuthWhereOp(filterResult.predicates)
        var q = AuthTable.selectAll().where {
            val d = AuthTable.type eq AuthType.Copay
            if (whereOp != null) d and whereOp else d
        }
        if (sort != null) {
            val parsed = parseAuthSort(sort)
                ?: return@transaction ResponseEntity.badRequest().body(mapOf("error" to "invalid_sort") as Any)
            val (field, dir) = parsed
            q = q.orderBy(AuthTable.columns.first { it.name == field } to dir)
        }
        val rows = q.limit(limit ?: 50, (offset ?: 0).toLong()).map { rowToAuth(it) }
        ResponseEntity.ok(rows as Any)
    }

    @GetMapping("/copay/{id}")
    fun getCopay(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val row = AuthTable.selectAll().where { (AuthTable.id eq id) and (AuthTable.type eq AuthType.Copay) }.singleOrNull()
            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        ResponseEntity.ok(rowToAuth(row) as Any)
    }

    @PostMapping("/copay")
    fun createCopay(@RequestBody dto: Auth): ResponseEntity<Auth> = transaction {
        val newId = AuthTable.insert {
            it[type] = AuthType.Copay
            it[reference] = dto.reference!!
            it[quantity] = dto.quantity
            it[copayAmount] = dto.copayAmount
            it[priorAuthNumber] = dto.priorAuthNumber
        }[AuthTable.id]
        val saved = AuthTable.selectAll().where { AuthTable.id eq newId }.single()
        ResponseEntity.status(HttpStatus.CREATED).body(rowToAuth(saved))
    }

    @RequestMapping(value = ["/copay/{id}"], method = [RequestMethod.PATCH, RequestMethod.PUT])
    fun updateCopay(@PathVariable id: Long, @RequestBody dto: Auth): ResponseEntity<Any> = transaction {
        val updated = AuthTable.update({ (AuthTable.id eq id) and (AuthTable.type eq AuthType.Copay) }) {
            if (dto.reference != null) it[reference] = dto.reference
            if (dto.quantity != null) it[quantity] = dto.quantity
            if (dto.copayAmount != null) it[copayAmount] = dto.copayAmount
            if (dto.priorAuthNumber != null) it[priorAuthNumber] = dto.priorAuthNumber
        }
        if (updated == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else {
            val row = AuthTable.selectAll().where { (AuthTable.id eq id) and (AuthTable.type eq AuthType.Copay) }.single()
            ResponseEntity.ok(rowToAuth(row) as Any)
        }
    }

    @DeleteMapping("/copay/{id}")
    fun deleteCopay(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val deleted = AuthTable.deleteWhere { with(SqlExpressionBuilder) { (AuthTable.id eq id) and (AuthTable.type eq AuthType.Copay) } }
        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else ResponseEntity.noContent().build<Any>()
    }

    // --- subtype PriorAuth (segment /priorauth) ---
    @GetMapping("/priorauth")
    fun listPriorAuth(
        @RequestParam(required = false) limit: Int?,
        @RequestParam(required = false) offset: Int?,
        @RequestParam(required = false) sort: String?,
        @RequestParam allParams: Map<String, String>,
    ): ResponseEntity<Any> = transaction {
        val filterResult = parseAuthFilter(allParams)
        if (filterResult.error != null) return@transaction ResponseEntity.badRequest().body(mapOf("error" to filterResult.error) as Any)
        val whereOp = AuthWhereOp(filterResult.predicates)
        var q = AuthTable.selectAll().where {
            val d = AuthTable.type eq AuthType.PriorAuth
            if (whereOp != null) d and whereOp else d
        }
        if (sort != null) {
            val parsed = parseAuthSort(sort)
                ?: return@transaction ResponseEntity.badRequest().body(mapOf("error" to "invalid_sort") as Any)
            val (field, dir) = parsed
            q = q.orderBy(AuthTable.columns.first { it.name == field } to dir)
        }
        val rows = q.limit(limit ?: 50, (offset ?: 0).toLong()).map { rowToAuth(it) }
        ResponseEntity.ok(rows as Any)
    }

    @GetMapping("/priorauth/{id}")
    fun getPriorAuth(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val row = AuthTable.selectAll().where { (AuthTable.id eq id) and (AuthTable.type eq AuthType.PriorAuth) }.singleOrNull()
            ?: return@transaction ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        ResponseEntity.ok(rowToAuth(row) as Any)
    }

    @PostMapping("/priorauth")
    fun createPriorAuth(@RequestBody dto: Auth): ResponseEntity<Auth> = transaction {
        val newId = AuthTable.insert {
            it[type] = AuthType.PriorAuth
            it[reference] = dto.reference!!
            it[quantity] = dto.quantity
            it[copayAmount] = dto.copayAmount
            it[priorAuthNumber] = dto.priorAuthNumber
        }[AuthTable.id]
        val saved = AuthTable.selectAll().where { AuthTable.id eq newId }.single()
        ResponseEntity.status(HttpStatus.CREATED).body(rowToAuth(saved))
    }

    @RequestMapping(value = ["/priorauth/{id}"], method = [RequestMethod.PATCH, RequestMethod.PUT])
    fun updatePriorAuth(@PathVariable id: Long, @RequestBody dto: Auth): ResponseEntity<Any> = transaction {
        val updated = AuthTable.update({ (AuthTable.id eq id) and (AuthTable.type eq AuthType.PriorAuth) }) {
            if (dto.reference != null) it[reference] = dto.reference
            if (dto.quantity != null) it[quantity] = dto.quantity
            if (dto.copayAmount != null) it[copayAmount] = dto.copayAmount
            if (dto.priorAuthNumber != null) it[priorAuthNumber] = dto.priorAuthNumber
        }
        if (updated == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else {
            val row = AuthTable.selectAll().where { (AuthTable.id eq id) and (AuthTable.type eq AuthType.PriorAuth) }.single()
            ResponseEntity.ok(rowToAuth(row) as Any)
        }
    }

    @DeleteMapping("/priorauth/{id}")
    fun deletePriorAuth(@PathVariable id: Long): ResponseEntity<Any> = transaction {
        val deleted = AuthTable.deleteWhere { with(SqlExpressionBuilder) { (AuthTable.id eq id) and (AuthTable.type eq AuthType.PriorAuth) } }
        if (deleted == 0) ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "not_found") as Any)
        else ResponseEntity.noContent().build<Any>()
    }

}

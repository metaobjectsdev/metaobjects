package acme.blog

import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.ResultRow
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
    ): ResponseEntity<Any> = transaction {
        var q = AuthorTable.selectAll()
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

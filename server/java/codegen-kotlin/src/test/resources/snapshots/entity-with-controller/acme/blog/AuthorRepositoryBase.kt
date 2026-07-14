package acme.blog

import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SqlExpressionBuilder
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.statements.UpdateStatement
import org.jetbrains.exposed.sql.update
import org.jetbrains.exposed.sql.transactions.transaction

/**
 * GENERATED — persistence repository base for Author. Do not hand-edit.
 *
 * `open` so a consumer can subclass and override; NOT `@Repository` (a subclass
 * would create an ambiguous bean — wiring is the consumer's, per FR-035 §8.2).
 */
open class AuthorRepositoryBase {

    /** Map an Exposed ResultRow to the Author data class. */
    open fun rowToAuthor(row: ResultRow): Author = Author(
        id = row[AuthorTable.id],
        name = row[AuthorTable.name],
    )

    /** The Author with this primary key, or null. */
    open fun findById(id: Long): Author? = transaction {
        AuthorTable.selectAll().where { AuthorTable.id eq id }.singleOrNull()?.let(::rowToAuthor)
    }

    /** Insert a Author and return it with the persisted primary key. */
    open fun insert(dto: Author): Author = transaction {
        val newId = AuthorTable.insert {
            it[AuthorTable.name] = dto.name
        }[AuthorTable.id]
        AuthorTable.selectAll().where { AuthorTable.id eq newId }.single().let(::rowToAuthor)
    }

    /** Overwrite every column of the row (present-non-null merge). Null if no such row. */
    open fun update(id: Long, dto: Author): Author? = transaction {
        val n = AuthorTable.update({ AuthorTable.id eq id }) {
            it[AuthorTable.name] = dto.name
        }
        if (n == 0) null else AuthorTable.selectAll().where { AuthorTable.id eq id }.single().let(::rowToAuthor)
    }

    /**
     * Partial update — the block sets only the columns it names, e.g.
     * `repo.patch(id) { it[AuthorTable.<col>] = value }`. A renamed or dropped column is a
     * COMPILE error, not a silently skipped write. Null if no such row.
     */
    open fun patch(id: Long, block: AuthorTable.(UpdateStatement) -> Unit): Author? = transaction {
        val n = AuthorTable.update({ AuthorTable.id eq id }, body = block)
        if (n == 0) null else AuthorTable.selectAll().where { AuthorTable.id eq id }.single().let(::rowToAuthor)
    }

    /** Delete by primary key; true if a row was removed. */
    open fun delete(id: Long): Boolean = transaction {
        AuthorTable.deleteWhere { with(SqlExpressionBuilder) { AuthorTable.id eq id } } > 0
    }
}

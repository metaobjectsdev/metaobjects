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
 * GENERATED — persistence repository base for Post. Do not hand-edit.
 *
 * `open` so a consumer can subclass and override; NOT `@Repository` (a subclass
 * would create an ambiguous bean — wiring is the consumer's, per FR-035 §8.2).
 */
open class PostRepositoryBase {

    /** Map an Exposed ResultRow to the Post data class. */
    open fun rowToPost(row: ResultRow): Post = Post(
        id = row[PostTable.id],
        title = row[PostTable.title],
    )

    /** The Post with this primary key, or null. */
    open fun findById(id: Long): Post? = transaction {
        PostTable.selectAll().where { PostTable.id eq id }.singleOrNull()?.let(::rowToPost)
    }

    /** Insert a Post and return it with the persisted primary key. */
    open fun insert(dto: Post): Post = transaction {
        val newId = PostTable.insert {
            it[PostTable.title] = dto.title
        }[PostTable.id]
        PostTable.selectAll().where { PostTable.id eq newId }.single().let(::rowToPost)
    }

    /** Overwrite every column of the row (present-non-null merge). Null if no such row. */
    open fun update(id: Long, dto: Post): Post? = transaction {
        val n = PostTable.update({ PostTable.id eq id }) {
            if (dto.title != null) it[PostTable.title] = dto.title
        }
        if (n == 0) null else PostTable.selectAll().where { PostTable.id eq id }.single().let(::rowToPost)
    }

    /**
     * Partial update — the block sets only the columns it names, e.g.
     * `repo.patch(id) { it[PostTable.<col>] = value }`. A renamed or dropped column is a
     * COMPILE error, not a silently skipped write. Null if no such row.
     */
    open fun patch(id: Long, block: PostTable.(UpdateStatement) -> Unit): Post? = transaction {
        val n = PostTable.update({ PostTable.id eq id }, body = block)
        if (n == 0) null else PostTable.selectAll().where { PostTable.id eq id }.single().let(::rowToPost)
    }

    /** Delete by primary key; true if a row was removed. */
    open fun delete(id: Long): Boolean = transaction {
        PostTable.deleteWhere { with(SqlExpressionBuilder) { PostTable.id eq id } } > 0
    }
}

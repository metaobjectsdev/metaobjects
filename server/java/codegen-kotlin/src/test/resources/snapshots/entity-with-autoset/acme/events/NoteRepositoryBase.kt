package acme.events

import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SqlExpressionBuilder
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.statements.UpdateStatement
import org.jetbrains.exposed.sql.update
import org.jetbrains.exposed.sql.transactions.transaction

/**
 * GENERATED — persistence repository base for Note. Do not hand-edit.
 *
 * `open` so a consumer can subclass and override; NOT `@Repository` (a subclass
 * would create an ambiguous bean — wiring is the consumer's, per FR-035 §8.2).
 */
open class NoteRepositoryBase {

    /** Map an Exposed ResultRow to the Note data class. */
    open fun rowToNote(row: ResultRow): Note = Note(
        id = row[NoteTable.id],
        title = row[NoteTable.title],
        body = row[NoteTable.body],
    )

    /** The Note with this primary key, or null. */
    open fun findById(id: Long): Note? = transaction {
        NoteTable.selectAll().where { NoteTable.id eq id }.singleOrNull()?.let(::rowToNote)
    }

    /** Insert a Note and return it with the persisted primary key. */
    open fun insert(dto: Note): Note = transaction {
        val newId = NoteTable.insert {
            it[NoteTable.title] = dto.title
            it[NoteTable.body] = dto.body
        }[NoteTable.id]
        NoteTable.selectAll().where { NoteTable.id eq newId }.single().let(::rowToNote)
    }

    /** Overwrite every column of the row (present-non-null merge). Null if no such row. */
    open fun update(id: Long, dto: Note): Note? = transaction {
        val n = NoteTable.update({ NoteTable.id eq id }) {
            it[NoteTable.title] = dto.title
            if (dto.body != null) it[NoteTable.body] = dto.body
        }
        if (n == 0) null else NoteTable.selectAll().where { NoteTable.id eq id }.single().let(::rowToNote)
    }

    /**
     * Partial update — the block sets only the columns it names, e.g.
     * `repo.patch(id) { it[NoteTable.<col>] = value }`. A renamed or dropped column is a
     * COMPILE error, not a silently skipped write. Null if no such row.
     */
    open fun patch(id: Long, block: NoteTable.(UpdateStatement) -> Unit): Note? = transaction {
        val n = NoteTable.update({ NoteTable.id eq id }, body = block)
        if (n == 0) null else NoteTable.selectAll().where { NoteTable.id eq id }.single().let(::rowToNote)
    }

    /** Delete by primary key; true if a row was removed. */
    open fun delete(id: Long): Boolean = transaction {
        NoteTable.deleteWhere { with(SqlExpressionBuilder) { NoteTable.id eq id } } > 0
    }
}

package acme.events

import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SqlExpressionBuilder
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.statements.UpdateBuilder
import org.jetbrains.exposed.sql.statements.UpdateStatement
import org.jetbrains.exposed.sql.update
import org.jetbrains.exposed.sql.transactions.transaction

/**
 * GENERATED — persistence repository base for Event. Do not hand-edit.
 *
 * `open` so a consumer can subclass and override; NOT `@Repository` (a subclass
 * would create an ambiguous bean — wiring is the consumer's, per FR-035 §8.2).
 */
open class EventRepositoryBase {

    /** Map an Exposed ResultRow to the Event data class. */
    open fun rowToEvent(row: ResultRow): Event = Event(
        id = row[EventTable.id],
        name = row[EventTable.name],
        createdAt = row[EventTable.createdAt],
        updatedAt = row[EventTable.updatedAt],
    )

    /** The Event with this primary key, or null. */
    open fun findById(id: Long): Event? = transaction {
        EventTable.selectAll().where { EventTable.id eq id }.singleOrNull()?.let(::rowToEvent)
    }

    /**
     * Write the `@autoSet` timestamp columns of Event into an insert/update builder
     * (the CRUD layer owns them — the caller does not supply them). ONE column-list
     * definition shared by insert / insertPreserving / update / patch:
     *  - `stampAutoSet` — stamp `now()` (base CRUD) vs. write the [dto] value verbatim
     *    (insertPreserving, for import/restore/replication that keep original timestamps);
     *  - `includeOnCreate` — write the write-once onCreate columns (insert) or skip them
     *    (update/patch never rewrite created_at — the latent lost-update bug otherwise).
     * [dto] is only read on the verbatim path, so the stamping callers pass null.
     * `now()` is keyed off each COLUMN's temporal type, so it generalizes beyond Instant.
     */
    protected open fun applyAutoSetColumns(
        stmt: UpdateBuilder<*>,
        dto: Event? = null,
        stampAutoSet: Boolean = true,
        includeOnCreate: Boolean = true,
    ) {
        if (includeOnCreate) {
            stmt[EventTable.createdAt] = if (stampAutoSet) java.time.Instant.now() else dto!!.createdAt
        }
        stmt[EventTable.updatedAt] = if (stampAutoSet) java.time.Instant.now() else dto!!.updatedAt
    }

    /** Insert a Event and return it with the persisted primary key. */
    open fun insert(dto: Event): Event = transaction {
        val newId = EventTable.insert {
            it[EventTable.name] = dto.name
            applyAutoSetColumns(it)
        }[EventTable.id]
        EventTable.selectAll().where { EventTable.id eq newId }.single().let(::rowToEvent)
    }

    /**
     * Insert a Event writing its `@autoSet` timestamp columns VERBATIM from the dto
     * instead of stamping `now()` — the import / restore / replication escape hatch that
     * must keep the original timestamps. Primary-key handling matches [insert].
     */
    open fun insertPreserving(dto: Event): Event = transaction {
        val newId = EventTable.insert {
            it[EventTable.name] = dto.name
            applyAutoSetColumns(it, dto, stampAutoSet = false)
        }[EventTable.id]
        EventTable.selectAll().where { EventTable.id eq newId }.single().let(::rowToEvent)
    }

    /** Overwrite every column of the row (present-non-null merge). Null if no such row. */
    open fun update(id: Long, dto: Event): Event? = transaction {
        val n = EventTable.update({ EventTable.id eq id }) {
            it[EventTable.name] = dto.name
            applyAutoSetColumns(it, includeOnCreate = false)
        }
        if (n == 0) null else EventTable.selectAll().where { EventTable.id eq id }.single().let(::rowToEvent)
    }

    /**
     * Partial update — the block sets only the columns it names, e.g.
     * `repo.patch(id) { it[EventTable.<col>] = value }`. A renamed or dropped column is a
     * COMPILE error, not a silently skipped write. Null if no such row.
     * `@autoSet` onUpdate columns are stamped BEFORE the block runs, so a partial
     * update still bumps them even if the block does not name them (#203).
     */
    open fun patch(id: Long, block: EventTable.(UpdateStatement) -> Unit): Event? = transaction {
        val n = EventTable.update({ EventTable.id eq id }) {
            applyAutoSetColumns(it, includeOnCreate = false)
            this.block(it)
        }
        if (n == 0) null else EventTable.selectAll().where { EventTable.id eq id }.single().let(::rowToEvent)
    }

    /** Delete by primary key; true if a row was removed. */
    open fun delete(id: Long): Boolean = transaction {
        EventTable.deleteWhere { with(SqlExpressionBuilder) { EventTable.id eq id } } > 0
    }
}

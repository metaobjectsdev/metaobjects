package acme.auth

import org.jetbrains.exposed.sql.Query
import org.jetbrains.exposed.sql.selectAll

/** GENERATED — extension fns for `Auth` to-many relationships. Do not hand-edit. */
/** Query `Auth.lines` (cardinality=many) on the AuthLine side. */
fun AuthTable.linesQuery(authId: Long): Query =
    AuthLineTable.selectAll().where { AuthLineTable.authId eq authId }

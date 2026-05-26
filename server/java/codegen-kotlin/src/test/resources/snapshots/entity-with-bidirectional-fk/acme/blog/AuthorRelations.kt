package acme.blog

import org.jetbrains.exposed.sql.Query
import org.jetbrains.exposed.sql.selectAll

/** GENERATED — extension fns for `Author` to-many relationships. Do not hand-edit. */
/** Query `Author.posts` (cardinality=many) on the Post side. */
fun AuthorTable.postsQuery(authorId: Long): Query =
    PostTable.selectAll().where { PostTable.authorId eq authorId }

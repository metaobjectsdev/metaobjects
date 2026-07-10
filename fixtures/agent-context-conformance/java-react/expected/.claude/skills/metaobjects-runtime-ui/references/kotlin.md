# Kotlin server runtime

The Kotlin port runtime is **generated Exposed `Table` objects plus your own
JetBrains Exposed transactions** — there is no Kotlin-specific persistence engine.
`KotlinExposedTableGenerator` emits one `<Entity>Table.kt` per entity with a
`source.rdb`; you hand-write the (trivial) transaction bodies, since the table
column definitions and the generated `data class` entity are both generated
from the same metadata.

(If you want a fully metadata-driven engine instead of hand-written Exposed, the
Java **OMDB** runtime — `metaobjects-omdb`, `ObjectManagerDB` — is on the JVM and
callable from Kotlin; see the Java runtime reference. OMDB is pure data-access:
CRUD / query / codec / transactions. Schema is owned by the Node `meta` migration
tool, not the runtime.)

## The generated table

For an `Author` entity, `KotlinEntityGenerator` + `KotlinExposedTableGenerator`
emit a data class and an Exposed `Table`:

```kotlin
// generated/acme/blog/Author.kt
data class Author(
    val id: Long,
    val name: String,
    val bio: String? = null,
)

// generated/acme/blog/AuthorTable.kt
object AuthorTable : Table("authors") {
    val id   = long("id").autoIncrement()
    val name = varchar("name", 200)
    val bio  = varchar("bio", 2000).nullable()
    override val primaryKey = PrimaryKey(id)
}
```

## Query + persist with Exposed

Obtain a `Database` (the generated `MetadataExposedConfig` `@Configuration` calls
`Database.connect(...)` for you, or do it yourself), then wrap reads/writes in
`transaction(db) { ... }`:

```kotlin
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.transactions.transaction

@Service
class AuthorService(private val db: Database) {
    fun list(): List<Author> = transaction(db) {
        AuthorTable.selectAll().map {
            Author(
                id   = it[AuthorTable.id],
                name = it[AuthorTable.name],
                bio  = it[AuthorTable.bio],
            )
        }
    }

    fun create(name: String, bio: String? = null): Long = transaction(db) {
        AuthorTable.insert {
            it[AuthorTable.name] = name
            it[AuthorTable.bio]  = bio
        } get AuthorTable.id
    }
}
```

Filtered reads use Exposed's `selectAll()` plus a `where { ... }` op tree (e.g.
`AuthorTable.selectAll().where { AuthorTable.name eq someName }`), exactly as the
`integration-tests-kotlin` query-conformance runner does against Testcontainers
Postgres.

## Return-type contract

An Exposed read yields **native in-process Kotlin/JVM types** at the column, never
wire strings — this is verified by the port's runtime-return-type test:

- `field.decimal` (NUMERIC) → `java.math.BigDecimal` — exact, lossless, no float
  round-tripping.
- `field.long` → `Long`; other scalars to their native Kotlin types.
- a `timestamp`-with-tz field → `java.time.Instant` (the metaobjects
  `instantWithTimeZone` `Column<Instant>` path — native temporal, not a String).

Wire canonicalization (currency → integer minor units as `Long`, temporals →
ISO-8601, UUID → canonical hex) happens only when a row leaves over HTTP — at the
serialization boundary in your Spring controller — never inside the query path.
Compute with `BigDecimal`/`Instant` in-process; let the HTTP layer encode.

## Serving the REST contract

`KotlinSpringControllerGenerator` emits `<Entity>Controller.kt` per writable entity
(`source.rdb` `@kind="table"`) as a Spring `@RestController` on the cross-port REST
contract (five CRUD endpoints, `?sort`, `?limit`/`?offset`, `?withCount=1`
envelope). The same universal TS/Angular web client consumes those controllers
unchanged — the wire format matches the C# and Java backends byte-for-byte.

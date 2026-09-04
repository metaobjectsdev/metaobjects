# Python server runtime

The Python runtime tier is the **`metaobjects.runtime.ObjectManager`** — a
metadata-driven query/CRUD engine that reads the same metadata at runtime and drives
persistence with no per-entity ORM boilerplate. It is the cross-port analog of Java's
OMDB: a method-based API (`find_by_id` / `find_many` / `count` / `create` / `update` /
`delete` / `relate`) that compiles a Filter dict to parameterized SQL and runs it via a
pluggable driver. It is **pure data-access** (CRUD / query / codec); schema is owned by
the Node `meta` migration tool, not the runtime.

## Construct an `ObjectManager`

`ObjectManager(root, driver)` takes a loaded metadata `root` plus a `PostgresDriver`
wrapping any DB-API 2 connection (pg8000 / psycopg):

```python
import pg8000
from metaobjects import load_directory
from metaobjects.runtime import ObjectManager, PostgresDriver

result = load_directory("metaobjects")     # same canonical JSON every port reads
conn = pg8000.connect(...)                 # any DB-API 2 connection
om = ObjectManager(result.root, PostgresDriver(conn))
```

## CRUD + query

Rows come back as **plain dicts keyed by metadata field name**, values native (see
below). Write calls take a field-keyed dict of values in their native authoring forms;
the write codec coerces each to the native Python type the driver binds:

```python
# Create — returns the inserted row (incl. any server-generated PK) via RETURNING
author = om.create("Author", {"name": "Ada"})

# Read
one  = om.find_by_id("Author", author["id"])
rows = om.find_many("Author", {"name": {"like": "Ada%"}},
                    sort=[("createdAt", "desc")], limit=25, offset=0)
n    = om.count("Author", {"name": {"eq": "Ada"}})

# Update (partial, by PK) / Delete
om.update("Author", author["id"], {"name": "Ada Lovelace"})   # None if no row matched
om.delete("Author", author["id"])                             # bool
```

`create()` stamps `@autoSet` timestamps (`createdAt` / `updatedAt`) with a shared `now()`,
**overriding** any caller-supplied value, and `update()` strips `onCreate`-only columns. For
a data import/restore that must preserve original timestamps, use `insert_preserving()` (#203).

The Filter dict is `{field: value}` (equality shortcut), `{field: {op: value}}` (typed
ops), or `{"and": [filter, ...]}` (combinator). The operator set is the closed cross-port
nine — `eq` `ne` `gt` `gte` `lt` `lte` `in` `like` `isNull`. `relate()` traverses an M:N
relationship from a source record to its related rows (hetero / directed / symmetric
self-joins), resolved generically from the junction's `identity.reference` children.

## Return-type contract

`ObjectManager` returns **native in-process Python types**, never wire strings (ADR-0019),
verified by the port's runtime-return-type test:

- `field.decimal` → `decimal.Decimal` — exact, **lossless end-to-end**, never via float.
- temporal fields → native `datetime` / `date` / `time`.
- `field.object` / jsonb → a native `dict` (pg8000 decodes jsonb).
- `field.uuid` → `uuid.UUID`; `field.currency` → a native `int` (integer minor units).

Wire canonicalization (currency → integer minor units, temporals → ISO-8601, UUID →
canonical hex) happens only at the serialization boundary, never inside the query path.
Compute with `Decimal` in-process; let the encoding layer emit the wire form. Currency is
integer minor units on the wire; the runtime never formats — formatting is client-side in
the universal (TS/Angular) web client. (Port-specific note: because pg8000 returns a plain
`int` for both INTEGER and BIGINT, `ObjectManager` exposes each query's per-column Postgres
OIDs via `last_column_oids` so the **canonical serializer** — the persistence-conformance
boundary — can apply the cross-port BIGINT→string rule. The generated FastAPI router serves
`field.long` as a JSON number, and the row *values* always stay native.)

## Serving the REST contract

The `routes` generator (run via `metaobjects gen`) emits a **FastAPI `APIRouter`** per
writable entity (`source.rdb @kind="table"`) on the cross-port REST contract (five CRUD
endpoints, `?filter[field][op]=`, `?sort=field:asc`, `?limit`/`?offset`, `?withCount=1`
envelope, 400/404 envelopes). Each router declares a repository **`Protocol`** you
implement and inject via FastAPI's `app.dependency_overrides` — back it with
`ObjectManager`, or your own SQLAlchemy Core / asyncpg code. There is **no** generated
`main.py`; create one and mount the routers (`app.include_router(...)`). The same
universal TS/Angular web client consumes those routes unchanged.

Two shape notes (do **not** hand-edit generated files around them): the generated router
assumes a **single-field** PK (a composite PK takes `@fields[0]`), and the PK's type is
**derived from its field subtype** — a `field.uuid` PK binds `uuid.UUID` on the route and
Protocol, not `int`. The PATCH body is typed `dict[str, Any]` **deliberately**: the generated
`<Entity>Create` / `<Entity>Patch` Pydantic models already validate constraints over HTTP
(FR-036), and the `dict` seam preserves the FR-035 present-key PATCH tristate (absent ≠
explicit-null) — retyping the PATCH parameter to the model would collapse that tristate.

## Physical names in your repository implementation

`ObjectManager` calls key by field name (`om.find_many("Author", {"name": …})`) and
resolve the column themselves, so that path never needs a physical name. The moment the
repository `Protocol` is backed by your own SQLAlchemy Core / asyncpg / psycopg code, it
does — and nothing Python generates carries one: the Pydantic models, create/patch
shapes, router and allowlist all key by field. Take it from the generated
`<entity_snake>_names.py` (`names` is in the default suite):

```python
from generated.author_names import AUTHOR_NAME, AUTHOR_CREATED_AT_COLUMN, AUTHOR_ID_COLUMN

row = await conn.fetchrow(
    f"SELECT {AUTHOR_CREATED_AT_COLUMN} FROM {AUTHOR_NAME} WHERE {AUTHOR_ID_COLUMN} = $1",
    author_id,
)
```

There is no typed handle to prefer on this port, so this is never the wrong choice here.
Pass the same `--column-naming` to `metaobjects gen` that you pass as `column_naming=` to
`ObjectManager` (both default to `literal`), or the constant names a column no row lands in.

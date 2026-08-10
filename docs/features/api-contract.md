# Cross-port REST API contract

The browser-side TypeScript client (`@metaobjectsdev/runtime-web` +
`@metaobjectsdev/react` + `@metaobjectsdev/tanstack`) is **universal**: it
ships with the React + TanStack runtime and the generated query hooks +
column defs, but it makes **no assumption about which language wrote the
backend**. Any HTTP server — TypeScript Fastify, Java Spring, Kotlin Spring,
C# ASP.NET, Python FastAPI — that speaks the URL grammar and JSON wire
format on this page can serve the same React app, with the same generated
hooks and grids.

This page is the contract. Implementations that pass it interoperate with
the TS client; implementations that don't, don't.

Throughout the doc the worked example is an `Author` entity in the
`acme::blog` package.

## What this is

The contract has two halves: the **URL grammar** (paths + query-string
shape) and the **wire format** (JSON request / response bodies). Both
halves are language-agnostic and stable across all five shipped
language ports. Every port ships a generated route implementation today
(see "Per-port route codegen status" below) — hand-writing a controller
is an option for custom needs, not the default path.

## The `EntityFetcher` contract

The browser client never calls `fetch` directly. Every generated hook
delegates to a single `EntityFetcher` function pulled from React
context:

```ts
// from @metaobjectsdev/runtime-web
export type EntityFetcher = <T>(path: string, init?: RequestInit) => Promise<T>;
```

Responsibilities of the fetcher (supplied by the consumer's app, not
generated):

- Resolve the `path` argument (always starts with `apiPrefix`, e.g.
  `/api/author?...`) to a fully-qualified URL.
- Attach auth (cookies / bearer token / API key) per the app's policy.
- Parse the JSON response and return it typed as `T`.
- Surface non-2xx as a thrown `Error` (hooks rely on this for React Query's
  `error` state).

The fetcher is supplied once via `<EntityFetcherProvider value={fetcher}>`
at the React tree root; every generated hook reads it via
`useEntityFetcher()` from `@metaobjectsdev/tanstack`.

## URL grammar

These are the routes a generated TanStack hook calls. The `apiPrefix`
prefix (default `/api`) is set in `metaobjects.config.ts` and is
**baked into the generated entity-constants file** as `$apiPrefix`, so the
client and server agree on it without runtime configuration.

### Routes per entity

| Verb | Path | Purpose |
|---|---|---|
| `GET`    | `/<apiPrefix>/<entity>?filter[...][...]=...&sort=...&limit=N&offset=N&withCount=1` | List (with filter / sort / pagination) |
| `GET`    | `/<apiPrefix>/<entity>/:id` | Get by id |
| `POST`   | `/<apiPrefix>/<entity>` | Create |
| `PATCH`  | `/<apiPrefix>/<entity>/:id` | Update (partial) |
| `PUT`    | `/<apiPrefix>/<entity>/:id` | Update (replace) — optional; same body shape as `PATCH` |
| `DELETE` | `/<apiPrefix>/<entity>/:id` | Delete |

`<entity>` is lowercased + pluralized per the codegen's pluralization
helper (so `Author` → `authors`). Generated TS hooks read `$path` from
the entity-constants file, so the client and the server agree on the
path segment without hand-coordination.

### Filter operators (9)

Filters use a **bracketed qs** shape: `filter[<field>][<op>]=<value>`.
A bare value (`filter[<field>]=<value>`) is sugar for `eq`. Multiple
filters AND together.

> **`filter[or]` / `filter[and]` nesting is a TS-only extension**, not part of
> the cross-port contract — see "TS-only filter extensions" below.

| Operator | Strings | Numbers / Dates | Booleans |
|---|---|---|---|
| `eq`, `ne`, `isNull` | yes | yes | yes (eq + isNull only) |
| `in`, `like` | yes | `in` only | – |
| `gt`, `gte`, `lt`, `lte` | – | yes | – |

The operator set is gated by field subtype in the generated
`<Entity>FilterAllowlist`. A request with an operator that the field
subtype doesn't support → HTTP 400. The operator list is a Tier 1
cross-port invariant — every port's parser must implement these nine
and only these nine.

**`like` is case-SENSITIVE SQL LIKE**
([ADR-0047](../../spec/decisions/ADR-0047-filter-like-is-case-sensitive-sql-like.md)):
the author-supplied pattern binds verbatim — `%` (any run) and `_` (any
single character) are the only wildcards, there is no `%`-wrapping and no
case folding — identically on every port and every engine. Engines whose
native LIKE is not case-sensitive are lowered around, not deferred to: on
SQLite/D1 (whose built-in LIKE folds ASCII case) the TS runtime lowers
`like` to GLOB with an exactly-translated pattern. Case-insensitive
matching is deliberately NOT in the operator vocabulary (FR-009 §7 /
ADR-0036 reserve `ilike` as a future additive operator, gated on real
consumer demand); until then, normalize case in the data or the pattern —
or use the TS-only `?search` extension, which IS case-insensitive.

### TS-only filter extensions (not part of the cross-port contract)

The TypeScript runtime parser ships five filter behaviors beyond the nine
operators. They are **NOT part of the cross-port REST contract** — the other
ports (Java, Kotlin, Python, C#) do not implement them, and a relying adopter
must not assume them on a non-TS backend. They are deliberately deferred until
real consumer demand (none touch the metamodel vocabulary, so any of them can be
added cross-port later as a purely additive, non-breaking change):

| Extension | What it does |
|---|---|
| `?search=<term>` | ORs a case-INSENSITIVE substring match (`%term%`) across the entity's `@filterable` string fields — deliberately looser than the case-sensitive `like` operator (it is a human search box; ILIKE on Postgres, native LIKE on SQLite) |
| `filter[or][N]` / `filter[and][N]` | boolean combinators (recursive nesting) |
| leading-wildcard gating | opt-in allow of `like` patterns starting with `%` |
| filter nesting-depth cap | rejects deeply-nested `or`/`and` (tied to the combinators) |

The **`in`-list size cap** (reject an `in` list longer than 100 → HTTP 400) is a
safety limit, not a feature — TS enforces it, the other ports currently do not.
Unifying that cap cross-port is the one item here worth doing regardless of
feature demand (it is a consistency/safety divergence, not a capability).

### Sort + pagination

- `sort=<field>:asc|desc` — single sort key (multi-sort not in the
  default contract). Field must appear in `<Entity>SortAllowlist`.
- `limit=N` — page size.
- `offset=N` — page offset.
- `withCount=1` — opt-in flag that switches the list response from
  `[<row>...]` to `{ rows: [<row>...], total: <N> }` (needed for grid
  pagination). The grid hook always sends `withCount=1`.

### `apiPrefix` policy

`apiPrefix` in `metaobjects.config.ts` flows through codegen to **both**
sides: the generated server routes mount under it, and the generated
client hooks bake it into their fetch URLs via `$apiPrefix` on the
entity-constants file.

```ts
export default defineConfig({
  apiPrefix: "/api",     // server mounts /api/author; hooks call /api/author
});
```

## Wire format

### Encoding

- **JSON** for all request and response bodies (`application/json;
  charset=utf-8`).
- No envelope on single-row responses (`GET /:id`, `POST`, `PATCH`, `PUT`)
  — the body is the row.
- List responses are either `[<row>...]` (default) or
  `{ rows, total }` (when `withCount=1`).

### Type encodings (Tier 1 invariant)

| Metadata field type | JSON type | Notes |
|---|---|---|
| `field.string`, `field.uuid`, `field.enum` | string | UUID is canonical hex (`8-4-4-4-12`). |
| `field.int`, `field.long`, `field.double` | number | `long` MAY be string on overflow; defer to per-port docs. |
| `field.boolean` | boolean | – |
| `field.date` | string | ISO 8601 calendar date (`YYYY-MM-DD`). |
| `field.timestamp` | string | ISO 8601 with timezone (`YYYY-MM-DDTHH:mm:ss.sssZ`). |
| `field.currency` | **integer minor units** | Cents for USD, yen for JPY. Float arithmetic is forbidden. Server never formats. |
| `field.object` (`@storage: jsonb`) | object | Nested per the sub-object schema. |
| `field.object` (`@storage: flattened`) | object | Same JSON shape — only the storage differs. |

The currency invariant is the load-bearing one: every port emits and
expects integer minor units on the wire, and the
[`features/field-types.md`](field-types.md) reference enforces this for
each port's codegen output. Float arithmetic for money has bitten
every language at least once.

### Error response

Non-2xx responses MUST return:

```json
{ "error": "<short_code>", "message": "<optional human string>" }
```

- HTTP 400 — validation / filter-parser errors (`{ "error": "validation", "issues": [...] }`
  in TS; `{ "error": "FILTER_UNKNOWN_FIELD", ... }` for filter
  errors).
- HTTP 404 — `{ "error": "not_found" }`.
- HTTP 5xx — implementation-defined.

The exact `error` code vocabulary is not yet a hard cross-port
invariant; consumers should treat any 4xx as user-facing and any 5xx as
retryable / log-only.

## Per-port route codegen status

| Port | Route codegen | Notes |
|---|---|---|
| TypeScript | shipped — `@metaobjectsdev/codegen-ts` `routesFile()` → Fastify (`@metaobjectsdev/runtime-ts/drizzle-fastify`) AND `routesFileHono()` → Hono (`@metaobjectsdev/runtime-ts/hono`) | Reference implementation; full filter/sort + `withCount` support. Both flavors emit byte-identical on-the-wire responses for the same metadata (same envelopes, same status codes, same filter operator parser), so consumers can pick the server framework that matches their runtime (Fastify for long-lived Node, Hono for Workers / Bun / edge). |
| C# | shipped — `MetaObjects.Codegen` `RoutesGenerator` → ASP.NET Minimal API | `MapGet` / `MapPost` / `MapPut` / `MapDelete` mounted under `apiPrefix`; full CRUD. |
| Java | shipped — `metaobjects-codegen-spring` `SpringControllerGenerator` + `SpringDtoGenerator` + `SpringRepositoryGenerator` → Spring `@RestController` (Spring Boot 3.x / Spring Web MVC) | One controller per writable entity (`source.rdb @kind="table"`); 5 CRUD endpoints (GET list / GET by id / POST / PATCH + PUT / DELETE); `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Java 21 record DTOs for request/response; a stubbed `<Entity>Repository` interface the consumer implements against their persistence layer (JPA / jOOQ / JDBC). Filter operators (`eq/ne/gt/gte/lt/lte/in/like/isNull`) ship via the generated `<Entity>FilterAllowlist` (`SpringFilterAllowlistGenerator`) + the runtime `FilterParser`, wired directly into the list handler. |
| Kotlin | shipped — `metaobjects-codegen-kotlin` `KotlinSpringControllerGenerator` → Spring `@RestController` | One controller per writable entity (`source.rdb @kind="table"`); 5 CRUD endpoints (GET list / GET by id / POST / PATCH+PUT / DELETE); `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Filter operators ship via the generated `<Entity>FilterAllowlist` (`KotlinFilterAllowlistGenerator`) + an inline `parse<Entity>Filter` helper emitted in the controller. |
| Python | shipped — `metaobjects.codegen.generators.router_generator` → FastAPI `APIRouter` | One router per writable entity (`source.rdb @kind="table"`); 5 CRUD endpoints (GET list / GET by id / POST / PATCH+PUT / DELETE); `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Consumer wires the repository via FastAPI `app.dependency_overrides`; the generator emits a `Protocol` interface so the persistence layer (SQLAlchemy / asyncpg / etc.) is the consumer's choice. Filter operators ship via the generated `<entity>_filter_allowlist.py` (`filter_allowlist_generator.py`) + the shared `filter_parser` helper, wired into the list handler. |

## Hand-writing a conforming controller (if you outgrow the generated one)

Every port ships a route generator today (see the status table above) —
you do not need to hand-write a controller to get a conforming API. This
section is for the rare case where you need a shape the generator
doesn't cover (a custom auth scheme, a framework the generator doesn't
target, etc.) and want a hand-rolled controller that still speaks the
contract. The shape is the same in every language — mount five (or six,
if you want PUT) routes under `apiPrefix` that match the URL grammar
above.

### Java — Spring `@RestController`

```java
// AuthorController.java
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/authors")
public class AuthorController {
  private final AuthorRepository repo;

  public AuthorController(AuthorRepository repo) { this.repo = repo; }

  @GetMapping
  public Object list(@RequestParam Map<String, String> qs) {
    var page = repo.find(FilterParser.parse(qs, AuthorFilterAllowlist.INSTANCE));
    return qs.containsKey("withCount")
      ? Map.of("rows", page.rows(), "total", page.total())
      : page.rows();
  }

  @GetMapping("/{id}")           public Author get(@PathVariable long id)              { return repo.findById(id).orElseThrow(() -> new NotFound()); }
  @PostMapping                   public ResponseEntity<Author> create(@RequestBody AuthorInsert in) { return ResponseEntity.status(201).body(repo.insert(in)); }
  @PatchMapping("/{id}")         public Author update(@PathVariable long id, @RequestBody AuthorUpdate in) { return repo.update(id, in); }
  @DeleteMapping("/{id}")        public ResponseEntity<Void> delete(@PathVariable long id) { repo.delete(id); return ResponseEntity.noContent().build(); }
}
```

### Kotlin — Spring `@RestController`

```kotlin
// AuthorController.kt
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/authors")
class AuthorController(private val repo: AuthorRepository) {

  @GetMapping
  fun list(@RequestParam qs: Map<String, String>): Any {
    val page = repo.find(FilterParser.parse(qs, AuthorFilterAllowlist))
    return if ("withCount" in qs) mapOf("rows" to page.rows, "total" to page.total) else page.rows
  }

  @GetMapping("/{id}")           fun get(@PathVariable id: Long): Author          = repo.findById(id) ?: throw NotFound()
  @PostMapping                   fun create(@RequestBody input: AuthorInsert): ResponseEntity<Author> = ResponseEntity.status(201).body(repo.insert(input))
  @PatchMapping("/{id}")         fun update(@PathVariable id: Long, @RequestBody input: AuthorUpdate): Author = repo.update(id, input)
  @DeleteMapping("/{id}")        fun delete(@PathVariable id: Long): ResponseEntity<Void> { repo.delete(id); return ResponseEntity.noContent().build() }
}
```

### Python — FastAPI router

```python
# author_router.py
from fastapi import APIRouter, HTTPException, Request, status
from .author import Author, AuthorInsert, AuthorUpdate, AuthorFilterAllowlist
from .repo import AuthorRepository
from .filter_parser import parse_filter_qs

router = APIRouter(prefix="/api/authors")
repo = AuthorRepository()

@router.get("")
async def list_authors(request: Request):
    qs = dict(request.query_params)
    page = repo.find(parse_filter_qs(qs, AuthorFilterAllowlist))
    return {"rows": page.rows, "total": page.total} if "withCount" in qs else page.rows

@router.get("/{id}")
async def get_author(id: int) -> Author:
    row = repo.find_by_id(id)
    if row is None: raise HTTPException(status_code=404, detail={"error": "not_found"})
    return row

@router.post("", status_code=status.HTTP_201_CREATED)
async def create_author(input: AuthorInsert) -> Author:
    return repo.insert(input)

@router.patch("/{id}")
async def update_author(id: int, input: AuthorUpdate) -> Author:
    return repo.update(id, input)

@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_author(id: int) -> None:
    repo.delete(id)
```

The filter-parser implementation is the bulk of the work; the route
shapes themselves are trivial. The TS `parseFilterParams` (in
`@metaobjectsdev/runtime-ts/drizzle-fastify`) is the reference — port it
into your framework's idiomatic query-builder, gated by the generated
`<Entity>FilterAllowlist`.

## Future direction

Cross-port route + filter codegen (Java, Kotlin, Python), the shared
route-shape oracle (`fixtures/api-contract-conformance/`), and a
browser-side Angular client have all shipped — see "Per-port route
codegen status" above and "Verified by" below, and
[`docs/ports/typescript-client.md#angular-18`](../ports/typescript-client.md#angular-18).

What's still genuinely open:

- The five **TS-only filter extensions** (`?search=`, `filter[or]` /
  `filter[and]` nesting, leading-wildcard gating, the nesting-depth cap,
  and the `in`-list size cap) — see "TS-only filter extensions" above.
  None touch the metamodel vocabulary, so any of them can be promoted
  cross-port later as a purely additive, non-breaking change if real
  consumer demand shows up.
- The `error` code vocabulary is not yet a hard cross-port invariant
  beyond `not_found` and the filter-parser error codes.

Neither item blocks adoption on any port today.

## Verified by

The query semantics behind these routes — filter operators, sort,
`withCount`, identity-by-id, projection read-only-ness — are exercised
by the shared corpus at
[`fixtures/persistence-conformance/queries/`](../../fixtures/persistence-conformance/queries/),
which every port runs against an ephemeral Postgres container via
`scripts/integration-test.sh`. Identical normalized results across every
port is the contract; deviation is a port bug.

The URL-grammar half (qs parsing, route mounting, status codes, JSON
envelope shape) is exercised by the cross-port corpus at
[`fixtures/api-contract-conformance/`](../../fixtures/api-contract-conformance/)
(10 scenarios — `list-empty`, `list-with-pagination`, `list-with-withcount`,
`sort-asc-desc`, `get-by-id`, `get-by-id-not-found`, `create-201`,
`update-patch-and-put`, `delete-204-and-404`, `invalid-sort-400`). Each
port's runner spins up a real HTTP server hosting its emitted routes for the
canonical `Author` entity, walks the scenarios, and asserts byte-shape
identical responses against the cross-port `expect.body.*` vocabulary.
All five ports ship a runner — TypeScript, Java, Kotlin, C#, and Python
each spin up their generated routes and pass every scenario. See
[`docs/CONFORMANCE.md`](../CONFORMANCE.md) for per-port pass status.

Filter operator coverage (`eq` / `ne` / `gt` / `gte` / `lt` / `lte` / `in` /
`like` / `isNull`) is part of the corpus: filter scenarios run on top of
the base CRUD scenarios, and all five ports satisfy the full
api-contract-conformance suite today (see
[`docs/CONFORMANCE.md`](../CONFORMANCE.md)).

## See also

- [`docs/features/loaders.md`](loaders.md) — how metadata maps to the
  entity shapes referenced by these routes
- [`docs/features/field-types.md`](field-types.md) — wire-format
  encoding per field subtype (currency minor units, date / timestamp,
  enum)
- [`docs/ports/typescript-client.md`](../ports/typescript-client.md) —
  the universal browser client that consumes this contract
- [`docs/ports/typescript.md`](../ports/typescript.md) — server-side TS
  reference implementation of route codegen
- [`docs/ports/csharp.md`](../ports/csharp.md) — C# reference
  implementation of route codegen

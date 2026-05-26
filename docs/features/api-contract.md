# Cross-port REST API contract

The browser-side TypeScript client (`@metaobjectsdev/runtime-web` +
`@metaobjectsdev/react` + `@metaobjectsdev/tanstack`) is **universal**: it
ships with the React + TanStack runtime and the generated query hooks +
column defs, but it makes **no assumption about which language wrote the
backend**. Any HTTP server — TypeScript Fastify, Java Spring, Kotlin Ktor,
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
halves are language-agnostic and stable across the four shipped
language ports. Routes can be **generated** (where the port ships a
route generator) or **hand-written** (where it doesn't) — the wire
behavior is identical either way.

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

### Filter operators (8)

Filters use a **bracketed qs** shape: `filter[<field>][<op>]=<value>`.
A bare value (`filter[<field>]=<value>`) is sugar for `eq`. Multiple
filters AND together; the optional `filter[or]=[...]` / `filter[and]=[...]`
keys nest disjunctions / conjunctions.

| Operator | Strings | Numbers / Dates | Booleans |
|---|---|---|---|
| `eq`, `ne`, `isNull` | yes | yes | yes (eq + isNull only) |
| `in`, `like` | yes | `in` only | – |
| `gt`, `gte`, `lt`, `lte` | – | yes | – |

The operator set is gated by field subtype in the generated
`<Entity>FilterAllowlist`. A request with an operator that the field
subtype doesn't support → HTTP 400. The operator list is a Tier 1
cross-port invariant — every port's parser must implement these eight
and only these eight.

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
| TypeScript | shipped — `@metaobjectsdev/codegen-ts` `routesFile()` → Fastify (`@metaobjectsdev/runtime-ts/drizzle-fastify`) | Reference implementation; full filter/sort + `withCount` support. |
| C# | shipped — `MetaObjects.Codegen` `RoutesGenerator` → ASP.NET Minimal API | `MapGet` / `MapPost` / `MapPut` / `MapDelete` mounted under `apiPrefix`; full CRUD. |
| Java | planned | Hand-write a Spring `@RestController` (or any HTTP-server framework) matching the URL grammar. OMDB persistence + the Maven plugin ship; only the controller layer is missing. |
| Kotlin | planned (deferred per [codegen-kotlin](../superpowers/specs/2026-05-25-codegen-kotlin-design.md) §9) | Hand-write a Spring-Kotlin `@RestController` or Ktor route handler. |
| Python | planned | Hand-write a FastAPI router matching the URL grammar. Entity-model codegen ships; persistence + migration in progress. |

## Hand-writing a conforming controller

While the planned route-codegen work matures, here is the minimum
controller needed to make `useAuthors`, `useAuthor`, etc. work against
each non-TS / non-C# backend. The shape is the same in every language —
mount five (or six, if you want PUT) routes under `apiPrefix` that
match the URL grammar above.

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

Cross-port route codegen — for Java (Spring), Kotlin (Spring-Kotlin /
Ktor), Python (FastAPI), and a browser-side Angular client — is planned
but not yet specced. The planned FR will track:

- A shared route-shape oracle (analogous to the persistence-conformance
  corpus) covering `list` / `get` / `create` / `update` / `delete` +
  filter / sort / `withCount` + the error-response shape.
- Per-port route generators emitting idiomatic controllers / routers
  against that oracle.
- An Angular client (browser-side) that consumes the same generated
  hook surface as the React client.

Until then, hand-written controllers per the templates above are
expected, and they remain the conformance gate.

## Verified by

The query semantics behind these routes — filter operators, sort,
`withCount`, identity-by-id, projection read-only-ness — are exercised
by the shared corpus at
[`fixtures/persistence-conformance/queries/`](../../fixtures/persistence-conformance/queries/),
which every port runs against an ephemeral Postgres container via
`scripts/integration-test.sh`. Identical normalized results across every
port is the contract; deviation is a port bug.

The URL-grammar half (qs parsing, route mounting, error shape) is
covered by per-port HTTP-layer tests today; a shared
`fixtures/api-conformance/` corpus is planned as part of the future
route-codegen FR.

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

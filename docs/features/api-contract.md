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
(see "Per-port route codegen status" below). That route code is a
[reference helper](own-your-codegen.md): it implements this contract on the
reference fixtures, and you eject it and own the copy when you need to change
it. The contract is what stays fixed.

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

The fetcher is supplied once via `<EntityFetcherProvider fetcher={fetcher} baseUrl="/api">`
at the React tree root; every generated hook reads it via
`useEntityPathFetcher()` from `@metaobjectsdev/tanstack`, which prepends `baseUrl`
to the ENTITY-relative path the hook passes it. (`useEntityFetcher()` is a
deprecated alias — it rewrites paths too, which its name did not say, so handing it
an application-absolute path produces `<baseUrl>` + that path and a silent 404.)

## URL grammar

These are the routes a generated TanStack hook calls, **relative to the
client's base URL**. `apiPrefix` in `metaobjects.config.ts` mounts the
generated *server* routes; the *client* base is supplied once at runtime as
`baseUrl` on the fetcher provider. The two must agree, and saying so is the
app's job — see the policy section below.

### Routes per entity

| Verb | Path | Purpose |
|---|---|---|
| `GET`    | `/<apiPrefix>/<entity>?filter[...][...]=...&sort=...&limit=N&offset=N&withCount=1` | List (with filter / sort / pagination) |
| `GET`    | `/<apiPrefix>/<entity>/:id` | Get by id |
| `POST`   | `/<apiPrefix>/<entity>` | Create |
| `PATCH`  | `/<apiPrefix>/<entity>/:id` | Update (partial) |
| `PUT`    | `/<apiPrefix>/<entity>/:id` | Update (replace) — optional; same body shape as `PATCH` |
| `DELETE` | `/<apiPrefix>/<entity>/:id` | Delete |

### Other endpoints

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/<apiPrefix>/_meta` | Serves the loaded model's shape (entities, fields, types, validators, layouts) as JSON — a separate contract, see [`docs/features/metadata-api.md`](metadata-api.md) |

#### The `<entity>` segment

`<entity>` is the **entity name** `snake_case`d and then pluralized. One rule, the
same in all five ports, and derived from the NAME — never from the physical
`@table`:

| Name | Segment | Why |
|---|---|---|
| `Author` | `authors` | a single regular word takes `s` |
| `PostCategory` | `post_categories` | multi-word: the capitals carry the word boundary |
| `Address` | `addresses` | ending `s`/`x`/`z`/`ch`/`sh` takes `es` |
| `Category` | `categories` | consonant + `y` becomes `ies` |
| `Day` | `days` | a VOWEL before the `y` does not |
| `HTTPServer` | `http_servers` | a run of capitals stays together until the final one that begins a word |

The same rule serves an `object.projection`, so `OrderSummary` is at
`/order_summaries` whether it is an entity or a projection.

Generated TS hooks read `$path` from the entity-constants file, so the client and
the server agree on the path segment without hand-coordination.

> **This changed.** Each port used to spell this differently, and they only agreed
> on single regular words like `Author` — which is every collection base the
> corpus had, so every lane was green while `OrderSummary` was served at four
> different URLs: `/order_summaries` (TS entity), `/order-summaries` (TS
> projection), `/ordersummaries` (C#) and `/ordersummarys` (Java, Kotlin,
> Python). If your entity names are all single regular words, nothing moves. If
> any is multi-word or takes an irregular plural, **its collection URL changes**
> and clients must follow. `fixtures/api-contract-conformance/m2m/`'s
> `PostCategory` now gates it in every port, on both lanes.

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
([ADR-0049](../../spec/decisions/ADR-0049-filter-like-is-case-sensitive-sql-like.md)):
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

The TypeScript runtime parser ships seven filter behaviors beyond the nine
operators. They are **NOT part of the cross-port REST contract** — the other
ports (Java, Kotlin, Python, C#) do not implement them, and a relying adopter
must not assume them on a non-TS backend. They are deliberately deferred until
real consumer demand (none touch the metamodel vocabulary, so any of them can be
added cross-port later as a purely additive, non-breaking change):

| Extension | What it does |
|---|---|
| `?search=<term>` | ORs a case-INSENSITIVE substring match (`%term%`) across the entity's `@filterable` string fields — deliberately looser than the case-sensitive `like` operator (it is a human search box; ILIKE on Postgres, native LIKE on SQLite) |
| `filter[or][N]` / `filter[and][N]` | boolean combinators (recursive nesting) |
| leading-wildcard gating | a `like` pattern starting with `%` → HTTP 400 (`filter.leading_wildcard_disallowed`) |
| filter nesting-depth cap | rejects deeply-nested `or`/`and` (tied to the combinators) |
| bare filterable-field parameter | `?priority=low` where `priority` is in the allowlist → HTTP 400 `{ "error": "filter.bare_field", "field": "priority", "expected": "filter[priority][eq]=low" }` instead of silently returning every row. Any other unknown parameter (a cache-buster, a tracking tag) is still ignored, and the reserved list parameters (`filter`, `sort`, `limit`, `offset`, `search`, `withCount`) are never claimed |
| filter-value format check | a comparison value (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`, and every element of an `in` list) that cannot be the field's type → HTTP 400 `{ "error": "invalid_filter_value", "field": "publishedOn", "op": "gte", "expected": "date (YYYY-MM-DD)" }` instead of reaching SQL, where SQLite compared the text and silently returned `[]` and Postgres failed the cast. Checked per field: `field.date` (a real calendar day), `field.time` (`HH:MM[:SS[.fff]]`), `field.timestamp` (a date, optionally with a time and a `Z`/offset), `field.uuid` (`8-4-4-4-12` hex), `field.enum` (a declared member — the response adds `allowed`), numbers (an empty value is not `0`) and booleans. The generated `<Entity>FilterAllowlist` carries the `format` / `enumValues` this needs; an allowlist generated before them still has a temporal value checked against all three temporal formats and an enum checked against the Drizzle column's own members. The envelope is the cross-port one; what is TS-only is refusing a malformed comparison value — the other ports pass it through to the database and only the `isNull` value is corpus-gated |

**Leading-wildcard gating is fail-closed with no metadata opt-in.** The
generated `<Entity>FilterAllowlist` hardcodes `leadingWildcard: false` on every
field — an unanchored LIKE (`"%@example.com"`) cannot use a btree index, so the
generated TS routes reject it by default. The runtime honors
`leadingWildcard: true` per field, but codegen never emits it: to opt a field
in, hand-edit that field's entry in the generated allowlist (hand edits inside
generated files survive regeneration via the three-way merge). There is
deliberately no `@`-attribute for this (ADR-0037/ADR-0023: the gate is a
TS-only generated-code behavior, not cross-port metamodel semantics — the other
ports accept leading wildcards, which is exactly why it is listed here as a
TS-only extension).

The **`in`-list size cap** (reject an `in` list longer than 100 → HTTP 400) is a
safety limit, not a feature — TS enforces it, the other ports currently do not.
Unifying that cap cross-port is the one item here worth doing regardless of
feature demand (it is a consistency/safety divergence, not a capability).

### TS-only error responses (not part of the cross-port contract)

The TypeScript mount helpers (`@metaobjectsdev/runtime-ts/drizzle-fastify`,
`/fastify` and `/hono`) pin two responses the contract leaves open — HTTP 5xx is
implementation-defined below, and no corpus scenario sends a malformed body. Both
use the contract's `{ "error": "<code>" }` envelope, and both are scoped to the
routes the helpers mount: an adopter's own routes, and a Fastify `setErrorHandler`
or Hono `onError` the adopter installed, answer exactly as they did before.

| Response | When |
|---|---|
| malformed JSON body | a `POST`/`PATCH`/`PUT` body that does not parse as JSON (an empty body sent as `application/json` included) → HTTP 400 `{ "error": "invalid_json" }`. Before, Fastify answered its own `{ "statusCode": 400, "code": "FST_ERR_CTP_INVALID_JSON_BODY", … }` and Hono a Zod `validation` error about a missing object |
| unexpected server error | anything that is not a filter, validation, not-found or constraint answer — a query against a column the database no longer has, a driver failure → HTTP 500 `{ "error": "internal" }`, the code the cross-port reference servers already use. The body names no SQL, table, column or bound parameter; the full error goes to the server log (`console.error`). Before, Fastify's default handler echoed the driver message, which for Drizzle is the query text and its parameter values |

How each framework scopes it: on Fastify, the helpers pass a **route-level**
`errorHandler` in the options of each route they register (Fastify applies it to
that route only). A deliberate 4xx raised on such a route — an auth `preHandler`'s
401, schema validation, 413, 415 — is rethrown to the enclosing scope's handler
untouched, and an `errorHandler` you pass in `routeOptions` replaces the helpers'
own. Hono has no per-route handler (`app.onError` is app-wide), so the helpers wrap
each handler they register instead; an `HTTPException` is rethrown to your
`onError`.

### Sort + pagination

- `sort=<field>:asc|desc` — single sort key (multi-sort not in the
  default contract). Field must appear in `<Entity>SortAllowlist`.
- `sort=<field>` — the `:asc|desc` half is OPTIONAL, and when omitted the
  direction comes from that field's `@sortableDefaultOrder`, defaulting to
  `asc` for a field that declares none. An order the caller DOES supply always
  wins: the declaration fills in a missing direction, it never overrides a
  present one. Applies per named field, so `?sort=name` on a model where
  `createdAt` declares `desc` still sorts `name` ascending.
  Guarded cross-port by the `sort-default-order` scenario
  (`fixtures/api-contract-conformance/scenarios/`), whose three arms cover the
  declared field, an explicit order beating it, and an undeclared field falling
  back to `asc`.
- **Known limit — enums sort by stored value, not declared order.** A
  string-backed `field.enum` sorts alphabetically (`high` < `low` < `medium`
  < `urgent`), not in `@values` order; an int-backed (`@intValueMap`) enum
  sorts by its mapped integers. To sort by declared order, back the enum with
  an `@intValueMap` whose integers follow that order.
- `limit=N` — page size.
- `offset=N` — page offset.
- `withCount=1` — opt-in flag that switches the list response from
  `[<row>...]` to `{ rows: [<row>...], total: <N> }` (needed for grid
  pagination). The grid hook always sends `withCount=1`.

### Base-URL policy

The two sides are configured **separately, and deliberately so**.

`apiPrefix` in `metaobjects.config.ts` is a *server* setting: the generated
routes mount under it, baked in as a literal, because the code that registers
`/api/authors` is the server.

```ts
export default defineConfig({
  apiPrefix: "/api",     // server mounts /api/authors
});
```

The client's base is a *deployment* fact, so it is supplied at runtime rather
than frozen at `meta gen` time. Generated hooks and Angular services emit
entity-relative paths (`${Author.$path}/${id}`), and the provider prepends the
base:

```tsx
<EntityFetcherProvider fetcher={fetcher} baseUrl="/api">
```

```ts
// Angular
provideEntityFetcher({ fetcher, baseUrl: "/api" })
```

`baseUrl` is optional and defaults to `""` — correct for an app served from the
same origin with routes at the root, which is what `meta init` scaffolds
(`apiPrefix: ""`). Because it is runtime configuration, one client bundle can be
served against a dev proxy, a preview environment, or a separate API host
(`baseUrl: "https://api.example.com/v1"`) without regenerating.

Before 0.25.0 the prefix was baked into every generated entity descriptor. See
[the migration guide](migrations/api-base-url-leaves-the-entity-descriptor.md)
for the one-line change.

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
| `field.time` | string | `HH:MM:SS[.fff]`. |
| `field.timestamp` | string | Instant, tz-aware by default (ADR-0036 Wave 2) — `YYYY-MM-DDTHH:MM:SS[.fff]Z`, **always UTC**. |
| `field.timestamp` (`@localTime: true`) | string | Naive wall clock — `YYYY-MM-DDTHH:MM:SS[.fff]`, **no `Z`**. |
| `field.currency` | **integer minor units** | Cents for USD, yen for JPY. Float arithmetic is forbidden. Server never formats. |
| `field.object` (`@storage: jsonb`) | object | Nested per the sub-object schema. |
| `field.object` (`@storage: flattened`) | object | Same JSON shape — only the storage differs. |

The currency invariant is the load-bearing one: every port emits and
expects integer minor units on the wire, and the
[`features/field-types.md`](field-types.md) reference enforces this for
each port's codegen output. Float arithmetic for money has bitten
every language at least once.

The temporal spellings above are **not** this document's to define — they are
the cross-port wire forms pinned by
[`fixtures/persistence-conformance/normalization.md`](../../fixtures/persistence-conformance/normalization.md),
which every port byte-matches. Two properties of that rule are easy to get
wrong and are restated here only because they decide whether a response
compares equal:

- **The `Z` discriminates the two timestamp kinds.** Never elide it for a
  default (tz-aware) `field.timestamp`, and never add it for an
  `@localTime: true` one. The suffix is what tells `TIMESTAMPTZ` from
  `TIMESTAMP`.
- **Sub-seconds are millisecond resolution, truncated, with no trailing
  zeros** — and the fractional component *and its `.`* are **omitted
  entirely when zero**. A whole-second instant is `2026-05-25T14:30:00Z`,
  never `2026-05-25T14:30:00.000Z`.

### Error response

Non-2xx responses MUST return:

```json
{ "error": "<short_code>", "message": "<optional human string>" }
```

- HTTP 400 — validation and filter/sort-parser errors.
- HTTP 404 — `{ "error": "not_found" }`.
- HTTP 409 — a declared constraint conflicting with existing state (a uniqueness or referential violation); a constraint rejecting the request's own value stays a 400.
- HTTP 5xx — implementation-defined (the TS mount helpers answer
  `{ "error": "internal" }` and nothing more — see "TS-only error responses").

#### Filter and sort errors name the field

These four codes are a hard cross-port invariant, and each one MUST carry
**`field`** — the filter or sort field the request was rejected for:

| `error` | Raised when | Example |
|---|---|---|
| `invalid_filter_field` | the field is not on the entity's filter allowlist | `{ "error": "invalid_filter_field", "field": "unknown" }` |
| `invalid_filter_op` | the operator is not valid for that field's subtype | `{ "error": "invalid_filter_op", "field": "name" }` |
| `invalid_filter_value` | the value will not coerce for that field and operator | `{ "error": "invalid_filter_value", "field": "bio" }` |
| `invalid_sort` | the sort field is off the sort allowlist, or the order is not `asc`/`desc` | `{ "error": "invalid_sort", "field": "unknownfield" }` |

`field` is REQUIRED, not optional. An optional member is un-gateable — the
corpus can neither require nor forbid it — which is exactly how one port came
to send it while four did not, invisibly, for several releases. A code that is
*not* about a particular field (an implementation-specific guard such as filter
nesting depth or in-list size) carries no `field`, and those guards are outside
this contract: a port may emit them under its own code.

Responses may carry additional diagnostic members beyond `field` (TS adds `op`,
`expected` and the allowlist); a consumer must tolerate them. Gated by
`fixtures/api-contract-conformance/scenarios/filter-invalid-*.yaml` and
`invalid-sort-400.yaml` in both the reference and generated lanes of every port.

Outside those four, treat any 4xx as user-facing and any 5xx as retryable /
log-only.

## Per-port route codegen status

| Port | Route codegen | Notes |
|---|---|---|
| TypeScript | shipped — `@metaobjectsdev/codegen-ts` `routesFile()` → Fastify (`@metaobjectsdev/runtime-ts/drizzle-fastify`) AND `routesFileHono()` → Hono (`@metaobjectsdev/runtime-ts/hono`) | Reference implementation; full filter/sort + `withCount` support. Both flavors emit byte-identical on-the-wire responses for the same metadata (same envelopes, same status codes, same filter operator parser), so consumers can pick the server framework that matches their runtime (Fastify for long-lived Node, Hono for Workers / Bun / edge). |
| C# | shipped — `MetaObjects.Codegen` `RoutesGenerator` → ASP.NET Minimal API | `MapGet` / `MapPost` / `MapPut` / `MapDelete` mounted under `apiPrefix`; full CRUD. |
| Java | shipped — `metaobjects-codegen-spring` `SpringControllerGenerator` + `SpringDtoGenerator` + `SpringRepositoryGenerator` → Spring `@RestController` (Spring Boot 3.x / Spring Web MVC) | One controller per writable entity (`source.rdb @kind="table"`) plus a READ-ONLY one per view-kind `object.projection` (F22, see "Read-only projections" below); 5 CRUD endpoints (GET list / GET by id / POST / PATCH + PUT / DELETE); `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Java 21 record DTOs for request/response; a stubbed `<Entity>Repository` interface the consumer implements against their persistence layer (JPA / jOOQ / JDBC). Filter operators (`eq/ne/gt/gte/lt/lte/in/like/isNull`) ship via the generated `<Entity>FilterAllowlist` (`SpringFilterAllowlistGenerator`) + the runtime `FilterParser`, wired directly into the list handler. |
| Kotlin | shipped — `metaobjects-codegen-kotlin` `KotlinSpringControllerGenerator` → Spring `@RestController` | One controller per writable entity (`source.rdb @kind="table"`) plus a READ-ONLY one per view-kind `object.projection` (F22, see "Read-only projections" below); 5 CRUD endpoints (GET list / GET by id / POST / PATCH+PUT / DELETE); `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Filter operators ship via the generated `<Entity>FilterAllowlist` (`KotlinFilterAllowlistGenerator`) + an inline `parse<Entity>Filter` helper emitted in the controller. |
| Python | shipped — `metaobjects.codegen.generators.router_generator` → FastAPI `APIRouter` | One router per writable entity (`source.rdb @kind="table"`) plus a READ-ONLY one per view-kind `object.projection` (F22, see "Read-only projections" below); 5 CRUD endpoints (GET list / GET by id / POST / PATCH+PUT / DELETE); `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Consumer wires the repository via FastAPI `app.dependency_overrides`; the generator emits a `Protocol` interface so the persistence layer (SQLAlchemy / asyncpg / etc.) is the consumer's choice. Filter operators ship via the generated `<entity>_filter_allowlist.py` (`filter_allowlist_generator.py`) + the shared `filter_parser` helper, wired into the list handler. |

## Read-only projections

**All five ports serve an `object.projection` whose only source is a read-only
view.** This used to be a 2-vs-3 split — TypeScript and C# mounted routes for one,
Java, Kotlin and Python emitted nothing — and the split was *documented* rather than
decided, because no corpus scenario ever asked. F22 ruled it: a projection's routes
are derivable from declared metadata exactly as a table entity's are, so they are
codegen, and scoping them out would have dropped a capability two ports shipped.

The surface:

- `GET /<plural>` and `GET /<plural>/{id}` are mounted, the latter through whatever
  identity the projection declares or inherits.
- `?filter[...]` and `?sort=` apply, against allowlists generated from the
  **projection's own** declared field set — not the base entity's.
- **Every write verb answers `405` with `{"error": "method_not_allowed"}`** — `POST`
  on the collection, `PATCH` / `PUT` / `DELETE` on the item. 405 rather than 404
  because the resource plainly exists: the same path answers `GET`. `message` is free
  prose and is not part of the contract.
- A **keyless** projection (no `identity.primary`) mounts no `/{id}` route at all, so
  it refuses only the collection verb — refusing an item verb would advertise an
  address the port never serves.

Every port mounts those refusals **explicitly**. Left to the framework, ASP.NET and
Spring each answer an unmatched method on a matched path with an empty-bodied 405 and
FastAPI with `{"detail": ...}` — three more body shapes on a wire the contract spells
one way.

Gated by [`fixtures/api-contract-conformance/projection/`](../../fixtures/api-contract-conformance/projection/),
which runs the **generated lane only, on all five ports**: what is under test is
whether a port's generator emits the routes, and a hand-rolled reference server would
answer every scenario by construction.

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

- The seven **TS-only filter extensions** (`?search=`, `filter[or]` /
  `filter[and]` nesting, leading-wildcard gating, the nesting-depth cap,
  the `in`-list size cap, the bare filterable-field 400, and the
  filter-value format check) — see "TS-only filter extensions" above.
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
The scenario count is deliberately not restated here — it was stale in this
sentence the last time it was written, and `ls
fixtures/api-contract-conformance/scenarios/` is always right. Representative
cases: `list-empty`, `list-with-pagination`, `list-with-withcount`,
`sort-asc-desc`, `sort-default-order`, `get-by-id`, `create-201`,
`update-patch-and-put`, `delete-204-and-404`, `invalid-sort-400`, and the
`filter-*` operator family. Each
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

- [`docs/features/metadata-api.md`](metadata-api.md) — the `GET /_meta`
  model-shape contract this page's row-data contract complements
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

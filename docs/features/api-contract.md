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
| `PUT`    | `/<apiPrefix>/<entity>/:id` | **An alias of `PATCH`** — same handler, same partial semantics, in every port (see below) |

**`PUT` is not a full replace.** Every port routes `PUT` to the same update handler as
`PATCH`, so a field the body omits keeps its stored value under either verb, and an
explicit `null` clears it under either verb. The contract has always meant it that way
(the `update-patch-and-put` scenario gates that both verbs reach the update path); only
this table's wording used to say "replace". A client that wants replace semantics sends
every field. The TS mounts can restrict the update to one verb with
`updateMethod: "patch" | "put"`.
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
| `Stats` | `stats` | already-plural (a final `s` NOT preceded by s/u/i/a) is left unchanged |

The same rule serves an `object.projection`, so `OrderSummary` is at
`/order_summaries` whether it is an entity or a projection.

> **Already-plural names don't double.** An entity whose name is already a
> plural noun — `Stats`, `Settings`, `Series` — used to be served at
> `/statses`, `/settingses`, `/serieses`. The pluralizer now treats a final
> `s` as already-plural unless the character before it is one of s/u/i/a
> (which still keeps `Status` → `/statuses`, `Address` → `/addresses`,
> `Alias` → `/aliases` pluralizing normally — those endings are a genuinely
> singular word, not an already-plural one). This is the API/code-surface
> rule only: a sourceless entity's DEFAULT PHYSICAL table name is a
> **separate, intentionally unchanged** derivation, so an adopter's existing
> database never sees a migration propose a rename for an already-plural
> entity it didn't touch. `fixtures/naming-conformance/` gates both rules,
> for the same input set, in every port.

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
| bare field parameter | `?priority=low` where `priority` is in the allowlist → HTTP 400 `{ "error": "filter.bare_field", "field": "priority", "expected": "filter[priority][eq]=low" }` instead of silently returning every row. A bare parameter named after a field of the entity that is NOT filterable (a column of the table or view the mount reads, off the allowlist) → HTTP 400 `{ "error": "filter.bare_field", "field": "kind", "filterable": false, "expected": "a filterable field — \"kind\" is not @filterable", "allowed": [<the filterable fields>] }` — declare `@filterable: true` on the field to filter by it. Any other unknown parameter (a cache-buster, a tracking tag) is still ignored, and the reserved list parameters (`filter`, `sort`, `limit`, `offset`, `search`, `withCount`) are never claimed |
| filter-value format check | a comparison value (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`, and every element of an `in` list) that cannot be the field's type → HTTP 400 `{ "error": "invalid_filter_value", "field": "publishedOn", "op": "gte", "expected": "date (YYYY-MM-DD)" }` instead of reaching SQL, where SQLite compared the text and silently returned `[]` and Postgres failed the cast. Checked per field: `field.date` (a real calendar day), `field.time` (`HH:MM[:SS[.fff]]`), `field.timestamp` (a date, optionally with a time and a `Z`/offset), `field.uuid` (`8-4-4-4-12` hex), `field.enum` (a declared member — the response adds `allowed`), numbers (an empty value is not `0`; on `field.int` / `field.long` / `field.currency` a fractional value such as `40.5` → `"expected": "integer (a whole number)"`) and booleans. A timestamp value whose offset arrived as a space — `…T00:00:00+00:00` sent unencoded, where `+` decodes to a space — adds `"hint"` saying to URL-encode the `+` as `%2B` or to use `Z`. A comparison value on a `field.timestamp` that is not `@localTime` is compared as an instant in the stored UTC spelling: a zoned value at its instant, a zoneless one read as UTC and a date alone as midnight UTC — the same rule the generated insert/update schemas store such a field by (`"2026-10-06"` is stored as `2026-10-06T00:00:00Z`: the canonical wire spelling, no fraction when it is zero; a value already spelled `YYYY-MM-DDTHH:MM:SS[.f]Z` is kept byte-for-byte), because SQLite and D1 compare the text; an `@localTime` value is kept as sent on both paths. The generated `<Entity>FilterAllowlist` carries the `format` / `enumValues` / `instant` / `integer` this needs; an allowlist generated before them still has a temporal value checked against all three temporal formats and an enum checked against the Drizzle column's own members. The envelope is the cross-port one; what is TS-only is refusing a malformed comparison value — the other ports pass it through to the database and only the `isNull` value is corpus-gated |

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
`/fastify` and `/hono`) pin five responses the contract leaves open — HTTP 5xx is
implementation-defined below, and no corpus scenario sends a malformed body, a write the database rejects, a
malformed page bound to an entity, or a value only the generated schema's format check refuses. All five use the contract's
`{ "error": "<code>" }` envelope, and all five are scoped to the
routes the helpers mount: an adopter's own routes, and a Fastify `setErrorHandler`
or Hono `onError` the adopter installed, answer exactly as they did before.

| Response | When |
|---|---|
| malformed JSON body | a `POST`/`PATCH`/`PUT` body that does not parse as JSON (an empty body sent as `application/json` included) → HTTP 400 `{ "error": "invalid_json" }`. An EMPTY body on a method that takes none (`GET`, `DELETE`, `HEAD`) is accepted even when the request declares `content-type: application/json`, as many clients do on every request; a non-empty `DELETE` body is still parsed. Before, Fastify answered its own `{ "statusCode": 400, "code": "FST_ERR_CTP_INVALID_JSON_BODY", … }` and Hono a Zod `validation` error about a missing object |
| malformed page bound | a `?limit=` or `?offset=` that is not a non-negative integer (`abc`, `-5`, `1.5`, an empty value) → HTTP 400 `{ "error": "pagination.invalid_value", "param": "limit", "value": "abc", "expected": "a non-negative integer (0 or more)" }`. Before, a non-numeric bound was dropped (every row came back) and a negative or fractional one reached SQL. There is no page-size maximum on an entity or a projection with declared columns; an opaque view (no declared columns, served by raw SQL) pages to at most 1000 rows, so there a `limit` above 1000 is refused too, with `"expected": "an integer from 0 to 1000"` (it used to be clamped silently). The same answer comes from the Drizzle mounts and the ObjectManager Fastify mount. The corpus sends a malformed bound only to a report (`report/bad-page-bound`), where every port answers this same envelope and also refuses `limit=0`; on an entity or a projection the other ports answer it as their framework does |
| database constraint violation | a write the database itself rejects → `{ "error": "constraint_violation", "constraint": "<kind>" }`, HTTP **409** for `unique` and `foreign_key` (a conflict with another row) and HTTP **400** for `check` and `not_null` (the request's own value), per the status rule under "Error response". The body names the constraint KIND only — never the SQL, the table or the bound values. A `CHECK` the model derives (an enum, a `validator.numeric`/`length`/`regex` range) is normally refused earlier by the route's own validation, as the corpus's `{ "error": "validation" }` 400; this row is the database's backstop |
| schema validation failure | a body that fails the insert/update schema → HTTP 400 `{ "error": "validation", "issues": [...] }`, each issue as Zod reports it **minus `pattern`**: Zod 4 attaches a failed `.regex()` check's source there, which for a generated `field.date` / `field.time` / `field.timestamp` check is a ~300-character calendar regex (and an authored `validator.regex` pattern is the server's to keep). The generated temporal checks carry a short `message` naming the expected format instead (`"must be an ISO date (YYYY-MM-DD)"`) |
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
- <a id="null-ordering"></a>**Null ordering — nulls sort as larger than any value, on every
  engine.** `sort=<field>:asc` puts null rows last and `sort=<field>:desc` puts them first, in
  every port (TypeScript, C#, Java, Kotlin, Python), on every engine each supports
  (Postgres, SQLite and D1, MySQL), for entity lists, projections and served reports alike. That
  is Postgres's own default; a bare `ORDER BY col` put nulls first ascending on SQLite and
  MySQL, so the same request used to answer a different order per engine. Each port now pins
  it: native `NULLS LAST` / `NULLS FIRST` where the engine has the clause, a leading
  `col IS NULL` key (or the ORM's equivalent) where it does not. Guarded cross-port by the
  `sort-null-ordering` scenario (`fixtures/api-contract-conformance/report/scenarios/`), an
  ascending and a descending sort over a column with a null row.
- **Known limit — enums sort by stored value, not declared order.** A
  string-backed `field.enum` sorts alphabetically (`high` < `low` < `medium`
  < `urgent`), not in `@values` order; an int-backed (`@intValueMap`) enum
  sorts by its mapped integers. To sort by declared order, back the enum with
  an `@intValueMap` whose integers follow that order.
- `limit=N` — page size.
- `offset=N` — page offset. Both are non-negative integers; the TS mounts refuse
  anything else with a 400 (see "TS-only error responses").
- **A report is the exception: one cap in every port.** A served `object.report` list returns every
  row when `limit` is omitted, up to 10,000 (a generator option), and answers
  `400 { "error": "report_too_large", "maxRows": N }` for one row more, or for a `limit` above the cap.
  A `limit` below 1, a negative `offset` or a value that is not an integer is
  `400 { "error": "pagination.invalid_value", "param": "limit" | "offset", "value", "expected" }` on
  a report in every port. See [reporting.md](reporting.md#how-a-report-is-served).
- **A report list can be exported: `?format=csv|json|xml`.** See
  [Report export](#report-export) below. Without `format` the response is byte-identical to the list
  route described here.
- **No page-size maximum on an entity, and the default is per port.** The contract pins what
  an explicit `limit`/`offset` returns (`list-with-pagination`); it does not pin a
  default or a ceiling, and the ports differ. With `limit` **omitted**, the
  TypeScript mounts and the C# routes return **every** matching row, while the
  Java, Kotlin and Python controllers return the first **50**. No port caps an
  explicit `limit` on an entity — `limit=100000` is honoured as asked — except
  the TS opaque-view route, which refuses a `limit` above 1000 (see "TS-only
  error responses"). A list over a large table should therefore always send a
  `limit`. A default page size is deliberately not introduced in a patch release:
  it would silently truncate the lists of every existing client that relies on
  the unpaged answer.
- `withCount=1` — opt-in flag that switches the list response from
  `[<row>...]` to `{ rows: [<row>...], total: <N> }` (needed for grid
  pagination). The grid hook always sends `withCount=1`.

### Report export

One selector on the existing report list route: `GET <apiPrefix>/<segment>?format=csv|json|xml`.
The route accepts `format` only when a `report-export` generator is wired for the project (see
[reporting.md](reporting.md#exporting-a-report)); a project that wires none sees no change at all,
and `?format=` is then ignored exactly as any unknown query parameter is today. **Accept headers are
never consulted**: the selector is the query parameter, in every port.

| Request | Answer |
|---|---|
| no `format` | Exactly the list route above: same body, same headers, same caps. |
| `format=json` | The list route's JSON body, unchanged, plus `Content-Disposition`: the array, or with `withCount=1` the `{ rows, total }` envelope. `Content-Type: application/json`. |
| `format=csv` | RFC 4180 CSV. `Content-Type: text/csv; charset=utf-8`. |
| `format=xml` | `application/xml`, shape below. |
| any other value (`xlsx`, `pdf`, `CSV`, empty) | `400 { "error": "invalid_format", "expected": ["csv", "json", "xml"] }`. `expected` lists the formats this route wires, in that order. `xlsx` is reserved for a later generator (`report-export-xlsx`) and is refused today like any unknown value. Matching is case-sensitive. |
| `format=csv` or `format=xml` and `withCount` truthy | `400 { "error": "export_with_count" }` (`message` is free prose). Only JSON carries the `{ rows, total }` envelope. |
| more rows than `maxRows` | `400 { "error": "export_too_large", "maxRows": N }` before a byte of the body is written. |

- **Header comparison.** Header names are case-insensitive. A runner compares `Content-Type` with the whitespace around `;` normalized (`text/csv;charset=utf-8` equals `text/csv; charset=utf-8`), because some servers re-spell it; every other header is compared exactly.
- **Headers.** Every successful export carries
  `Content-Disposition: attachment; filename="<segment>.<ext>"` with `<ext>` one of `csv`, `json`,
  `xml`. A response without `format` carries none.
- **Filters, sort, `limit` and `offset`** use the list route's parser, allowlists and 400 envelopes
  unchanged. In export mode an absent `limit` means every row up to `maxRows`; an explicit `limit` or
  `offset` is honoured.
- **One cap, two names.** `maxRows` is an option of the `report-export` generator, default 100,000.
  The route fetches `maxRows + 1` rows and refuses with `export_too_large` rather than truncate, and
  an explicit `limit` above `maxRows` is refused the same way. With `?format` set the export cap
  governs and `report_too_large` never answers; without it the list route's own cap
  (`report_too_large`, default 10,000) is untouched. A report is materialised up to the cap; there is
  no streaming in this version.
- **CSV.** UTF-8, no BOM unless the generated constant `EXPORT_CSV_BOM` is flipped to true, CRLF after
  every record including the last. One header row with the report's derived field names, in derived-field
  order (dimensions, then measures, as `reportShape` lists them). A value is written in its wire
  form: currency as integer minor units, a date as `YYYY-MM-DD`, a decimal as the `wire` setting spells
  it, a boolean as `true`/`false`, null as an empty cell. A cell containing `"`, `,`, CR or LF is
  quoted with embedded quotes doubled. **The formula-injection guard applies to every string-valued
  cell** (`field.string`, an enum symbol, a uri): a value starting with `=`, `+`, `-`, `@`, TAB or CR is
  prefixed with `'` before quoting. This is the render escapers' rule
  (`render-csv-injection` fixture). Numbers, decimals, dates and booleans are never guarded, so a
  negative number stays a number.
- **XML.** `<{ReportName}><row><{field}>value</{field}>...</row>...</{ReportName}>`, no XML declaration,
  no indentation, UTF-8, values in the same wire form as CSV, text and attribute content escaped
  (`&amp; &lt; &gt;`). There is no injection guard in XML. A null follows the generator option
  `xmlNulls`: `"nil"` writes the field as an empty element with `xsi:nil="true"` and declares
  `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` on the root; `"empty"` writes an empty element
  and declares nothing. **The default is each port's own standard** (ADR-0019 Amendment 2): see the
  per-port table in [reporting.md](reporting.md#exporting-a-report). The corpus pins `"nil"` in every lane
  and compares the body as an XML infoset (names, attributes, text, order), not byte for byte.
- **JSON** is whatever the list route's standard serializer writes in that port, so a `wire` setting
  applies to it exactly as it does to the list route.

The report-export scenarios (`report/scenarios/export-*.yaml`) use three assertion keys the rest of the
corpus does not: `headers` on `expect` (a map of lower-cased header name to its exact value, or `null` for
"the header is absent"), `text` on the body (the exact body, compared as UTF-8 text), and `xml` on the body
(compared as an XML infoset). A request may also carry `headers` (a map sent with the request).

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
| `field.date` | string | ISO 8601 calendar date (`YYYY-MM-DD`). Asserted literally by the `report/` sub-corpus (a time dimension's bucket), the first corpus to do so. |
| `field.decimal` | per [the wire setting](#the-wire-setting) | **Out:** by default, the port's language-standard form (a JSON number in C#, Java and Kotlin; a string in Python and TypeScript). Under `"wire": { "decimals": "string" }`, the canonical string of ADR-0019 Amendment 1: plain notation, no exponent, no trailing fraction zeros, zero as `"0"`, matching `^-?(0\|[1-9][0-9]*)(\.[0-9]*[1-9])?$` (`12.50` is sent `"12.5"`). **In, in every mode:** a string in JSON-number grammar or a JSON number, read exactly (TypeScript reads a JSON number exactly to 15 significant digits, so send a string for more); anything else is `400 validation`, and so is a value with more fraction digits than `@scale` or more integer digits than `@precision - @scale` (nothing is rounded). A filter operand uses the same grammar, is compared exactly, and a bad one is `400 invalid_filter_value`. Postgres and MySQL are exact to the declared precision; SQLite and D1 to 15 significant digits. The setting covers every decimal (entity, projection, report row) in every port; the `decimal/` sub-corpus asserts the string form, which the corpus pins. |
| `field.time` | string | `HH:MM:SS[.fff]`. |
| `field.timestamp` | string | Instant, tz-aware by default (ADR-0036 Wave 2) — `YYYY-MM-DDTHH:MM:SS[.fff]Z`, **always UTC**. |
| `field.timestamp` (`@localTime: true`) | string | Naive wall clock — `YYYY-MM-DDTHH:MM:SS[.fff]`, **no `Z`**. |
| `field.currency` | **integer minor units** | Cents for USD, yen for JPY. Float arithmetic is forbidden. Server never formats. |
| `field.object` (`@storage: jsonb`) | object | Nested per the sub-object schema. A null member is written per [the wire setting](#the-wire-setting) (`nullMembers`). |
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

### The wire setting

What a generated API writes for a decimal and for a value object's null member is a project
setting, `wire` in `.metaobjects/config.json`, read by every port's codegen the way `naming` is
([ADR-0019 Amendment 2](../../spec/decisions/ADR-0019-runtime-return-type-contract.md)):

```json
{ "schema_version": 1, "wire": { "decimals": "native", "nullMembers": "native" } }
```

Both keys default to `native`: **each port writes what its language's standard serializer
writes**, so a C# API looks like a C# API and a Python API like a Python API. Identical output
across ports is something you opt into:

```json
{ "schema_version": 1, "wire": { "decimals": "string", "nullMembers": "omit" } }
```

That is the form 1.1.0 and 1.1.1 wrote, and the form the cross-port conformance corpora pin in
their own config. Choose it when clients written in several languages share one contract, or when
a browser client must read a decimal exactly: `JSON.parse` turns a JSON number into a double
before your code sees it.

| Port | `decimals: native` (default) | `decimals: string` | `nullMembers: native` (default) | `emit` | `omit` | Change from 1.1.1 with no setting |
|---|---|---|---|---|---|---|
| C# | JSON number, as System.Text.Json writes a `decimal` (`12.50`, `0.0000001`) | `"12.5"` | `null`, key present | same as native | left out | decimals are numbers again, null members are written again (the 1.0.x output) |
| Java | JSON number, as the host's Jackson `ObjectMapper` writes a `BigDecimal` (Spring Boot: `12.50`, `1E-7`) | `"12.5"` | `null`, key present | same as native | left out | the same: the 1.0.x output |
| Kotlin | same as Java | `"12.5"` | `null`, key present | same as native | left out | the same: the 1.0.x output |
| Python | string, as Pydantic writes a `Decimal` (`"12.50"`, `"1E-7"`) | `"12.5"` | as stored: a stored `null` is `null`, a missing member is absent | every declared member, `null` when unset | left out | decimals keep their scale (`"12.50"`, not `"12.5"`) |
| TypeScript | string, as the runtime holds it: the driver's text on Postgres and MySQL (`"12.50"`); the stored number at 15 significant digits on SQLite and D1 | `"12.5"` | as stored: a stored `null` is `null`, a missing member is absent | every declared member, `null` when unset | left out | decimals keep their scale (`"12.50"`, not `"12.5"`) |

- **Input never follows the setting.** A decimal in a request body is a string in the
  JSON-number grammar or a JSON number in every mode. Garbage, and a value past the field's
  `@scale` or `@precision`, is `400 validation`, never rounded. A filter operand is compared
  exactly.
- `nullMembers` covers the members of an `object.value` only, and so also the jsonb that a typed
  serializer writes. A top-level entity field that is null is always written as `null`.
- There is no `"number"` value for `decimals`. In C#, Java and Kotlin, `native` already is a
  number; in Python and TypeScript, a number would be a lossy spelling those languages do not
  use.
- An unknown key or value is refused when the config is read. Every port's codegen drift gate
  (`meta verify --codegen`, `dotnet meta verify --codegen`, `mvn metaobjects:verify`,
  `metaobjects verify`) says which `wire` block reproduces committed output that was generated
  under another setting, instead of telling you to regenerate.
- Changing the setting changes generated code (converters, annotations, serializers), so
  regenerate after you change it, and commit the result.

### Error response

Non-2xx responses MUST return:

```json
{ "error": "<short_code>", "message": "<optional human string>" }
```

- HTTP 400 — validation and filter/sort-parser errors.
- HTTP 404 — `{ "error": "not_found" }`.
- HTTP 409 — a declared constraint conflicting with existing state (a uniqueness or referential violation); a constraint rejecting the request's own value — a `CHECK` or `NOT NULL` violation — stays a 400, because resending the same body can never succeed while a 409 can clear once the other row changes (the TS body is under "TS-only error responses").
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
`expected` and the allowlist — an `invalid_sort` answer carries
`"expected": "sort=<field>:asc|desc"` and `allowed`, the sortable fields, so a
`?sort=-createdAt` names the spelling that works); a consumer must tolerate them. Gated by
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

- `GET /<plural>` is mounted, and `GET /<plural>/{id}` when the projection can be
  addressed by key (the keyless rule below), through whatever identity it declares or
  inherits.
- `?filter[...]` and `?sort=` apply, against allowlists generated from the
  **projection's own** declared field set — not the base entity's.
- **Every write verb answers `405` with `{"error": "method_not_allowed"}`** — `POST`
  on the collection, `PATCH` / `PUT` / `DELETE` on the item. 405 rather than 404
  because the resource plainly exists: the same path answers `GET`. `message` is free
  prose and is not part of the contract.
- A **keyless** projection, one that declares and inherits no `identity.primary`, mounts no
  `/{id}` route of any verb in any port, so it refuses only the collection verb —
  refusing an item verb would advertise an address the port never serves. A field that
  happens to be named `id` is a convention, not a key: a projection with an `id` field and
  no declared identity is keyless. `GET /<plural>/1` on one answers the framework's own
  `404`, never a row. A projection with a declared identity addresses a row by the field
  that identity names, which need not be called `id` and which the view's column must
  match: `GET /<plural>/{key}` answers that row, or the `404 {"error": "not_found"}`
  envelope. One difference remains, and the corpus does not gate it: C#, Java and Kotlin
  mount item routes only for a **single-column** identity, while TypeScript and Python
  bind a composite one to its first field.
- Filters apply to a projection's `field.decimal` and `field.float` fields as they do to
  an entity's. A decimal is written as "Type encodings" and [the wire setting](#the-wire-setting)
  say, as for an entity.
- **The api docs list the same routes.** A projection's api page documents `GET <path>`,
  and `GET <path>/{id}` only when the item route exists. The `405` refusals are not
  operations a caller can use, so no write verb is documented. Pinned in every port by
  `projection/docs-routes.json`.

Every port mounts those refusals **explicitly**. Left to the framework, ASP.NET and
Spring each answer an unmatched method on a matched path with an empty-bodied 405 and
FastAPI with `{"detail": ...}` — three more body shapes on a wire the contract spells
one way.

Gated by [`fixtures/api-contract-conformance/projection/`](../../fixtures/api-contract-conformance/projection/),
which runs the **generated lane only, on all five ports**: what is under test is
whether a port's generator emits the routes, and a hand-rolled reference server would
answer every scenario by construction.

## Reports

**All five ports serve a view-backed `object.report`** (a concrete report whose read source
is a `source.rdb` of `@kind: view`) exactly as a keyless read-only projection is served. A
report with no source, an abstract one, and one over a `materializedView`, `storedProc` or
`tableFunction` mount nothing. `<segment>` is the object rule above: `InvoicesByMonth` is at
`/invoices_by_months`.

| Request | Answer |
|---|---|
| `GET /<apiPrefix>/<segment>` | `200`, a JSON array of rows, one per distinct dimension tuple. `?filter[...]`, `?sort=`, `limit` and `offset` apply as on any list route; `withCount=1` answers `{ "rows": [...], "total": N }`, `N` being the number of groups after filtering. |
| `POST /<apiPrefix>/<segment>` | `405 {"error": "method_not_allowed"}`. `message` is free prose. |
| any verb on `/<apiPrefix>/<segment>/{id}` | Not mounted, in every port: a report has no identity. The framework's own `404`; its body is outside the contract. |
| a filter or sort error | The field-naming envelopes above, unchanged. |

Every derived field whose type has filter operators is filterable and sortable, dimension
and measure alike; the allowlists are the report's own derived fields, never the `@from`
entity's. No request parameter picks dimensions, measures or a grain. TypeScript generates a
list hook for a report; no port generates a grid or form for one.

A report with `@spine` lists the rows that have no facts too (a count of `0` there), and
`withCount=1` counts them; `?filter[<count>][gt]=0` removes them on request. A measure with
`@default` reads its default on such a row and is never `null`: `?filter[<m>][eq]=0` matches
the empty rows, `isNull=true` matches nothing, and a sort on it orders the same on every
engine.

Gated by [`fixtures/api-contract-conformance/report/`](../../fixtures/api-contract-conformance/report/)
(37 scenarios), **generated lane only, on all five ports**, for the reason `projection/`
gives. The columns, their types and the per-port generated files are in
[reporting.md](reporting.md#how-a-report-is-served).

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
import com.metaobjects.generator.spring.runtime.FilterParser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/authors")
public class AuthorController {
  private final AuthorRepository repo;

  public AuthorController(AuthorRepository repo) { this.repo = repo; }

  @GetMapping
  public ResponseEntity<?> list(HttpServletRequest request) {
    // The RAW query string: a servlet container drops a parameter with a malformed escape.
    var filter = FilterParser.parse(request.getQueryString(), AuthorFilterAllowlist.FIELDS,
        AuthorFilterAllowlist.OPS_BY_FIELD, AuthorFilterAllowlist.DECIMAL_FIELDS);
    if (filter.error() != null) {
      return ResponseEntity.badRequest().body(Map.of("error", filter.error(), "field", filter.field()));
    }
    var page = repo.find(filter.predicates());
    return ResponseEntity.ok(request.getParameter("withCount") != null
      ? Map.of("rows", page.rows(), "total", page.total())
      : page.rows());
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
import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/authors")
class AuthorController(private val repo: AuthorRepository) {

  @GetMapping
  fun list(request: HttpServletRequest): ResponseEntity<*> {
    // Parse the RAW query string, as the generated controller's parseAuthorFilter does.
    val filter = parseAuthorFilter(request.queryString)
    filter.error?.let { return ResponseEntity.badRequest().body(mapOf("error" to it, "field" to filter.field)) }
    val page = repo.find(filter.predicates)
    return ResponseEntity.ok(
      if (request.getParameter("withCount") != null) mapOf("rows" to page.rows, "total" to page.total) else page.rows,
    )
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

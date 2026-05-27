# `fixtures/api-contract-conformance/` — cross-port REST API contract corpus

Verifies that every backend's emitted CRUD routes — TS Fastify, Kotlin
Spring controllers, Java Spring controllers, ASP.NET Minimal API, FastAPI
routers — answer identically when driven over HTTP. The corpus is the
language-agnostic contract; per-port runners spin up a real HTTP server,
walk the scenarios, and assert each response matches.

Scope: the **URL grammar + wire format** half of the contract from
[`docs/features/api-contract.md`](../../docs/features/api-contract.md).
The persistence-layer half (filter operators, projections) is exercised
separately by `fixtures/persistence-conformance/`.

## Shape

```
fixtures/api-contract-conformance/
├── README.md                   # this file
├── meta.json                   # shared canonical metadata (Author entity)
├── seed.json                   # 5 seed Author rows applied before each scenario
└── scenarios/
    ├── list-empty.yaml
    ├── list-with-pagination.yaml
    ├── list-with-withcount.yaml
    ├── sort-asc-desc.yaml
    ├── get-by-id.yaml
    ├── get-by-id-not-found.yaml
    ├── create-201.yaml
    ├── update-patch-and-put.yaml
    ├── delete-204-and-404.yaml
    ├── invalid-sort-400.yaml
    ├── filter-eq.yaml             # FR-009 filter operators
    ├── filter-ne.yaml
    ├── filter-gt.yaml
    ├── filter-lt.yaml
    ├── filter-in.yaml
    ├── filter-like.yaml
    ├── filter-isnull-true.yaml
    ├── filter-and.yaml
    ├── filter-invalid-field.yaml
    └── filter-invalid-op.yaml
```

`meta.json` declares a single canonical `Author` entity in the `acme::blog`
package:

| Field        | Type             | Notes                                |
|--------------|------------------|--------------------------------------|
| `id`         | `field.long`     | `identity.primary @generation=increment` |
| `name`       | `field.string`   | `@required` + `@maxLength 100`       |
| `bio`        | `field.string`   | nullable + `@maxLength 1000`         |
| `createdAt`  | `field.timestamp`| `@required`                          |

`source.rdb @table="authors"` — the URL segment per the cross-port grammar
is therefore `/api/authors` (lowercased + pluralized).

`seed.json` is applied fresh before every scenario (truncate-then-insert).
Scenarios that need an empty table opt in via `setup: { truncate: true }`.

## Scenario YAML shape

```yaml
name: <kebab-case-scenario-name>
description: >
  Free-text describing what behavior the scenario verifies.
setup:                     # optional
  truncate: true           # opt-in: empty the table before this scenario's requests
requests:
  - id: r1                 # stable id per request (referenced in test logs)
    method: GET            # GET | POST | PATCH | PUT | DELETE
    path: /api/authors?... # path + query string; runner prepends the base URL
    body:                  # optional; JSON-shaped; omitted for GET/DELETE
      name: "..."
    expect:
      status: 200          # exact HTTP status to assert
      body:                # one of: equals | row | rows | length | envelope | error | empty | hasId | ids | names
        ...
```

### Supported `body.*` assertions

| Key          | Meaning                                                                |
|--------------|------------------------------------------------------------------------|
| `equals`     | deep-equal the response body to the literal value                      |
| `length`     | the response body is an array of this length                           |
| `ids`        | the response body is an array; assert the `id` field of each, in order |
| `names`      | the response body is an array; assert the `name` field of each         |
| `row`        | the response body is an object; assert the listed keys match           |
| `hasId`      | the response body is an object containing a numeric `id`               |
| `envelope`   | the response body is `{ rows, total }` (set `rowsLength` + `total`)    |
| `error`      | the response body has `error: "<value>"`                               |
| `empty`      | the response body is empty / null (204 No Content)                     |

Runners are responsible for normalizing `createdAt` (and any other
non-deterministic fields) before comparison. The keys listed above are
the only ones a runner must understand to be conformant.

## Filter operator coverage (FR-009)

The `filter-*` scenarios pin the 9 cross-port filter operators declared in
[`docs/features/api-contract.md`](../../docs/features/api-contract.md) under
the URL grammar `?filter[<field>][<op>]=<value>` (with bare `?filter[<field>]=<value>`
sugar = `eq`). Coverage:

| Scenario | Operator | Path |
|---|---|---|
| `filter-eq` | `eq` | `?filter[name][eq]=Ada%20Lovelace` |
| `filter-ne` | `ne` | `?filter[name][ne]=Ada%20Lovelace` |
| `filter-gt` | `gt` (numeric) | `?filter[id][gt]=2` |
| `filter-lt` | `lt` (numeric) | `?filter[id][lt]=3` |
| `filter-in` | `in` (comma-sep) | `?filter[name][in]=Ada%20Lovelace,Alan%20Turing` |
| `filter-like` | `like` (SQL `%` wildcard, URL-encoded `%25`) | `?filter[name][like]=A%25` |
| `filter-isnull-true` | `isNull=true` | `?filter[bio][isNull]=true` |
| `filter-and` | implicit-AND combinator across multiple `filter[...]` params | `?filter[name][like]=A%25&filter[id][gt]=1` |
| `filter-invalid-field` | error: unknown field → 400 `{"error":"invalid_filter_field"}` | `?filter[unknown][eq]=x` |
| `filter-invalid-op` | error: op-subtype mismatch → 400 `{"error":"invalid_filter_op"}` | `?filter[name][gt]=Ada` |

`gte` and `lte` are derivable from `gt`/`lt` + boundary value; the corpus pins
the 9 listed above to keep the matrix focused. Per the cross-port operator-
subtype matrix (`docs/features/api-contract.md`):

- **string** subtypes accept `eq`, `ne`, `in`, `like`, `isNull`
- **numeric / date / timestamp** subtypes accept `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `isNull`
- **boolean** subtypes accept `eq`, `isNull`

## How a port's runner works

Every per-port runner:

1. Loads `meta.json` and applies it as a fresh schema (via the port's
   migrate engine or hand-rolled DDL for ports that lack migrate).
2. Starts an HTTP server hosting the port's generated CRUD routes for
   `Author` mounted under `/api`.
3. For each scenario file in `scenarios/`:
   - Truncates + re-seeds `authors` from `seed.json` (or empties it when
     `setup.truncate: true`).
   - Walks `requests[]` in order, issuing each over HTTP via the port's
     standard test-client (Fastify inject, ASP.NET `WebApplicationFactory`,
     Spring `MockMvc`, FastAPI `TestClient`, or a raw HTTP client against
     a local-bound port).
   - Asserts the response status + body matches `expect`.
4. Tears down (postgres testcontainer, in-memory DB, etc.).

The runner's job is to **map** the cross-port assertion vocabulary
(`row` / `rows` / `envelope` / `error` / `empty`) onto its own port's
test-assertion idioms.

## Adding a scenario

1. Drop a new `<name>.yaml` in `scenarios/`.
2. Make sure each per-port runner's allowed-scenarios list (or auto-discovery
   glob) picks it up.
3. If the scenario needs a new assertion shape beyond the table above, add it
   to **every** runner in lockstep — the corpus is the contract.

## Pass status per port

See [`docs/CONFORMANCE.md`](../../docs/CONFORMANCE.md) for the current
per-port pass count against this corpus.

## Why this is separate from `persistence-conformance/`

`persistence-conformance/` exercises the runtime metadata pillar end-to-end
through the persistence layer (filter operators, projections, view DDL).
`api-contract-conformance/` exercises the URL grammar + HTTP wire shape
above the persistence layer. A port can ship one without the other
(e.g. a port might land routes-only first), so they live in separate
corpora and are gated independently.

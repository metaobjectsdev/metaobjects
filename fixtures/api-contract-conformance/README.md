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
    ├── create-constraint-violation-400.yaml # FR-036 POST field-constraint → 400 {error:"validation"}
    ├── update-patch-and-put.yaml
    ├── update-constraint-violation-400.yaml # FR-036 PATCH present-value constraint → 400
    ├── delete-204-and-404.yaml
    ├── invalid-sort-400.yaml
    ├── filter-eq.yaml             # FR-009 filter operators
    ├── filter-ne.yaml
    ├── filter-gt.yaml
    ├── filter-lt.yaml
    ├── filter-in.yaml
    ├── filter-in-over-cap-400.yaml # `in`-list over the 100-element cap → 400
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

## Two runner lanes per port (hand-rolled reference + GENERATED artifact)

**All five ports** now drive the corpus through **two** lanes: a hand-rolled
reference server (the stable contract reference) **and** the port's **generated**
API artifact booted over HTTP. The generated lane is what proves the *deployed*
artifact — not a re-implementation — implements the contract. (Building these
lanes surfaced and fixed **10 real generated-API bugs** across the ports that
golden-snapshot tests never caught — e.g. C# filter dispatch throwing 500 on
every filter, Spring PATCH/PUT route stacking → PUT 405, timestamp binding
errors, Python error envelopes wrapped as `{"detail": ...}`.)

| Port | Generated artifact | Generated-lane harness | DB |
|---|---|---|---|
| TypeScript | `Author.routes.ts` + `drizzle-fastify` | `runGen` → dynamic-import → Fastify `inject` | Testcontainers PG |
| C# (ASP.NET) | minimal-API routes + `AppDbContext` | Roslyn-compile → Kestrel `WebApplication` + `HttpClient` | Testcontainers PG |
| Java (Spring) | `@RestController` (`codegen-spring`) | `ToolProvider`-compile → `MockMvc` standaloneSetup + in-memory repo behind the generated repo interface | in-memory |
| Kotlin (Spring) | `@RestController` (`codegen-kotlin`) | kotlin-compile-testing → `MockMvc` standaloneSetup + in-memory H2 behind the generated `Table` | in-memory |
| Python (FastAPI) | `APIRouter` (`router_generator`) | `render_router` → import → `TestClient` + in-memory repo behind the generated DI dependency | in-memory |

**Why some ports use a real DB and others in-memory:** TS and C# generate a
*complete* server (routes + generated persistence — Drizzle / `AppDbContext`), so
the whole generated stack runs against Testcontainers Postgres. Java / Kotlin /
Python generate the **controller/router** with a *consumer-supplied* persistence
seam (a repository interface / DI dependency MetaObjects intentionally leaves the
consumer to implement) — so the generated controller is the artifact under test,
hosted with a minimal in-memory repo behind that seam (real DB behavior is owned
by `persistence-conformance`). Each generated lane hosts the EMITTED
controller/routes **unmodified**; the in-memory repo (seam ports) is the only
hand-written piece.

Every generated lane lives beside its port's hand-rolled lane and runs under the
same per-port `integration-tests.yml` job — no separate opt-in.

### TS lanes (illustrative detail)

On the TypeScript port the corpus is driven by **two** lanes, both
against a Postgres testcontainer over HTTP:

1. **Hand-rolled reference lane** (`test/api-contract.test.ts`) — a server the
   integration-tests package wires up directly. It is the stable reference
   implementation of the contract semantics; it does **not** exercise the
   codegen output.
2. **Generated-routes lane** (`test/api-contract-generated.test.ts`) — runs
   `codegen-ts`'s `runGen` to emit the real `Author.routes.ts` into a temp dir,
   then dynamically imports the **emitted** route file unmodified and mounts it
   on Fastify (the generated routes call `mountCrudRoutes` from
   `@metaobjectsdev/runtime-ts/drizzle-fastify`). This drives the SAME corpus
   over HTTP, so the deployed artifact — not a re-implementation — is what gets
   verified. (Building this lane surfaced and fixed real divergences between the
   generated routes / `drizzle-fastify` mount and the contract.)

Both lanes live in `server/typescript/packages/integration-tests/test/` and are
run by the same `cd server/typescript/packages/integration-tests && bun test`
invocation, so the `.github/workflows/integration-tests.yml` TS job gates both
on every PR and push-to-main — no separate opt-in.

### Fan-out — COMPLETE (all 5 ports)

The generated-artifact lane now covers **all five ports** (see the table above);
the original TS-only gap is closed. Each port's deployed CRUD artifact is driven
over HTTP against this corpus alongside its hand-rolled reference lane.

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

# Conformance coverage

The MetaObjects standard has 6 cross-language conformance corpora plus a deferred
7th (`codegen-conformance/`, tracked as FR-007). Every port runs every applicable
corpus and asserts the same expected behavior against the same fixtures. **This
page is the inverse index**: fixture → feature doc + per-port pass status.

If you are coming from a feature doc's `## Verified by` section, you are in the
right place. If you are wondering whether a particular fixture has a
human-readable explanation somewhere, look it up in the
"Fixture-to-doc mapping" table below.

## Per-corpus totals

| Corpus | Fixtures | TS | Java | Kotlin | C# | Python |
|---|---|---|---|---|---|---|
| [`fixtures/conformance/`](../fixtures/conformance/) (metamodel) | 91 | 91 / 91 | 89 / 91 (2 FR5c-pending: `error-merge-conflict-attr`, `warning-duplicate-declaration`) | inherits via `metadata-ktx` | 89 / 91 (same 2 FR5c-pending) | 89 / 91 (same 2 FR5c-pending) |
| [`fixtures/yaml-conformance/`](../fixtures/yaml-conformance/) | 13 | 13 / 13 | 12 / 13 (1 ledgered: `yaml-quoted-leading-zero` — Java pipeline strips quotes off `"007"`) | inherits via Java | 12 / 13 (1 ledgered: `error-yaml-coerced-hex-in-string` — YamlDotNet doesn't coerce `0xFF`) | 13 / 13 |
| [`fixtures/verify-conformance/`](../fixtures/verify-conformance/) | 31 | 31 / 31 | 31 / 31 | inherits via Java | 31 / 31 | 31 / 31 |
| [`fixtures/render-conformance/`](../fixtures/render-conformance/) | 14 | 14 / 14 | 14 / 14 | inherits via Java | 14 / 14 | 14 / 14 |
| [`fixtures/persistence-conformance/`](../fixtures/persistence-conformance/) | 12 (9 query + 3 migration) | 12 / 12 | 12 / 12 | 12 / 12 (via Exposed) | 12 / 12 | 12 / 12 |
| [`fixtures/api-contract-conformance/`](../fixtures/api-contract-conformance/) | 20 | 20 / 20 (Fastify reference runner) | 20 / 20 (embedded HTTP + JDBC reference runner) | 20 / 20 (embedded HTTP + Exposed reference runner) | 20 / 20 (HttpListener + Npgsql reference runner) | 20 / 20 (FastAPI + pg8000 reference runner) |
| `fixtures/codegen-conformance/` (FR-007 — DROPPED in favor of `persistence-conformance` participation) | 0 | n/a | n/a | n/a | n/a | n/a |

The two ledgered YAML fixtures are documented library-vs-pipeline divergences (see the
`_comment` block in each port's `yaml-conformance-expected-failures.json` for the
full reconciliation note). They are tracked as known-gaps rather than silently
patched — the runner treats listed fixtures as passing, but a future port-level
reconciliation pass would close them.

Per-port runners + commands:

| Port | Metamodel + YAML + render + verify | Persistence | API contract |
|---|---|---|---|
| TypeScript | `cd server/typescript && bun test` (per-package, `~3s`) | `scripts/integration-test.sh ts` (needs Docker) | `cd server/typescript/packages/integration-tests && bun test test/api-contract.test.ts` (needs Docker) |
| Java | `mvn -pl metaobjects-conformance test` (and per-tier `-pl render`, etc.) | `scripts/integration-test.sh java` (needs Docker) | `mvn -f server/java/integration-tests/pom.xml test -Dtest=ApiContractConformanceTest` (needs Docker) |
| Kotlin | `mvn -pl codegen-kotlin test` (snapshot suite) | `mvn -pl integration-tests-kotlin test` (needs Docker) | `mvn -f server/java/integration-tests-kotlin/pom.xml test -Dtest=ApiContractConformanceTest` (needs Docker) |
| C# | `dotnet test` (per project) | `scripts/integration-test.sh csharp` (needs Docker) | `dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj --filter "FullyQualifiedName~ApiContractConformanceTest"` (needs Docker) |
| Python | `pytest` (per package) | `scripts/integration-test.sh python` (needs Docker) | `cd server/python && uv run --extra integration pytest tests/integration/test_api_contract.py` (needs Docker) |

The `persistence-conformance` corpus is intentionally **on-demand** — none of the
unit-test runners (`bun test`, `dotnet test`, `pytest`, `mvn test`) pull Docker.
`scripts/integration-test.sh` is the entry point and is wired into
[`docs/RELEASING.md`](RELEASING.md) §2b as the pre-`latest` gate.

## Fixture-to-doc mapping

### `fixtures/conformance/` — metamodel loader + canonical serializer (91)

| Fixture prefix | Feature doc |
|---|---|
| `loader-basic-*`, `error-parse-*` | [features/loaders.md](features/loaders.md) |
| `extends-*`, `error-extends-*` | [features/entities.md](features/entities.md) (inheritance) |
| `identity-*`, `subtype-entity-*`, `subtype-value-*` | [features/entities.md](features/entities.md) (identity / entity vs value) |
| `attr-*`, `error-attr-*`, `error-reserved-word-as-attr` | [features/entities.md](features/entities.md) (attributes) |
| `doc-common-attrs-*` | [features/entities.md](features/entities.md) (documentation common attrs) |
| `auto-set-on-*` | [features/entities.md](features/entities.md) (auto-set timestamps) |
| `attr-filter-*`, `loader-filterable-*`, `warning-filterable-*`, `layout-data-grid-*`, `error-data-grid-*` | [features/entities.md](features/entities.md) (filter / sort / grid) |
| `overlay-*` | [features/entities.md](features/entities.md) (overlay / merge) |
| `merge-three-way-no-conflict`, `error-merge-conflict-attr`, `warning-duplicate-declaration` | [features/loaders.md](features/loaders.md) (multi-file merge attribution, FR5c) |
| `field-string-*`, `field-decimal-*`, `field-object-storage-*`, `error-field-object-storage-*` | [features/field-types.md](features/field-types.md) |
| `currency-*` | [features/field-types.md](features/field-types.md) (currency) |
| `enum-*`, `error-enum-*` | [features/field-types.md](features/field-types.md) (enum) |
| `source-rdb-*`, `source-db-table-*`, `source-db-view-*`, `source-multi-source-*`, `error-source-*` | [features/source-kinds.md](features/source-kinds.md) |
| `relationship-*`, `error-unknown-relationship-*` | [features/relationships.md](features/relationships.md) |
| `template-*`, `error-template-*` | [features/templates-and-payloads.md](features/templates-and-payloads.md) |
| `origin-*`, `error-origin-*` | [features/templates-and-payloads.md](features/templates-and-payloads.md) (payload origins) |
| `smoke-empty-metadata` | [features/entities.md](features/entities.md) |

### `fixtures/yaml-conformance/` (13)

All 13 fixtures → [features/yaml-authoring.md](features/yaml-authoring.md). The corpus
splits into 7 happy-path fixtures (sigil-free attrs, array suffix, anchor/alias,
block scalars, mixed bare-and-prefixed, quoted leading zero, etc.) and 6
`error-yaml-*` fixtures that pin the YAML 1.1 coercion guards (bool / null / hex
in string contexts; numeric in enum contexts; reserved-as-attr).

### `fixtures/render-conformance/` (14)

All 14 fixtures → [features/templates-and-payloads.md](features/templates-and-payloads.md)
(render engine output section). 4 are end-to-end shape examples (prompt / email /
spreadsheet / CSV-injection escape); 10 pin Mustache-engine semantics — dotted-path
lookup, parent-context fallthrough, falsy/empty-array section behavior, inverted
sections, nested partials, standalone-tag whitespace stripping, raw-HTML bypass,
trailing-newline preservation, and unicode multibyte handling.

### `fixtures/verify-conformance/` (31)

All 31 fixtures → [features/migrations-and-drift.md](features/migrations-and-drift.md)
(template drift section — `Renderer.verify`).

### `fixtures/persistence-conformance/` (12)

- `migrations/*` (3) → [features/migrations-and-drift.md](features/migrations-and-drift.md) (schema migration section)
- `queries/*` (9) → [features/source-kinds.md](features/source-kinds.md) (query semantics against `source.rdb`)

### `fixtures/api-contract-conformance/` (20)

All 20 scenarios → [features/api-contract.md](features/api-contract.md) (cross-port
REST API URL grammar + JSON wire format). Verifies every backend's emitted CRUD
routes answer identically over HTTP — list / get / create / patch+put / delete,
plus pagination (`limit`/`offset`), sort (`sort=field:dir`), the `withCount=1`
envelope, the `not_found` / `invalid_sort` error envelopes, and the 201 / 204
status codes.

The corpus also covers the 9 cross-port filter operators (`eq`, `ne`, `gt`,
`gte`, `lt`, `lte`, `in`, `like`, `isNull`) plus the implicit-AND combinator
and 2 error shapes (`invalid_filter_field` / `invalid_filter_op`) under the
URL grammar `?filter[<field>][<op>]=<value>` (FR-009) — 10 filter scenarios
on top of the 10 base CRUD scenarios. All 5 ports — TS, Java, Kotlin, C#,
Python — satisfy all 20 scenarios today.

## Orphaned fixtures (tested but not yet documented)

All 181 fixtures across the 6 active corpora map to a feature doc. None are
orphaned today.

If you add a new fixture and don't see a clear home for it, either:

1. Add a section to the closest matching feature doc and reference it from its
   `## Verified by` block, or
2. Open an issue if the fixture exercises behavior the feature docs haven't yet
   described.

## Orphaned docs (documented but no fixture coverage)

None of the 8 feature docs lack fixture coverage. The closest case is the
high-level overview material in each doc (e.g., the "Anatomy of an entity"
explainer in `entities.md`) — these are pedagogical, not behavioral, and don't
require pinning.

## See also

- [features/](features/) — the per-feature reference, each with its own `## Verified by`
- [`spec/conformance-tests.md`](../spec/conformance-tests.md) — fixture format + canonical serializer contract
- [`spec/cross-language-porting-guide.md`](../spec/cross-language-porting-guide.md) — how a new port wires up against the corpora
- [`fixtures/conformance/ERROR-CODES.json`](../fixtures/conformance/ERROR-CODES.json) — the enumerated error codes every `error-*` fixture pins
- [`docs/RELEASING.md`](RELEASING.md) — `scripts/integration-test.sh` runs `persistence-conformance` per port pre-release

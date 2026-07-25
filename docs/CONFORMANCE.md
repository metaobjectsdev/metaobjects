# Conformance coverage

The MetaObjects standard ships **19 shared conformance corpora** under
[`fixtures/`](../fixtures/). Every port runs every corpus that is *applicable to
it* and asserts the same expected behaviour against the same fixtures. **This page
is the inverse index**: fixture → feature doc + per-port pass status, and it is the
single place per-corpus counts are maintained (the port READMEs deliberately point
here instead of restating them).

Not every corpus is a five-port corpus, and that asymmetry is deliberate rather
than a gap — schema migration is TypeScript-owned ([ADR-0015](../spec/decisions/ADR-0015-single-shared-migrate-engine.md)),
Kotlin runs on the JVM and inherits the Java loader/render/extract engines instead
of re-implementing them, and a few corpora gate tooling that only one port ships.
The dark cells below say which is which.

If you are coming from a feature doc's `## Verified by` section, you are in the
right place. If you are wondering whether a particular fixture has a
human-readable explanation somewhere, look it up in the
"Fixture-to-doc mapping" table below.

## Per-corpus totals

Counts are fixture directories (or scenario files, where a corpus is file-shaped);
regenerate with `ls -d fixtures/<corpus>/*/ | wc -l`.

| Corpus | Fixtures | TS | Java | Kotlin | C# | Python |
|---|---|---|---|---|---|---|
| [`fixtures/conformance/`](../fixtures/conformance/) (metamodel) | 249 | ✓ | ✓ | inherits via `metadata-ktx` | ✓ | ✓ |
| [`fixtures/yaml-conformance/`](../fixtures/yaml-conformance/) | 15 | 15 / 15 | 14 / 15 (1 ledgered: `yaml-quoted-leading-zero` — Java pipeline strips quotes off `"007"`) | inherits via Java | 14 / 15 (1 ledgered: `error-yaml-coerced-hex-in-string` — YamlDotNet doesn't coerce `0xFF`) | 15 / 15 |
| [`fixtures/verify-conformance/`](../fixtures/verify-conformance/) | 31 | ✓ | ✓ | inherits via Java | ✓ | ✓ |
| [`fixtures/verify-strict-conformance/`](../fixtures/verify-strict-conformance/) | 1 | ✓ | — | — | — | ✓ |
| [`fixtures/render-conformance/`](../fixtures/render-conformance/) | 15 | ✓ | ✓ | inherits via Java | ✓ | ✓ |
| [`fixtures/extract-conformance/`](../fixtures/extract-conformance/) | 33 | ✓ | ✓ | inherits the shared JVM engine | ✓ | ✓ |
| [`fixtures/output-prompt-conformance/`](../fixtures/output-prompt-conformance/) | 14 | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`fixtures/persistence-conformance/`](../fixtures/persistence-conformance/) | 30 (24 query + 6 migration) | all 30 | 24 query (migrations TS-only, ADR-0015) | 24 query (via Exposed) | 24 query | 24 query |
| [`fixtures/api-contract-conformance/`](../fixtures/api-contract-conformance/) | 41 (26 core + 8 tph + 3 m2m + 2 jsonb + 2 write-through) | ✓ (Fastify reference + generated lane) | ✓ (embedded HTTP + JDBC) | ✓ (embedded HTTP + Exposed) | ✓ (HttpListener + Npgsql) | ✓ (FastAPI + pg8000) |
| [`fixtures/validation-conformance/`](../fixtures/validation-conformance/) | 16 cases | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`fixtures/registry-conformance/`](../fixtures/registry-conformance/) | 1 canonical manifest | ✓ (reference emitter) | ✓ | ✓ | ✓ | ✓ |
| [`fixtures/object-model-conformance/`](../fixtures/object-model-conformance/) | 1 shared metadata fixture (per-port scenarios) | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`fixtures/codegen-conformance/`](../fixtures/codegen-conformance/) | 4 | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`fixtures/template-codegen-conformance/`](../fixtures/template-codegen-conformance/) | 3 | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`fixtures/template-output-render-conformance/`](../fixtures/template-output-render-conformance/) | 4 | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`fixtures/generator-registry-conformance/`](../fixtures/generator-registry-conformance/) | 1 canonical manifest | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`fixtures/provider-composition-conformance/`](../fixtures/provider-composition-conformance/) | 5 cases | ✓ | ✓ | — (JVM registry via Java) | ✓ | ✓ |
| [`fixtures/agent-context-conformance/`](../fixtures/agent-context-conformance/) | 4 | ✓ (the emitter is TS-owned) | — | — | — | — |
| [`fixtures/metamodel-docs/`](../fixtures/metamodel-docs/) | 1 | ✓ (docs emit is TS-owned) | — | — | — | — |

A ✓ means the port runs the corpus green; an explicit `n / m` is used where a port
carries a ledgered divergence. The two ledgered YAML fixtures are documented
library-vs-pipeline divergences (see the `_comment` block in each port's
`yaml-conformance-expected-failures.json` for the full reconciliation note). They
are tracked as known-gaps rather than silently patched — the runner treats listed
fixtures as passing, but a future port-level reconciliation pass would close them.

Per-port runners + commands:

| Port | Metamodel + YAML + render + verify | Persistence | API contract |
|---|---|---|---|
| TypeScript | `cd server/typescript && bun test` (per-package, `~3s`) | `scripts/integration-test.sh ts` (needs Docker) | `cd server/typescript/packages/integration-tests && bun test test/api-contract.test.ts` (needs Docker) |
| Java | `cd server/java && mvn -pl metadata test` (and per-tier `-pl render`, etc.) | `scripts/integration-test.sh java` (needs Docker) | `mvn -f server/java/integration-tests/pom.xml test -Dtest=ApiContractConformanceTest` (needs Docker) |
| Kotlin | `cd server/java && mvn -pl codegen-kotlin test` (snapshot suite) | `mvn -f server/java/integration-tests-kotlin/pom.xml test` (needs Docker) | `mvn -f server/java/integration-tests-kotlin/pom.xml test -Dtest=ApiContractConformanceTest` (needs Docker) |
| C# | `dotnet test` (per project) | `scripts/integration-test.sh csharp` (needs Docker) | `dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj --filter "FullyQualifiedName~ApiContractConformanceTest"` (needs Docker) |
| Python | `pytest` (per package) | `scripts/integration-test.sh python` (needs Docker) | `cd server/python && uv run --extra integration pytest tests/integration/test_api_contract.py` (needs Docker) |

The `persistence-conformance` corpus is intentionally **on-demand** — none of the
unit-test runners (`bun test`, `dotnet test`, `pytest`, `mvn test`) pull Docker.
`scripts/integration-test.sh` is the entry point and is wired into
[`docs/RELEASING.md`](RELEASING.md) §2b as the pre-`latest` gate.

## Fixture-to-doc mapping

### `fixtures/conformance/` — metamodel loader + canonical serializer (249)

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

### `fixtures/yaml-conformance/` (15)

All 15 fixtures → [features/yaml-authoring.md](features/yaml-authoring.md). The corpus
splits into 7 happy-path fixtures (sigil-free attrs, array suffix, anchor/alias,
block scalars, mixed bare-and-prefixed, quoted leading zero, etc.) and 6
`error-yaml-*` fixtures that pin the YAML 1.1 coercion guards (bool / null / hex
in string contexts; numeric in enum contexts; reserved-as-attr).

### `fixtures/render-conformance/` (15)

All 15 fixtures → [features/templates-and-payloads.md](features/templates-and-payloads.md)
(render engine output section). 4 are end-to-end shape examples (prompt / email /
spreadsheet / CSV-injection escape); 10 pin Mustache-engine semantics — dotted-path
lookup, parent-context fallthrough, falsy/empty-array section behavior, inverted
sections, nested partials, standalone-tag whitespace stripping, raw-HTML bypass,
trailing-newline preservation, and unicode multibyte handling.

### `fixtures/verify-conformance/` (31)

All 31 fixtures → [features/migrations-and-drift.md](features/migrations-and-drift.md)
(template drift section — `Renderer.verify`).

### `fixtures/persistence-conformance/` (29 — 24 query + 5 migration)

- `migrations/*` (6) → [features/migrations-and-drift.md](features/migrations-and-drift.md) (schema migration section)
- `queries/*` (24) → [features/source-kinds.md](features/source-kinds.md) (query semantics against `source.rdb`)

### `fixtures/api-contract-conformance/` (41)

All 41 scenarios → [features/api-contract.md](features/api-contract.md) (cross-port
REST API URL grammar + JSON wire format). Verifies every backend's emitted CRUD
routes answer identically over HTTP — list / get / create / patch+put / delete,
plus pagination (`limit`/`offset`), sort (`sort=field:dir`), the `withCount=1`
envelope, the `not_found` / `invalid_sort` error envelopes, and the 201 / 204
status codes.

The corpus also covers the 9 cross-port filter operators (`eq`, `ne`, `gt`,
`gte`, `lt`, `lte`, `in`, `like`, `isNull`) plus the implicit-AND combinator
and 2 error shapes (`invalid_filter_field` / `invalid_filter_op`) under the
URL grammar `?filter[<field>][<op>]=<value>` (FR-009). On top of the 26 core
scenarios the corpus carries four sub-corpora — `tph/` (8, single-table
inheritance), `m2m/` (3), `jsonb/` (2, typed value-object columns) and
`write-through/` (2, table-write + view-read entities). All 5 ports — TS, Java,
Kotlin, C#, Python — run it in BOTH lanes: a hand-rolled reference server and
the port's own GENERATED API artifact booted over HTTP.

## Orphaned fixtures (tested but not yet documented)

The fixtures in the six corpora mapped above (metamodel 249 + yaml 15 + verify 31
+ render 15 + persistence 30 + api-contract 41) each map to a feature doc. None
are orphaned today. The remaining corpora in the totals table gate tooling
contracts (registry manifests, provider composition, agent context, docs emit)
rather than user-facing metamodel behaviour, so they have no feature-doc row.

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

# Conformance Corpus

Language-neutral fixtures that define the MetaObjects standard's behavior. Every
language port runs every fixture through its own adapter. The corpus is the
contract — see [`spec/conformance-tests.md`](../../spec/conformance-tests.md).

Fixtures use the canonical metadata format: every node is a one-key map
`{ "<type>.<subType>": <body> }` (e.g. `object.entity`, `field.long`,
`identity.primary`). Reserved structural body keys are `name`, `package`,
`extends`, `abstract`, `overlay`, `isArray`, and `children`; everything else is
an `@`-prefixed attribute in alphabetical order. `expected.json` and
`expected-effective.json` are the authoritative reference for the shape — when
in doubt, read one.

Port status: the **metamodel loader + canonical serializer corpus is run by
four ports — TypeScript, C#, Java, and Python — all green.**

**Kotlin runs this corpus transitively, not as a separate run — by design.**
Kotlin has no distinct loader, parser, or canonical-serializer surface: the
`metadata-ktx` facade (`com.metaobjects.metadata.ktx.Loader`) forwards every
call straight to `MetaDataLoader` in the Java `metadata` module, which is the
single JVM implementation of the load/parse/canonical-serialize path this corpus
exercises. Java already runs the full corpus against that exact code
(`metadata/src/test/java/com/metaobjects/conformance/ConformanceTest.java`), so
wiring a parallel Kotlin metamodel-corpus run would re-invoke identical bytecode
through a Kotlin harness — redundant, with zero added coverage. Kotlin's
*distinct* surfaces (codegen via `codegen-kotlin`, runtime via Exposed) are gated
by their own corpora (render-conformance, persistence-conformance, and
api-contract-conformance, all of which Kotlin runs as a first-class port). The
shared metamodel **vocabulary** Kotlin emits is additionally byte-gated by
`fixtures/registry-conformance/` (Kotlin is live + green there).

## A scenario directory

```
<scenario>/
├── input/*.json          # metadata under test (one shared copy)
├── providers.json        # optional — provider ids to compose (default: ["metaobjects-core-types"])
├── expected.json         # optional — golden canonicalSerialize of the resolved tree
├── expected-effective.json  # optional — golden canonicalSerialize of the effective tree
├── expected-errors.json  # optional — list of { "code": "ERR_*" } the load must produce
└── script.json           # optional — operation-script: API-surface checks
```

A scenario runs whatever checks its expectation files declare. A fixture with
only `expected.json` is a behavioral fixture; one with `script.json` adds
API-surface checks; a fixture may have both.

## script.json

```json
{
  "operations": [
    { "navigate": ["object:Program", "field:weekCount"],
      "invoke": "field.is-required",
      "expect": { "scalar": false } }
  ]
}
```

- `navigate` — path segments `type:name`, or `type[subType]` for nameless nodes.
- `invoke` — a capability-id, `<type>.<capability>` (kebab-case).
- `args` — optional flat map of scalar arguments.
- `expect` — a normalized result (see below).

## Normalized result vocabulary

| Kind | Meaning |
|---|---|
| `{ "names": [...] }` | ordered node-name list |
| `{ "name": "..." }` | a single node |
| `{ "absent": true }` | null / None / Optional.empty / undefined |
| `{ "scalar": <value> }` | string / number / boolean |
| `{ "subtype": "..." }` | a node's subtype |
| `{ "effective-tree": "<canonical string>" }` | a resolved subtree, canonical-serialized |
| `{ "error": { "code": "ERR_*" } }` | the invocation surfaced an error |

## Error codes

Fixtures assert error *codes*, never message prose. Codes are registered in
`ERROR-CODES.json`. Adding a code is an additive edit to that file.

## Array fields through the filter/sort tier (#335)

- `error-filterable-array-field` — a `field.string @isArray @filterable` fails
  `ERR_FILTERABLE_UNSUPPORTED_SUBTYPE`: no FR-009 operator (eq/ne/gt/gte/lt/lte/in/like/isNull)
  applies to a collection column.
- `error-sortable-array-field` — the same shape with `@sortable` in place of
  `@filterable` fails `ERR_SORTABLE_UNSUPPORTED_SUBTYPE`: a collection column has
  no ordering.

A structural scan of the whole repo (1321 JSON + 124 YAML files) found **zero**
fields carrying both `isArray: true` and `@filterable`/`@sortable: true` before
these two fixtures were added — they are the **only** cases in the corpus that
exercise an array field through the filter/sort tier, so they are what makes the
rule (added to the TypeScript loader for #335) a cross-port contract rather than
a TS-only unit test.

## Adding a fixture

Create a directory; add `input/` and expectation files. No runner code changes —
discovery is automatic. A new fixture a port cannot yet pass goes in that port's
`conformance-expected-failures.json` ledger.

## When a fixture is removed because its vocabulary was retired

A corpus that stops exercising a path emits no diagnostic — removing a fixture is
silent. So every removal records what it covered and where that coverage went.

**FR-037 R2 (#336) — `origin.collection` retired to reserved-not-registered:**

| Removed | What it covered | Where the coverage lives now |
|---|---|---|
| `origin-collection-simple` | the subtype parses + round-trips on a projection host | nothing to cover: the subtype is deregistered. Replaced by `error-origin-collection-retired`, which asserts the same declaration on the same legal host now fails `ERR_UNKNOWN_SUBTYPE` — the retirement is proved where the use was previously VALID |
| `error-value-origin-collection` | #210 — an assembly origin is illegal on an `object.value` host | its three siblings, all present and green: `error-value-origin-aggregate`, `error-value-origin-computed`, `error-value-origin-first`. The rule is a property of the shared `ASSEMBLY_ORIGIN_SUBTYPES` constant, not of a per-subtype branch |

**Coverage genuinely lost, stated rather than faked:** `flattened-kitchen-sink`
dropped its `supplierBriefs` field, the corpus's only array-of-value-object
carrying an origin. No surviving origin expresses a whole-object rollup along a
relationship — `origin.aggregate @agg:collect` reduces a *column* via `@of`. That
shape becomes expressible again when [#335](https://github.com/metaobjectsdev/metaobjects/issues/335)
makes `@of` optional on `collect`; the fixture is the place to restore it.

## Generated fixtures (differential testing)

`generated-*` directories are produced by the differential fixture generator
(`conformance generate <corpusRoot> <count> [startSeed]`). Each fixture's
`expected.json` golden is captured from the TS reference implementation at
generation time (spec §7.2).

**Important (spec §7.5):** a port diverging on a `generated-*` fixture does
not automatically mean the port is wrong. The TS reference is the oracle only
insofar as it is correct. If a port disagrees with a generated golden,
investigate both sides: the port may be right and the TS reference may have a
bug. Do not auto-conform ports to a generated golden without understanding the
divergence.

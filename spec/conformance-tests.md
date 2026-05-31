# Cross-Language Conformance Tests

The MetaObjects standard ships with a conformance test suite that the language implementations run. There are now **seven corpora** spanning loader, YAML desugar, render, verify, codegen-walk, persistence, and API contract; this document specifies the **metamodel (loader) corpus** (`metaobjects/fixtures/conformance/`) — the **shared source of truth** for Loader behavior — and the canonical serializer contract. The other corpora are summarized under [Sibling corpora](#sibling-corpora-render-and-verify).

The loader corpus is run by the four ports that have their own Loader (TS, Java, Python, C#). **Kotlin** is the fifth port; it consumes the Java metadata via the `metadata-ktx` facade rather than re-implementing a Loader, so it participates in the persistence and API-contract corpora but not the loader/YAML/render/verify corpora.

> The full corpus × port run-matrix, known coverage gaps, and a remediation backlog live in [`docs/superpowers/specs/2026-05-29-conformance-hardening-review.md`](../docs/superpowers/specs/2026-05-29-conformance-hardening-review.md). Consult it before treating "all green" as full coverage.

## Why conformance fixtures?

Without a shared test surface, each language's Loader behavior drifts independently — overlay merging works one way in TS and a subtly different way in Java, and nobody notices until a real consumer hits the mismatch. The conformance suite makes parity testable, not aspirational.

Inspirations: Apache Arrow integration tests, IEEE 754 test vectors, the JSON Schema official test suite.

## What conformance covers

| In scope | Out of scope |
|---|---|
| Loader behavior — parsing, merge, extends resolution, validation | Codegen **byte**-equivalence (each language emits idiomatic code). *Semantic* codegen parity is a separate, planned corpus (FR-007), not a non-goal — see the hardening review. |
| Error messages emitted on bad metadata | Runtime behavior (filter parsing, ObjectManager, etc. — these get per-language unit tests) |
| Warning messages on drift cases | UI / hooks / fastify integration |
| Canonical serialized metamodel output | Wire format of generated CRUD endpoints (covered separately in spec/wire-format.md) |

## Fixture directory format

Every fixture is a directory under `metaobjects/fixtures/conformance/`. Each fixture has:

```
<fixture-name>/
├── input/                       # required — one or more metadata files
│   ├── meta.foo.json
│   └── meta.bar.json            # multiple files for overlay/multi-file scenarios
├── expected.json                # happy-path: canonical metamodel
├── expected-errors.json         # error case: FR5a envelope { errors: [...], warnings: [] }
└── expected-warnings.json       # optional: array of warning message strings
```

**Exactly one** of `expected.json` or `expected-errors.json` must be present:
- `expected.json` → the Loader is expected to succeed (no errors). The canonical serialized output of the loaded root MUST deep-equal this file. The canonical shape is the **fused-key form** documented in [`wire-format.md`](wire-format.md) — every node is `{ "<type>.<subType>": <body> }`.
- `expected-errors.json` → the Loader is expected to emit errors. Post-FR5a (ADR-0009), the file is an envelope object:

  ```jsonc
  {
    "errors": [
      {
        "code": "ERR_BAD_ATTR_VALUE",
        "source": {
          "format": "json",
          "files": ["meta.users.json"],
          "jsonPath": "$['metadata.root'].children[0]['object.entity']..."
        }
      }
    ],
    "warnings": []
  }
  ```

  Per ADR-0009, every port's harness asserts (in declaration order, per error): `code`, `source.format`, `source.files`, and `source.jsonPath`. Error *message text* is NOT compared — only the stable `ErrorCode`; message wording is Tier-2 (idiomatic per language). Other envelope fields (`suggestions`, `fixture`, `node`, `yamlPosition`) are RECOMMENDED-only and are not asserted by the cross-port harness.

  The legacy `[{ "code": "ERR_*" }]` array shape remains accepted by every port's parser for backward compat (the envelope assertion is skipped, only the code-set is compared) — pre-FR5a fixtures continue to work without rewrite. The cross-port migration of the corpus to the envelope shape lands in the FR5a coordinated work.

`expected-warnings.json` is optional. When present, the set of warnings MUST equal this list. When absent on a happy-path fixture, warnings are asserted empty.

### Fixture naming

- Happy-path: `<topic>-<scenario>` — e.g. `loader-basic-single-file`, `extends-multi-level`, `overlay-same-package-merge`.
- Error: `error-<topic>-<scenario>` — e.g. `error-extends-nonexistent`.
- Warning: `warning-<topic>-<scenario>` — e.g. `warning-filterable-no-index`.

Kebab-case throughout. No leading numbers. Names persist forever across all language implementations — once a fixture exists in CI history, renaming it requires coordination.

## Canonical serializer contract

The conformance test depends on **deterministic** serialization: the same metamodel must produce the same bytes in every language.

### Node encoding

Every node is a one-key map of the form `{ "<type>.<subType>": <body> }`. The wrapper key
fuses type and subType — there is **no separate `subType` body key** in the canonical form.
Examples: `metadata.root`, `object.entity`, `field.long`, `identity.primary`,
`source.rdb`, `origin.aggregate`.

### Key ordering within each node body

```
1. name             (when non-empty)
2. package          (when set)
3. extends          (when set)
4. abstract         (when true)
5. overlay          (when true)
6. isArray          (when true — structural, NOT an @-attr)
7. @-prefixed attrs (alphabetical order within this section)
8. children         (declaration order — NOT alphabetized)
```

These are the **only** reserved structural keys. Everything else inside a body is either an
`@`-prefixed attribute or invalid.

### Other rules

- **2-space indent**. JSON output is pretty-printed.
- **Trailing newline**. Output ends with exactly one `\n`.
- **No implicit defaults**. If the parser would infer a value, and the input metadata omits it, the canonical output ALSO omits it. (Subtype is fused into the wrapper key and is always present there.)
- **`@`-attrs in alphabetical order**. Inline `@`-attrs within a single node are sorted alphabetically. Structural keys keep their documented order from the table above.
- **Children in declaration order**. The order of children inside `children: [...]` reflects authoring order, not alphabetical order. Overlay merge appends; it does NOT re-sort.
- **`@fields` normalization**. Authoring may write `"@fields": "id"` (scalar); canonical form is always the array form `"@fields": ["id"]`.

### Errors and warnings: code-set + envelope-deep-equal

Errors are compared at two layers (per FR5a / ADR-0009):

1. **Code-set check** — sorted sets of `code` values from `expected-errors.json` (envelope or legacy form) vs the loader-emitted codes. Order-independent (mirrors validation-pass dispatch order quirks).
2. **Envelope assertion (envelope-shape fixtures only)** — for every error in declaration order, the harness asserts `code`, `source.format`, `source.files`, and `source.jsonPath` exactly. JSONPath is the canonical form per [ADR-0009](decisions/ADR-0009-loader-error-envelope-and-source-on-node.md) — byte-identical across ports.

Warnings remain compared as **sorted sets of message strings**. Error *message text* is never compared — only the stable `ErrorCode`; message wording is Tier-2 (idiomatic per language).

Pre-FR5a fixtures using the legacy `[{"code": "..."}]` array shape get only the code-set check; the envelope assertion is skipped.

### Multi-file load order (FR5c)

Finalized 2026-05-27 across all four ports (TS / C# / Java / Python). When a fixture's `input/` directory contains more than one `meta.*.json` file, every port loads them in **case-sensitive alphabetical order of basename** before merging. This is a cross-port contract — the order determines:

- which file is the `overlay-base` (alphabetically first) and which are `overlay-extension`s on a merged node's `source.contributors[]`;
- the `files[]` list inside an `ERR_MERGE_CONFLICT` or `WARN_DUPLICATE_DECLARATION` envelope (also alphabetical, byte-identical across ports).

Last-writer-wins still governs non-conflicting attr overlays (one side unset, or both sides set to the same value). When both contributors set the same `@attr` to *different* non-empty values, the loader raises `ERR_MERGE_CONFLICT` with a `format: "merged"` envelope listing both contributors. When two files declare a node and the second contributes no semantic change (per the FR5a `semantic_diff`), the loader emits `WARN_DUPLICATE_DECLARATION` and the merged node's `source` is **not** upgraded to `format: "merged"`.

**WARN envelope-shape assertion** (finalized 2026-05-27, all four ports): every port's conformance runner asserts envelope shape on `warnings[]` (code + source.format + source.files + source.jsonPath) when the fixture's `expected-errors.json` declares warning entries with `source`. Algorithm mirrors errors: per-warning code first, then per-element source-field comparison in declaration order. The `warning-duplicate-declaration` fixture is the reference — declared in `expected-errors.json#warnings[]` only (the legacy `expected-warnings.json` string-list path is retired). Cross-port byte-identical: TS / C# / Java / Python all emit the same three-warning envelope (Subscriber + id + email, each `source.format=merged` listing both contributing files).

## TS conformance runner

Lives at `typescript/packages/metadata/test/conformance.test.ts`. Algorithm:

```
for each subdirectory of fixtures/conformance/:
    fixture = subdirectory.name
    inputDir = subdirectory / "input"

    load result = Loader().loadFromDirectory(inputDir)

    if expected-errors.json exists:
        envelope = parse(expected-errors.json)   # envelope or legacy array
        assert sorted(codes(result.errors)) == sorted(codes(envelope))
        if envelope is FR5a-shaped (not legacy array):
            for i, (want, got) in enumerate(zip(envelope.errors, result.errors)):
                assert want.code == got.code
                assert want.source.format == got.source.format
                assert want.source.files == got.source.files
                assert want.source.jsonPath == got.source.jsonPath
            assert len(envelope.warnings) == len(result.warnings)
        stop

    assert result.errors is empty
    canonical = canonicalSerialize(result.root)
    expected = parse expected.json
    assert JSON.parse(canonical) deep-equals expected

    if expected-warnings.json exists:
        assert sorted(result.warnings) == sorted(expected-warnings.json)
    else:
        assert result.warnings is empty
```

## C# conformance runner

Lives at `csharp/MetaObjects.Conformance.Tests/` and runs via `dotnet test`. Same fixture
directory, same canonical output. Auto-discovers fixtures from
`metaobjects/fixtures/conformance/` via `FixtureDiscovery`. If the C# implementation
produces a different canonical string for any fixture, that's a bug in C#'s Loader or
serializer — not in the fixture.

## Java conformance runner

Lives at `server/java/metadata/src/test/java/com/metaobjects/conformance/ConformanceTest.java`
and runs via `mvn -pl metadata test`. Same fixture directory, same canonical output.
If the Java implementation produces a different canonical string for any fixture,
that's a bug in Java's Loader or serializer — not in the fixture.

## Adding a new fixture

1. Create the directory: `mkdir -p metaobjects/fixtures/conformance/<fixture-name>/input`
2. Add one or more `meta.*.json` files to `input/`.
3. Decide if it's happy-path, error, or warning:
   - Happy-path → add `expected.json` (canonical metamodel) and optionally `expected-warnings.json`.
   - Error → add `expected-errors.json` (FR5a envelope: `{ "errors": [{ "code": "ERR_*", "source": { "format": "...", "files": [...], "jsonPath": "$..." } }], "warnings": [] }`).
4. Run the TS conformance test — the new directory is auto-discovered:
   `cd typescript/packages/metadata && bun test test/conformance.test.ts -t "<fixture-name>"`
5. If the test fails with "actual vs expected" diff, you have a choice:
   - Adjust `expected.json` to match actual canonical output (most common).
   - File an issue: the Loader's behavior on this input might be wrong.

## Sibling corpora: render and verify

The corpus above (`fixtures/conformance/`) covers **Loader** behavior. Two
**sibling corpora** cover the FR-004 render/prompt tier. Each is a separate
top-level directory with its own per-engine runner: a port runs a sibling corpus
only once it implements that engine, exactly as it runs the loader corpus once it
has a Loader. They are **not** gated by `conformance-expected-failures.json` —
that ledger is loader-corpus only.

- **`fixtures/render-conformance/`** — byte-exact render output. Run by TS, C#, Java, and Python. Java asserts byte-equality against the shared baseline with an explicit `KNOWN_DRIFT` ledger (`server/java/render/KNOWN_DRIFT.md`). **Kotlin does not run this corpus** (no standalone render engine).
- **`fixtures/verify-conformance/`** — template drift-check output. Run by TS, C#, Java, and Python (below).

Two further corpora cover the **runtime** tier and are exercised by **all five ports, including Kotlin**, on demand against Testcontainers Postgres via `scripts/integration-test.sh` (these are **not** in the default `test` path for the JVM/.NET ports — see the hardening review):

- **`fixtures/persistence-conformance/`** — CRUD / filter / projection round-trips. The **query** scenarios run on every port; each port provisions its test DB by **executing the committed, TS-produced `canonical/schema.postgres.sql`** (no port synthesizes schema) and then exercises its runtime data-access layer. Per ADR-0015 schema migrations are TS-owned, so the **migration** scenarios are run by **TS only**, and the cross-port query corpus is **Postgres-only** (Derby was dropped for it).

  **Wire-type normalization + projection reads are gated by these shared round-trips on all five ports** (see `fixtures/persistence-conformance/normalization.md` for the per-type canonical rules):
  - **REAL/DOUBLE** → plain-decimal strings, no trailing zeros, no exponential notation (`queries/measurement-floats.yaml`).
  - **uuid** (lowercase canonicalization), **jsonb** (key-sorting), **TIMESTAMPTZ** (seeded with a non-UTC offset, read back as UTC `Z` — proving normalization, not mere formatting), plain **TIMESTAMP** (no `Z`), **DATE**, **TIME** (`queries/normalization-wire-types.yaml`, with companion coverage in `queries/asset-uuid-roundtrip.yaml`).
  - **projection reads** — passthrough-view read (`queries/projection-passthrough.yaml`) and `sum`/`avg`/`min`/`max`/`count` aggregates over a VIEW, including the aggregate-over-zero-rows NULL semantics (`queries/projection-aggregates.yaml`, `queries/projection-aggregate.yaml`). These also pin INTEGER→number, BIGINT→string, and NUMERIC→no-trailing-zeros-string.

  Because this end-to-end round-trip enforces the canonical wire shape identically across ports, the **divergent per-port normalization _unit_ tests were retired** (they had drifted in coverage — TS ~9 cases, Java/Kotlin 4, Python 3 — and are now subsumed). Each port keeps its `Normalization` **helper module** (the runner depends on it). The **only** unit assertion kept per port is the out-of-band float guard (`canonicalFloat`/`normalize_value` must **throw/raise** on exponential-notation values) — a value that must throw cannot be expressed as a successful round-trip seed, so it stays a standalone unit test (TS `normalization.test.ts`, Java/Kotlin `NormalizationFloatTest`, Python `test_normalization.py`). C# never had a separate normalization unit test (only the runner + helper), so nothing was removed there.
- **`fixtures/api-contract-conformance/`** — emitted CRUD routes answered over real HTTP (URL grammar + wire format).

A `fixtures/render-conformance/template-generator/` sub-corpus additionally exercises the codegen *walk* (file-per-entity inventory + render) in TS, C#, Java, and Python.

### Verify-conformance corpus

`verify` is the build-time drift gate: it parses a template's text and
cross-checks every `{{var}}`, `{{#section}}`, and `{{> partial}}` against the
*declared field tree* of the template's payload view-object — catching "a renamed
field silently broke a prompt". This corpus is the cross-language oracle for that
check: the same (payload-tree + template + options) MUST produce the same set of
drift findings in every port that implements `verify`.

Each fixture is a directory under `fixtures/verify-conformance/`:

```
<fixture-name>/
├── payload.json              # required — the payload FIELD-TREE (declared shape, not data)
├── template.mustache         # required — the template text whose vars are checked
├── partials/<name>.mustache  # optional — partial bodies, referenced as `partials/<name>`
├── options.json              # optional — { "requiredSlots"?: string[], "provider"?: "with" | "without" }
└── expected-drift.json       # required — array of { "code", "path" } findings (compared as a sorted multiset)
```

- **`payload.json`** is a `PayloadField[]` — the recursive field tree a port
  derives from an `object.value` view-object. A node *with* a `fields` array is a
  context-pushing field (object / array-of-object); a node *without* is a scalar:

  ```json
  [
    { "name": "displayName" },
    { "name": "posts", "fields": [
      { "name": "title" },
      { "name": "tags", "fields": [{ "name": "name" }] }
    ] }
  ]
  ```

  (This differs from `render-conformance`'s `payload.json`, which holds render
  *data*. Here it is the declared *shape*.)

- **`template.mustache`** is the entry template. Whitespace/literal text is
  irrelevant to drift — `verify` reads only tag structure, not output. Use only
  plain interpolation, sections, inverted sections, and partials: the C#/Python
  ports use a purpose-built tag tokenizer that does **not** model Mustache
  set-delimiter directives (`{{=<% %>=}}`), so a fixture using them would diverge
  from the TS engine (which parses with the real `mustache` library).

- **`partials/`** holds partial bodies; `partials/tone.mustache` is resolvable as
  `{{> partials/tone}}`. Same convention as `render-conformance`.

- **`options.json`** (optional):
  - `requiredSlots` — slot names that MUST be referenced; an unreferenced one
    yields `ERR_REQUIRED_SLOT_UNUSED` (a warning-level finding).
  - `provider` — `"with"` passes a partial provider (built from `partials/`,
    possibly an empty map); `"without"` passes none, so `{{> ...}}` partials are
    not checked. **Default**: `"with"` iff a `partials/` directory exists, else
    `"without"`. The *unresolved-partial* case sets `"provider": "with"` with no
    `partials/` directory — an empty provider resolves nothing, so a
    `{{> ...}}` reference becomes `ERR_PARTIAL_UNRESOLVED`.

- **`expected-drift.json`** is a JSON array of `{ "code": "ERR_*", "path": "..." }`,
  where `code` is one of the three verify codes in
  [`ERROR-CODES.json`](../fixtures/conformance/ERROR-CODES.json)
  (`ERR_VAR_NOT_ON_PAYLOAD`, `ERR_PARTIAL_UNRESOLVED`, `ERR_REQUIRED_SLOT_UNUSED`),
  and `path` is the offending variable path, partial ref, or slot name. The list
  is compared as a **sorted multiset by `(code, path)`** — order-independent (a
  port's template-walk order is its own business, and ports need not sort the same
  way, only consistently within themselves), but duplicates are significant. Author
  the array sorted for readability (the runner sorts before comparing, so emit/author
  order is not asserted). An empty array `[]` means "no drift".

Fixture naming: `verify-<scenario>`, kebab-case (both clean and drift scenarios —
unlike the loader corpus, a verify fixture is not inherently an error case, so the
`error-` prefix does not apply).

#### Verify-conformance runner

Lives at `server/typescript/packages/render/test/verify-conformance.test.ts`.
Per fixture directory:

```
fields   = parse payload.json                       # PayloadField[]
template = read template.mustache
opts     = parse options.json (if present)
provider = (opts.provider ?? (partials/ exists ? "with" : "without")) == "with"
             ? InMemoryProvider built from partials/   # empty map if no partials/
             : none
actual   = verify(template, fields, { provider, requiredSlots: opts.requiredSlots })

assert every expected code is a known verify code              # typo guard
assert sortByCodePath(actual) == sortByCodePath(expected-drift.json)
assert verify(...) is identical across two runs                # determinism
```

Adding a fixture directory adds a test automatically — no code change required.

**Per-port runners** (same corpus, same algorithm; each parses `payload.json` into
its native `PayloadField` tree, builds a partial provider from `partials/`, and
compares drift as a sorted multiset):

| Port | `verify` engine | Verify-conformance runner |
|---|---|---|
| TypeScript | `server/typescript/packages/render/src/verify.ts` | `server/typescript/packages/render/test/verify-conformance.test.ts` |
| C# | `server/csharp/MetaObjects.Render/Verify.cs` | `server/csharp/MetaObjects.Render.Tests/VerifyConformanceTests.cs` |
| Java | `metaobjects-render` (`server/java/render`) | `server/java/render/src/test/java/com/metaobjects/render/VerifyConformanceTest.java` |
| Python | `server/python/src/metaobjects/render/verify.py` | `server/python/tests/render/test_verify_conformance.py` |

All four Loader-bearing ports (TS, C#, Java, Python) now run this corpus; Java
adopted it once its render tier and conformance harness landed. **Kotlin** does
not (no standalone `verify` engine). There is no per-port ledger for the verify
corpus (it follows the `render-conformance` precedent): a port runs it when it has
a `verify`, and is simply absent until then.

## What this suite does not test

- Codegen **byte** output (Drizzle/Zod for TS, Spring/JPA for Java, EF Core for C#, Pydantic/SQLAlchemy for Python, Exposed for Kotlin) — port-local snapshot tests. *Semantic* codegen parity (file inventory, type mapping, payload-VO shape) is planned as a separate corpus (FR-007).
- Runtime behavior beyond the persistence + api-contract corpora (`parseFilterParams`, `ObjectManager` internals, etc.) — per-language unit tests.
- CLI / tooling entry points (`meta gen` / `verify` / `migrate`), packaging/publish, and doc-gen output — currently **un-gated cross-port** (see the hardening review backlog, R1/R12/R13).
- Filesystem / OS edge cases (path normalization, file-system case sensitivity) — out of scope.

For everything else: **if a behavior should be identical across languages, write a conformance fixture.**

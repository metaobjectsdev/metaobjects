# Cross-Language Conformance Tests

The MetaObjects standard ships with a conformance test suite that every language implementation (TS, Java, Python, C#) runs. The suite lives at `metaobjects/fixtures/conformance/` and is the **shared source of truth** for Loader behavior.

This document specifies the fixture format and the canonical serializer contract so that the same fixture produces byte-identical expected output in every language.

## Why conformance fixtures?

Without a shared test surface, each language's Loader behavior drifts independently — overlay merging works one way in TS and a subtly different way in Java, and nobody notices until a real consumer hits the mismatch. The conformance suite makes parity testable, not aspirational.

Inspirations: Apache Arrow integration tests, IEEE 754 test vectors, the JSON Schema official test suite.

## What conformance covers

| In scope | Out of scope |
|---|---|
| Loader behavior — parsing, merge, extends resolution, validation | Codegen output (each language emits idiomatic per-language code; byte equivalence isn't the goal) |
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

## Java conformance runner (in progress, H3b)

Same algorithm. H3a (loader-restructure) shipped 2026-05-19; H3b (conformance harness) is
in progress. Will live at `java/<module>/src/test/java/com/metaobjects/ConformanceTest.java`.
Same fixtures, same canonical output. If the Java implementation produces a different
canonical string for any fixture, that's a bug in Java's Loader or serializer — not in the
fixture.

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

- **`fixtures/render-conformance/`** — byte-exact render output. Run by TS and C#.
- **`fixtures/verify-conformance/`** — template drift-check output. Run by TS, C#, and Python (below).

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
| Python | `server/python/src/metaobjects/render/verify.py` | `server/python/tests/render/test_verify_conformance.py` |

**Java** does not run this corpus yet: it has no cross-language conformance harness
on `main` and no render/`verify` tier (it is mid loader-restructure). It will adopt
the corpus once its conformance harness lands — exactly as it does not yet run the
loader or `render-conformance` corpora. There is no per-port ledger for the verify
corpus (it follows the `render-conformance` precedent): a port runs it when it has a
`verify`, and is simply absent until then.

## What this suite does not test

- Codegen output (Drizzle for TS, jOOQ for Java) — covered by per-language unit tests.
- Runtime behavior (`parseFilterParams`, `ObjectManager`, etc.) — per-language unit tests.
- Filesystem / OS edge cases (path normalization, file-system case sensitivity) — out of scope.

For everything else: **if a behavior should be identical across languages, write a conformance fixture.**

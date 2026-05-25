# FR5a — JSON-shape loader errors + envelope foundation (TS / C# / Java / Python)

**Status:** Design — plan-of-record
**Date:** 2026-05-25 (post-brainstorm)
**Scope:** **All four ports, coordinated landing.** TS / C# / Java / Python loaders
implement [ADR-0009](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md)
for the JSON-shape error class. Subsequent FRs cover the other classes (5b YAML, 5c
merge, 5d resolved, 5e database).
**Depends on:** ADR-0009 (the envelope shape + source-on-node contract).
**Coordination caveat:** Java is mid-H3b (conformance harness in progress) and Python
loader is Phase 1 (56/60 corpus green). Both can absorb this work in parallel with
their conformance maturation, but landing may stagger 2–4 weeks across ports — the
ADR specifies the shape, not the timing.

## Goal

Every loader error raised during the **JSON parse + per-node validation** phase of every
port carries the [ADR-0009 envelope](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md):

```jsonc
{
  "code": "ERR_UNKNOWN_TYPE",
  "message": "unknown type 'objct' at $.metadata.root.children[0]",
  "source": {
    "format": "json",
    "files": ["metaobjects/meta.example.json"],
    "jsonPath": "$.metadata.root.children[0].objct.entity"
  }
}
```

And every metadata node carries a populated `source` field — including the
programmatic / test-constructed case (`{ format: "code" }`).

## Per-port implementation

Each port does five things. The work is structurally identical; only the language /
loader architecture differs.

### 1. Add `source` to MetaData base class

| Port | Class | Change |
|---|---|---|
| TS | `@metaobjectsdev/metadata` `src/metadata.ts` (or wherever `MetaData` lives) | Add `source: ErrorSource` field; `ErrorSource` union type in a new `src/source.ts` module. |
| C# | `MetaObjects.Metadata.MetaData` | Add `Source` property (interface or abstract base). |
| Java | `com.metaobjects.MetaData` | Add `getSource() / setSource()` (or Lombok `@Data`). |
| Python | `metaobjects.meta.MetaData` | Add `source: ErrorSource` typed attribute. |

`source` is settable by loader phases; treated as `final` after the load pipeline
completes (no per-port type-level enforcement required — convention).

### 2. Thread source through the JSON parse

Each port's JSON parser already does a tree-walk. The change:

- Track the current JSONPath (canonical form per ADR-0009) as you descend.
- When constructing a metadata node, pass `{ format: "json", files: [filePath], jsonPath: <current> }` to the constructor.
- When raising an error mid-parse, attach the current `source` to the error envelope.

JSONPath construction is a small helper per port (~30 LOC): a stack/deque of segments
(`$`, `.foo`, `[2]`, `['my-key']`) that the walker pushes/pops as it descends. Quoting
rule comes from ADR-0009 (`^[A-Za-z_][A-Za-z0-9_]*$` for dot notation, else bracket).

### 3. Use `node.source` at non-parse error sites

Per-node validation that fires after parse (own-only attr validation, required-attr
checks, etc.) raises errors with `source: node.source` — already populated. No
threading required.

### 4. Programmatic construction defaults

Constructor / factory paths that don't carry a parser context default `source` to
`{ format: "code" }`. Tests and plugins that want richer info can pass an envelope
explicitly:

```ts
new MetaField({
  name: "id",
  source: { format: "code", caller: "QueriesTest.makePost" },
});
```

### 5. Update error-raising sites to emit the full envelope

Every existing throw / error-return is reviewed; ones that fire during JSON parse or
per-node validation now produce the envelope. Other sites (merge, reference resolution,
validation passes) remain in their existing skeletal shape — those are FR5b/5c/5d's
problem.

## Conformance corpus migration

**Existing error fixtures** (in `fixtures/conformance/`) get `expected.json` rewritten
to the array-of-envelopes shape:

```jsonc
// Before
{ "code": "ERR_BAD_ATTR_VALUE" }

// After (FR5a)
{
  "errors": [
    {
      "code": "ERR_BAD_ATTR_VALUE",
      "source": {
        "format": "json",
        "files": ["metaobjects/input.json"],
        "jsonPath": "$.metadata.root.children[0].field.enum.@values"
      }
    }
  ],
  "warnings": []
}
```

A new top-level `warnings: []` array (empty in most fixtures) makes room for the
warning channel from ADR-0009; the first fixture that triggers
`WARN_DUPLICATE_DECLARATION` will populate it (FR5c may add such fixtures).

The path values are derivable from each input fixture by inspection. Estimated work:
~30 minutes for the corpus rewrite, ~12-15 fixtures affected.

**Conformance harness extension** (per port, identically structured):

```
for each error_fixture:
  parsed = port.load(fixture.input)
  expected = fixture.expected
  assert len(parsed.errors) == len(expected.errors)
  for (got, want) in zip(parsed.errors, expected.errors):
    assert got.code == want.code
    assert got.source.format == want.source.format
    assert got.source.files == want.source.files
    assert got.source.jsonPath == want.source.jsonPath
    # suggestions, fixture, node — NOT asserted (T2)
```

T2 fields (`suggestions`, `fixture`, `node`) are not enforced by the cross-port
harness. Each port may run its own internal tests verifying its T2 implementations.

## Recommended T2 work (per port, optional in FR5a)

Each port may ship some or all of these alongside the mandatory work. Algorithms are
spec'd here for cross-port consistency, but conformance doesn't enforce.

### `suggestions[]` — did-you-mean

Algorithm:

1. Triggered on `ERR_UNKNOWN_TYPE`, `ERR_UNKNOWN_SUBTYPE`, `ERR_RESERVED_ATTR`, and
   `ERR_BAD_ATTR_VALUE` when the bad value looks like a typo of a known token.
2. Compute Levenshtein distance from the unknown token to each candidate in the
   known-token set (registered types/subtypes for the variant; reserved attr names
   for `RESERVED_ATTR`; etc.).
3. Threshold: `max(2, ceil(len(token) / 4))`.
4. Return up to 3 nearest, ranked by distance ascending.

Output:

```jsonc
"suggestions": ["did you mean 'field.enum' instead of 'field.enmu'?"]
```

### `fixture` — canonical example

Lookup table at `fixtures/conformance/ERROR_TO_FIXTURE.json`:

```jsonc
{
  "ERR_BAD_ATTR_VALUE": {
    "field.enum.@values": "enum-inline",
    "field.currency.@currency": "currency-storage-and-render"
  },
  "ERR_MISSING_REQUIRED_ATTR": {
    "field.enum.@values": "enum-inline"
  }
}
```

Ports populate `fixture` by looking up the (code, type-context) combination. Missing
entries are fine — `fixture` stays `undefined`.

### `node` — structural context

Populated when the error has a node reference in scope:

```jsonc
"node": {
  "type": "field",
  "subtype": "enum",
  "name": "ColorEnum",
  "fqn": "myapp::ui::ColorEnum"
}
```

## Tests + verification

### Cross-port conformance

- Conformance harness in each port asserts the four required envelope fields per
  fixture.
- Rewritten error fixtures land in the same commit as the harness change in each port.

### Per-port unit tests

- **JSONPath construction tests** — each port verifies its path-builder produces the
  canonical form on edge cases (special-character keys, empty arrays, nested children).
- **`source` field tests** — each port verifies the constructor stores `source` and
  the canonical-JSON serializer omits it.
- **`semantic_diff` tests** — even though FR5a's overlay-merge changes are minimal,
  the diff function is implemented and tested per ADR-0009 so FR5c can pick it up.
- **Programmatic default test** — node constructed via the public API without a
  source argument gets `{ format: "code" }`.

### Port-private T2 tests (optional)

- `suggestions[]` Levenshtein behaviour, including the threshold.
- `fixture` lookup against a populated `ERROR_TO_FIXTURE.json`.
- `node` context for representative error cases.

## What stays unchanged

- **Fail-fast semantics.** Loader stops at the first error; `errors[]` in fixtures is
  always length-1 in FR5a. Multi-error mode is out of scope.
- **Existing `ERR_*` code taxonomy.** No new codes in FR5a; existing codes get richer
  envelopes.
- **Canonical JSON serialization.** Round-trip fixtures unchanged; the canonical
  serializer continues to omit `source`.
- **All other generator / runtime / migrate code paths.** This FR touches only the
  loader pipeline + conformance harness + error envelopes.

## What's deferred

- **FR5b** — YAML authoring source positions (`yamlPosition` field; ADR-0006 substrate).
- **FR5c** — Multi-file merge error attribution (`format: "merged"`; warning channel
  exercise; `semantic_diff` consumer).
- **FR5d** — Reference resolution errors (`format: "resolved"`).
- **FR5e** — Database-source errors (`format: "database"`; gated on FR-003).

Each is a separate sketch in `docs/superpowers/specs/`.

## File-level change summary (per port)

**New files (per port, structurally identical):**

- TypeScript:
  - `server/typescript/packages/metadata/src/source.ts` — `ErrorSource` union type + `Contributor`/`NodeContext`/`LoaderError`/`LoaderWarning` types.
  - `server/typescript/packages/metadata/src/json-path.ts` — canonical JSONPath builder.
  - `server/typescript/packages/metadata/src/semantic-diff.ts` — `semantic_diff(a, b): boolean`.
- C#: `MetaObjects.Metadata/ErrorSource.cs`, `JsonPath.cs`, `SemanticDiff.cs`.
- Java: `com.metaobjects.source.ErrorSource`, `JsonPath`, `SemanticDiff` (separate files per Java convention).
- Python: `metaobjects/meta/source.py`, `json_path.py`, `semantic_diff.py`.

**Modified per port:**

- MetaData base class — adds `source` field.
- JSON loader / parser — threads JSONPath, constructs `source`, raises envelope-shaped errors.
- Conformance harness — asserts the four required envelope fields.
- Canonical serializer — explicitly omits `source` from JSON output (idempotency tested).

**Shared (cross-port):**

- `fixtures/conformance/<error-fixture>/expected.json` — rewritten to the
  `{errors[], warnings[]}` shape.
- `fixtures/conformance/ERROR_TO_FIXTURE.json` — new lookup table (optional consumer
  for T2 `fixture` field).
- `spec/conformance-tests.md` — documented new harness assertions.

## Open questions

None at the ADR or FR level — every load-bearing decision is settled.

Per-port impl questions (Levenshtein library choice, exception-vs-result-type for
the error channel) are owned by each port team.

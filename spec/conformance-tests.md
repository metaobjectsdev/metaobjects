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
├── expected-errors.json         # error case: array of error message strings
└── expected-warnings.json       # optional: array of warning message strings
```

**Exactly one** of `expected.json` or `expected-errors.json` must be present:
- `expected.json` → the Loader is expected to succeed (no errors). The canonical serialized output of the loaded root MUST deep-equal this file.
- `expected-errors.json` → the Loader is expected to emit errors. The set of error messages MUST equal this list (compared as sorted sets — order-independent).

`expected-warnings.json` is optional. When present, the set of warnings MUST equal this list. When absent on a happy-path fixture, warnings are asserted empty.

### Fixture naming

- Happy-path: `<topic>-<scenario>` — e.g. `loader-basic-single-file`, `extends-multi-level`, `overlay-same-package-merge`.
- Error: `error-<topic>-<scenario>` — e.g. `error-extends-nonexistent`.
- Warning: `warning-<topic>-<scenario>` — e.g. `warning-filterable-no-index`.

Kebab-case throughout. No leading numbers. Names persist forever across all language implementations — once a fixture exists in CI history, renaming it requires coordination.

## Canonical serializer contract

The conformance test depends on **deterministic** serialization: the same metamodel must produce the same bytes in every language.

### Key ordering within each node

```
1. package          (if non-empty)
2. name             (if non-empty)
3. subType          (always — being explicit is never wrong)
4. extends          (if set)
5. isAbstract       (if true)
6. @isArray         (if true — emitted with @ prefix, attr-like)
7. inline @-attrs   (alphabetical order)
8. children         (declaration order — NOT alphabetized)
```

### Other rules

- **2-space indent**. JSON output is pretty-printed.
- **Trailing newline**. Output ends with exactly one `\n`.
- **No implicit defaults**. If the parser would infer a value (e.g. `subType: "base"`), and the input metadata omits it, the canonical output ALSO omits it — UNLESS the field is `subType` itself, which is always emitted (because being explicit is never wrong).
- **Attrs in alphabetical order**. Inline `@-attrs` within a single node are sorted alphabetically. Structural keys (`name`, `subType`, etc.) keep their documented order from the table above.
- **Children in declaration order**. The order of children inside `children: [...]` reflects authoring order, not alphabetical order. Overlay merge appends; it does NOT re-sort.

### Errors and warnings as message lists

Errors and warnings are compared as **sorted string lists** to avoid ordering issues across validation passes. Each error/warning is its own line. The list is sorted alphabetically before comparison.

## TS conformance runner

Lives at `typescript/packages/metadata/test/conformance.test.ts`. Algorithm:

```
for each subdirectory of fixtures/conformance/:
    fixture = subdirectory.name
    inputDir = subdirectory / "input"

    load result = Loader().loadFromDirectory(inputDir)

    if expected-errors.json exists:
        assert sorted(result.errors) == sorted(expected-errors.json)
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

## Java conformance runner (planned, H3)

Same algorithm. Will live at `java/<module>/src/test/java/com/metaobjects/ConformanceTest.java`. Same fixtures, same canonical output. If the Java implementation produces a different canonical string for any fixture, that's a bug in Java's Loader or serializer — not in the fixture.

## Adding a new fixture

1. Create the directory: `mkdir -p metaobjects/fixtures/conformance/<fixture-name>/input`
2. Add one or more `meta.*.json` files to `input/`.
3. Decide if it's happy-path, error, or warning:
   - Happy-path → add `expected.json` (canonical metamodel) and optionally `expected-warnings.json`.
   - Error → add `expected-errors.json` (sorted list of error message strings).
4. Run the TS conformance test — the new directory is auto-discovered:
   `cd typescript/packages/metadata && bun test test/conformance.test.ts -t "<fixture-name>"`
5. If the test fails with "actual vs expected" diff, you have a choice:
   - Adjust `expected.json` to match actual canonical output (most common).
   - File an issue: the Loader's behavior on this input might be wrong.

## What this suite does not test

- Codegen output (Drizzle for TS, jOOQ for Java) — covered by per-language unit tests.
- Runtime behavior (`parseFilterParams`, `ObjectManager`, etc.) — per-language unit tests.
- Filesystem / OS edge cases (path normalization, file-system case sensitivity) — out of scope.

For everything else: **if a behavior should be identical across languages, write a conformance fixture.**

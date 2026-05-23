# Python port — Loader + Conformance (milestone P1) — Design

**Date:** 2026-05-23
**Status:** Approved (design)
**Author:** Doug Mealing (with Claude)
**Scope:** First Python implementation of the MetaObjects standard — the metadata **loader**
and a **conformance runner** over the shared corpus. Codegen and runtime are out of scope.
**Binding contracts:** ADR-0002 (Open-Closed typed nodes), ADR-0003 (constants colocation),
ADR-0004 (provider-based registration), ADR-0001 (type binding). Porting method:
`spec/cross-language-porting-guide.md`, `spec/conformance-tests.md`.

## Goal

Bring Python to **loader + conformance parity**: the same shape as the C# milestone (loader,
canonical serializer, a corpus runner), but built on the **current** extensibility model
(TS/Java post-refactor), not the stale C# internals. Definition of done: all 55 conformance
fixtures green (or honestly listed in the expected-failures ledger), plus an Open-Closed
proof test.

Carry forward — do not discard — the 2026-05-15 node-model spike
(`server/python/metaobjects/`, validated in `spec/cross-language-metadata-spike-findings.md`):
it is the seed of the real `MetaData` / `MetaObject` / `MetaField` classes.

## Non-goals (deferred to later milestones)

- **Python codegen.** When built, it will use Jinja2 templates + `ruff format` + the
  language-agnostic `git merge-file --diff3` three-way merge — **not** Mustache (Mustache is
  reserved for the FR-004 prompt-construction pillar, a different problem: byte-stable text
  rendering, not structured-code emission). Codegen output is explicitly *not* conformance-
  gated, so Python may emit idiomatic code.
- **Python runtime** (SQLAlchemy Core, filter parser, currency).
- **YAML input** (no fixture uses it; `ERR_MALFORMED_YAML` stays defined, unexercised).
- **Effective-serialization** and **multi-provider composition** (`ERR_PROVIDER_*`): zero
  fixtures exercise them; build the single-core-provider seam now, defer the rest.

## Tooling (Tier-2 / Tier-3)

- **`uv`** + `pyproject.toml` (hatchling build backend). **Python 3.11+**.
- **Zero runtime dependencies** (stdlib `json` only — the spike proved this is achievable).
  Dev dependencies: `pytest`, `mypy`.
- **src-layout.** `pytest` for both the corpus runner (parametrized, one id per fixture) and
  unit tests; `mypy` clean. TDD throughout.

## Package layout

```
server/python/
├── pyproject.toml
├── README.md                       # updated from the placeholder
├── src/metaobjects/
│   ├── __init__.py                 # barrel: re-exports public constants + classes (convenience)
│   ├── shared/                     # genuinely structural — NOT a god file
│   │   ├── structural.py           #   reserved keys (name/package/extends/abstract/overlay/isArray)
│   │   ├── separators.py           #   @ prefix, :: package sep, fused-key form
│   │   └── base_types.py           #   the base TYPE_* names + SUBTYPE_BASE/ROOT
│   ├── datatype.py                 # DataType enum + coarse classification
│   ├── data_converter.py           # type-directed JSON→value coercion (base subtypes)
│   ├── errors.py                   # ErrorCode enum (matches ERROR-CODES.json) + MetaError + exceptions
│   ├── registry.py                 # TypeRegistry, TypeDefinition (inherits_from), AttrSchema, ChildRule
│   ├── provider.py                 # MetaDataTypeProvider protocol + compose_registry (topo-sort)
│   ├── core_types.py               # the core provider: thin composition of per-concern registrations
│   ├── parser.py                   # JSON → node tree (owns inline-vs-child attr syntax)
│   ├── super_resolve.py            # deferred, package-aware extends resolution
│   ├── serializer_json.py          # canonical (fused-key) serializer
│   ├── meta/
│   │   ├── meta_data.py            # abstract base (expanded from the spike): attr instances, effective_*, freeze, cache
│   │   ├── meta_root.py
│   │   ├── core/
│   │   │   ├── object/             # meta_object.py + object constants/schema (colocated)
│   │   │   ├── field/              # meta_field.py (+ data_type behavior) + field constants/schema
│   │   │   ├── attr/               # meta_attr.py base + filter/stringarray/properties subclasses (self-register)
│   │   │   ├── validator/          # meta_validator.py + subtype subclasses + schema
│   │   │   ├── identity/           # meta_identity.py + primary/secondary/reference subclasses + schema
│   │   │   ├── relationship/
│   │   │   └── query/              # filter operators + sort-order vocab (shared query constants)
│   │   ├── presentation/           # view/  layout/  (dataGrid lives here)
│   │   └── persistence/            # source/  origin/
│   └── loader/
│       ├── meta_data_source.py     # source protocol (FileSource, InMemorySource)
│       ├── file_meta_data_loader.py# filesystem discovery (ordinal-sorted *.json)
│       ├── meta_data_loader.py     # core pipeline: merge → super-resolve → validate → freeze
│       └── validation_passes.py    # the 6 passes
└── tests/
    ├── conformance/
    │   ├── fixture_discovery.py
    │   ├── conformance_adapter.py
    │   ├── expected_failures.py
    │   ├── conformance-expected-failures.json   # the ledger
    │   └── test_conformance.py                  # pytest, parametrized over fixtures
    ├── open_closed_proof_test.py                # the Open-Closed regression guard
    └── unit/                                     # targeted per-component tests
```

The corpus root (`<repo-root>/fixtures/conformance/`) is resolved by walking **up** from the
test file — **no absolute or home paths** (public-repo hygiene).

## Extensibility model (the load-bearing part — Tier-1 contract)

Per ADR-0002/0003/0004, realized idiomatically in Python:

- **Constants colocated** with each concern module. The package-root `__init__.py` barrel
  re-exports for convenience; colocated definitions are the source of truth. No
  `constants.py` monolith, no `core_attr_schemas.py` monolith.
- **Behavior on the class.** `MetaAttr` base owns `data_type` / `coerce` / `validate_value` /
  `desugar`; `FilterAttr`, `StringArrayAttr`, `PropertiesAttr` override only what differs.
  `MetaField` base owns `data_type`. No central datatype map / coercion switch / validator
  subtype-set. Attributes are **fully materialized** as `MetaAttr` instances; the parser owns
  inline-vs-child syntax; canonical output is always inline `@name`.
- **Decorator self-registration + explicit composition.** Each subtype registers onto its
  domain provider:

  ```python
  @field_provider.register
  class StringField(MetaField):
      SUBTYPE = FIELD_SUBTYPE_STRING
      DATA_TYPE = DataType.STRING
      ATTRS = [...]                      # colocated attr schema
  ```

  `compose_registry([core_provider])` topo-sorts providers by dependency and builds the
  `TypeRegistry`. Importing a concern package (its `__init__`) triggers its subtypes'
  registration — deterministic, no SPI ceremony. Entry-point discovery is a documented future
  extension that does not change the seam.
- **Registry-level inheritance.** `TypeDefinition` supports `inherits_from(type, subtype)` so
  a subtype need not re-declare base attributes.

## Loader pipeline (Tier-1 semantics — mirror current TS/Java)

File discovery (ordinal-sorted `*.json`) → parse (BOM strip; `defer_super_resolution=True`;
parser materializes all attrs into instances) → multi-source overlay merge (same
package+name; last-writer-wins attrs; children accumulate) → deferred package-aware
super-resolution (bare / `::abs` / `..::rel`) → **6 validation passes** (subtype rules →
dataGrid sort field → filterable-without-index *warning* → origin paths → attr schema →
dataGrid filter values) → freeze → `LoadResult(root, errors, warnings)`.

Errors carry stable `ErrorCode`s matching `fixtures/conformance/ERROR-CODES.json` — the
corpus compares error **codes** (sorted set), not message text. See the porting guide §3/§5
for the per-stage details and the subtle behaviors (deferred resolution, `@fields` desugar,
whole-number-double serialization, positional package inheritance, fixed canonical key
order).

## Conformance harness

pytest-parametrized, one test id per fixture; check ordering identical to the TS/C# runner
(the *runner algorithm* is sound — only the C# loader *internals* are stale). Checks:
expected-errors (sorted code set) → expected.json (canonical bytes) → expected-warnings
(sorted set — Python checks warnings, like C#, unlike the current TS gap) → the one
`script.json` fixture (navigate/invoke) → no-expectation guard.

**Expected-failures ledger** (`conformance-expected-failures.json`): classifier returns
`pass` / `known-gap` / `fail` / `fixed-but-listed`; the test passes iff status ∈ {pass,
known-gap}. Seed with all 55 fixtures as known-gaps so CI is green from commit #1; remove
each as its slice lands. Never regenerate a golden to force green — escalate a suspect
fixture instead.

## Slice plan

Each slice ends with fixtures moving known-gap → pass, ledger updated:

0. **Harness + ledger green** — discovery, adapter, ledger seeded; CI green with everything a
   known-gap. Provider/registry seam + node bases + colocated constants stood up.
1. **Basic load + serializer** — single-entity load, canonical serialization
   (`loader-basic-*`, `smoke-empty-metadata`).
2. **extends / super-resolution** (`extends-*`).
3. **Overlay merge** (`overlay-*`).
4. **Subtype rules + identities** (`subtype-*`, `identity-*`).
5. **Relationships** (`relationship-*`).
6. **Sources + origins** (`source-*`, `origin-*`).
7. **Attr-schema + filter validation** (`attr-*`, `currency-*`, `layout-data-grid-*`,
   `auto-set-*`, the `error-*` fixtures).
8. **`script.json`** capability fixture (`extends-abstract-base`).
9. **Open-Closed proof test** — register a throwaway `attr.fizz` + `field.fizz` via only a
   class + a registration line; assert load→coerce→validate→serialize work and no central
   file was touched.

## Verification (not optional)

- `pytest` green: all 55 fixtures pass or are honestly listed as known-gaps; unit tests pass.
- `mypy` clean.
- The Open-Closed proof test passes.
- Canonical serializer output matches the corpus byte-for-byte for every happy-path fixture.
- No absolute/home paths committed; public-repo hygiene clean.

## Risks

- **Mirroring stale C#.** Mitigation: this design + the porting guide pin the current TS/Java
  model; ADR-0002/0003/0004 are the binding contracts. Read TS for pipeline, Java for
  extensibility — not C#.
- **Self-registration import-ordering.** A concern whose module isn't imported silently drops
  its subtypes. Mitigation: each concern package `__init__` imports its subtypes; a registry
  completeness assertion in tests.
- **Effective-attr / overlay-merge drift over instances.** Mitigation: the extends/overlay
  corpus fixtures + the Open-Closed proof.
- **Canonical byte drift** (key order, whole-number doubles, `@fields` desugar). Mitigation:
  the corpus is the oracle; the porting guide §5 enumerates the hazards.

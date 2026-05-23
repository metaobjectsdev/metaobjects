# Python Loader + Conformance — Phase 2 (metamodel type coverage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Register the remaining (non-prompt) metamodel subtypes so their fixtures parse and canonically serialize, plus the `attr.filter`/`attr.properties` value behavior — turning ~18 corpus fixtures from known-gap to green.

**Architecture:** Follows the Phase-1 Open-Closed pattern exactly (ADR-0002/0003/0004): each concern gets colocated constants + a node class + a `TypeDefinition` registration on `core_provider` in `core_types.py`. Canonical serialization needs only the type/subType registered (un-declared `@`-attrs flow through as base `MetaAttr` instances and serialize alphabetically); attr **schemas** are added only where a `stringArray` attr is authored as a scalar (needs desugar) or for the `attr.filter` desugar. No validation, no merge, no super-resolution here.

**Scope boundary:** Phase 2 is type coverage + attr behavior only. **Deferred:** multi-file/overlay merge + super-resolution (Phase 3); the validation passes — attr-schema, dataGrid sort/filter, origin-path, subtype-rules, filterable-without-index warning (Phase 4); the FR-004 `prompt.*` metatype (separate). Fixtures needing those stay in the ledger as known-gaps.

**Tech/process:** Python 3.11+, uv, pytest, mypy. Worktree `feat/python-loader-phase-2`. Run from `server/python`. **The conformance corpus is the oracle** — read each target fixture's `expected.json` for exact `@`-attr names and structure. **Ledger discipline:** each task implements its types, runs `uv run --extra dev pytest tests/conformance -q`, and **delists every fixture that now passes** from `tests/conformance/conformance-expected-failures.json` in the SAME commit (a passing-but-listed fixture is `fixed-but-listed` = a red test). Keep the whole suite green at every commit. Never delist a fixture that still fails.

**The Phase-1 pattern to copy** (read these before each task):
- A node class: `src/metaobjects/meta/core/field/meta_field.py` (data_type by subtype) and `src/metaobjects/meta/core/object/meta_object.py` (typed accessors).
- Colocated constants: `src/metaobjects/meta/core/field/field_constants.py`.
- Registration: the loops in `src/metaobjects/core_types.py` that build `TypeDefinition`s on `core_provider`.
- Attr behavior: `src/metaobjects/meta/core/attr/meta_attr.py` (`MetaAttr`/`StringArrayAttr`, self-registration into `attr_class_map`).

**Conventions for every task:** TDD where natural, but the real test is the conformance corpus — implement, run the conformance suite, delist newly-green fixtures, confirm `uv run --extra dev pytest -q` and `uv run --extra dev mypy` both green, commit. Fix mypy strictly (remove unused ignores; prefer `cast`). Public repo — no home paths / private names. If the commit guard rejects, STOP (never `--no-verify`).

---

### Task P2.1: Missing field subtypes + `field.currency`

**Files:** modify `src/metaobjects/meta/core/field/field_constants.py` (add subtypes), `src/metaobjects/meta/core/field/meta_field.py` (data_type map). No new files.

Phase 1 registered `field.{string,int,long,double,float,boolean,date}`. Add the rest the corpus uses: `timestamp`, `time`, `decimal`, `object`, `class`, `currency`. Extend `FIELD_SUBTYPES` and the `_FIELD_DATA_TYPE` map (timestamp/time/date → `DataType.DATE`; decimal → `DataType.DOUBLE`; object/class/currency → `DataType.OBJECT`/`STRING`/`LONG` respectively — currency stores integer minor units so `DataType.LONG`). The `core_types.py` field loop already iterates `FIELD_SUBTYPES`, so no registration change is needed beyond the constant.

- [ ] Read `fixtures/conformance/currency-default-usd/` and `attr-filter-explicit-ops/` (uses `field.timestamp`) to confirm subtype names + that `@currency` simply flows through.
- [ ] Add the subtypes + data_type entries. Run `uv run --extra dev pytest tests/conformance -q`.
- [ ] Delist now-green fixtures (expected: `currency-default-usd`; possibly others once their other needs are met later). Confirm full suite + mypy green.
- [ ] Commit: `feat(python): register remaining field subtypes incl. currency`.

### Task P2.2: `source` (dbTable, dbView)

**Files:** create `src/metaobjects/meta/core/.../source/` is NOT the layer — sources are persistence-layer. Create `src/metaobjects/meta/persistence/__init__.py`, `src/metaobjects/meta/persistence/source/__init__.py`, `.../source/source_constants.py` (`SOURCE_SUBTYPE_DB_TABLE="dbTable"`, `SOURCE_SUBTYPE_DB_VIEW="dbView"`, `SOURCE_SUBTYPES`, attr name consts `@name`, `@schema`), `.../source/meta_source.py` (`MetaSource(MetaData)`). Register `source.{dbTable,dbView}` (and `base`) on `core_provider` in `core_types.py`, child rules allowing `attr` + `origin`. Attrs (`@name`, `@schema`) flow through as base attrs — no schema needed for canonical.

- [ ] Read `fixtures/conformance/source-db-table-explicit/`, `source-db-table-with-schema/`, `source-db-view-with-schema/` for exact attr names + that the object carries the `source.*` child.
- [ ] Implement + register. Run conformance.
- [ ] Delist now-green source fixtures (those that are single-file; a projection that extends a base across files stays a gap until Phase 3). Confirm suite + mypy green.
- [ ] Commit: `feat(python): register source.dbTable/dbView`.

### Task P2.3: `relationship` subtypes

**Files:** create `src/metaobjects/meta/core/relationship/{__init__.py, relationship_constants.py, meta_relationship.py}`. Subtypes `association`, `aggregation`, `composition` (+ base). Attr consts incl. `@objectRef`, `@cardinality`, `@fkField`, `@parentField`, `@joinEntity`, `@joinFields` (only the ones the corpus uses are load-bearing; include the vocabulary). Register on `core_provider`; object child rules must allow `relationship`.

- [ ] Read `fixtures/conformance/relationship-one-to-many/` for exact attrs. Read `error-unknown-relationship-subtype/expected-errors.json` (it expects `ERR_UNKNOWN_SUBTYPE` — registering the relationship type with valid subtypes makes the unknown-subtype fixture emit that, so it should go green too).
- [ ] Implement + register (ensure `object.entity`/`value` child rules include `TYPE_RELATIONSHIP`). Run conformance.
- [ ] Delist `relationship-one-to-many` and `error-unknown-relationship-subtype` if green. Confirm suite + mypy green.
- [ ] Commit: `feat(python): register relationship subtypes`.

### Task P2.4: `origin` (passthrough, aggregate)

**Files:** create `src/metaobjects/meta/persistence/origin/{__init__.py, origin_constants.py, meta_origin.py}`. Subtypes `passthrough`, `aggregate` (+ base). Attr consts: passthrough `@from`, `@via`; aggregate `@agg`, `@of`, `@via`. Register on `core_provider`; **field** child rules must allow `origin` (origins are children of fields on projections). Optionally thin subclasses `MetaPassthroughOrigin`/`MetaAggregateOrigin` per the Phase-1 identity pattern, or one `MetaOrigin` — match Phase-1 style (one class is fine for Phase 2).

- [ ] Read `fixtures/conformance/origin-passthrough-simple/`, `origin-aggregate-count/`, `origin-aggregate-sum/`, `origin-multi-level-via/` for exact attrs. Note: if any of these is multi-file or its projection extends a base in a separate file, it needs Phase-3 MERGE/SUPER and must stay a gap — only delist the ones that actually pass.
- [ ] Implement + register (field child rules include `TYPE_ORIGIN`). Run conformance.
- [ ] Delist the origin fixtures that now pass. Confirm suite + mypy green.
- [ ] Commit: `feat(python): register origin.passthrough/aggregate`.

### Task P2.5: `view` + `layout` (dataGrid)

**Files:** create `src/metaobjects/meta/presentation/__init__.py`, `.../view/{__init__.py, view_constants.py, meta_view.py}`, `.../layout/{__init__.py, layout_constants.py, meta_layout.py}`. View subtypes incl. `currency` (+ the others the corpus uses, + base); `view.currency` carries `@locale`. Layout subtype `dataGrid` (+ base); attrs `@columns` (stringArray), `@defaultSortField`, `@defaultSortOrder`, `@pageSize`, `@filterable`, `@filter`. Register both on `core_provider`. **Important:** `@columns` is a `stringArray` — add a colocated attr schema on `layout.dataGrid` declaring `columns` as `value_type="stringArray"` (so a scalar `@columns` desugars to an array, mirroring `@fields`). Fields must allow `view` children; objects must allow `layout` children.

- [ ] Read `fixtures/conformance/layout-data-grid-basic/`, `layout-data-grid-multiple-named/`, `currency-explicit-jpy/`, `currency-precedence-field-vs-view/` for exact attrs + child placement (view is a child of a field; layout is a child of an object).
- [ ] Implement + register (with the `@columns` stringArray schema). Run conformance.
- [ ] Delist now-green fixtures (`layout-data-grid-*`, `currency-explicit-jpy`, `currency-precedence-field-vs-view`). Confirm suite + mypy green.
- [ ] Commit: `feat(python): register view + layout.dataGrid subtypes`.

### Task P2.6: `attr.properties` / `attr.class` + `attr.filter` desugar

**Files:** modify `src/metaobjects/meta/core/attr/attr_constants.py` (add `properties`, `class`, `filter` subtypes); add `PropertiesAttr`, `ClassAttr` (if needed), `FilterAttr` classes in `src/metaobjects/meta/core/attr/meta_attr.py` (or a sibling module) self-registering into `attr_class_map`; ensure the `core_types.py` attr loop covers the new subtypes. Add a colocated attr schema on `layout.dataGrid` declaring `filter` as `value_type="filter"` so the parser materializes a `FilterAttr` for `@filter`.

`FilterAttr.desugar` (the corpus behavior): for a `@filter` object, each field value desugars — a scalar `v` → `{"eq": v}`, an array → `{"in": [...]}`, `null` → `{"isNull": true}`; a value that is already an op-object (e.g. `{"gte": 5}`, `{"like": "%x"}`) passes through unchanged. `attr.properties` stores an object/string-bag (identity coerce). `attr.class` is string-like.

- [ ] Read `fixtures/conformance/attr-properties-basic/expected.json` (note: canonical form is inline `@config`/`value` — match it), `attr-filter-shorthand/expected.json` (shorthand→ops) and `attr-filter-explicit-ops/expected.json` (ops pass through). These pin the exact desugar.
- [ ] Implement the classes + desugar + schema wiring. Run conformance.
- [ ] Delist `attr-properties-basic`, `attr-filter-shorthand`, `attr-filter-explicit-ops` if green. Confirm suite + mypy green.
- [ ] Commit: `feat(python): attr.properties/class + attr.filter desugar (behavior on the class)`.

---

## Phase 2 — definition of done
- `uv run --extra dev pytest -q` green; `uv run --extra dev mypy` clean.
- ~18 more fixtures green (delisted); ledger honestly retains only fixtures needing Phase 3 (merge/super) or Phase 4 (validation) or prompt.*.
- Zero `fail` / `fixed-but-listed`. New subtypes added Open-Closed (a class + a registration; no central switch edits).

## Self-review note (author)
Some "TYPE"-tagged fixtures (origin-*, source-db-view-projection) may *also* depend on multi-file MERGE or super-resolution depending on how their fixture is authored (single- vs multi-file). The ledger discipline makes this self-correcting: a task only delists fixtures that actually pass; any that still need Phase 3 stay listed. Do not force-delist.

# Python Loader + Conformance — Phase 4 (validation passes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Implement the loader's validation passes, turning the 11 remaining validation/warning fixtures green. After Phase 4 the Python loader passes the entire shared corpus except the 3 `template.*` fixtures (FR-004, separate). Ledger 14 → 3.

**Architecture:** Validation passes are the *legitimately central* category (ADR-0002: cross-node checks can't live on a single node). Add `src/metaobjects/loader/validation_passes.py` with a `run_validations(root, registry, errors, warnings)` entry that runs each pass; wire it into the loader **after super-resolution, before freeze** (passes need the resolved super chain via `effective_children`/`effective_attrs`). Errors append `MetaError(code=...)`; warnings append plain strings. **Error message text is free** (conformance compares error *codes*); **warning text MUST be byte-identical** to the fixture's `expected-warnings.json` (conformance compares warning strings).

**Process:** Python 3.11+, uv, pytest, mypy (over src+tests). Worktree `feat/python-loader-phase-4` off current main. Run from `server/python`. **Corpus is the oracle** — read each fixture's `input/` + `expected-errors.json`/`expected-warnings.json`. **Ledger discipline:** each task implements its pass(es), runs `uv run --extra dev pytest tests/conformance -q`, and **delists every now-passing fixture** in the same commit; suite stays green; never delist a still-failing fixture. mypy clean over src+tests. Public repo. Forward-only main; never `--no-verify`.

**Reference:** TS `server/typescript/packages/metadata/src/loader/validation-passes.ts`, `subtype-rules.ts`, `attr-schema-validate.ts`, `query-constants.ts`; C# `server/csharp/MetaObjects/Loader/ValidationPasses.cs`. Existing Python: `registry.effective_attrs(type,sub)`/`attr_schema(...)` (AttrSchema has `name`, `value_type`, `required`, `allowed_values`, `default`); `MetaData.effective_children()`/`own_meta_attrs()`/`attr(name)`; `MetaObject.fields()`/`own_fields()`/`primary_identity()`; `errors.ErrorCode`.

**Ops-per-field-subtype allow-table** (from `query-constants.ts`): `string` → eq,ne,in,like,isNull; `boolean` → eq,isNull; all numerics (int/short/byte/long/double/float/decimal) + date/time/timestamp → eq,ne,gt,gte,lt,lte,in,isNull. Implement `ops_for_subtype(field_subtype) -> set[str]`.

---

### Task P4.1: validation scaffold + attr schemas + attr-schema pass

**Files:** create `src/metaobjects/loader/validation_passes.py`; modify `src/metaobjects/loader/meta_data_loader.py` (wire `run_validations` after `resolve_supers`, before `freeze`); modify `src/metaobjects/core_types.py` (add attr schemas); test `tests/unit/test_validation_attr_schema.py`.

**Attr schemas to declare in `core_types.py`** (so the pass has rules):
- `layout.dataGrid`: add `AttrSchema("pageSize", "int")`, `AttrSchema("defaultSortField", "string")`, `AttrSchema("defaultSortOrder", "string", allowed_values=("asc","desc"))` (alongside the existing `columns` stringArray + `filter` filter schemas).
- `origin.aggregate`: `AttrSchema("agg", "string", required=True, allowed_values=("count","sum","avg","min","max"))`, `AttrSchema("of", "string", required=True)`, `AttrSchema("via", "string", required=True)`.
- `origin.passthrough`: `AttrSchema("from", "string", required=True)`, `AttrSchema("via", "string")`.

**`run_validations(root, registry, errors, warnings)`** scaffold: walk helper `_walk(root) -> list[MetaData]`; call each pass (initially just attr-schema). **Attr-schema pass** (`_validate_attr_schema`): for every node, `schemas = registry.effective_attrs(node.type, node.sub_type)`; for each schema:
- **required**: if `schema.required` and the node's effective attr set lacks `schema.name` → `MetaError(ERR_MISSING_REQUIRED_ATTR)`. (Use `node.attr(name) is None` AND not present in `own_meta_attrs`/super chain — effective. Identity `@fields` is the case; identity.primary missing `@fields` → error.)
- **type**: for each OWN attr instance whose name matches a schema, validate its value type. The cleanest: the materialized `MetaAttr` instance already knows its subtype; reuse `MetaAttr.validate_value(value)` if present, else check the coerced value against `schema.value_type` (e.g. value_type `int` → value must be an int (not a str); `filter` → value must be a dict (a string `@filter` fails)). On failure → `MetaError(ERR_BAD_ATTR_VALUE)`. (Greens `error-attr-wrong-type` `@pageSize="twenty-five"` and `error-attr-filter-legacy-string` `@filter="..."`.)
- **allowed_values**: if `schema.allowed_values` and the own attr's value not in it → `MetaError(ERR_BAD_ATTR_VALUE)`. (Greens `error-origin-bad-aggregate-fn` `@agg="notARealFn"`.)

Wire into loader: `from .validation_passes import run_validations` then `run_validations(result.root, registry, result.errors, result.warnings)` between `resolve_supers(...)` and `result.root.freeze()`. NOTE the loader composes the `registry` already (it's local in `load_directory`) — pass it.

- [ ] Read the 5 attr fixtures (`error-attr-bad-allowed-value`, `error-attr-missing-required`, `error-attr-wrong-type`, `error-attr-filter-legacy-string`, `error-origin-bad-aggregate-fn`) — confirm exact codes (all in `expected-errors.json`) + which node/attr.
- [ ] TDD unit test for the pass; implement schemas + pass + wiring.
- [ ] Run conformance; delist the 5 fixtures that now pass (confirm each passes). Full suite + mypy green.
- [ ] Commit: `feat(python): attr-schema validation pass (+ layout/origin attr schemas)`.

### Task P4.2: dataGrid sort-field pass

**Files:** modify `validation_passes.py` (+ call in `run_validations`); test.

`_validate_datagrid_sort_fields(root)`: for each `object.*` node, for each child `layout.dataGrid`, read `@defaultSortField`; if set and not in the object's effective field names (`[f.name for f in obj.fields()]`) → `MetaError(ERR_BAD_DEFAULT_SORT_FIELD)`.

- [ ] Read `error-data-grid-bad-sort-field` (expects `ERR_BAD_DEFAULT_SORT_FIELD`).
- [ ] Implement + call in `run_validations`. Run conformance; delist `error-data-grid-bad-sort-field`. Suite + mypy green.
- [ ] Commit: `feat(python): dataGrid @defaultSortField validation`.

### Task P4.3: dataGrid filter-values pass (+ ops-per-subtype)

**Files:** modify `validation_passes.py`; add `ops_for_subtype` (in `validation_passes.py` or a colocated `meta/core/query/` constants module — match existing structure; query vocab may already have a constants home, check `meta/core/query/`); test.

`_validate_datagrid_filter_values(root)`: for each `object.*`, build a map `filterable_field -> ops_for_subtype(field.sub_type)` from the object's effective fields that have `@filterable: true`. For each `layout.dataGrid` child's `@filter` (a dict of `field -> {op: value}` after desugar): if a referenced field isn't in the filterable map → `MetaError(ERR_BAD_ATTR_FILTER)`; if an op for a field isn't in that field's allowed set → `MetaError(ERR_BAD_ATTR_FILTER)`.

- [ ] Read `error-attr-filter-bad-field` (non-filterable field) + `error-attr-filter-bad-op` (boolean field with `like`) — both expect `ERR_BAD_ATTR_FILTER`.
- [ ] Implement `ops_for_subtype` (the table above) + the pass + call. Run conformance; delist the 2 fixtures. Suite + mypy green.
- [ ] Commit: `feat(python): dataGrid @filter field/op validation`.

### Task P4.4: origin-paths pass

**Files:** modify `validation_passes.py`; test.

`_validate_origin_paths(root)`: for each `field` with an `origin.{passthrough,aggregate}` child: validate `@from`/`@of` resolves to `Entity.field` (the entity exists in the tree by name; the field exists on it), and `@via` (dotted relationship path like `"Program.weeks.workouts"`) hops correctly — each segment after the first is a relationship on the current entity whose target entity (`@objectRef`) becomes the next hop. Any failure → `MetaError(ERR_INVALID_ORIGIN)`. (Greens `error-origin-bad-via-path`: `@via="Program.notARealRelationship"` — no such relationship on Program.) Use a tree-wide `name -> object` index (entities are top-level/root children) + `MetaObject` accessors for fields/relationships.

- [ ] Read `error-origin-bad-via-path` (expects `ERR_INVALID_ORIGIN`) + a couple of the PASSING origin fixtures (`origin-multi-level-via`, `origin-aggregate-count`) to ensure the validator does NOT false-positive on valid paths (they're currently green/unlisted — must STAY green).
- [ ] Implement + call. Run conformance; delist `error-origin-bad-via-path`; confirm the valid origin fixtures stay green. Suite + mypy green.
- [ ] Commit: `feat(python): origin @from/@of/@via path validation`.

### Task P4.5: subtype-rules + filterable-without-index (warnings — byte-exact text)

**Files:** modify `validation_passes.py`; test.

Two **warning** passes (warning STRINGS must match `expected-warnings.json` byte-for-byte — READ the fixtures and copy the text exactly; do not paraphrase):
- `_validate_subtype_rules(root, warnings)`: for each `object.entity` with no effective primary identity and not `@isAbstract: true` → append the entity-missing-primary warning. (Also: a `value` object WITH a primary identity → `MetaError(ERR_SUBTYPE_RULE_VIOLATION)` — implement for completeness even if no current fixture triggers the error side; the corpus has only the entity warning.)
- `_validate_filterable_has_index(root, warnings)`: for each `field` with `@filterable: true` that is NOT part of any identity (`@fields`) on its object AND has no `@db.indexed: true` → append the filterable-without-index warning.

**Byte-exact templates** (verify against the fixtures — these are from the survey, confirm verbatim):
- entity-no-primary: `entity object '<Name>' has no primary identity (add an identity child or mark @isAbstract: true)` — confirm whether `<Name>` is `node.name` or `node.fqn()`/`effective_fqn()` by matching the fixture.
- filterable-no-index: `[filterable-without-index] field "<Entity>.<field>" has @filterable: true but is not part of any identity. Filtering on this field will sequential-scan. Add @db.indexed: true to the field (when supported), or remove @filterable: true.` — confirm `<Entity>.<field>` formatting from the fixture.

The conformance runner already compares the sorted warning set when `expected-warnings.json` is present, and asserts no warnings on happy-path fixtures — so a warning that fires on the WRONG fixtures will turn previously-green fixtures red. Make the conditions precise.

- [ ] Read `subtype-entity-missing-primary-warning/expected-warnings.json` + `warning-filterable-no-index/expected-warnings.json` for the EXACT strings. Also confirm no currently-green fixture would spuriously trigger these warnings (e.g. abstract bases, entities with primary identities, non-filterable fields).
- [ ] Implement both + calls. Run conformance; delist the 2 warning fixtures; confirm zero unexpected warnings elsewhere. Suite + mypy green.
- [ ] Commit: `feat(python): subtype-rules + filterable-without-index warnings`.

---

## Phase 4 — definition of done
- `uv run --extra dev pytest -q` green; `uv run --extra dev mypy` clean (src+tests).
- All 11 validation/warning fixtures green → ledger 14 → **3** (only the `template.*` FR-004 fixtures remain).
- Warning text byte-identical to fixtures; error codes correct; no previously-green fixture regressed (the passes must not false-positive). Open-Closed proof + registry-completeness still pass.

## Self-review note
The passes are cross-node (central) by design (ADR-0002 §4). Keep them in `validation_passes.py`; do NOT push validation logic onto node classes. The risk is **false positives** turning green fixtures red — each pass's trigger condition must be precise (use effective accessors; respect `@isAbstract`; only flag the exact violations the fixtures show). The corpus is the guardrail.

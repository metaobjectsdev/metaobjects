# Int-Backed Enum Values — Python Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `field.enum`'s `@intValueMap` (metamodel layer already shipped) into Python's `ObjectManager` runtime: encode the member symbol to its int on write, decode it back on read. Python has no per-subtype `EnumField` class (confirmed — `field.sub_type == fc.FIELD_SUBTYPE_ENUM` is the only discriminator) and no codegen change is needed at all — Python's generated type for an inline enum field is `Literal["DRAFT", "PUBLISHED", ...]` regardless of backing mode, since codegen never reads `@intValueMap`.

**Architecture:** `_coerce_write_value` (`server/python/src/metaobjects/runtime/object_manager.py:766-826`) is today a pure fallthrough for `field.sub_type == FIELD_SUBTYPE_ENUM` (falls to the final `return value` at line 826). This plan adds a new branch there for the write side. The **read side needs a wholly new function** — confirmed there is no decode/read-side coercion anywhere in this module today (`select()`/`find_by_id`/`find_many` return pg8000's native values verbatim, per ADR-0019). This plan adds `_decode_read_value(field, value)` and wires it into every row-mapping call site.

**Tech Stack:** Python, pytest, pg8000 (via `ObjectManager`).

## Global Constraints

- Python's generated type for `field.enum` (`Literal["A","B",...]` inline, or the FR-019 shared `class X(str, Enum)`) is unchanged whether or not `@intValueMap` is present — do not touch `entity_model.py` or `fr019_shared_enum.py`.
- `@intValueMap`'s presence alone is the trigger, read via `field.get_meta_attr(fc.FIELD_ATTR_INT_VALUE_MAP)` (resolving — own or inherited via `extends`, matching how `@localTime`/`@storage` are already read in this same function).
- Every codec constant/import goes through `field_constants` (`fc`) — this module already imports it aliased as `fc`; follow that convention.

---

### Task 1: write-side encode in `_coerce_write_value`

**Files:**
- Modify: `server/python/src/metaobjects/runtime/object_manager.py`
- Test: `server/python/tests/runtime/test_object_manager_enum_intvaluemap.py`

**Interfaces:**
- Consumes: `fc.FIELD_ATTR_INT_VALUE_MAP` (metamodel plan, already shipped).
- Produces: `_coerce_write_value(field, value)` returns the mapped int for an int-backed enum field, unchanged behavior otherwise.

- [ ] **Step 1: Write the failing tests**

```python
# server/python/tests/runtime/test_object_manager_enum_intvaluemap.py
import pytest
from metaobjects.runtime.object_manager import _coerce_write_value
from metaobjects.loader.loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource


def _load_order_field(extra: str):
    json_str = f"""{{ "metadata.root": {{ "children": [
      {{ "object.entity": {{ "name": "Order", "children": [
        {{ "field.long": {{ "name": "id" }} }},
        {{ "field.enum": {{ "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] {extra} }} }},
        {{ "identity.primary": {{ "name": "pk", "@fields": ["id"] }} }}
      ]}} }}
    ]}} }}"""
    loader = MetaDataLoader()
    result = loader.load([InMemoryStringSource(json_str, "test.json")])
    assert result.errors == []
    entity = result.root.find_object("Order")
    return entity.field("status")


def test_int_backed_enum_write_value_encodes_symbol_to_int():
    field = _load_order_field(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}')
    assert _coerce_write_value(field, "PUBLISHED") == 5


def test_string_backed_enum_write_value_is_unchanged():
    field = _load_order_field("")
    assert _coerce_write_value(field, "PUBLISHED") == "PUBLISHED"


def test_int_backed_enum_write_value_none_stays_none():
    field = _load_order_field(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}')
    assert _coerce_write_value(field, None) is None
```

> Check `MetaDataLoader`/`InMemoryStringSource`/`find_object`/`.field(name)`'s actual API against `test_field_enum.py` (used as the template in the metamodel plan) before finalizing — this file reuses that same loading idiom.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/python && pytest tests/runtime/test_object_manager_enum_intvaluemap.py -v`
Expected: FAIL — `test_int_backed_enum_write_value_encodes_symbol_to_int` fails (currently returns `"PUBLISHED"` unchanged, since enum is a pure fallthrough).

- [ ] **Step 3: Add the encode branch**

Edit `server/python/src/metaobjects/runtime/object_manager.py` — insert before the final fallthrough comment/return (line 824-826):

```python
    # field.enum: int-backed persistence (docs/superpowers/specs/2026-07-23-int-backed-
    # enum-values-design.md). @intValueMap maps the member symbol to its stored int;
    # resolving read (own or inherited via extends), matching @localTime/@storage above.
    # Absent → string-backed default, unchanged (falls to the generic return below).
    if sub == fc.FIELD_SUBTYPE_ENUM:
        int_value_map = field.get_meta_attr(fc.FIELD_ATTR_INT_VALUE_MAP)
        if isinstance(int_value_map, dict):
            return int_value_map[value]

    # Everything else (string / int / long / double / float / boolean / enum)
    # is already the native type pg8000 binds directly.
    return value
```

(This replaces the trailing comment+return at lines 824-826 — the new `if` block goes immediately above it, inside the same function, after the existing `field.object`/`field.map` jsonb branch at lines 820-823.)

Add `FIELD_ATTR_INT_VALUE_MAP` to this file's existing `from metaobjects import field_constants as fc`-style import (it already imports `fc` wholesale per the module's existing style, based on `fc.FIELD_ATTR_DB_COLUMN_TYPE`/`fc.FIELD_SUBTYPE_DECIMAL` usage — no new import line needed if `fc` is a module-level import, since `FIELD_ATTR_INT_VALUE_MAP` was already added to `field_constants.py` by the metamodel plan).

- [ ] **Step 4: Run tests — confirm all pass**

Run: `cd server/python && pytest tests/runtime/test_object_manager_enum_intvaluemap.py -v`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Run the full ObjectManager test suite**

Run: `cd server/python && pytest tests/runtime/`
Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/python/src/metaobjects/runtime/object_manager.py server/python/tests/runtime/test_object_manager_enum_intvaluemap.py
git commit -m "feat(python): ObjectManager encodes int-backed field.enum symbol->int on write"
```

---

### Task 2: read-side decode (new function + wiring)

**Files:**
- Modify: `server/python/src/metaobjects/runtime/object_manager.py`
- Test: extend `server/python/tests/runtime/test_object_manager_enum_intvaluemap.py`

**Interfaces:**
- Produces: `_decode_read_value(field, value)` — a new function, the read-side mirror of `_coerce_write_value`, consumed by every row-mapping call site in `find_by_id`/`find_many`.

- [ ] **Step 1: Write the failing tests**

Append to `test_object_manager_enum_intvaluemap.py`:

```python
from metaobjects.runtime.object_manager import _decode_read_value


def test_int_backed_enum_read_value_decodes_int_to_symbol():
    field = _load_order_field(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}')
    assert _decode_read_value(field, 5) == "PUBLISHED"


def test_string_backed_enum_read_value_is_unchanged():
    field = _load_order_field("")
    assert _decode_read_value(field, "PUBLISHED") == "PUBLISHED"


def test_int_backed_enum_read_value_none_stays_none():
    field = _load_order_field(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}')
    assert _decode_read_value(field, None) is None


def test_int_backed_enum_read_value_unknown_int_raises():
    field = _load_order_field(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}')
    with pytest.raises(ValueError):
        _decode_read_value(field, 42)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server/python && pytest tests/runtime/test_object_manager_enum_intvaluemap.py -v`
Expected: FAIL — `ImportError: cannot import name '_decode_read_value'`.

- [ ] **Step 3: Add `_decode_read_value`**

Edit `server/python/src/metaobjects/runtime/object_manager.py` — add near `_coerce_write_value`:

```python
def _decode_read_value(field: MetaField, value: Any) -> Any:
    """The read-side mirror of _coerce_write_value for int-backed field.enum. Every
    other field type's read value passes through unmodified today (ADR-0019 — the
    runtime returns native types, never wire-strings); this is the first field type
    needing a genuine decode step, mirroring the (also-new) write-side encode above."""
    if value is None:
        return None
    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        int_value_map = field.get_meta_attr(fc.FIELD_ATTR_INT_VALUE_MAP)
        if isinstance(int_value_map, dict):
            for symbol, i in int_value_map.items():
                if i == value:
                    return symbol
            raise ValueError(
                f"field.enum '{field.name}' read value {value!r} has no matching @intValueMap entry"
            )
    return value
```

- [ ] **Step 4: Wire it into the row-mapping call sites**

Find `find_by_id`/`find_many`'s row-to-object mapping code (the functions the earlier research noted do "no per-field value transformation" today — read them in full first) and add a pass over each row's fields, applying `_decode_read_value(field, raw_value)` for every field before constructing the returned object. The exact insertion point depends on whether row mapping is a dict comprehension, a loop, or a dataclass constructor call — mirror whichever shape those functions actually use; do not restructure them beyond adding this one per-field decode step.

- [ ] **Step 5: Run tests — confirm all pass**

Run: `cd server/python && pytest tests/runtime/test_object_manager_enum_intvaluemap.py -v`
Expected: PASS — all 7 tests in this file green.

- [ ] **Step 6: Run the full ObjectManager test suite**

Run: `cd server/python && pytest tests/runtime/`
Expected: all pass, no regressions — every existing read of a string-backed enum (or any other field type) must be a no-op through `_decode_read_value` (confirmed by `test_string_backed_enum_read_value_is_unchanged` and the broader regression run).

- [ ] **Step 7: Commit**

```bash
git add server/python/src/metaobjects/runtime/object_manager.py server/python/tests/runtime/test_object_manager_enum_intvaluemap.py
git commit -m "feat(python): ObjectManager decodes int-backed field.enum int->symbol on read"
```

---

### Task 3: real-engine round-trip

**Files:**
- Test: `server/python/tests/integration/test_enum_intvaluemap_roundtrip.py`

**Interfaces:**
- Consumes: Tasks 1-2.

- [ ] **Step 1: Write the real-engine test**

```python
# server/python/tests/integration/test_enum_intvaluemap_roundtrip.py
import pytest
from metaobjects.runtime.object_manager import ObjectManager
from metaobjects.loader.loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource

# Match whatever pg8000 + Testcontainers (or the existing local Postgres) fixture
# this module's other integration tests already use — check
# server/python/tests/integration/ for the established connection-fixture pattern.


@pytest.mark.integration
def test_int_backed_enum_round_trips_through_real_postgres(pg_connection):  # fixture name TBD — match existing convention
    json_str = """{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ]}}
    ]}}"""
    loader = MetaDataLoader()
    result = loader.load([InMemoryStringSource(json_str, "test.json")])
    entity = result.root.find_object("Order")

    om = ObjectManager(pg_connection)
    # Table must already exist — apply the corresponding DDL (integer + int CHECK,
    # per the TS persistence plan's schema) before this test runs, matching however
    # this module's other integration tests provision their schema (likely the
    # committed canonical/schema.postgres.sql, per this repo's ADR-0015 convention).
    created = om.create(entity, {"status": "PUBLISHED"})
    fetched = om.find_by_id(entity, created["id"])

    assert fetched["status"] == "PUBLISHED"  # decoded back to the symbol, not 5

    raw = pg_connection.run("SELECT status FROM orders WHERE id = :id", id=created["id"])
    assert raw[0][0] == 5  # the actual stored value is the mapped int
```

> `pg_connection`'s fixture name/shape, `ObjectManager`'s real constructor signature, and how this module provisions its test schema are all placeholders pending a read of `server/python/tests/integration/`'s existing setup — mirror an existing integration test there exactly (do not guess the connection/fixture wiring).

- [ ] **Step 2: Run to verify current gap**

Run: `cd server/python && pytest tests/integration/test_enum_intvaluemap_roundtrip.py -v -m integration`
Expected: FAIL or errors until Step 1 is completed for real against the actual fixture/connection pattern.

- [ ] **Step 3: Complete the test for real, run, confirm pass**

Run: `cd server/python && pytest tests/integration/test_enum_intvaluemap_roundtrip.py -v -m integration`
Expected: PASS.

- [ ] **Step 4: Run the full Python test suite**

Run: `cd server/python && pytest`
Expected: 100% pass.

- [ ] **Step 5: Commit**

```bash
git add server/python/tests/integration/test_enum_intvaluemap_roundtrip.py
git commit -m "test(python): int-backed field.enum round-trips through real Postgres via ObjectManager"
```

---

## After all five plans land

Once every port's persistence plan is done (this one; TS; C#; Java+Kotlin), the last remaining item from the design spec's conformance plan is the shared `fixtures/persistence-conformance/roundtrip-all-types.yaml` scenario carrying `intEnumVal` (added in the TS persistence plan's Task 6) passing identically across **all five** ports' real-engine runners — that is the final, cross-language proof this feature is genuinely done, not just done-per-port. Run each port's persistence-conformance suite one more time after all five plans are merged to confirm.

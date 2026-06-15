"""FR-033 — strict structural-child placement enforcement (gating test).

A STRUCTURAL child (field/identity/source/validator/… — not an @-attr) placed
under a parent whose strict registered ``child_rules`` do NOT admit it is
rejected at strict load with ``ERR_CHILD_NOT_ALLOWED`` (the structural analogue
of the ``ERR_UNKNOWN_ATTR`` misplaced-attr check). Mirrors the TS gating test
(``server/typescript/packages/metadata/test/child-placement-enforcement.test.ts``)
and the Java ``StrictChildPlacementTest`` — the same two cases, the same code.

Pins the loader-wired Check 0b in ``loader/validation_passes.py``. Lax load
(the default) keeps the legacy open policy — a no-op.
"""
from __future__ import annotations

from metaobjects.errors import ErrorCode
from metaobjects.loader.meta_data_loader import MetaDataFormat, MetaDataLoader

# Case 1 — a `relationship.association` under an `object.projection`. Strict
# projection children = field/identity/validator/layout/source — NO relationship.
_RELATIONSHIP_UNDER_PROJECTION = """
{ "metadata.root": { "package": "test", "children": [
  { "object.entity": { "name": "Account", "children": [
      { "field.string": { "name": "id" }},
      { "identity.primary": { "name": "pk", "@fields": ["id"] }}
  ]}},
  { "object.projection": { "name": "AccountView", "extends": "Account", "children": [
      { "relationship.association": {
          "name": "bogus", "@cardinality": "one", "@objectRef": "Account" }}
  ]}}
]}}
"""

# Case 2 — a `field.string` under an attr-only `validator.required`. Strict
# validator children = [] (attr-only) — a structural field is never admitted.
_FIELD_UNDER_VALIDATOR = """
{ "metadata.root": { "package": "test", "children": [
  { "object.entity": { "name": "Account", "children": [
      { "field.string": { "name": "id", "children": [
          { "validator.required": { "name": "req", "children": [
              { "field.string": { "name": "bogus" }}
          ]}}
      ]}}
  ]}}
]}}
"""


def _codes(content: str, *, strict: bool) -> list[ErrorCode]:
    result = MetaDataLoader.from_string(
        content, format=MetaDataFormat.JSON, strict=strict
    )
    return [e.code for e in result.errors]


def test_relationship_under_projection_rejected_strict() -> None:
    codes = _codes(_RELATIONSHIP_UNDER_PROJECTION, strict=True)
    assert ErrorCode.ERR_CHILD_NOT_ALLOWED in codes


def test_field_under_validator_rejected_strict() -> None:
    codes = _codes(_FIELD_UNDER_VALIDATOR, strict=True)
    assert ErrorCode.ERR_CHILD_NOT_ALLOWED in codes


def test_misplaced_structural_child_is_noop_in_lax_mode() -> None:
    # Lax load (the default) preserves the legacy open placement policy — the
    # check never fires (downstream apps can loosen the model).
    assert ErrorCode.ERR_CHILD_NOT_ALLOWED not in _codes(
        _RELATIONSHIP_UNDER_PROJECTION, strict=False
    )
    assert ErrorCode.ERR_CHILD_NOT_ALLOWED not in _codes(
        _FIELD_UNDER_VALIDATOR, strict=False
    )

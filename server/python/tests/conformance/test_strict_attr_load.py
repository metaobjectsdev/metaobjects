"""ADR-0022 — strict-attr load (Python).

Under strict load, an authored own ``@attr`` that matches no per-type attr
schema and no commonAttr is an ``ERR_UNKNOWN_ATTR`` (own-only, mirroring the
TS reference Check-0 in attr-schema-validate.ts). In lax mode (the default,
so downstream apps may loosen) the legacy open-attr policy holds: an
undeclared attr is silently accepted.
"""
from __future__ import annotations

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.documentation import doc_provider
from metaobjects.errors import ErrorCode

# A field.string carrying a made-up attribute no provider declares.
_MADE_UP = """
{
  "metadata.root": {
    "package": "acme::users",
    "children": [
      {
        "object.entity": {
          "name": "Account",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "email", "@madeUpAttr": "nope" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
"""


def _codes(result) -> list[str]:
    return [e.code.name for e in result.errors]


def test_lax_default_accepts_undeclared_attr() -> None:
    """Default (strict=False): the open-attr policy is preserved."""
    result = MetaDataLoader.from_string(_MADE_UP)
    assert ErrorCode.ERR_UNKNOWN_ATTR.name not in _codes(result)


def test_strict_rejects_undeclared_attr() -> None:
    """strict=True: an undeclared own @attr → ERR_UNKNOWN_ATTR."""
    result = MetaDataLoader.from_string(_MADE_UP, strict=True)
    assert ErrorCode.ERR_UNKNOWN_ATTR.name in _codes(result)


def test_strict_accepts_declared_common_attr() -> None:
    """A declared common attr (@description) is NOT flagged under strict.

    @description is a documentation common attr registered by doc_provider, so
    the loader must compose it in (the library conformance default provider set).
    """
    json_text = """
    {
      "metadata.root": {
        "package": "acme::users",
        "children": [
          {
            "object.entity": {
              "name": "Account",
              "children": [
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "email", "@description": "the email" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
              ]
            }
          }
        ]
      }
    }
    """
    result = MetaDataLoader.from_string(
        json_text, providers=[core_provider, doc_provider], strict=True
    )
    assert ErrorCode.ERR_UNKNOWN_ATTR.name not in _codes(result)

"""ERR_COLUMN_NAME_COLLISION advice wording and the @sql view exemption.

Mirrors ``server/typescript/packages/metadata/test/column-name-collision-message.test.ts``.
"""
from __future__ import annotations

import json

from metaobjects import load_string
from metaobjects.errors import ErrorCode

TABLE = {"source.rdb": {"@kind": "table", "@table": "account"}}


def _collision_messages(source: dict, field_a: dict, field_b: dict) -> list[str]:
    doc = {
        "metadata.root": {
            "package": "demo",
            "children": [
                {
                    "object.entity": {
                        "name": "Account",
                        "children": [
                            source,
                            {"field.long": {"name": "id"}},
                            field_a,
                            field_b,
                            {"identity.primary": {"name": "id", "@fields": ["id"]}},
                        ],
                    }
                }
            ],
        }
    }
    result = load_string(json.dumps(doc))
    return [e.message for e in result.errors if e.code == ErrorCode.ERR_COLUMN_NAME_COLLISION]


def test_two_explicit_columns_on_one_column_do_not_suggest_adding_a_column() -> None:
    (msg,) = _collision_messages(
        TABLE,
        {"field.string": {"name": "userName", "@column": "username"}},
        {"field.string": {"name": "displayName", "@column": "username"}},
    )
    assert "point one @column at a different column" in msg
    assert "give one an explicit @column" not in msg


def test_implicit_collision_still_suggests_an_explicit_column() -> None:
    (msg,) = _collision_messages(
        TABLE,
        {"field.string": {"name": "userId"}},
        {"field.string": {"name": "userID"}},
    )
    assert "give one an explicit @column" in msg


def test_sql_view_may_share_a_column_between_fields() -> None:
    doc = {
        "metadata.root": {
            "package": "demo",
            "children": [
                {
                    "object.projection": {
                        "name": "UserView",
                        "children": [
                            {"source.rdb": {"@kind": "view", "@view": "v", "@sql": "SELECT id, username FROM t"}},
                            {"field.long": {"name": "id", "@column": "id"}},
                            {"field.string": {"name": "userName", "@column": "username"}},
                            {"field.string": {"name": "displayName", "@column": "username"}},
                        ],
                    }
                }
            ],
        }
    }
    assert load_string(json.dumps(doc)).errors == []

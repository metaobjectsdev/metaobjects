"""#208 — DDL-ownership escape valves loader validation (@sql / @unmanaged).

One test per rule: R1-R5 are hard errors, R6 is a WARN (not an error), plus a
positive case (a valid @sql view projection must load with zero errors/warnings).

Mirrors the TS reference
``server/typescript/packages/metadata/test/validate-source-escapes.test.ts``.
"""
from __future__ import annotations

import json

from metaobjects import load_string
from metaobjects.errors import ErrorCode


def _codes(errors) -> list[str]:
    return [e.code.name if hasattr(e.code, "name") else e.code for e in errors]


def _warning_codes(result) -> list[str]:
    return [w.code for w in result.envelope_warnings]


def test_r1_sql_and_unmanaged_same_source_source_escape() -> None:
    """R1: @sql AND @unmanaged on one source -> ERR_SQL_BODY_WITH_UNMANAGED."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.projection": {
                        "name": "H",
                        "children": [
                            {
                                "source.rdb": {
                                    "@kind": "view",
                                    "@view": "v",
                                    "@sql": "SELECT 1",
                                    "@unmanaged": True,
                                }
                            },
                            {"field.long": {"name": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    result = load_string(json.dumps(doc))
    assert ErrorCode.ERR_SQL_BODY_WITH_UNMANAGED in [e.code for e in result.errors], (
        f"Expected ERR_SQL_BODY_WITH_UNMANAGED in {_codes(result.errors)}"
    )


def test_r2_sql_on_writable_kind_source_escape() -> None:
    """R2: @sql on @kind:table (writable, default) -> ERR_SQL_BODY_ON_WRITABLE_KIND."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "H",
                        "children": [
                            {"source.rdb": {"@table": "t", "@sql": "SELECT 1"}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"name": "id", "@fields": ["id"]}},
                        ],
                    }
                }
            ],
        }
    }
    result = load_string(json.dumps(doc))
    assert ErrorCode.ERR_SQL_BODY_ON_WRITABLE_KIND in [e.code for e in result.errors], (
        f"Expected ERR_SQL_BODY_ON_WRITABLE_KIND in {_codes(result.errors)}"
    )


def test_r3_sql_empty_string_source_escape() -> None:
    """R3: @sql present but empty string -> ERR_BAD_ATTR_VALUE."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.projection": {
                        "name": "H",
                        "children": [
                            {"source.rdb": {"@kind": "view", "@view": "v", "@sql": ""}},
                            {"field.long": {"name": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    result = load_string(json.dumps(doc))
    assert ErrorCode.ERR_BAD_ATTR_VALUE in [e.code for e in result.errors], (
        f"Expected ERR_BAD_ATTR_VALUE in {_codes(result.errors)}"
    )


def test_r3b_sql_whitespace_only_source_escape() -> None:
    """R3b: @sql present but whitespace-only -> ERR_BAD_ATTR_VALUE."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.projection": {
                        "name": "H",
                        "children": [
                            {"source.rdb": {"@kind": "view", "@view": "v", "@sql": "   "}},
                            {"field.long": {"name": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    result = load_string(json.dumps(doc))
    assert ErrorCode.ERR_BAD_ATTR_VALUE in [e.code for e in result.errors], (
        f"Expected ERR_BAD_ATTR_VALUE in {_codes(result.errors)}"
    )


def test_r4_origin_under_sql_host_source_escape() -> None:
    """R4: origin.* under an @sql host -> ERR_ORIGIN_UNDER_SQL_BODY."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Base",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.string": {"name": "title"}},
                            {"identity.primary": {"name": "id", "@fields": "id"}},
                        ],
                    }
                },
                {
                    "object.projection": {
                        "name": "H",
                        "children": [
                            {
                                "source.rdb": {
                                    "@kind": "view",
                                    "@view": "v_h",
                                    "@sql": "SELECT id, title FROM base",
                                }
                            },
                            {"field.long": {"name": "id", "extends": "acme::Base.id"}},
                            {
                                "field.string": {
                                    "name": "displayTitle",
                                    "children": [
                                        {
                                            "origin.passthrough": {
                                                "@from": "acme::Base.title"
                                            }
                                        }
                                    ],
                                }
                            },
                            {"identity.primary": {"name": "id", "extends": "acme::Base.id"}},
                        ],
                    }
                },
            ],
        }
    }
    result = load_string(json.dumps(doc))
    assert ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY in [e.code for e in result.errors], (
        f"Expected ERR_ORIGIN_UNDER_SQL_BODY in {_codes(result.errors)}"
    )


def test_r5_filter_plus_sql_on_projection_source_escape() -> None:
    """R5: @filter (#207) + @sql on a projection -> ERR_ORIGIN_UNDER_SQL_BODY."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Order",
                        "children": [
                            {"source.rdb": {"@table": "orders"}},
                            {"field.uuid": {"name": "id"}},
                            {"field.string": {"name": "status"}},
                            {"identity.primary": {"name": "id", "@fields": ["id"]}},
                        ],
                    }
                },
                {
                    "object.projection": {
                        "name": "ActiveOrders",
                        "@filter": {"status": {"ne": "archived"}},
                        "children": [
                            {
                                "source.rdb": {
                                    "@kind": "view",
                                    "@view": "v_active_orders",
                                    "@sql": "SELECT * FROM orders WHERE status <> 'archived'",
                                }
                            },
                            {"field.uuid": {"name": "id", "extends": "acme::Order.id"}},
                            {
                                "field.string": {
                                    "name": "status",
                                    "extends": "acme::Order.status",
                                }
                            },
                            {
                                "identity.primary": {
                                    "name": "id",
                                    "extends": "acme::Order.id",
                                }
                            },
                        ],
                    }
                },
            ],
        }
    }
    result = load_string(json.dumps(doc))
    assert ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY in [e.code for e in result.errors], (
        f"Expected ERR_ORIGIN_UNDER_SQL_BODY in {_codes(result.errors)}"
    )


def test_r6_origin_under_unmanaged_host_warns_not_errors_source_escape() -> None:
    """R6: origin.* under an @unmanaged host -> WARN, not error."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Base",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.string": {"name": "title"}},
                            {"identity.primary": {"name": "id", "@fields": "id"}},
                        ],
                    }
                },
                {
                    "object.projection": {
                        "name": "H",
                        "children": [
                            {
                                "source.rdb": {
                                    "@kind": "view",
                                    "@view": "v_h",
                                    "@unmanaged": True,
                                }
                            },
                            {"field.long": {"name": "id", "extends": "acme::Base.id"}},
                            {
                                "field.string": {
                                    "name": "displayTitle",
                                    "children": [
                                        {
                                            "origin.passthrough": {
                                                "@from": "acme::Base.title"
                                            }
                                        }
                                    ],
                                }
                            },
                            {"identity.primary": {"name": "id", "extends": "acme::Base.id"}},
                        ],
                    }
                },
            ],
        }
    }
    result = load_string(json.dumps(doc))
    assert result.errors == [], f"Expected no errors, got {_codes(result.errors)}"
    assert "WARN_ORIGIN_UNDER_UNMANAGED" in _warning_codes(result), (
        f"Expected WARN_ORIGIN_UNDER_UNMANAGED in {_warning_codes(result)}"
    )


def test_positive_valid_sql_view_projection_loads_clean_source_escape() -> None:
    """A valid @sql view projection (extends-bound identity/fields, no origins)
    must load with zero errors and zero WARN_ORIGIN_UNDER_UNMANAGED /
    ERR_*-escape warnings."""
    doc = {
        "metadata.root": {
            "package": "demo",
            "children": [
                {
                    "object.entity": {
                        "name": "Program",
                        "children": [
                            {"source.rdb": {"@table": "program"}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"name": "id", "@fields": ["id"]}},
                        ],
                    }
                },
                {
                    "object.projection": {
                        "name": "ProgramSummaryEscaped",
                        "children": [
                            {
                                "source.rdb": {
                                    "@kind": "view",
                                    "@view": "v_program_summary_escaped",
                                    "@sql": "SELECT id, count(*) AS n FROM program GROUP BY id",
                                }
                            },
                            {"field.long": {"name": "id", "extends": "demo::Program.id"}},
                            {
                                "identity.primary": {
                                    "name": "id",
                                    "extends": "demo::Program.id",
                                }
                            },
                        ],
                    }
                },
            ],
        }
    }
    result = load_string(json.dumps(doc))
    assert result.errors == [], f"Expected no errors, got {_codes(result.errors)}"
    assert _warning_codes(result) == [], (
        f"Expected no warnings, got {_warning_codes(result)}"
    )

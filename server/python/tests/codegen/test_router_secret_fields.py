"""#484 — a generated router ignores ``@formExclude`` / credential fields on write and never
returns a credential. Pins the generated shape; the HTTP behaviour is the api-contract
``secret-fields`` corpus (``tests/integration/test_api_contract_secret_fields.py``)."""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.runtime.decimal_wire import WireOutput, render_wire
from metaobjects.codegen.runtime.m2m_codegen import build_object_index
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _load(meta: dict) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="router-secret-"))
    try:
        (tmp / "meta.json").write_text(json.dumps(meta))
        result = MetaDataLoader.from_directory(str(tmp))
        assert not result.errors, "; ".join(f"{e.code}: {e.message}" for e in result.errors)
        return {
            c.name: c for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _id() -> list[dict]:
    return [
        {"source.rdb": {"@table": "t"}},
        {"field.long": {"name": "id"}},
        {"identity.primary": {"name": "id", "@fields": "id", "@generation": "increment"}},
    ]


_META = {"metadata.root": {"package": "acme::secrets", "children": [
    {"object.entity": {"name": "Account", "children": [
        *_id(),
        {"field.string": {"name": "name", "@maxLength": 100}},
        {"field.string": {"name": "tokenHash", "@maxLength": 100, "@formExclude": True}},
        {"field.string": {"name": "pinHash", "@maxLength": 100, "children": [{"view.password": {}}]}},
    ]}},
    # The credential is inherited from the abstract base: the resolving read must see it.
    {"object.entity": {"name": "Base", "abstract": True, "children": [
        {"field.string": {"name": "secret", "@maxLength": 100, "children": [{"view.password": {}}]}},
    ]}},
    {"object.entity": {"name": "Child", "extends": "Base", "children": [
        *_id(),
        {"field.string": {"name": "label", "@maxLength": 100}},
    ]}},
    {"object.entity": {"name": "Plain", "children": [
        *_id(),
        {"field.string": {"name": "title", "@maxLength": 100}},
    ]}},
]}}

_E = _load(_META)
_INDEX = build_object_index(list(_E.values()))


def _router(name: str) -> str:
    out = render_router(_E[name], _INDEX)
    assert out is not None
    return out


def test_create_and_update_name_both_denied_fields() -> None:
    out = _router("Account")
    assert '_DENIED_FIELDS: frozenset[str] = frozenset({\n    "tokenHash",\n    "pinHash",\n})' in out
    # The strip sits in create AND update (PATCH + PUT share one handler), before validation.
    assert out.count("for _denied in _DENIED_FIELDS:") == 2
    create = out[out.index("def create_account("):out.index("def update_account(")]
    assert create.index("_DENIED_FIELDS") < create.index("AccountCreate(**dto)")
    update = out[out.index("def update_account("):out.index("def delete_account(")]
    assert update.index("_DENIED_FIELDS") < update.index("_REQUIRED_FIELDS")


def test_only_the_credential_is_hidden_on_read() -> None:
    out = _router("Account")
    assert "hidden=('pinHash',)" in out
    assert "tokenHash'" not in out.split("WireOutput(")[1].split(")")[0]


def test_inherited_credential_counts() -> None:
    out = _router("Child")
    assert '_DENIED_FIELDS: frozenset[str] = frozenset({\n    "secret",\n})' in out
    assert "hidden=('secret',)" in out


def test_model_with_neither_mark_is_unchanged() -> None:
    out = _router("Plain")
    assert "_DENIED_FIELDS" not in out
    assert "hidden=" not in out


def test_render_wire_drops_hidden_key_not_nulls_it() -> None:
    wire = WireOutput(hidden=("pinHash",))
    assert render_wire({"id": 1, "pinHash": None}, wire) == {"id": 1}
    assert render_wire([{"id": 1, "pinHash": "x"}], wire) == [{"id": 1}]

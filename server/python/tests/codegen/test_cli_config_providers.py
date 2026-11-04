"""A project's custom providers reach every metadata-loading CLI entry point.

``providers: ["module:symbol"]`` in ``metaobjects.config.yaml`` and ``--provider
module:symbol`` are two spellings of the same thing and must MERGE wherever the CLI loads
metadata: ``gen``, ``verify`` (codegen, templates, the requirement gate and field lint)
and ``fmt``.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from metaobjects.cli import main

# The project's own vocabulary: a new layout.picker subtype + two attrs on field.string.
VOCAB_MODULE = '''
from metaobjects.meta.presentation.layout.meta_layout import MetaLayout
from metaobjects.provider import Provider
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition
from metaobjects.shared.base_types import TYPE_ATTR

vocab = Provider("acme-vocabulary", dependencies=("metaobjects-core-types",))
vocab.add(TypeDefinition(
    type="layout", sub_type="picker", factory=MetaLayout,
    attrs=[AttrSchema("displayField", "string", required=False)],
    child_rules=[ChildRule(TYPE_ATTR, "*")],
))
vocab.on_register(lambda registry: registry.extend(
    "field", "string",
    attributes=[
        AttrSchema("searchable", "boolean", required=False),
        AttrSchema("valueLabels", "string", required=False, is_array=True),
    ],
))
'''

# A second, independent provider, supplied on the command line.
FLAG_MODULE = '''
from metaobjects.meta.meta_data import MetaData
from metaobjects.provider import Provider
from metaobjects.registry import TypeDefinition

flag_provider = Provider("acme-flag", ("metaobjects-core-types",))
flag_provider.add(TypeDefinition(
    type="validator", sub_type="geocheck",
    factory=lambda t, s, n: MetaData(t, s, n), description="A custom validator",
))
'''

CUSTOM_META = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {
                "object.value": {
                    "name": "Contact",
                    "children": [
                        {"field.string": {"name": "name", "@searchable": True}},
                        {"layout.picker": {"name": "contactPicker", "@displayField": "name"}},
                    ],
                }
            }
        ],
    }
}


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.contacts.json").write_text(json.dumps(CUSTOM_META), encoding="utf-8")
    (tmp_path / "acme_vocab_mod.py").write_text(VOCAB_MODULE, encoding="utf-8")
    (tmp_path / "acme_flag_mod.py").write_text(FLAG_MODULE, encoding="utf-8")
    (tmp_path / "metaobjects.config.yaml").write_text(
        'metadata: metaobjects\nproviders: ["acme_vocab_mod:vocab"]\n'
        "targets:\n  app:\n    outDir: gen\n    generators: []\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    saved = list(sys.path)
    sys.path.insert(0, str(tmp_path))  # for the --provider (flag) module
    yield tmp_path
    sys.path[:] = saved
    for name in ("acme_vocab_mod", "acme_flag_mod"):
        sys.modules.pop(name, None)


def test_fmt_honors_config_providers(project: Path, capsys) -> None:
    rc = main(["fmt", "--check"])
    err = capsys.readouterr().err
    assert "ERR_UNKNOWN" not in err and "unknown" not in err.lower()
    assert rc in (0, 1)  # 1 only means "not canonical"; the load itself must not fail
    assert (project / "metaobjects" / "meta.contacts.json").read_text(encoding="utf-8")


def test_fmt_rewrites_a_file_using_the_config_vocabulary(project: Path) -> None:
    path = project / "metaobjects" / "meta.contacts.json"
    path.write_text(json.dumps(CUSTOM_META), encoding="utf-8")  # compact, not canonical
    assert main(["fmt"]) == 0
    assert path.read_text(encoding="utf-8").startswith("{\n  \"metadata.root\"")
    assert "@searchable" in path.read_text(encoding="utf-8") or "searchable" in path.read_text(
        encoding="utf-8"
    )


def test_fmt_without_config_providers_still_refuses_the_vocabulary(project: Path) -> None:
    (project / "metaobjects.config.yaml").unlink()
    assert main(["fmt"]) != 0


def test_fmt_merges_config_and_flag_providers(project: Path) -> None:
    rc = main(["fmt", "--provider", "acme_flag_mod:flag_provider"])
    assert rc == 0


def test_verify_keeps_config_and_flag_providers(project: Path) -> None:
    """Metadata needing BOTH the config provider's vocabulary and the flag provider's
    validator loads clean through every verify gate (requirement gate + field lint)."""
    meta = json.loads(json.dumps(CUSTOM_META))
    meta["metadata.root"]["children"][0]["object.value"]["children"][0]["field.string"][
        "children"
    ] = [{"validator.geocheck": {"name": "chk"}}]
    (project / "metaobjects" / "meta.contacts.json").write_text(json.dumps(meta), encoding="utf-8")
    assert main(["verify", "--provider", "acme_flag_mod:flag_provider"]) == 0


def test_verify_without_the_flag_provider_fails_on_its_validator(project: Path) -> None:
    meta = json.loads(json.dumps(CUSTOM_META))
    meta["metadata.root"]["children"][0]["object.value"]["children"][0]["field.string"][
        "children"
    ] = [{"validator.geocheck": {"name": "chk"}}]
    (project / "metaobjects" / "meta.contacts.json").write_text(json.dumps(meta), encoding="utf-8")
    assert main(["verify"]) != 0

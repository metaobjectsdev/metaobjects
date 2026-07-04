"""#158 — the Python CLI ``--provider module:symbol`` hook.

The metadata loaders already accept consumer providers in every language; the gap
was purely at the CLI layer (``_load_root`` → ``from_directory`` used core
providers only). These tests prove the standalone ``metaobjects gen``/``verify``
can now load an app's custom subtype via ``--provider``, parity with the TS
``metaobjects.config.ts`` ``providers`` path.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from metaobjects.cli import main

# A provider module the test writes to disk + imports. Registers the custom
# ``validator.geocheck`` subtype (a validator, so it exercises provider-threading
# without depending on how codegen maps a novel field's physical type).
PROVIDER_MODULE = '''
from metaobjects.provider import Provider
from metaobjects.registry import TypeDefinition
from metaobjects.meta.meta_data import MetaData

geo_provider = Provider("test-geocheck", ("metaobjects-core-types",))
geo_provider.add(TypeDefinition(
    type="validator",
    sub_type="geocheck",
    factory=lambda t, s, n: MetaData(t, s, n),
    description="A custom validator",
))
'''

# Metadata whose ``name`` field carries the custom validator — resolves ONLY when
# the provider is loaded.
CUSTOM_META = {
    "metadata.root": {
        "package": "acme::geo",
        "children": [
            {
                "object.entity": {
                    "name": "Place",
                    "children": [
                        {"field.long": {"name": "id"}},
                        {
                            "field.string": {
                                "name": "name",
                                "children": [{"validator.geocheck": {"name": "chk"}}],
                            }
                        },
                        {"source.rdb": {"name": "src", "@table": "places"}},
                        {
                            "identity.primary": {
                                "name": "pk",
                                "@fields": ["id"],
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            }
        ],
    }
}


def _project(tmp_path: Path) -> str:
    d = tmp_path / "meta"
    d.mkdir()
    (d / "meta.json").write_text(json.dumps(CUSTOM_META))
    return str(d)


def _install_provider_module(tmp_path: Path, name: str) -> None:
    (tmp_path / f"{name}.py").write_text(PROVIDER_MODULE)
    sys.path.insert(0, str(tmp_path))


def test_gen_without_provider_fails_on_custom_subtype(tmp_path: Path) -> None:
    """Baseline: the custom subtype is unknown without the provider."""
    rc = main(["gen", _project(tmp_path), "--out", str(tmp_path / "out")])
    assert rc != 0


def test_gen_with_provider_loads_custom_subtype(tmp_path: Path) -> None:
    """--provider composes the consumer provider on top of core → subtype resolves."""
    meta_dir = _project(tmp_path)
    _install_provider_module(tmp_path, "geo_prov_gen")
    try:
        rc = main(
            [
                "gen",
                meta_dir,
                "--out",
                str(tmp_path / "out"),
                "--provider",
                "geo_prov_gen:geo_provider",
            ]
        )
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("geo_prov_gen", None)
    assert rc == 0


def test_verify_with_provider_loads_custom_subtype(tmp_path: Path) -> None:
    """verify --codegen also threads --provider (reuses the gen code path)."""
    meta_dir = _project(tmp_path)
    _install_provider_module(tmp_path, "geo_prov_ver")
    out = tmp_path / "out"
    try:
        # generate committed output first (with the provider), then verify no drift.
        gen_rc = main(
            ["gen", meta_dir, "--out", str(out), "--provider", "geo_prov_ver:geo_provider"]
        )
        assert gen_rc == 0
        rc = main(
            [
                "verify",
                meta_dir,
                "--codegen",
                "--out",
                str(out),
                "--provider",
                "geo_prov_ver:geo_provider",
            ]
        )
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("geo_prov_ver", None)
    assert rc == 0


def test_bad_provider_spec_reports_error(tmp_path: Path) -> None:
    """A malformed --provider spec fails cleanly (not 'module:symbol')."""
    rc = main(
        [
            "gen",
            _project(tmp_path),
            "--out",
            str(tmp_path / "out"),
            "--provider",
            "not-a-valid-spec",
        ]
    )
    assert rc == 1

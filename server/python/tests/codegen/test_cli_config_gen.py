"""#267 — `metaobjects gen` declarative-config mode (no-arg, targets registry)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from metaobjects.cli import main

FITNESS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def _project(tmp_path: Path, config_text: str, meta_subdir: str = "metaobjects") -> Path:
    """Write a config + a metadata dir (fitness fixture) under tmp_path. Return the config path."""
    meta = tmp_path / meta_subdir
    meta.mkdir(parents=True)
    (meta / "meta.fitness.json").write_text(FITNESS.read_text())
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(config_text)
    return cfg


TWO_TARGETS = """
targets:
  models:
    outDir: gen/models
    generators: [entity]
    entities: [Program, Week]
  other:
    outDir: gen/other
    generators: [entity]
    entities: [Node, Measurement]
"""


def test_gen_no_args_runs_all_targets_via_config_flag(tmp_path: Path) -> None:
    cfg = _project(tmp_path, TWO_TARGETS)
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 0
    assert (tmp_path / "gen/models/Program.py").exists()
    assert (tmp_path / "gen/models/Week.py").exists()
    assert (tmp_path / "gen/other/Node.py").exists()
    assert (tmp_path / "gen/other/Measurement.py").exists()
    # allowlists honored per target
    assert not (tmp_path / "gen/models/Node.py").exists()
    assert not (tmp_path / "gen/other/Program.py").exists()


def test_gen_no_args_discovers_config_in_cwd(tmp_path: Path, monkeypatch) -> None:
    _project(tmp_path, TWO_TARGETS)
    monkeypatch.chdir(tmp_path)
    rc = main(["gen"])
    assert rc == 0
    assert (tmp_path / "gen/models/Program.py").exists()


def test_gen_target_scopes_to_one(tmp_path: Path) -> None:
    cfg = _project(tmp_path, TWO_TARGETS)
    rc = main(["gen", "--config", str(cfg), "--target", "models"])
    assert rc == 0
    assert (tmp_path / "gen/models/Program.py").exists()
    assert not (tmp_path / "gen/other").exists()


def test_gen_unknown_target_errors(tmp_path: Path, capsys) -> None:
    cfg = _project(tmp_path, TWO_TARGETS)
    rc = main(["gen", "--config", str(cfg), "--target", "nope"])
    assert rc == 1
    assert "unknown --target" in capsys.readouterr().err


def test_gen_missing_config_errors(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)  # no config here
    rc = main(["gen"])
    assert rc == 2
    assert "metaobjects.config.yaml" in capsys.readouterr().err


DUP_TARGETS = """
targets:
  a:
    outDir: shared/gen
    generators: [entity]
    entities: [Program]
  b:
    outDir: shared/gen
    generators: [entity]
    entities: [Program]
"""


def test_gen_cross_target_duplicate_output_path_guard(tmp_path: Path, capsys) -> None:
    cfg = _project(tmp_path, DUP_TARGETS)
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 1
    assert "duplicate output path across targets" in capsys.readouterr().err


# --- config-relative provider (no PYTHONPATH) -------------------------------

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


def test_gen_resolves_provider_config_relative_without_pythonpath(tmp_path: Path) -> None:
    """A provider module beside the config resolves via the config dir on sys.path,
    with NO caller PYTHONPATH / sys.path manipulation."""
    meta = tmp_path / "metaobjects_meta"
    meta.mkdir()
    (meta / "meta.json").write_text(json.dumps(CUSTOM_META))
    (tmp_path / "geo_conf_prov.py").write_text(PROVIDER_MODULE)
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(
        """
        metadata: metaobjects_meta
        providers: ["geo_conf_prov:geo_provider"]
        targets:
          models:
            outDir: gen
            generators: [entity]
        """
    )
    assert str(tmp_path) not in sys.path  # precondition: not already importable
    try:
        rc = main(["gen", "--config", str(cfg)])
    finally:
        if str(tmp_path) in sys.path:
            sys.path.remove(str(tmp_path))
        sys.modules.pop("geo_conf_prov", None)
    assert rc == 0
    assert (tmp_path / "gen/Place.py").exists()


def test_gen_flag_path_ignores_config_when_present(tmp_path: Path) -> None:
    """Back-compat: an explicit <metadata_dir> + --out uses the flag path and does
    NOT consult a metaobjects.config.yaml sitting in cwd (byte-identical)."""
    _project(tmp_path, DUP_TARGETS)  # a config that WOULD fail (dup guard) if consulted
    out = tmp_path / "flagout"
    meta = tmp_path / "metaobjects"  # created by _project
    # Flag path: metadata_dir + --out present => config ignored, normal gen.
    rc = main(["gen", str(meta), "--out", str(out)])
    assert rc == 0
    assert (out / "Program.py").exists()

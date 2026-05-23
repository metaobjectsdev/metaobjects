import json
from pathlib import Path

import pytest

from metaobjects.loader.meta_data_loader import load_directory
from metaobjects.meta.meta_data import MetaData
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.generators.entity_model import entity_model


def _load(meta_dir: Path, doc: dict[str, object]) -> MetaData:
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / "meta.json").write_text(json.dumps(doc))
    return load_directory(str(meta_dir)).root


def test_run_gen_writes_a_model_per_entity(tmp_path: Path) -> None:
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Subscriber", "children": [
            {"field.string": {"name": "email", "@required": True}},
        ]}},
    ]}})
    out = tmp_path / "out"
    result = run_gen(GenConfig(out_dir=str(out)), root, generators=[entity_model()])
    assert (out / "Subscriber.py").exists()
    assert "class Subscriber(BaseModel):" in (out / "Subscriber.py").read_text()
    assert [w[1] for w in result.files] == ["new"]


def test_run_gen_skips_unsafe_names_with_warning(tmp_path: Path) -> None:
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Bad-Name", "children": [
            {"field.string": {"name": "x"}},
        ]}},
    ]}})
    out = tmp_path / "out"
    result = run_gen(GenConfig(out_dir=str(out)), root, generators=[entity_model()])
    assert result.files == []
    assert any("unsafe name" in w for w in result.warnings)


def test_run_gen_refuses_handwritten_file(tmp_path: Path) -> None:
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Subscriber", "children": [{"field.string": {"name": "x"}}]}},
    ]}})
    out = tmp_path / "out"
    out.mkdir()
    (out / "Subscriber.py").write_text("# hand written, no marker\nx = 1\n")
    result = run_gen(GenConfig(out_dir=str(out)), root, generators=[entity_model()])
    assert [w[1] for w in result.files] == ["refused"]
    assert any("Refused to overwrite" in w for w in result.warnings)
    assert "hand written" in (out / "Subscriber.py").read_text()  # untouched


def test_run_gen_warns_when_no_entities(tmp_path: Path) -> None:
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": []}})
    result = run_gen(GenConfig(out_dir=str(tmp_path / "out")), root, generators=[entity_model()])
    assert result.files == []
    assert any("No entities to generate" in w for w in result.warnings)


def test_run_gen_errors_on_path_collision(tmp_path: Path) -> None:
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "A", "children": [{"field.string": {"name": "x"}}]}},
    ]}})
    with pytest.raises(ValueError, match="collision"):
        run_gen(GenConfig(out_dir=str(tmp_path / "out")), root,
                generators=[entity_model(), entity_model()])

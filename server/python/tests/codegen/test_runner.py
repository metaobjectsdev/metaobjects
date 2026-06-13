import json
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.meta.meta_data import MetaData
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.constants import GENERATED_MARKER
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.generators.entity_model import entity_model


def _load(meta_dir: Path, doc: dict[str, object]) -> MetaData:
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / "meta.json").write_text(json.dumps(doc))
    return MetaDataLoader.from_directory(meta_dir).root


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
    statuses = {Path(p).name: s for p, s in result.files}
    assert statuses["Subscriber.py"] == "new"
    assert statuses["__init__.py"] == "new"  # package marker emitted alongside


def test_run_gen_emits_importable_package_init(tmp_path: Path) -> None:
    """The codegen out dir is a self-contained package: run_gen emits an
    ``@generated`` ``__init__.py`` so a consumer can import the generated modules
    (which use package-relative imports) without hand-adding a marker file that
    ``verify --codegen`` would then flag as ``extra``."""
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Subscriber", "children": [
            {"field.string": {"name": "email", "@required": True}},
        ]}},
    ]}})
    out = tmp_path / "out"
    run_gen(GenConfig(out_dir=str(out)), root, generators=[entity_model()])
    init = out / "__init__.py"
    assert init.exists(), "expected a generated __init__.py in the out dir"
    assert GENERATED_MARKER in init.read_text(), "__init__.py must carry the @generated marker"


def test_run_gen_package_init_can_be_disabled(tmp_path: Path) -> None:
    """``emit_package_init=False`` suppresses the package marker (consumer owns it)."""
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Subscriber", "children": [{"field.string": {"name": "x"}}]}},
    ]}})
    out = tmp_path / "out"
    run_gen(GenConfig(out_dir=str(out), emit_package_init=False), root,
            generators=[entity_model()])
    assert not (out / "__init__.py").exists()


def test_run_gen_does_not_clobber_handwritten_package_init(tmp_path: Path) -> None:
    """A hand-authored ``__init__.py`` (no @generated marker) is left untouched."""
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Subscriber", "children": [{"field.string": {"name": "x"}}]}},
    ]}})
    out = tmp_path / "out"
    out.mkdir()
    (out / "__init__.py").write_text("# hand written package init\nVERSION = '1'\n")
    result = run_gen(GenConfig(out_dir=str(out)), root, generators=[entity_model()])
    statuses = {Path(p).name: s for p, s in result.files}
    assert statuses["__init__.py"] == "refused"
    assert "hand written package init" in (out / "__init__.py").read_text()  # untouched


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
    statuses = {Path(p).name: s for p, s in result.files}
    assert statuses["Subscriber.py"] == "refused"
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

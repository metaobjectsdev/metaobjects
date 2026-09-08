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


# ── `baseline="adopt"` — the first run a pre-manifest project can perform ──────────
#
# The no-manifest refusal used to LEAD with "commit .metaobjects/.gen-state/.hashes.json",
# which the population it names cannot do: nothing writes a manifest until a gen succeeds,
# and a run where every file refuses writes none. `adopt` records what is on disk as the
# baseline and writes nothing, which is the run that produces the file to commit.


def _pre_manifest_project(tmp_path: Path) -> tuple[MetaData, Path]:
    """Output on disk that differs from fresh, with no manifest — an older engine's run."""
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Subscriber", "children": [{"field.string": {"name": "x"}}]}},
    ]}})
    out = tmp_path / "out"
    out.mkdir()
    (out / "Subscriber.py").write_text(f"# {GENERATED_MARKER}\n# from an older engine\n")
    return root, out


def test_adopt_records_the_files_and_writes_nothing(tmp_path: Path) -> None:
    root, out = _pre_manifest_project(tmp_path)
    before = (out / "Subscriber.py").read_text()
    state = tmp_path / ".metaobjects" / ".gen-state"

    result = run_gen(
        GenConfig(out_dir=str(out), gen_state_dir=str(state), baseline="adopt"),
        root,
        generators=[entity_model()],
    )

    statuses = {Path(p).name: s for p, s in result.files}
    assert statuses["Subscriber.py"] == "adopted"
    assert (out / "Subscriber.py").read_text() == before  # not one byte written
    assert (state / ".hashes.json").exists()  # …and the file to commit now exists


def test_adopt_says_what_to_do_next_once(tmp_path: Path) -> None:
    root, out = _pre_manifest_project(tmp_path)
    state = tmp_path / ".metaobjects" / ".gen-state"

    result = run_gen(
        GenConfig(out_dir=str(out), gen_state_dir=str(state), baseline="adopt"),
        root,
        generators=[entity_model()],
    )

    notices = [w for w in result.warnings if "baseline" in w]
    assert len(notices) == 1
    assert ".hashes.json" in notices[0]
    assert "replace" in notices[0] or "regenerat" in notices[0]


def test_after_adopt_the_next_plain_run_regenerates(tmp_path: Path) -> None:
    root, out = _pre_manifest_project(tmp_path)
    state = tmp_path / ".metaobjects" / ".gen-state"
    run_gen(GenConfig(out_dir=str(out), gen_state_dir=str(state), baseline="adopt"), root,
            generators=[entity_model()])

    result = run_gen(GenConfig(out_dir=str(out), gen_state_dir=str(state)), root,
                     generators=[entity_model()])

    statuses = {Path(p).name: s for p, s in result.files}
    assert statuses["Subscriber.py"] == "overwrite"
    assert "class Subscriber" in (out / "Subscriber.py").read_text()


def test_adopt_does_not_suppress_a_pristine_regen(tmp_path: Path) -> None:
    """`adopt` only ever replaces a REFUSAL — a recorded, unedited file still regenerates."""
    root = _load(tmp_path / "meta", {"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Subscriber", "children": [{"field.string": {"name": "x"}}]}},
    ]}})
    out = tmp_path / "out"
    state = tmp_path / ".metaobjects" / ".gen-state"
    run_gen(GenConfig(out_dir=str(out), gen_state_dir=str(state)), root,
            generators=[entity_model()])

    result = run_gen(GenConfig(out_dir=str(out), gen_state_dir=str(state), baseline="adopt"),
                     root, generators=[entity_model()])

    assert all(s != "adopted" for _p, s in result.files)


def test_the_no_manifest_refusal_leads_with_the_performable_remedy(tmp_path: Path) -> None:
    root, out = _pre_manifest_project(tmp_path)
    state = tmp_path / ".metaobjects" / ".gen-state"

    result = run_gen(GenConfig(out_dir=str(out), gen_state_dir=str(state)), root,
                     generators=[entity_model()])

    msgs = [w for w in result.warnings if "no codegen hash manifest" in w]
    assert len(msgs) == 1
    assert "--baseline=adopt" in msgs[0]
    # What it must no longer do: prescribe committing a file this project cannot produce.
    assert "Commit '.metaobjects/.gen-state/.hashes.json' and re-run" not in msgs[0]

import importlib.util
from pathlib import Path

from metaobjects.loader.meta_data_loader import load_directory
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.generators.entity_model import entity_model

GOLDEN = Path(__file__).parent / "golden"


def _cases() -> list[str]:
    return [d.name for d in GOLDEN.iterdir() if d.is_dir()]


def _generate(case_dir: Path, out: Path) -> Path:
    meta_dir = out / "meta"
    meta_dir.mkdir(parents=True)
    (meta_dir / "meta.json").write_text((case_dir / "meta.json").read_text())
    root = load_directory(str(meta_dir)).root
    gen_out = out / "gen"
    run_gen(GenConfig(out_dir=str(gen_out)), root, generators=[entity_model()])
    return gen_out


def test_golden_matches(tmp_path: Path) -> None:
    cases = _cases()
    assert cases, "no golden cases found"
    for case in cases:
        case_dir = GOLDEN / case
        gen_out = _generate(case_dir, tmp_path / case)
        for expected in (case_dir / "expected").glob("*.py"):
            actual = (gen_out / expected.name).read_text()
            assert actual == expected.read_text(), f"{case}/{expected.name} mismatch"


def test_generated_is_importable(tmp_path: Path) -> None:
    # pydantic models must be valid, importable Python (not just a string match).
    gen_out = _generate(GOLDEN / "vanilla", tmp_path / "imp")
    target = next(gen_out.glob("*.py"))
    spec = importlib.util.spec_from_file_location(target.stem, target)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # raises on syntax/import error


def test_determinism(tmp_path: Path) -> None:
    a = _generate(GOLDEN / "vanilla", tmp_path / "a")
    b = _generate(GOLDEN / "vanilla", tmp_path / "b")
    for f in a.glob("*.py"):
        assert f.read_text() == (b / f.name).read_text()

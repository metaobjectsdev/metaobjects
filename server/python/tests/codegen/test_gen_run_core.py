"""One `metaobjects gen` run: the hash manifest is written once, and `--entities` narrows
what is written without shrinking the files rendered from the whole model.

Parity with codegen-ts (`manifest-write-once.test.ts`, `run-gen.test.ts`).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen import overwrite_policy
from tests.codegen.manifest_helpers import read_manifest
from tests.codegen.config_helpers import as_config
from tests.codegen.gen_suite import GEN_SUITE

FIXTURE = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def _meta_dir(tmp_path: Path) -> str:
    d = tmp_path / "meta"
    d.mkdir()
    (d / "meta.fitness.json").write_text(FIXTURE.read_text())
    return str(d)


def _gen(meta_dir: str, out: Path, *extra: str) -> int:
    return main(as_config(["gen", "--generators", GEN_SUITE, meta_dir, "--out", str(out), *extra]))


@pytest.fixture
def manifest_writes(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    writes: list[str] = []
    real = overwrite_policy._write_manifest_file

    def counting(gen_state_dir: str, ordered: dict[str, object]) -> None:
        writes.append(gen_state_dir)
        real(gen_state_dir, ordered)

    monkeypatch.setattr(overwrite_policy, "_write_manifest_file", counting)
    return writes


def _manifest(tmp_path: Path) -> dict[str, object]:
    [state] = {p.parent for p in tmp_path.rglob(".hashes") if p.is_dir()}
    return read_manifest(state)


def test_a_run_writes_the_manifest_once(tmp_path: Path, manifest_writes: list[str]) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"

    assert _gen(meta_dir, out) == 0
    assert len(manifest_writes) == 1
    recorded = _manifest(tmp_path)
    assert len(recorded) > 2  # many files, one write

    # Two files regenerate and are recorded again: still one write. (Deleting a file
    # alone is not enough: it regenerates to the hash already recorded, which writes
    # nothing.)
    gone = ("out/Program.py", "out/Week.py")
    for path in tmp_path.rglob(".hashes/*.json"):
        kept = {k: v for k, v in json.loads(path.read_text()).items() if k not in gone}
        path.write_text(json.dumps(kept))
    assert len(_manifest(tmp_path)) == len(recorded) - 2
    (out / "Program.py").unlink()
    (out / "Week.py").unlink()
    manifest_writes.clear()
    assert _gen(meta_dir, out) == 0
    assert len(manifest_writes) == 1

    # Nothing changes: no write at all, and the manifest is the same.
    manifest_writes.clear()
    assert _gen(meta_dir, out) == 0
    assert manifest_writes == []
    assert _manifest(tmp_path) == recorded


def test_an_unchanged_file_is_not_reported_as_written(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert _gen(meta_dir, out) == 0
    capsys.readouterr()

    (out / "Program.py").unlink()
    assert _gen(meta_dir, out) == 0
    printed = capsys.readouterr().out.splitlines()
    assert [line for line in printed if line.endswith(".py")] == [str(out / "Program.py")]
    assert "metaobjects gen: wrote 1 file(s)" in printed[-1]
    assert "left as they were" in printed[-1]


def test_entities_narrows_the_write_not_the_whole_model_files(tmp_path: Path) -> None:
    """`--entities Week` writes Week's files and leaves out Program's, but every file it
    does write is byte-identical to the full run's: the shared enums module still
    carries Program's enum, which Week does not declare."""
    meta_dir = _meta_dir(tmp_path)
    full = tmp_path / "full"
    narrow = tmp_path / "narrow"
    assert _gen(meta_dir, full) == 0
    assert _gen(meta_dir, narrow, "--entities", "Week,Node") == 0

    assert (narrow / "Week.py").exists()
    assert (narrow / "Node.py").exists()
    assert not (narrow / "Program.py").exists()
    assert (narrow / "enums.py").exists()

    written = sorted(p.relative_to(narrow) for p in narrow.rglob("*") if p.is_file())
    assert written
    for rel in written:
        assert (narrow / rel).read_bytes() == (full / rel).read_bytes(), str(rel)


def test_a_failed_run_keeps_its_own_error_when_the_manifest_write_fails_too(
    tmp_path: Path,
) -> None:
    gen_state = tmp_path / "gen-state"
    with pytest.raises(RuntimeError, match="the generator's own failure"):
        with overwrite_policy.manifest_batch(str(gen_state)):
            overwrite_policy.decide_and_write(
                str(tmp_path / "a.py"), "x = 1\n", gen_state_dir=str(gen_state), rel_path="a.py"
            )
            # A directory where the manifest goes: the end-of-batch write now fails.
            (gen_state / overwrite_policy.HASHES_FILE).mkdir(parents=True)
            raise RuntimeError("the generator's own failure")

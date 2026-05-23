from pathlib import Path

from metaobjects.codegen.overwrite_policy import decide_and_write
from metaobjects.codegen.constants import generated_header


def test_new_file_written(tmp_path: Path):
    p = tmp_path / "sub" / "A.py"
    res = decide_and_write(str(p), "content", "overwrite")
    assert res == "new"
    assert p.read_text() == "content"


def test_existing_generated_file_overwritten(tmp_path: Path):
    p = tmp_path / "A.py"
    p.write_text(generated_header("A", "A") + "old")
    res = decide_and_write(str(p), generated_header("A", "A") + "new", "overwrite")
    assert res == "overwrite"
    assert "new" in p.read_text()


def test_existing_handwritten_file_refused(tmp_path: Path):
    p = tmp_path / "A.py"
    p.write_text("# hand written, no marker\nx = 1\n")
    res = decide_and_write(str(p), "whatever", "overwrite")
    assert res == "refused"
    assert "hand written" in p.read_text()  # untouched


def test_skip_existing_skips_generated(tmp_path: Path):
    p = tmp_path / "A.py"
    p.write_text(generated_header("A", "A") + "old")
    res = decide_and_write(str(p), generated_header("A", "A") + "new", "skip-existing")
    assert res == "skipped"
    assert "old" in p.read_text()

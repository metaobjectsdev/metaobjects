"""The Python write path must not destroy a hand edit.

The marker-only policy refused a file whose ``@generated`` header was ABSENT — but a
hand-edited generated file still carries its header, so the one case that needed
protecting was the one case that got overwritten. Same defect the TypeScript port
carried until the hash manifest landed; Python never had a merge, so it had no way to
tell its own output from an edit at all.

The fix mirrors TS: a committed ``.gen-state/.hashes.json`` records what we wrote, and
the decision is a hash comparison.

  identical fresh content            -> unchanged
  file still hashes to what we wrote -> overwrite (nothing is lost)
  hash mismatch, or no record at all -> refused (fail closed)

Without a ``gen_state_dir`` there is no record to consult, so the old marker behaviour
stands — mirroring TS, where a ``runGen`` with no ``projectRoot`` also gets weaker
guarantees. The CLI always supplies one.
"""

from __future__ import annotations

import json
from pathlib import Path

from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.overwrite_policy import (
    content_hash,
    decide_and_write,
    has_hash_manifest,
    read_generated_hash,
)


def _gen(path: Path, content: str, state: Path) -> str:
    return decide_and_write(
        str(path), content, "overwrite", gen_state_dir=str(state), rel_path=path.name
    )


def test_hand_edited_generated_file_is_refused(tmp_path: Path) -> None:
    """The defect, directly. The file KEEPS its @generated header."""
    state = tmp_path / ".gen-state"
    p = tmp_path / "A.py"
    original = generated_header("A", "A") + "x = 1\n"
    assert _gen(p, original, state) == "new"

    edited = original + "# my hand edit\n"
    p.write_text(edited)

    assert _gen(p, generated_header("A", "A") + "x = 2\n", state) == "refused"
    assert p.read_text() == edited
    # The recorded hash is NOT advanced: a refusal that forgets becomes a silent
    # overwrite on the next run.
    assert read_generated_hash(str(state), "A.py") == content_hash(original)


def test_untouched_generated_file_is_overwritten(tmp_path: Path) -> None:
    state = tmp_path / ".gen-state"
    p = tmp_path / "A.py"
    _gen(p, generated_header("A", "A") + "x = 1\n", state)

    fresh = generated_header("A", "A") + "x = 2\n"
    assert _gen(p, fresh, state) == "overwrite"
    assert p.read_text() == fresh
    assert read_generated_hash(str(state), "A.py") == content_hash(fresh)


def test_identical_content_is_unchanged(tmp_path: Path) -> None:
    state = tmp_path / ".gen-state"
    p = tmp_path / "A.py"
    content = generated_header("A", "A") + "x = 1\n"
    _gen(p, content, state)
    assert _gen(p, content, state) == "unchanged"


def test_file_with_no_record_is_refused_not_adopted(tmp_path: Path) -> None:
    """Fail closed. Adopting the content would launder the edit into the manifest and
    license the next run to overwrite it."""
    state = tmp_path / ".gen-state"
    p = tmp_path / "A.py"
    p.write_text(generated_header("A", "A") + "someone else wrote this\n")

    assert _gen(p, generated_header("A", "A") + "fresh\n", state) == "refused"
    assert "someone else wrote this" in p.read_text()
    assert read_generated_hash(str(state), "A.py") is None


def test_marker_is_no_longer_consulted(tmp_path: Path) -> None:
    """A file WE wrote is ours even if a template stopped emitting the header.

    Under the marker rule this refused, which was wrong in the opposite direction:
    the file was our own output.
    """
    state = tmp_path / ".gen-state"
    p = tmp_path / "A.py"
    _gen(p, "x = 1\n", state)  # no header at all
    assert _gen(p, "x = 2\n", state) == "overwrite"


def test_manifest_is_sorted_and_detectable(tmp_path: Path) -> None:
    state = tmp_path / ".gen-state"
    assert has_hash_manifest(str(state)) is False
    for name in ("z.py", "a.py", "m.py"):
        _gen(tmp_path / name, f"# {name}\n", state)
    assert has_hash_manifest(str(state)) is True
    # Sorted, because this file is committed: insertion order would make the diff
    # depend on which entity generated first.
    data = json.loads((state / ".hashes.json").read_text())
    assert list(data.keys()) == ["a.py", "m.py", "z.py"]


def test_skip_existing_still_skips(tmp_path: Path) -> None:
    state = tmp_path / ".gen-state"
    p = tmp_path / "A.py"
    _gen(p, "x = 1\n", state)
    res = decide_and_write(
        str(p), "x = 2\n", "skip-existing", gen_state_dir=str(state), rel_path="A.py"
    )
    assert res == "skipped"
    assert p.read_text() == "x = 1\n"


def test_without_gen_state_the_legacy_marker_rule_stands(tmp_path: Path) -> None:
    """Back-compat for programmatic callers that pass no state, mirroring TS's
    no-projectRoot fallback. The CLI always supplies a state dir."""
    p = tmp_path / "A.py"
    p.write_text("# hand written, no marker\n")
    assert decide_and_write(str(p), "fresh\n", "overwrite") == "refused"

    q = tmp_path / "B.py"
    q.write_text(generated_header("B", "B") + "old\n")
    assert decide_and_write(str(q), generated_header("B", "B") + "new\n", "overwrite") == "overwrite"

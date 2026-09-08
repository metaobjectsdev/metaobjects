"""F72 — the manifest is anchored on the PROJECT, so its keys must be too.

Keys were relative to ``--out`` while the manifest itself lives at the project root.
Two consequences, both silent:

  * two runs with different ``--out`` share ONE manifest keyed by names that mean
    different files — ``gen --out a`` and ``gen --out b`` both record ``alarm_names.py``,
    and run B's hash then claims ownership of run A's file. The manifest is the only
    thing that can tell "this is exactly what I wrote" from "somebody edited this" on a
    machine that did not generate the code, so one that can be populated from an
    unrelated tree and keyed ambiguously is one that can say yes to the wrong file.
  * the multi-target path (#267) is the same shape by construction: every target has its
    own ``outDir`` and they all share one ``gen_state_dir``.

Re-keying would invalidate every existing manifest — a recorded file becomes unrecorded,
which is fail-closed (``gen`` REFUSES it) but makes an adopter regenerate to get past a
change they never asked for. So the old spelling is read as a FALLBACK and dropped once
the file is recorded under the new key: a manifest converges with no migration command.

The lookup in ``verify --codegen``'s jurisdiction guard reads the same manifest and had
to move with it. That half fails in the direction nothing notices: a lookup that finds
nothing makes every file "not ours", so the ``extra`` verdict silently empties while the
gate still prints a clean result.
"""

from __future__ import annotations

import json
from pathlib import Path

from metaobjects.codegen.overwrite_policy import (
    content_hash,
    decide_and_write,
    read_generated_hash,
)


def _manifest(gen_state: Path) -> dict[str, str]:
    return json.loads((gen_state / ".hashes.json").read_text(encoding="utf-8"))


def test_key_is_project_relative_not_out_relative(tmp_path: Path) -> None:
    gen_state = tmp_path / ".metaobjects" / ".gen-state"
    out = tmp_path / "build" / "gen"
    out.mkdir(parents=True)
    target = out / "alarm_names.py"

    decide_and_write(
        str(target), "X = 1\n", gen_state_dir=str(gen_state),
        rel_path="build/gen/alarm_names.py", legacy_rel_path="alarm_names.py",
    )

    keys = list(_manifest(gen_state))
    assert keys == ["build/gen/alarm_names.py"]
    # Stated in the negative: the bare name is exactly what made two out dirs collide.
    assert "alarm_names.py" not in keys


def test_two_out_dirs_no_longer_collide_on_one_key(tmp_path: Path) -> None:
    gen_state = tmp_path / ".metaobjects" / ".gen-state"
    for out_rel in ("a", "b"):
        d = tmp_path / out_rel
        d.mkdir()
        decide_and_write(
            str(d / "names.py"), f"X = '{out_rel}'\n", gen_state_dir=str(gen_state),
            rel_path=f"{out_rel}/names.py", legacy_rel_path="names.py",
        )

    manifest = _manifest(gen_state)
    assert sorted(manifest) == ["a/names.py", "b/names.py"]
    # Distinct content, distinct hashes: before the re-key these were one entry, and the
    # last writer's hash decided whether the OTHER file counted as pristine.
    assert manifest["a/names.py"] != manifest["b/names.py"]


def test_a_pre_rekey_manifest_still_recognises_its_own_file(tmp_path: Path) -> None:
    gen_state = tmp_path / ".metaobjects" / ".gen-state"
    gen_state.mkdir(parents=True)
    out = tmp_path / "gen"
    out.mkdir()
    target = out / "names.py"
    target.write_text("X = 1\n", encoding="utf-8")
    # A manifest written before the re-key: keyed by the out-dir-relative name.
    (gen_state / ".hashes.json").write_text(
        json.dumps({"names.py": content_hash("X = 1\n")}), encoding="utf-8"
    )

    status = decide_and_write(
        str(target), "X = 2\n", gen_state_dir=str(gen_state),
        rel_path="gen/names.py", legacy_rel_path="names.py",
    )

    # Recognised as ours and overwritten — NOT refused. That is the whole point of the
    # fallback: fail-closed is correct behaviour for an unknown file and the wrong cost
    # to impose on every existing adopter.
    assert status == "overwrite"
    assert target.read_text(encoding="utf-8") == "X = 2\n"
    # And it converged: one key, the new spelling.
    assert sorted(_manifest(gen_state)) == ["gen/names.py"]


def test_a_genuinely_edited_file_is_still_refused(tmp_path: Path) -> None:
    # The fallback must not become a way to say yes to a file nobody recorded.
    gen_state = tmp_path / ".metaobjects" / ".gen-state"
    gen_state.mkdir(parents=True)
    out = tmp_path / "gen"
    out.mkdir()
    target = out / "names.py"
    target.write_text("X = 999  # hand edit\n", encoding="utf-8")
    (gen_state / ".hashes.json").write_text(
        json.dumps({"names.py": content_hash("X = 1\n")}), encoding="utf-8"
    )

    status = decide_and_write(
        str(target), "X = 2\n", gen_state_dir=str(gen_state),
        rel_path="gen/names.py", legacy_rel_path="names.py",
    )
    assert status == "refused"
    assert target.read_text(encoding="utf-8") == "X = 999  # hand edit\n"


def test_read_prefers_the_new_key_over_the_legacy_one(tmp_path: Path) -> None:
    gen_state = tmp_path / ".metaobjects" / ".gen-state"
    gen_state.mkdir(parents=True)
    (gen_state / ".hashes.json").write_text(
        json.dumps({"gen/names.py": "new", "names.py": "legacy"}), encoding="utf-8"
    )
    assert read_generated_hash(str(gen_state), "gen/names.py", "names.py") == "new"
    # The legacy key alone still answers, for a file not yet re-recorded under the new
    # spelling: the new key is absent, so the fallback is what finds the record.
    assert read_generated_hash(str(gen_state), "gen/not-yet-rekeyed.py", "names.py") == "legacy"
    # A key present in NEITHER spelling stays unrecorded — the fallback must not become a
    # way to say yes to a file nobody recorded.
    assert read_generated_hash(str(gen_state), "gen/absent.py", "absent.py") is None


def test_a_project_reached_through_a_symlink_keeps_its_jurisdiction(
    tmp_path: Path, monkeypatch
) -> None:
    """The anchor and the path must be resolved on the SAME side.

    ``project_root`` arrives resolved; ``full`` is built from the raw ``out_dir``. Relpath
    between a resolved anchor and an unresolved path is not the path between the two
    directories — under a directory symlink it walks OUT of the project, so every key
    read ``../link/gen/X.py``, ``_is_ours_for`` matched none of them, and
    ``verify --codegen`` printed ``in sync (0 file(s))`` over 68 genuinely stale files.

    The spelling this replaced (``relpath(full, out_dir)``) was immune by ACCIDENT: both
    sides came from one unresolved string, so it was symmetric. Symmetry is the property;
    this pins it deliberately. ``/tmp`` is a symlink on macOS, so any project there hits
    it directly.
    """
    real = tmp_path / "proj"
    (real / "metaobjects").mkdir(parents=True)
    fixture = (
        Path(__file__).parents[4]
        / "fixtures"
        / "persistence-conformance"
        / "canonical"
        / "meta.fitness.json"
    )
    meta_file = real / "metaobjects" / "meta.fitness.json"
    meta_file.write_text(fixture.read_text(), encoding="utf-8")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    from metaobjects.cli import main

    monkeypatch.chdir(tmp_path)
    assert main(["gen", str(link / "metaobjects"), "--out", str(link / "gen")]) == 0

    manifest = json.loads(
        (real / ".metaobjects" / ".gen-state" / ".hashes.json").read_text(encoding="utf-8")
    )
    assert manifest, "gen recorded no manifest"
    # Not one key escapes the project. A `../` key is the whole defect.
    assert not any(k.startswith("..") for k in manifest), sorted(manifest)[:3]
    assert all(k.startswith("gen/") for k in manifest), sorted(manifest)[:3]

    # And the gate still convicts stale output reached through the link.
    meta_file.write_text('{"metadata.root": {"package": "fitness", "children": []}}')
    assert main(["verify", "--codegen", str(link / "metaobjects"), "--out", str(link / "gen")]) == 1

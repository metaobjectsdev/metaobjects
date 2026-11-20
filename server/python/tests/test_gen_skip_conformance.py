"""ADR-0064 — the shared table of skip cases (``fixtures/codegen-skip-conformance/cases.json``).

Every case: run ``gen`` once (it must write and store a fingerprint), apply the change, then
ask what the next ``gen`` does and what a LOCAL ``verify --codegen`` may do. A case id this
runner does not know FAILS, so a case added to the shared table reaches this port.
"""
from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pytest

from metaobjects import cli
from metaobjects.codegen import skip
from metaobjects.cli import main

CASES = json.loads(
    (Path(__file__).parents[3] / "fixtures" / "codegen-skip-conformance" / "cases.json").read_text()
)["cases"]

_ENTITY = {
    "metadata.root": {
        "package": "skip",
        "children": [
            {"object.entity": {"name": "{name}", "children": [
                {"field.long": {"name": "id"}},
                {"field.string": {"name": "title"}},
            ]}}
        ],
    }
}

_OWNED = '''\
from pathlib import Path
from metaobjects.codegen.generator import EmittedFile


class Owned:
    name = "owned"
    declared_extra_inputs = ("extra/data.txt",)

    def generate(self, ctx):
        data = Path("extra/data.txt")
        return [EmittedFile("owned.txt", "owned\\n")]


def make():
    return Owned()
'''

_UNCACHEABLE = '''\
from metaobjects.codegen.generator import EmittedFile


class Volatile:
    name = "volatile"
    cacheable = False

    def generate(self, ctx):
        return [EmittedFile("volatile.txt", "v\\n")]


def make():
    return Volatile()
'''


def _book_json(base_extra: bool = False, with_book: bool = True) -> str:
    """meta.b.json: an abstract parent (Base) and, optionally, a child that extends it."""
    base_fields = [{"field.long": {"name": "id"}}]
    if base_extra:
        base_fields.append({"field.string": {"name": "note"}})
    children: list[object] = [
        {"object.entity": {"name": "Base", "abstract": True, "children": base_fields}}
    ]
    if with_book:
        children.append({"object.entity": {"name": "Book", "extends": "Base", "children": [
            {"field.string": {"name": "title"}}]}})
    return json.dumps({"metadata.root": {"package": "skip", "children": children}}, indent=2) + "\n"


def _entity_json(name: str, extra_attr: str | None = None) -> str:
    doc = json.loads(json.dumps(_ENTITY).replace("{name}", name))
    if extra_attr:
        doc["metadata.root"]["children"][0]["object.entity"]["@description"] = extra_attr
    return json.dumps(doc, indent=2) + "\n"


@dataclass
class Project:
    root: Path
    uncacheable: bool = False

    @property
    def config(self) -> Path:
        return self.root / "metaobjects.config.yaml"

    @property
    def state(self) -> Path:
        return self.root / ".metaobjects" / ".gen-state"

    def write_config(self, generators: str = "[entity, owned:make]") -> None:
        gens = generators
        if self.uncacheable:
            gens = "[entity, owned:make, volatile:make]"
        self.config.write_text(
            "metadata: metaobjects\ntemplates: prompts\n"
            f"targets:\n  app:\n    outDir: generated\n    generators: {gens}\n",
            encoding="utf-8",
        )


def _project(tmp_path: Path, uncacheable: bool = False) -> Project:
    p = Project(tmp_path, uncacheable)
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "meta.a.json").write_text(_entity_json("Author"))
    (tmp_path / "metaobjects" / "meta.b.json").write_text(_book_json())
    (tmp_path / "prompts").mkdir()
    (tmp_path / "prompts" / "p.txt").write_text("hello\n")
    (tmp_path / "extra").mkdir()
    (tmp_path / "extra" / "data.txt").write_text("1\n")
    (tmp_path / "README.md").write_text("readme\n")
    (tmp_path / "owned.py").write_text(_OWNED)
    (tmp_path / "volatile.py").write_text(_UNCACHEABLE)
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text('{"schema_version": 1, "sources": [{"path": "metaobjects"}]}\n')
    p.write_config()
    return p


class Harness:
    def __init__(self, project: Project, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
        self.project = project
        self.mp = monkeypatch
        self.capsys = capsys
        self.loads = 0
        self.renders = 0
        self.out = ""
        self.err = ""
        real_load = cli._load_root_from_collection
        real_run = cli._run_gen_targets

        def counting_load(*a, **k):
            self.loads += 1
            return real_load(*a, **k)

        def counting_run(*a, **k):
            self.renders += 1
            return real_run(*a, **k)

        monkeypatch.setattr(cli, "_load_root_from_collection", counting_load)
        monkeypatch.setattr(cli, "_run_gen_targets", counting_run)
        monkeypatch.chdir(project.root)
        monkeypatch.delenv("CI", raising=False)

    def gen(self, *flags: str) -> tuple[int, bool]:
        """Run gen; return (exit code, whether it skipped without loading anything)."""
        self.loads = 0
        self.renders = 0
        self.capsys.readouterr()
        rc = main(["gen", "--config", str(self.project.config), *flags])
        cap = self.capsys.readouterr()
        out = self.out = cap.out
        self.err = cap.err
        skipped = "nothing changed" in out
        if skipped:
            assert self.renders == 0, "a skipped run renders nothing"
        return rc, skipped

    def verify(self, *flags: str) -> tuple[int, bool]:
        """Run verify --codegen; return (exit code, whether it rendered)."""
        self.renders = 0
        rc = main(["verify", "--codegen", "--config", str(self.project.config), *flags])
        self.capsys.readouterr()
        return rc, self.renders > 0


def _touch_same(p: Project, h: Harness) -> None:
    f = p.root / "metaobjects" / "meta.a.json"
    f.write_text(f.read_text())
    os.utime(f, (1, 1))


def _reformat(p: Project, h: Harness) -> None:
    f = p.root / "metaobjects" / "meta.a.json"
    doc = json.loads(f.read_text())
    entity = doc["metadata.root"]["children"][0]["object.entity"]
    # Different whitespace and key order, same content (children keep their authored order).
    f.write_text(json.dumps(doc, separators=(",", ":"), sort_keys=True))
    del entity


def _move(p: Project, h: Harness) -> None:
    (p.root / "metaobjects" / "meta.b.json").write_text(_book_json(with_book=False))
    book = {"metadata.root": {"package": "skip", "children": [
        {"object.entity": {"name": "Book", "extends": "Base", "children": [
            {"field.string": {"name": "title"}}]}}]}}
    (p.root / "metaobjects" / "meta.c.json").write_text(json.dumps(book))


def _edit_owned(p: Project, h: Harness) -> None:
    f = p.root / "owned.py"
    f.write_text(f.read_text() + "\n# edited\n")


def _delete_generated(p: Project, h: Harness) -> None:
    (p.root / "generated" / "owned.txt").unlink()


def _edit_generated(p: Project, h: Harness) -> None:
    f = p.root / "generated" / "owned.txt"
    f.write_text(f.read_text() + "hand edit\n")


def _hand_edit_kept(p: Project, h: Harness) -> None:
    # Python has no three-way merge: a hand edit is REFUSED, the run exits 1 and stores no
    # key (a refusal is a failed gate), so the "kept" run can never be followed by a skip.
    # The follow-up gen is therefore asserted to re-run and refuse again, not to skip.
    _edit_generated(p, h)


def _failed_run(p: Project, h: Harness) -> None:
    good = (p.root / "metaobjects" / "meta.a.json").read_text()
    (p.root / "metaobjects" / "meta.a.json").write_text("{ not json")
    rc, _ = h.gen()
    assert rc != 0
    (p.root / "metaobjects" / "meta.a.json").write_text(good)


def _legacy_manifest(p: Project, h: Harness) -> None:
    """Put the manifest back in its pre-1.3.0 form: one .hashes.json, no .hashes/ directory."""
    merged: dict[str, object] = {}
    for f in sorted((p.state / ".hashes").glob("*.json")):
        merged.update(json.loads(f.read_text()))
    shutil.rmtree(p.state / ".hashes")
    (p.state / ".hashes.json").write_text(json.dumps(dict(sorted(merged.items())), indent=2) + "\n")


def _write(rel: str, text: str) -> Callable[[Project, Harness], None]:
    def go(p: Project, h: Harness) -> None:
        f = p.root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)

    return go


def _append(rel: str, text: str) -> Callable[[Project, Harness], None]:
    def go(p: Project, h: Harness) -> None:
        f = p.root / rel
        f.write_text(f.read_text() + text)

    return go


def _engine_changed(p: Project, h: Harness) -> None:
    h.mp.setattr(skip, "engine_identity", lambda: "another-engine")


#: id -> (setup, extra gen flags). A flag-only case has a no-op setup.
_NOOP = lambda p, h: None  # noqa: E731
HANDLERS: dict[str, tuple[Callable[[Project, Harness], None], tuple[str, ...]]] = {
    "no-change": (_NOOP, ()),
    "metadata-touched": (_touch_same, ()),
    "unrelated-file-edited": (_append("README.md", "more\n"), ()),
    "metadata-reformatted": (_reformat, ()),
    "metadata-moved": (_move, ()),
    "parent-edited": (_write("metaobjects/meta.b.json", _book_json(base_extra=True)), ()),
    "metadata-edited": (_write("metaobjects/meta.a.json", _entity_json("Author", "edited")), ()),
    "metadata-added": (_write("metaobjects/meta.c.json", _entity_json("Chapter")), ()),
    "metadata-removed": (lambda p, h: (p.root / "metaobjects" / "meta.b.json").unlink(), ()),
    "config-edited": (lambda p, h: p.write_config("[entity, owned:make, names]"), ()),
    "project-config-edited": (
        _write(".metaobjects/config.json", '{ "schema_version": 1, "sources": [{"path": "metaobjects"}] }\n'), ()),
    "template-edited": (_write("prompts/p.txt", "changed\n"), ()),
    "template-added": (_write("prompts/new.txt", "new\n"), ()),
    "owned-generator-edited": (_edit_owned, ()),
    "engine-changed": (_engine_changed, ()),
    "selection-changed": (_NOOP, ("--generators", "entity")),
    "declared-extra-edited": (_write("extra/data.txt", "2\n"), ()),
    "uncacheable-generator": (_NOOP, ()),
    "generated-file-deleted": (_delete_generated, ()),
    "generated-file-edited": (_edit_generated, ()),
    "hand-edit-kept": (_hand_edit_kept, ()),
    "fingerprint-missing": (lambda p, h: skip.delete_stored(str(p.state)), ()),
    "force": (_NOOP, ("--force",)),
    "ci": (_NOOP, ()),
    "failed-run": (_failed_run, ()),
    "legacy-manifest": (_legacy_manifest, ()),
}


def test_every_shared_case_has_a_handler() -> None:
    ids = {c["id"] for c in CASES}
    assert ids - set(HANDLERS) == set(), "unknown case id(s): add a handler for them"
    assert set(HANDLERS) - ids == set(), "handler for a case id the shared table dropped"


#: Cases whose "gen keeps the edit" outcome is a refusal in Python (no merge engine).
PYTHON_REFUSES_HAND_EDIT = {"hand-edit-kept"}


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_case(case: dict[str, str], tmp_path: Path, monkeypatch, capsys) -> None:
    assert case["id"] in HANDLERS, f"unknown case id {case['id']!r}"
    setup, flags = HANDLERS[case["id"]]
    project = _project(tmp_path, uncacheable=case["id"] == "uncacheable-generator")
    h = Harness(project, monkeypatch, capsys)

    rc, skipped = h.gen()
    assert rc == 0 and not skipped, h.out + h.err
    assert (project.state / skip.FINGERPRINT_FILE).exists() == (case["id"] != "uncacheable-generator")

    setup(project, h)
    if case["id"] == "ci":
        monkeypatch.setenv("CI", "true")

    # verify first: it never writes or deletes anything, so gen's decision is unaffected.
    verify_flags = {"selection-changed": ("--generators", "entity"), "force": ("--full",)}
    v_rc, rendered = h.verify(*verify_flags.get(case["id"], ()))
    if case["verify"] == "must-render":
        assert rendered, "verify must render and compare"
    else:
        assert not rendered and v_rc == 0, "verify may answer from the fingerprint"
    if case["id"] == "legacy-manifest":
        assert (project.state / ".hashes.json").exists(), "verify must not migrate"

    monkeypatch.delenv("CI", raising=False)
    rc, skipped = h.gen(*flags)
    if case["id"] in PYTHON_REFUSES_HAND_EDIT:
        assert not skipped and rc == 1, "a refused hand edit must keep failing, never skip"
    elif case["gen"] == "skip":
        assert skipped and rc == 0
    else:
        assert not skipped
    if case["id"] == "legacy-manifest":
        assert not (project.state / ".hashes.json").exists(), "the write run removes the legacy file"
        assert list((project.state / ".hashes").glob("*.json")), "and leaves per-package files"


def test_unchanged_files_keep_their_timestamp_and_report_unchanged(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    project = _project(tmp_path)
    h = Harness(project, monkeypatch, capsys)
    assert h.gen()[0] == 0
    generated = project.root / "generated"
    files = [f for f in generated.rglob("*") if f.is_file()]
    assert files
    for f in files:
        os.utime(f, (1, 1))
    manifests = sorted((project.state / ".hashes").glob("*.json"))
    assert manifests
    manifest_bytes = [m.read_bytes() for m in manifests]
    for m in manifests:
        os.utime(m, (1, 1))
    assert h.gen("--force")[0] == 0
    out = h.out
    assert all(f.stat().st_mtime == 1 for f in files), "an identical file was rewritten"
    assert all(m.stat().st_mtime == 1 for m in manifests), "an unchanged manifest was rewritten"
    assert [m.read_bytes() for m in manifests] == manifest_bytes
    assert "wrote 0 file(s)" in out and "left as they were" in out
    assert not [ln for ln in out.splitlines() if ln.startswith(str(generated))]


def test_a_run_that_names_entities_renders_and_leaves_the_full_run_key_alone(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    project = _project(tmp_path)
    h = Harness(project, monkeypatch, capsys)
    assert h.gen() == (0, False)
    stored = project.state / skip.FINGERPRINT_FILE
    key = stored.read_bytes()
    # Naming entities forces exactly those: it renders over unchanged inputs, never skips.
    rc, skipped = h.gen("--entities", "Book")
    assert rc == 0 and not skipped and h.renders > 0, h.out + h.err
    rc, skipped = h.gen("--entities", "Book")
    assert rc == 0 and not skipped and h.renders > 0
    # It neither wrote nor forgot the full-run key, so the next full run still skips.
    assert stored.read_bytes() == key
    assert h.gen() == (0, True)

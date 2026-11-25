"""``metaobjects agent-docs`` writes the shipped agent files itself (G-PY-2).

The contract is ``agent-context-shipped/README.md``: the embedded tree, one stack, guide
links pinned to the release tag, each file written at its path. The result must equal
what the TypeScript scaffolder writes, which ``fixtures/agent-context-conformance/python``
holds as the shared golden.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from metaobjects.agent_context.agent_docs import run_agent_docs
from metaobjects.agent_context.scaffold import AGENT_CONTEXT_MANIFEST_PATH
from metaobjects.agent_context.shipped import (
    ShippedContextError,
    docs_ref_for_version,
    load_shipped,
    materialize,
    shipped_stack_id,
)
from metaobjects.cli import main

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "agent-context-shipped").is_dir())
SHIPPED_ROOT = REPO_ROOT / "agent-context-shipped"
EMBEDDED_ROOT = Path(__file__).resolve().parents[2] / "src/metaobjects/agent_context/shipped"
GOLDEN = REPO_ROOT / "fixtures/agent-context-conformance/python"
RELEASE = "1.3.0"

_TREE = json.loads((SHIPPED_ROOT / "manifest.json").read_text(encoding="utf-8"))
PYTHON_STACKS = [s for s in _TREE["stacks"] if "python" in s["servers"]]


def _tree(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): p.read_text(encoding="utf-8")
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def _without_manifest(tree: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in tree.items() if k != AGENT_CONTEXT_MANIFEST_PATH}


def test_embedded_copy_matches_the_repo_root_tree() -> None:
    root, copy = _tree(SHIPPED_ROOT), _tree(EMBEDDED_ROOT)
    root.pop("README.md")
    assert copy == root, "stale copy: run scripts/sync-python-agent-context.sh"


@pytest.mark.parametrize("stack", PYTHON_STACKS, ids=lambda s: s["id"])
def test_every_python_stack_equals_the_tree_after_link_pinning(stack: dict[str, object], tmp_path: Path) -> None:
    if stack.get("migration"):
        # A `-migrate` stack is chosen by the project config, not by a flag.
        (tmp_path / ".metaobjects").mkdir()
        (tmp_path / ".metaobjects" / "config.json").write_text(
            '{"schema_version": 1, "migrate": {"dialect": "postgres"}}\n', encoding="utf-8"
        )
    run_agent_docs(
        servers=list(stack["servers"]), clients=list(stack["clients"]),  # type: ignore[call-overload]
        out=tmp_path, wire_root=False, version=RELEASE,
    )
    prefix, ref = _TREE["docsLinkPrefix"], _TREE["docsRef"]
    expected = {
        f["path"]: (SHIPPED_ROOT / "files" / f["file"]).read_text(encoding="utf-8")
        .replace(f"{prefix}{ref}/", f"{prefix}v{RELEASE}/")
        for f in stack["files"]  # type: ignore[attr-defined]
    }
    assert {k: v for k, v in _without_manifest(_tree(tmp_path)).items() if k != ".metaobjects/config.json"} == expected


def test_the_shared_golden_is_reproduced_byte_for_byte(tmp_path: Path) -> None:
    stack = json.loads((GOLDEN / "stack.json").read_text(encoding="utf-8"))
    # The golden is written by a prerelease-or-main build, so its links stay on main.
    run_agent_docs(
        servers=stack["servers"], clients=stack["clients"],
        out=tmp_path, wire_root=False, version="1.3.0-rc.1",
    )
    assert _without_manifest(_tree(tmp_path)) == _tree(GOLDEN / "expected")


def test_a_prerelease_or_unresolvable_version_keeps_main() -> None:
    assert docs_ref_for_version("1.3.0") == "v1.3.0"
    for v in ("1.3.0rc1", "1.3.0-rc.1", "0.0.0", "dev", ""):
        assert docs_ref_for_version(v) == "main"


def test_the_pinned_files_name_the_release_tag_and_no_main_link(tmp_path: Path) -> None:
    run_agent_docs(servers=["python"], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    text = "".join(_without_manifest(_tree(tmp_path)).values())
    prefix = _TREE["docsLinkPrefix"]
    assert f"{prefix}v{RELEASE}/" in text
    assert f"{prefix}main/" not in text


def test_stack_id_orders_servers_then_clients_canonically() -> None:
    assert shipped_stack_id(["kotlin", "java"], ["tanstack", "react"]) == "java-kotlin-react-tanstack"


def test_an_unknown_stack_is_refused_naming_the_shipped_ids(tmp_path: Path) -> None:
    with pytest.raises(ShippedContextError) as err:
        run_agent_docs(servers=["python"], clients=["tanstack"], out=tmp_path, version=RELEASE)
    msg = str(err.value)
    assert "python-tanstack" in msg and "python-react-tanstack" in msg
    assert not any(tmp_path.iterdir())
    with pytest.raises(ShippedContextError, match="--server cobol"):
        run_agent_docs(servers=["cobol"], clients=[], out=tmp_path, version=RELEASE)


def test_materialize_refuses_a_stack_with_no_entry() -> None:
    with pytest.raises(ShippedContextError):
        materialize(load_shipped(), ["python", "rust"], [], "main")


def test_the_default_server_is_python(tmp_path: Path) -> None:
    run_agent_docs(servers=[], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    manifest = json.loads((tmp_path / AGENT_CONTEXT_MANIFEST_PATH).read_text(encoding="utf-8"))
    assert manifest["servers"] == ["python"] and manifest["clients"] == []
    assert manifest["generatedBy"] == RELEASE


def test_a_rerun_writes_nothing_and_keeps_the_recorded_stack(tmp_path: Path) -> None:
    run_agent_docs(servers=["python"], clients=["react"], out=tmp_path, version=RELEASE)
    files = [p for p in tmp_path.rglob("*") if p.is_file()]
    for p in files:
        os.utime(p, (1_000_000, 1_000_000))
    created, notes = run_agent_docs(servers=[], clients=[], out=tmp_path, version=RELEASE)
    assert created == [] and notes == []
    assert all(p.stat().st_mtime == 1_000_000 for p in files)


def test_a_project_with_its_own_skills_dir_is_refused_untouched(tmp_path: Path) -> None:
    run_agent_docs(servers=["python"], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    manifest_path = tmp_path / AGENT_CONTEXT_MANIFEST_PATH
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["skillsDir"] = ".agents/skills"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    before = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    with pytest.raises(ShippedContextError) as err:
        run_agent_docs(servers=[], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    assert "npx meta agent-docs --skills-dir .agents/skills" in str(err.value)
    assert {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()} == before


def test_a_hand_edited_file_is_kept_and_the_fresh_text_goes_beside_it(tmp_path: Path) -> None:
    run_agent_docs(servers=["python"], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    agents = tmp_path / ".metaobjects/AGENTS.md"
    pristine = agents.read_text(encoding="utf-8")
    agents.write_text(pristine + "\nmine\n", encoding="utf-8")
    created, notes = run_agent_docs(servers=["python"], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    assert agents.read_text(encoding="utf-8").endswith("mine\n")
    assert (tmp_path / ".metaobjects/AGENTS.md.new").read_text(encoding="utf-8") == pristine
    assert created == [".metaobjects/AGENTS.md.new"]
    assert any("hand-edited" in n for n in notes)
    # Reverting the edit makes the next run see an unmodified file again.
    agents.write_text(pristine, encoding="utf-8")
    created, _ = run_agent_docs(servers=["python"], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    assert created == []


def test_an_unedited_file_is_refreshed_when_the_release_moves(tmp_path: Path) -> None:
    run_agent_docs(servers=["python"], clients=[], out=tmp_path, wire_root=False, version="1.2.0")
    created, _ = run_agent_docs(servers=["python"], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    assert created and not any(c.endswith(".new") for c in created)
    pinned = "".join(p.read_text(encoding="utf-8") for p in tmp_path.rglob("*.md"))
    assert "/blob/v1.3.0/" in pinned and "/blob/v1.2.0/" not in pinned


def test_a_changed_stack_prunes_untouched_orphans_and_keeps_edited_ones(tmp_path: Path) -> None:
    run_agent_docs(servers=["python"], clients=["react", "tanstack"], out=tmp_path, wire_root=False, version=RELEASE)
    alone = set(materialize(load_shipped(), ["python"], [], "main"))
    react_only = set(_tree(tmp_path)) - alone - {AGENT_CONTEXT_MANIFEST_PATH}
    assert len(react_only) > 1
    edited = sorted(react_only)[0]
    (tmp_path / edited).write_text("mine", encoding="utf-8")
    # No flags reuses the recorded stack, so nothing is pruned.
    run_agent_docs(servers=[], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    assert all((tmp_path / p).exists() for p in react_only)
    # Naming the python stack alone drops the react-only files, except the one edited.
    _, notes = run_agent_docs(servers=["python"], clients=[], out=tmp_path, wire_root=False, version=RELEASE)
    assert (tmp_path / edited).read_text(encoding="utf-8") == "mine"
    assert any(edited in n and "hand-edited" in n for n in notes)
    assert not any((tmp_path / p).exists() for p in react_only - {edited})


def test_out_directory_is_created_and_root_files_are_wired_once(tmp_path: Path) -> None:
    out = tmp_path / "proj"
    run_agent_docs(servers=["python"], clients=[], out=out, version=RELEASE)
    for name in ("AGENTS.md", "CLAUDE.md"):
        assert (out / name).read_text(encoding="utf-8").count("@.metaobjects/AGENTS.md") == 1
    run_agent_docs(servers=["python"], clients=[], out=out, version=RELEASE)
    assert (out / "CLAUDE.md").read_text(encoding="utf-8").count("@.metaobjects/AGENTS.md") == 1


def test_command_writes_into_out_and_refuses_an_unknown_stack(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "ctx"
    assert main(["agent-docs", "--server", "py", "--client", "react", "--out", str(out), "--no-wire-root"]) == 0
    assert (out / ".metaobjects/AGENTS.md").is_file()
    assert not (out / "AGENTS.md").exists()
    capsys.readouterr()
    assert main(["agent-docs", "--server", "python", "--client", "tanstack", "--out", str(tmp_path / "no")]) == 2
    assert "python-react-tanstack" in capsys.readouterr().err
    assert not (tmp_path / "no").exists()

"""An owned copy must see another owned copy, not the packaged one.

`metaobjects eject` copies one generator and wires it in beside the packaged ones. Two
things would leave an owned copy calling packaged emit logic, and each is executed here:

* A generator that imports a helper from ANOTHER ejectable generator's module. The owned
  copy keeps calling the packaged generator, so loading one generator must load no other.
* An emit rule two generators share that eject does not hand over. `shared_predicates` is
  copied to `codegen/runtime/` with every generator that imports it, and the owned
  generators read that copy: an edit to it moves both, together.

Each import check runs in a fresh interpreter, because in this process every generator is
already loaded.
"""
from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest

import metaobjects
import metaobjects.codegen.runtime
from metaobjects.cli import main
from metaobjects.codegen import eject as owned
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY

REPO = Path(__file__).parents[4]
FITNESS = REPO / "fixtures" / "persistence-conformance" / "canonical" / "meta.fitness.json"
SHARED = "shared_predicates"
PACKAGED_SHARED = f"metaobjects.codegen.runtime.{SHARED}"
OWNED_SHARED = f"codegen.runtime.{SHARED}"
#: The two cross-generator calls the eject audit found: filter-allowlist asked the routes
#: generator which objects get a router, and extractor asked the entity generator which
#: fields carry a literal default.
SHARED_USERS = {
    "routes": ["emits_router"],
    "filter-allowlist": ["emits_router"],
    "entity": ["has_literal_default"],
    "extractor": ["has_literal_default"],
}


def _fresh_interpreter(code: str, cwd: Path) -> Any:
    """Run *code* in a new interpreter that can import this ``metaobjects``; return the JSON
    it prints."""
    src = str(Path(metaobjects.__file__).resolve().parents[1])
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(
        p for p in (src, os.environ.get("PYTHONPATH", "")) if p)}
    proc = subprocess.run([sys.executable, "-c", code], cwd=cwd, env=env,
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_loading_one_ejectable_generator_loads_no_other_generators_module(tmp_path) -> None:
    sources = {e.name: e.source_module for e in GENERATOR_REGISTRY.values() if e.source_module}
    assert sources, "expected the registry to name ejectable generators"
    offenders: list[str] = []
    for name, own in sources.items():
        siblings = sorted(set(sources.values()) - {own})
        loaded = _fresh_interpreter(
            "import importlib, json, sys\n"
            f"importlib.import_module({own!r})\n"
            f"print(json.dumps([m for m in {siblings!r} if m in sys.modules]))\n",
            tmp_path,
        )
        offenders.extend(f"loading {name} ({own}) also loads {m}" for m in loaded)
    assert not offenders, "\n".join(offenders)


#: The docs generator reads the router gates (`is_read_only_routed`, `emits_writable_router`) from
#: the same module, so the reference describes the routers an owned `routes` emits.
DOCS_READERS = {"api-docs"}


def test_the_generators_that_share_a_predicate_hand_it_over() -> None:
    users = {n for n, e in GENERATOR_REGISTRY.items() if SHARED in e.runtime}
    assert users == set(SHARED_USERS) | DOCS_READERS


def test_each_owned_generator_ejected_alone_reads_the_owned_predicates(tmp_path, monkeypatch) -> None:
    for name, predicates in SHARED_USERS.items():
        root = tmp_path / owned.owned_stem(name)
        root.mkdir()
        monkeypatch.chdir(root)
        assert main(["eject", name]) == 0
        # The installed module is unimportable here, so an owned copy that still reached for
        # it (directly, or through a packaged module it imports) fails instead of passing.
        homes = _fresh_interpreter(
            "import importlib, json, sys\n"
            f"sys.modules[{PACKAGED_SHARED!r}] = None\n"
            f"sys.path.insert(0, {str(root)!r})\n"
            f"mod = importlib.import_module('codegen.generators.{owned.owned_stem(name)}')\n"
            f"print(json.dumps({{p: getattr(mod, p).__module__ for p in {predicates!r}}}))\n",
            root,
        )
        assert homes == {p: OWNED_SHARED for p in predicates}, name


def _project(root: Path, generators: str) -> Path:
    """A project whose single target writes into a uniquely-named package; returns it."""
    (root / "metaobjects").mkdir(parents=True)
    (root / "metaobjects" / FITNESS.name).write_text(FITNESS.read_text(encoding="utf-8"))
    pkg = f"gen_{uuid.uuid4().hex[:8]}"
    (root / "metaobjects.config.yaml").write_text(
        f"targets:\n  api:\n    outDir: {pkg}\n    generators: [{generators}]\n"
    )
    return root / pkg


def _emitted(out: Path, suffix: str) -> list[str]:
    return sorted(p.name for p in out.glob(f"*{suffix}"))


def test_an_edit_to_the_owned_predicate_moves_owned_routes_and_owned_allowlist_together(
    tmp_path, monkeypatch, capsys,
) -> None:
    packaged = tmp_path / "packaged"
    packaged_out = _project(packaged, "entity, filter-allowlist, routes")
    monkeypatch.chdir(packaged)
    assert main(["gen"]) == 0
    routers = _emitted(packaged_out, "_router.py")
    allowlists = _emitted(packaged_out, "_filter_allowlist.py")
    assert routers and allowlists

    root = tmp_path / "owned"
    out = _project(root, "entity, codegen.generators.filter_allowlist:filter_allowlist_generator, "
                         "codegen.generators.routes:router_generator")
    monkeypatch.chdir(root)
    assert main(["eject", "routes"]) == 0
    capsys.readouterr()
    assert main(["eject", "filter-allowlist"]) == 0
    kept = capsys.readouterr().out
    assert f"codegen/runtime/{SHARED}.py: kept your copy — identical" in kept
    assert "may need the newer copy" not in kept

    # One owned rule, edited once: the Post object no longer gets a router.
    rule = root / "codegen" / "runtime" / f"{SHARED}.py"
    rule.write_text(
        rule.read_text(encoding="utf-8")
        + "\n\n_reference_emits_router = emits_router\n\n\n"
        "def emits_router(entity):\n"
        "    return entity.name != 'Post' and _reference_emits_router(entity)\n",
        encoding="utf-8",
    )
    assert main(["gen"]) == 0
    assert "post_router.py" in routers and "post_filter_allowlist.py" in allowlists
    assert _emitted(out, "_router.py") == [r for r in routers if r != "post_router.py"]
    assert _emitted(out, "_filter_allowlist.py") == [
        a for a in allowlists if a != "post_filter_allowlist.py"
    ]

    assert main(["gen", "--list"]) == 0
    assert (f"runtime codegen/runtime/{SHARED}.py [owned — DIFFERS: 0 behind, 3 of your own]"
            in capsys.readouterr().out)


#: The predicates `routes` and `api-docs` read from the shared module that an earlier
#: hand-over of it did not carry.
ADDED_PREDICATES = {"is_read_only_routed", "emits_writable_router"}


def _shared_predicates_before_the_added_ones() -> str:
    source = owned.packaged_runtime_path(SHARED).read_text(encoding="utf-8")
    lines = source.splitlines(keepends=True)
    removed = set()
    for node in reversed(ast.parse(source).body):
        if isinstance(node, ast.FunctionDef) and node.name in ADDED_PREDICATES:
            del lines[node.lineno - 1:node.end_lineno]
            removed.add(node.name)
    assert removed == ADDED_PREDICATES
    return "".join(lines)


@pytest.mark.parametrize("own_edit", ["", "\n# my fix\n"], ids=["unedited", "edited"])
def test_eject_onto_an_older_shared_copy_keeps_it_and_says_how_to_refresh_it(
    own_edit: str, tmp_path, monkeypatch, capsys,
) -> None:
    """A project that ejected a generator before `api-docs` existed owns a
    `shared_predicates.py` without the predicates the api reference imports. Eject keeps
    that copy, so it has to say the copy is behind and name the way to bring it up."""
    older = _shared_predicates_before_the_added_ones() + own_edit
    mine = tmp_path / "codegen" / "runtime" / f"{SHARED}.py"
    mine.parent.mkdir(parents=True)
    mine.write_text(older, encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["eject", "api-docs"]) == 0
    assert mine.read_text(encoding="utf-8") == older
    lines = capsys.readouterr().out.splitlines()
    at = next(i for i, ln in enumerate(lines) if f"{SHARED}.py: kept your copy" in ln)
    behind, own = re.search(r"kept your copy — DIFFERS: (\d+) behind, (\d+) of your own",
                            lines[at]).groups()
    assert int(behind) > 0 and int(own) == (1 if own_edit else 0)

    packaged = Path(metaobjects.codegen.runtime.__path__[0]) / f"{SHARED}.py"
    hint = lines[at + 1]
    assert "api-docs may need the newer copy" in hint
    if own_edit:
        assert f'diff -u codegen/runtime/{SHARED}.py "{packaged}"' in hint
        assert "cp " not in hint
    else:
        assert f'cp "{packaged}" codegen/runtime/' in hint
    assert [ln for ln in lines if "may need the newer copy" in ln] == [hint]

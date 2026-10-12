"""The eject contract, asserted for the Python port (ADR-0034 Amendment 8).

Every stock generator can be ejected, and the owned copy holds its emit. Three assertions,
each driven by ``fixtures/generator-registry-conformance/registry.json``:

* **Census.** Every generator class under ``metaobjects.codegen`` belongs to a registry
  entry, and the registry exposes exactly the names the shared file gives this port.
* **Completeness.** Every registered generator ships eject source, unless the shared file
  exempts it with a reason.
* **Depth.** Each generator, ejected alone into an empty project, loads; imports nothing
  from the codegen packages outside the engine surface; and emits what the packaged
  generator emits.

Where the contract does not hold yet, the shared file's ``pending`` list says so. A pending
entry that passes fails here, and so does a gap that is not listed.
"""
from __future__ import annotations

import ast
import importlib
import importlib.util
import inspect
import json
import os
import pkgutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest

import metaobjects
import metaobjects.codegen
from metaobjects.codegen import eject as owned
from metaobjects.codegen.generator import Generator
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY, GeneratorBuildContext

from . import eject_contract as contract

REPO = contract.manifest_path().parents[2]
FIXTURES = REPO / "fixtures"

#: Models that between them make every ejectable generator emit. ``files`` are loaded
#: together; ``templates`` is the directory template refs resolve under.
CORPORA: dict[str, dict[str, object]] = {
    "fitness": {
        "files": [FIXTURES / "persistence-conformance" / "canonical" / "meta.fitness.json"],
        "templates": FIXTURES / "persistence-conformance" / "canonical" / "prompts",
    },
    "requirements": {
        "files": sorted(
            (FIXTURES / "requirement-test-identity-conformance" / "worked-example" / "input").iterdir()
        ),
    },
    "llm-call": {
        "files": sorted((FIXTURES / "conformance" / "ai-trace-prompt-nested" / "input").iterdir()),
    },
}

#: The one difference an owned copy's output is allowed: it imports the helper runtime the
#: adopter owns, emitted beside it, where packaged output imports the installed one.
PACKAGED_RUNTIME_IMPORT = "from metaobjects.codegen.runtime."
OWNED_RUNTIME_IMPORT = "from ._runtime."
OWNED_RUNTIME_DIR = "_runtime/"


# ---------------------------------------------------------------------------------------
# census
# ---------------------------------------------------------------------------------------


def _generator_classes() -> set[type]:
    """Every class under ``metaobjects.codegen`` that is a generator: it has ``generate``."""
    found: set[type] = set()
    for info in pkgutil.walk_packages(metaobjects.codegen.__path__, "metaobjects.codegen."):
        module = importlib.import_module(info.name)
        for _, cls in inspect.getmembers(module, inspect.isclass):
            if cls.__module__ != info.name or cls is Generator:
                continue
            if callable(getattr(cls, "generate", None)):
                found.add(cls)
    return found


def test_census_every_generator_class_belongs_to_a_registry_entry() -> None:
    registered = {type(e.factory(GeneratorBuildContext())) for e in GENERATOR_REGISTRY.values()}
    unregistered = sorted(f"{c.__module__}.{c.__name__}" for c in _generator_classes() - registered)
    assert not unregistered, (
        "generator classes no registry entry constructs, so no catalog, eject command or "
        f"test sees them: {unregistered}. Register each in generator_registry.py and in "
        f"{contract.manifest_path().name}."
    )


def test_census_the_registry_exposes_the_names_the_shared_file_gives_this_port() -> None:
    expected = set(contract.port_slice())
    actual = set(GENERATOR_REGISTRY)
    pending = set(contract.pending("census"))
    assert actual - expected == set(), "registered, but the shared file does not list it for python"
    assert expected - actual == pending, (
        "the shared file expects these generators in the Python registry and they are not "
        f"there: {sorted(expected - actual)}; pending census entries: {sorted(pending)}. "
        "Register the generator, or remove the pending entry of one that is now registered."
    )


# ---------------------------------------------------------------------------------------
# completeness
# ---------------------------------------------------------------------------------------


def test_completeness_every_registered_generator_ships_eject_source_unless_exempt() -> None:
    ejectable = {e.name for e in owned.ejectable()}
    pending = set(contract.pending("completeness"))
    problems: list[str] = []
    for name in sorted(GENERATOR_REGISTRY):
        if contract.is_exempt(name):
            if name in ejectable:
                problems.append(f"{name}: exempt in the shared file but ejectable; drop the exemption")
            continue
        if name in ejectable and name in pending:
            problems.append(f"{name}: ejectable now; remove its pending completeness entry")
        if name not in ejectable and name not in pending:
            problems.append(f"{name}: no eject source, and the shared file does not exempt it")
    problems += [f"{n}: pending completeness entry for a generator this port does not register"
                 for n in sorted(pending - set(GENERATOR_REGISTRY))]
    assert not problems, "\n".join(problems)


# ---------------------------------------------------------------------------------------
# depth
# ---------------------------------------------------------------------------------------


#: The calls that import a module named by a string: ``importlib.import_module("m")``,
#: a bare ``import_module("m")`` and ``__import__("m")``.
_IMPORT_CALLS = {"import_module", "__import__"}


def _imported_by_call(node: ast.Call) -> str | None:
    """The module a call imports by a string LITERAL, or ``None``. A name built at run time
    cannot be read here; that limit is stated in ADR-0034 Amendment 8."""
    func = node.func
    name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
    if name not in _IMPORT_CALLS or not node.args:
        return None
    first = node.args[0]
    return first.value if isinstance(first, ast.Constant) and isinstance(first.value, str) else None


def _imports(path: Path, module_name: str) -> set[str]:
    """Every module *path* imports, resolved to a dotted name: its import statements, and
    its ``import_module`` / ``__import__`` calls on a string literal. A ``from p import a``
    names ``p.a`` when that is a module, else ``p``."""
    package = module_name.rpartition(".")[0]
    out: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Call):
            named = _imported_by_call(node)
            if named is not None:
                out.add(named)
        elif isinstance(node, ast.Import):
            out.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parent = package.rsplit(".", node.level - 1)[0] if node.level > 1 else package
                base = f"{parent}.{base}" if base else parent
            for alias in node.names:
                candidate = f"{base}.{alias.name}"
                is_module = base.startswith("metaobjects") and _is_module(candidate)
                out.add(candidate if is_module else base)
    return out


def _is_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _eject_alone(name: str, root: Path) -> list[Path]:
    """Eject *name* by itself into the empty project at *root*; the files eject wrote."""
    root.mkdir(parents=True)
    result = owned.eject([name], root)
    assert result.code == 0, result.err
    return sorted(p for p in (root / "codegen").rglob("*.py") if p.name != "__init__.py")


def _outside_engine_surface(name: str, root: Path) -> list[str]:
    surface = contract.EngineSurface()
    outside: set[str] = set()
    for path in _eject_alone(name, root):
        module_name = ".".join(path.relative_to(root).with_suffix("").parts)
        outside.update(m for m in _imports(path, module_name) if surface.outside(m))
    return sorted(outside)


def test_depth_an_owned_copy_imports_only_the_engine_surface(tmp_path: Path) -> None:
    pending = contract.pending("depth")
    ejectable = {e.name for e in owned.ejectable()}
    problems: list[str] = []
    for name in sorted(ejectable):
        actual = _outside_engine_surface(name, tmp_path / owned.owned_stem(name))
        expected = sorted(m for entry in pending.get(name, []) for m in entry["outside"])
        if actual == expected:
            continue
        if not expected:
            problems.append(
                f"{name}: its owned copy imports emit code that stays in the package: {actual}. "
                "Hand it over with the generator; an import of the engine belongs in "
                "eject.engineSurface.python.engine."
            )
        elif not actual:
            problems.append(f"{name}: its owned copy is whole now; remove its pending depth entry")
        else:
            problems.append(f"{name}: pending depth entry lists {expected}, the owned copy imports {actual}")
    problems += [f"{n}: pending depth entry for a generator that is not ejectable"
                 for n in sorted(set(pending) - ejectable)]
    assert not problems, "\n".join(problems)


def test_depth_the_scan_reads_string_imports_as_well_as_import_statements(tmp_path: Path) -> None:
    probe = tmp_path / "probe.py"
    probe.write_text(
        "import importlib\n"
        "from importlib import import_module\n"
        "a = importlib.import_module('metaobjects.codegen.extract_delegate_emitter')\n"
        "b = import_module('metaobjects.codegen.type_map')\n"
        "c = __import__('metaobjects.codegen.fr010_field_mapping')\n"
        "d = importlib.import_module(name)\n"
        "from metaobjects.apidocs import PythonApiDocsRenderer\n"
        "from metaobjects.apidocs import naming\n",
        encoding="utf-8",
    )
    found = _imports(probe, "codegen.generators.probe")
    assert {
        "metaobjects.codegen.extract_delegate_emitter",
        "metaobjects.codegen.type_map",
        "metaobjects.codegen.fr010_field_mapping",
        "metaobjects.apidocs",
        "metaobjects.apidocs.naming",
    } <= found
    surface = contract.EngineSurface()
    assert sorted(m for m in found if surface.outside(m)) == [
        "metaobjects.apidocs",
        "metaobjects.codegen.extract_delegate_emitter",
        "metaobjects.codegen.fr010_field_mapping",
    ]


def test_depth_every_engine_surface_entry_names_a_real_module() -> None:
    stale = [m for m in contract.EngineSurface().engine if "*" not in m and not _is_module(m)]
    assert not stale, f"eject.engineSurface.python.engine names modules that do not exist: {stale}"


#: Runs in a fresh interpreter with the project root as its working directory, so the owned
#: copy is loaded the way an adopter's ``metaobjects gen`` loads it and nothing this test
#: process imported is in the way. Prints ``{"owned": {...}, "packaged": {...}}``, each
#: ``{corpus: {relative path: content}}``.
_DRIVER = r"""
import json, sys, tempfile
from pathlib import Path

root, name, corpora = Path(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3])

from metaobjects import MetaDataLoader
from metaobjects.codegen import eject as owned
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY, GeneratorBuildContext
from metaobjects.codegen.runner import run_gen
from metaobjects.loader.sources import FileSource

entry = GENERATOR_REGISTRY[name]
out = {"owned": {}, "packaged": {}}
for corpus, spec in corpora.items():
    loaded = MetaDataLoader(strict=True).load([FileSource(Path(f)) for f in spec["files"]])
    assert not loaded.errors, [str(e) for e in loaded.errors]
    ctx = GeneratorBuildContext(template_root=spec.get("templates"))
    mine, err = owned.build_owned(owned.owned_token(entry), root, ctx)
    assert err is None, err
    for side, generator in (("owned", mine), ("packaged", entry.factory(ctx))):
        with tempfile.TemporaryDirectory() as tmp:
            run_gen(GenConfig(out_dir=tmp, emit_package_init=False), loaded.root, generators=[generator])
            out[side][corpus] = {
                p.relative_to(tmp).as_posix(): p.read_text(encoding="utf-8")
                for p in sorted(Path(tmp).rglob("*")) if p.is_file()
            }
print(json.dumps(out))
"""


def _run_alone(name: str, root: Path) -> dict[str, dict[str, dict[str, str]]]:
    src = str(Path(metaobjects.__file__).resolve().parents[1])
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(
        p for p in (src, os.environ.get("PYTHONPATH", "")) if p)}
    corpora = {
        corpus: {"files": [str(f) for f in spec["files"]],  # type: ignore[union-attr]
                 **({"templates": str(spec["templates"])} if "templates" in spec else {})}
        for corpus, spec in CORPORA.items()
    }
    proc = subprocess.run(
        [sys.executable, "-c", _DRIVER, str(root), name, json.dumps(corpora)],
        cwd=root, env=env, capture_output=True, text=True,
    )
    assert proc.returncode == 0, f"{name}, ejected alone, does not load and run:\n{proc.stderr}"
    return json.loads(proc.stdout)


def _lines(text: str) -> Counter[str]:
    return Counter(line for line in text.splitlines() if line.strip())


@pytest.mark.parametrize("name", sorted(e.name for e in owned.ejectable()))
def test_depth_an_unchanged_owned_copy_emits_what_the_packaged_generator_emits(
    name: str, tmp_path: Path
) -> None:
    root = tmp_path / owned.owned_stem(name)
    _eject_alone(name, root)
    result = _run_alone(name, root)
    hands_runtime_over = owned.ejected_source(GENERATOR_REGISTRY[name]) != owned.packaged_source(
        GENERATOR_REGISTRY[name])

    emitted = 0
    for corpus in CORPORA:
        packaged, mine = result["packaged"][corpus], result["owned"][corpus]
        emitted += len(packaged)
        extra = sorted(set(mine) - set(packaged))
        assert sorted(set(packaged) - set(mine)) == [], (name, corpus)
        if not hands_runtime_over:
            assert extra == [], (name, corpus)
            assert mine == packaged, (name, corpus)
            continue
        # Import sorting moves the now-relative runtime imports below the third-party
        # block, so this one comparison is over lines, not positions.
        assert all(OWNED_RUNTIME_DIR in path for path in extra), (name, corpus, extra)
        for path, text in packaged.items():
            expected = text.replace(PACKAGED_RUNTIME_IMPORT, OWNED_RUNTIME_IMPORT)
            assert _lines(mine[path]) == _lines(expected), (name, corpus, path)
    assert emitted > 0, f"{name} emitted nothing over {sorted(CORPORA)}: nothing was compared"

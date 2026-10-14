"""Each ejectable generator, ejected ALONE, owns everything that writes its output.

ADR-0034 Amendment 3: the adopter owns the generator and the code that code calls, when
that code is a helper. So for every generator the registry makes ejectable, derived from the
registry and not from a list kept beside it, an empty project that ejects only that generator
must get a copy that

* is the generator and the helper modules its registry entry lists, and nothing else;
* loads and runs with every packaged emit module made unimportable; and
* writes output byte-identical to the packaged generator over the same model.

What an owned copy may still import from the package (the engine surface) is defined once, in
``fixtures/generator-registry-conformance/registry.json`` (``eject.engineSurface.python``), and
asserted by ``tests/conformance/test_eject_contract.py``.

The one documented difference is the router: an owned ``routes`` emits its runtime into the
generated package and imports it from there, so its router modules differ from the packaged
ones in those import lines and in the ``_runtime/`` files (``test_eject_runtime.py``).

The census at the bottom keeps the guard honest: a helper module no registry entry hands over,
or a generator module no registry entry names, fails here instead of staying packaged.
"""
from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
import sys
import warnings
from pathlib import Path
from typing import Any

import pytest

import metaobjects
from metaobjects.codegen import eject as owned
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY
from tests.conformance import eject_contract as contract

REPO = Path(__file__).parents[4]
FIXTURES = REPO / "fixtures"
CODEGEN = Path(metaobjects.__file__).parent / "codegen"

EJECTABLE = sorted(e.name for e in owned.ejectable())


@pytest.mark.parametrize("name", EJECTABLE)
def test_eject_writes_the_generator_and_the_helpers_its_entry_lists(name: str, tmp_path: Path) -> None:
    entry = GENERATOR_REGISTRY[name]
    assert owned.eject([name], tmp_path).code == 0
    copied = [owned.owned_path(tmp_path, name)] + [
        owned.runtime_path(tmp_path, m) for m in entry.runtime
    ]
    written = {p.relative_to(tmp_path).as_posix() for p in (tmp_path / "codegen").rglob("*.py")
               if p.name != "__init__.py"}
    assert written == {p.relative_to(tmp_path).as_posix() for p in copied}


# --- the same project, run twice -------------------------------------------------------

_PROMPTS = {
    "metadata.root": {
        "package": "acme::prompts",
        "children": [
            {"object.value": {"name": "ClassifyRequest", "children": [
                {"field.string": {"name": "text", "@required": True}}]}},
            {"object.value": {"name": "ClassifyResponse", "children": [
                {"field.string": {"name": "label", "@required": True}},
                {"field.int": {"name": "score"}},
                {"field.string": {"name": "tags", "isArray": True}}]}},
            {"template.prompt": {
                "name": "ClassifyPrompt", "@payloadRef": "ClassifyRequest",
                "@responseRef": "ClassifyResponse", "@textRef": "p/classify", "@format": "json"}},
            {"template.prompt": {
                "name": "ClassifyXmlPrompt", "@payloadRef": "ClassifyRequest",
                "@responseRef": "ClassifyResponse", "@textRef": "p/classify", "@format": "xml"}},
            {"object.entity": {
                "name": "ClassifyCall", "extends": "metaobjects::ai::LlmCallBase",
                "children": [
                    {"source.rdb": {"@table": "classify_call", "@role": "primary"}},
                    {"identity.primary": {"name": "id", "@fields": ["traceId"]}},
                    {"template.prompt": {
                        "name": "ClassifyTraced", "@payloadRef": "ClassifyRequest",
                        "@responseRef": "ClassifyResponse", "@textRef": "p/classify",
                        "@format": "json"}}]}},
        ],
    }
}


def _model_project(root: Path, generators: str) -> Path:
    """A project over every metadata shape the ejectable generators read, with one target
    that runs *generators*."""
    meta = root / "metaobjects"
    meta.mkdir(parents=True)
    canonical = FIXTURES / "persistence-conformance" / "canonical" / "meta.fitness.json"
    (meta / canonical.name).write_text(canonical.read_text(encoding="utf-8"), encoding="utf-8")
    render = FIXTURES / "template-output-render-conformance"
    (meta / "meta.render.json").write_text((render / "meta.json").read_text(encoding="utf-8"))
    shutil.copytree(render / "templates", root / "templates")
    shutil.copytree(canonical.parent / "prompts", root / "templates", dirs_exist_ok=True)
    (root / "templates" / "p").mkdir()
    (root / "templates" / "p" / "classify.mustache").write_text("Classify {{text}}\n")
    (meta / "meta.prompts.json").write_text(json.dumps(_PROMPTS), encoding="utf-8")
    shop = FIXTURES / "requirement-test-identity-conformance" / "worked-example" / "input"
    for doc in shop.iterdir():
        (meta / doc.name).write_text(doc.read_text(encoding="utf-8"), encoding="utf-8")
    config = f"libraries: [ai]\ntargets:\n  main:\n    outDir: gen\n    generators: [{generators}]\n"
    (root / "metaobjects.config.yaml").write_text(config, encoding="utf-8")
    return root


#: Run in a fresh interpreter: load the CLI, then (for an owned run) make every packaged emit
#: module unimportable, run the command, and print the tree it wrote.
_SCRIPT = """
import json, os, sys
from pathlib import Path
from metaobjects.cli import main
block = json.loads(sys.argv[3])
for name in list(sys.modules):
    if any(name == b or name.startswith(b + ".") for b in block):
        sys.modules[name] = None
sys.path.insert(0, os.getcwd())
rc = main(json.loads(sys.argv[2]))
out = Path(sys.argv[1])
tree = {p.relative_to(out).as_posix(): p.read_text(encoding="utf-8")
        for p in sorted(out.rglob("*")) if p.is_file() and "__pycache__" not in p.parts}
print(json.dumps({"rc": rc, "tree": tree}))
"""


def _run(root: Path, argv: list[str], out: str, block: list[str]) -> dict[str, str]:
    src = str(Path(metaobjects.__file__).resolve().parents[1])
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(
        p for p in (src, os.environ.get("PYTHONPATH", "")) if p)}
    proc = subprocess.run(
        [sys.executable, "-c", _SCRIPT, str(root / out), json.dumps(argv), json.dumps(block)],
        cwd=root, env=env, capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    result: dict[str, Any] = json.loads(proc.stdout.splitlines()[-1])
    assert result["rc"] == 0, proc.stderr
    return result["tree"]  # type: ignore[no-any-return]


def _packaged_modules() -> list[str]:
    """Every packaged module an owned copy must not reach: each ejectable generator's own and
    the helper runtime beside it."""
    return sorted({"metaobjects.codegen.runtime"}
                  | {e.source_module for e in owned.ejectable() if e.source_module})


def _import_line(line: str) -> bool:
    return line.startswith(("import ", "from "))


def _shape(text: str) -> tuple[list[str], list[str]]:
    """A module as (its import lines, sorted; every other line, IN ORDER). Import sorting moves
    the now-relative imports of an owned router, so only their set is compared; everything
    else must match line for line, so a reordered body still fails."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return sorted(ln for ln in lines if _import_line(ln)), [ln for ln in lines if not _import_line(ln)]


@pytest.mark.parametrize("name", EJECTABLE)
def test_an_ejected_generator_writes_what_the_packaged_one_writes(name: str, tmp_path: Path) -> None:
    entry = GENERATOR_REGISTRY[name]
    argv = ["gen"]
    out = "gen"

    packaged_root = _model_project(tmp_path / "packaged", name)
    packaged = _run(packaged_root, argv, out, block=[])
    assert packaged, f"{name} wrote nothing over the test model, so it proves nothing"

    owned_root = _model_project(tmp_path / "owned", owned.owned_token(entry))
    assert owned.eject([name], owned_root).code == 0
    mine = _run(owned_root, argv, out, block=_packaged_modules())

    if entry.runtime and {"constraint_errors", "filter_parser"} <= set(entry.runtime):
        # An owned router emits its runtime into the generated package and imports it there.
        runtime_files = {k for k in mine if k.startswith("_runtime/")}
        assert runtime_files and runtime_files == {
            f"_runtime/{m}.py" for m in ("__init__", "constraint_errors", "filter_parser")
        }
        mine = {k: v for k, v in mine.items() if k not in runtime_files}
        packaged = {k: v.replace("metaobjects.codegen.runtime.", "._runtime.")
                    for k, v in packaged.items()}
        assert set(mine) == set(packaged)
        assert {k: _shape(v) for k, v in mine.items()} == {k: _shape(v) for k, v in packaged.items()}
    else:
        assert mine == packaged


# --- the census -------------------------------------------------------------------------


def test_every_helper_module_is_handed_over_by_some_generator() -> None:
    """A module in ``codegen/runtime/`` no registry entry lists is one eject would leave
    packaged behind an owned generator."""
    on_disk = {p.stem for p in (CODEGEN / "runtime").glob("*.py") if p.stem != "__init__"}
    listed = {m for e in GENERATOR_REGISTRY.values() for m in e.runtime}
    assert on_disk == listed


def _is_deprecated_alias(module: str) -> bool:
    """A module that moved into ``runtime/`` leaves an alias at its old path: importing the
    old name returns the module at the new one."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        return importlib.import_module(module).__name__ != module


def test_every_generator_module_is_a_registry_entry_or_a_model_walk() -> None:
    """The census for Python: every module in ``codegen/generators/`` is a registered
    generator or one of the model walks the shared engine surface names."""
    package = "metaobjects.codegen.generators"
    registered = {e.source_module for e in GENERATOR_REGISTRY.values() if e.source_module}
    # The primitive: exempt, it has no emit logic of its own.
    registered |= {f"{package}.template_generator"}
    walks = {m for m in contract.EngineSurface().engine if m.startswith(f"{package}.")}
    on_disk = {f"{package}.{p.stem}" for p in (CODEGEN / "generators").glob("*.py")
               if p.stem != "__init__"}
    assert {m for m in on_disk if not _is_deprecated_alias(m)} == registered | walks

"""Each ejectable generator, ejected ALONE, owns everything that writes its output.

ADR-0034 Amendment 3: the adopter owns the generator and the code that code calls, when
that code is a helper. So for every generator the registry makes ejectable, derived from the
registry and not from a list kept beside it, an empty project that ejects only that generator
must get a copy that

* imports no packaged emit module: the copy and the helper source eject placed beside it
  import only the engine surface written below (the generator base, the file writer and
  formatter, the naming and type-mapping tables, the model walks and the loader);
* loads and runs with every packaged emit module made unimportable; and
* writes output byte-identical to the packaged generator over the same model.

The one documented difference is the router: an owned ``routes`` emits its runtime into the
generated package and imports it from there, so its router modules differ from the packaged
ones in those import lines and in the ``_runtime/`` files (``test_eject_runtime.py``).

The census at the bottom keeps the guard honest: a helper module no registry entry hands over,
or a generator module no registry entry names, fails here instead of staying packaged.
"""
from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

import metaobjects
from metaobjects.codegen import eject as owned
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY

REPO = Path(__file__).parents[4]
FIXTURES = REPO / "fixtures"
CODEGEN = Path(metaobjects.__file__).parent / "codegen"

#: The packaged ``metaobjects.codegen`` modules an owned copy may import: the engine. Everything
#: that returns emitted text is handed over instead, and everything outside ``metaobjects.codegen``
#: (the loader, the metamodel, naming, render, extract, the runtime) is core by ruling.
ENGINE_CODEGEN = frozenset({
    "metaobjects.codegen.config",               # GenConfig
    "metaobjects.codegen.constants",            # the @generated marker and header
    "metaobjects.codegen.format",               # the formatter
    "metaobjects.codegen.generator",            # the generator base, EmittedFile, GenContext
    "metaobjects.codegen.instance_artifacts",   # model questions: what an object emits
    "metaobjects.codegen.model_walk",
    "metaobjects.codegen.project_config",       # the requirementTests options
    "metaobjects.codegen.requirement_hooks",
    "metaobjects.codegen.requirement_walk",     # shared with `verify`
    "metaobjects.codegen.type_map",             # the type-mapping table
    "metaobjects.codegen.value_objects",        # naming and value-object resolution
    "metaobjects.codegen.generators.find_inbound",   # model walk: the inbound tier
    "metaobjects.codegen.generators.tph_plan",       # model walk: table-per-hierarchy
})
#: Of ``metaobjects.apidocs``, only the naming seam: the names the generators emit under.
ENGINE_APIDOCS = frozenset({"metaobjects.apidocs.naming"})

EJECTABLE = sorted(e.name for e in owned.ejectable())


def _runtime_imports(node: ast.AST) -> list[ast.stmt]:
    """The import statements under *node* that run: an ``if TYPE_CHECKING:`` block is only an
    annotation for a type checker, so it is not walked."""
    found: list[ast.stmt] = []
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.If) and isinstance(child.test, ast.Name) \
                and child.test.id == "TYPE_CHECKING":
            found.extend(_runtime_imports_of(child.orelse))
        elif isinstance(child, (ast.Import, ast.ImportFrom)):
            found.append(child)
        else:
            found.extend(_runtime_imports(child))
    return found


def _runtime_imports_of(body: list[ast.stmt]) -> list[ast.stmt]:
    found: list[ast.stmt] = []
    for stmt in body:
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            found.append(stmt)
        else:
            found.extend(_runtime_imports(stmt))
    return found


def _imports(source: str) -> list[tuple[int, str | None, list[str]]]:
    """``(level, module, imported names)`` for each import statement in *source* that runs."""
    out: list[tuple[int, str | None, list[str]]] = []
    for node in _runtime_imports(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            out.append((node.level, node.module, [a.name for a in node.names]))
        elif isinstance(node, ast.Import):
            out.extend((0, a.name, []) for a in node.names)
    return out


def _outside_the_engine(source: str, handed_over: set[str]) -> list[str]:
    """What *source* imports that is neither the engine surface nor a helper handed over."""
    offenders: list[str] = []
    for level, module, names in _imports(source):
        if level:
            # A relative import is the handed-over helper: `..runtime.<m>` from a generator,
            # `.<m>` or `from . import <m>` from a helper.
            if module is None:
                targets = names
            elif module.startswith("runtime."):
                targets = [module.split(".", 1)[1]]
            elif module == "runtime":
                targets = names
            else:
                targets = [module]
            offenders.extend(
                f"relative import of {t!r}, which eject does not hand over"
                for t in targets if t not in handed_over
            )
            continue
        if module is None or not module.startswith("metaobjects."):
            continue
        # `from metaobjects.codegen import type_map` names a module through the package.
        packages = ("metaobjects.codegen", "metaobjects.codegen.generators",
                    "metaobjects.codegen.runtime", "metaobjects.apidocs")
        candidates = [f"{module}.{n}" for n in names] if module in packages else [module]
        for c in candidates:
            if c.startswith("metaobjects.codegen"):
                if c not in ENGINE_CODEGEN:
                    offenders.append(c)
            elif c.startswith("metaobjects.apidocs"):
                if c not in ENGINE_APIDOCS:
                    offenders.append(c)
    return offenders


@pytest.mark.parametrize("name", EJECTABLE)
def test_an_ejected_generator_imports_only_the_engine(name: str, tmp_path: Path) -> None:
    entry = GENERATOR_REGISTRY[name]
    assert owned.eject([name], tmp_path).code == 0
    handed_over = set(entry.runtime)
    copied = [owned.owned_path(tmp_path, name)] + [
        owned.runtime_path(tmp_path, m) for m in entry.runtime
    ]
    offenders: list[str] = []
    for path in copied:
        assert path.is_file(), f"eject did not write {path.relative_to(tmp_path)}"
        offenders += [
            f"{path.relative_to(tmp_path)}: {o}"
            for o in _outside_the_engine(path.read_text(encoding="utf-8"), handed_over)
        ]
    assert not offenders, "\n".join(offenders)
    # Nothing else was written: the copy is the generator and its helpers.
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


def _model_project(root: Path, generators: str, docs: str = "") -> Path:
    """A project over every metadata shape the ejectable generators read, with one target
    that runs *generators* (and, when given, a ``docs.generators`` block)."""
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
    if docs:
        config += f"docs:\n  generators: [{docs}]\n"
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


def _lines(text: str) -> Counter[str]:
    return Counter(ln for ln in text.splitlines() if ln.strip())


@pytest.mark.parametrize("name", EJECTABLE)
def test_an_ejected_generator_writes_what_the_packaged_one_writes(name: str, tmp_path: Path) -> None:
    entry = GENERATOR_REGISTRY[name]
    docs = entry.docs_surface is not None
    # The docs label defaults to the directory's name, which differs between the two projects.
    argv = ["docs", "--out", "docs", "--project", "model"] if docs else ["gen"]
    out = "docs" if docs else "gen"

    packaged_root = _model_project(tmp_path / "packaged", "" if docs else name)
    packaged = _run(packaged_root, argv, out, block=[])
    assert packaged, f"{name} wrote nothing over the test model, so it proves nothing"

    owned_root = _model_project(
        tmp_path / "owned",
        "" if docs else owned.owned_token(entry),
        owned.owned_token(entry) if docs else "",
    )
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
        # Import sorting moves the now-relative imports, so compare lines, not positions.
        assert {k: _lines(v) for k, v in mine.items()} == {k: _lines(v) for k, v in packaged.items()}
    else:
        assert mine == packaged


# --- the census -------------------------------------------------------------------------


def test_every_helper_module_is_handed_over_by_some_generator() -> None:
    """A module in ``codegen/runtime/`` no registry entry lists is one eject would leave
    packaged behind an owned generator."""
    on_disk = {p.stem for p in (CODEGEN / "runtime").glob("*.py") if p.stem != "__init__"}
    listed = {m for e in GENERATOR_REGISTRY.values() for m in e.runtime}
    assert on_disk == listed


def test_every_generator_module_is_a_registry_entry_or_a_model_walk() -> None:
    """The census for Python: every module in ``codegen/generators/`` is a registered
    generator or one of the two model walks the engine surface names."""
    registered = {Path(e.source_module.replace(".", "/")).name
                  for e in GENERATOR_REGISTRY.values() if e.source_module}
    registered |= {"template_generator"}  # the primitive: exempt, it has no emit logic of its own
    walks = {Path(m.replace(".", "/")).name for m in ENGINE_CODEGEN
             if m.startswith("metaobjects.codegen.generators.")}
    # A module that moved into `runtime/` leaves a deprecated alias at its old path.
    on_disk = {p.stem for p in (CODEGEN / "generators").glob("*.py")
               if p.stem != "__init__" and "codegen._moved" not in p.read_text(encoding="utf-8")}
    assert on_disk == registered | walks


def test_template_is_the_only_registered_generator_without_an_eject_source() -> None:
    assert {e.name for e in GENERATOR_REGISTRY.values() if e.source is None} == {"template"}

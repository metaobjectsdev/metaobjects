"""`metaobjects eject` — copy a reference generator into the adopter's repo to own.

ADR-0034 Amendment 3: a generator is a reference helper, not a guarantee. The adopter
copies it with ``eject``, wires the copy into ``generators`` as ``module:symbol`` (the
syntax ``providers`` already accepts), and ``gen`` / ``verify --codegen`` run the copy.
Mirrors the TypeScript ``meta eject``: the copy is verbatim, an existing copy is never
overwritten without ``--force``, and the config is never edited — eject prints the entry
to wire instead.

A copy imports the same ``metaobjects.codegen.*`` module paths the packaged generator
does. Those module paths are the documented surface an owned generator builds on.

What the copy's OUTPUT imports is a different question. A generator whose generated code
imports helper runtime (``routes``: ``filter_parser``, ``constraint_errors``) lists it on
its registry entry, and eject hands that over too: the runtime source lands in
``codegen/runtime/`` and the copy's ``OWNED_RUNTIME`` switch is flipped, so the owned
generator emits that source into the generated package and its output imports the local
copy. Core modules (loader, registry, render, extract, ``ObjectManager``) stay package
imports. An existing runtime copy is never overwritten, even with ``--force``: eject
reports how it compares with the packaged module, and how to refresh one that is behind.

Everything a generator writes its output THROUGH is handed over the same way: the emit
rules several generators share (``shared_predicates``), the fragment emitters behind a full
generator (the shared-enum and M:N writers), the prompt-tier emitters (the extract delegate,
the extract schema, the field mapping and the output-format spec) and, for ``api-docs``, the
page model, builder, renderer and path math. A generator imports each relatively from its
``runtime`` sibling, so the verbatim copy in ``codegen/generators/`` reads
``codegen/runtime/<module>.py`` with no edit, and two owned generators read the one copy.
Only the engine stays a package import: the generator base and file writer, the naming and
type-mapping tables, the model walks and the loader. That surface is written in the shared
manifest (``eject.engineSurface.python`` in ``fixtures/generator-registry-conformance/registry.json``)
and ``tests/conformance/test_eject_contract.py`` ejects each generator alone and holds it to
exactly that.

An owned ``api-docs`` is wired like every other owned copy: its ``module:symbol`` replaces
``api-docs`` in a target's ``generators`` (ADR-0034 Amendment 9).
"""
from __future__ import annotations

import importlib
import inspect
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from metaobjects.codegen.generator import Generator
from metaobjects.codegen.generator_registry import (
    GENERATOR_REGISTRY,
    GeneratorBuildContext,
    GeneratorEntry,
)
from metaobjects.codegen.project_import import import_project_symbol

#: Where an owned copy lands, relative to the project root. Mirrors the TS layout.
OWNED_DIR = Path("codegen") / "generators"

#: Where the helper runtime an owned generator's output depends on lands. A sibling of
#: :data:`OWNED_DIR`, which is where the owned router reads it from.
RUNTIME_DIR = Path("codegen") / "runtime"

#: The switch an owned copy flips to emit and import its runtime locally.
_RUNTIME_SWITCH_OFF = "OWNED_RUNTIME = False"
_RUNTIME_SWITCH_ON = "OWNED_RUNTIME = True"


def owned_stem(name: str) -> str:
    """The module name of an owned copy: the stable name with ``-`` as ``_``."""
    return name.replace("-", "_")


def owned_path(root: Path, name: str) -> Path:
    return root / OWNED_DIR / f"{owned_stem(name)}.py"


def owned_token(entry: GeneratorEntry) -> str:
    """The ``module:symbol`` entry that wires an owned copy of *entry*."""
    return f"codegen.generators.{owned_stem(entry.name)}:{entry.symbol}"


def packaged_source(entry: GeneratorEntry) -> str:
    return packaged_module_path(entry).read_text(encoding="utf-8")


def ejected_source(entry: GeneratorEntry) -> str:
    """What ``eject`` writes for *entry*: the packaged source, with the runtime switch on
    when it carries one (a generator whose output imports helper runtime does). This is
    the reference an owned copy is compared against."""
    source = packaged_source(entry)
    switches = source.count(_RUNTIME_SWITCH_OFF)
    if switches == 0:
        return source
    if switches != 1:
        raise RuntimeError(
            f"{entry.source_module} must carry at most one {_RUNTIME_SWITCH_OFF!r} line "
            "for eject to hand its runtime over"
        )
    return source.replace(_RUNTIME_SWITCH_OFF, _RUNTIME_SWITCH_ON)


def packaged_runtime_path(module: str) -> Path:
    """The installed source of helper runtime *module*."""
    package = importlib.import_module("metaobjects.codegen.runtime")
    assert package.__file__ is not None
    return Path(package.__file__).parent / f"{module}.py"


def runtime_path(root: Path, module: str) -> Path:
    return root / RUNTIME_DIR / f"{module}.py"


def ejectable() -> list[GeneratorEntry]:
    return [e for e in GENERATOR_REGISTRY.values() if e.source is not None]


@dataclass
class EjectResult:
    code: int
    out: list[str]
    err: list[str]


def eject(names: list[str], root: Path, *, force: bool = False) -> EjectResult:
    """Copy each named generator. Every name is checked before any file is written."""
    names = list(dict.fromkeys(names))
    known = {e.name: e for e in ejectable()}
    unknown = [n for n in names if n not in known]
    if unknown:
        return EjectResult(2, [], [
            f"unknown or non-ejectable generator(s): {', '.join(unknown)}; "
            f"ejectable: {', '.join(sorted(known))}",
        ])
    existing = [n for n in names if owned_path(root, n).exists()]
    if existing and not force:
        return EjectResult(1, [], [
            f"already owned: {', '.join(str(owned_path(root, n).relative_to(root)) for n in existing)}. "
            "Eject never overwrites your copy; pass --force to replace it with the reference.",
        ])

    (root / OWNED_DIR).mkdir(parents=True, exist_ok=True)
    for init in (root / "codegen" / "__init__.py", root / OWNED_DIR / "__init__.py"):
        if not init.exists():
            init.write_text("", encoding="utf-8")

    out: list[str] = []
    for n in names:
        entry = known[n]
        target = owned_path(root, n)
        target.write_text(ejected_source(entry), encoding="utf-8")
        out.append(f"ejected {n} -> {target.relative_to(root)}")
        out.append(f"  wire it: replace \"{n}\" in `generators` with {owned_token(entry)}")
        for module in entry.runtime:
            rt = runtime_path(root, module)
            rel = rt.relative_to(root)
            packaged = packaged_runtime_path(module)
            reference = packaged.read_text(encoding="utf-8")
            if rt.exists():
                behind, own = _line_diff(rt.read_text(encoding="utf-8"), reference)
                out.append(f"  runtime {rel}: kept your copy — {_status(behind, own)} "
                           "(eject never overwrites runtime)")
                if behind:
                    out.append(f'    {n} may need the newer copy: diff -u "{rt}" "{packaged}"; '
                               f'if you have not changed it: cp "{packaged}" "{rt}"')
                continue
            rt.parent.mkdir(parents=True, exist_ok=True)
            rt.write_text(reference, encoding="utf-8")
            out.append(f"  runtime {rel}: copied — your owned generator reads this copy")
    out.append("")
    out.append(
        "The copies are yours: edit them freely. Keep only one of the packaged name and your "
        "copy in `generators` — wiring both runs both, and they write the same files."
    )
    return EjectResult(0, out, [])


def identical_owned(root: Path) -> list[GeneratorEntry]:
    """The owned generator copies that are identical to the shipped one, generator file and
    companion runtime both. ``gen`` names them and ``eject --undo`` drops them."""
    found: list[GeneratorEntry] = []
    for entry in ejectable():
        if owned_path(root, entry.name).exists():
            verdict = owned_verdict(root, entry)
            if verdict is not None and verdict[0] == "identical":
                found.append(entry)
    return found


def undo(names: list[str], root: Path, *, force: bool = False) -> EjectResult:
    """Drop owned generator copies identical to the shipped ones (``eject --undo``).

    With no *names*, every identical copy goes. With names, only those; a copy that differs
    is refused (nothing removed) unless *force*. Every name is checked before any file is
    removed. The config is never edited: the entry that points back at the shipped generator
    is printed instead. A companion runtime copy goes only when it matches the package and
    no remaining owned generator reads it."""
    names = list(dict.fromkeys(names))
    known = {e.name: e for e in ejectable()}
    unknown = [n for n in names if n not in known]
    if unknown:
        return EjectResult(2, [], [
            f"unknown or non-ejectable generator(s): {', '.join(unknown)}; "
            f"ejectable: {', '.join(sorted(known))}",
        ])
    not_owned = [n for n in names if not owned_path(root, n).exists()]
    if not_owned:
        return EjectResult(2, [], [f"not an owned copy (nothing at {OWNED_DIR.as_posix()}): "
                                   f"{', '.join(not_owned)}"])

    if names:
        chosen = [known[n] for n in names]
        identical = identical_owned(root)
        differing = [e for e in chosen if e not in identical]
        if differing and not force:
            return EjectResult(2, [], [
                f"{e.name} differs from the shipped generator; nothing removed. Inspect: "
                f'diff -u "{owned_path(root, e.name)}" "{packaged_module_path(e)}" '
                "(pass --force to remove it anyway)"
                for e in differing
            ])
    else:
        chosen = identical_owned(root)
        if not chosen:
            return EjectResult(0, [
                "nothing to undo: no owned generator copy is identical to the shipped one."
            ], [])

    removing = {e.name for e in chosen}
    out: list[str] = []
    wiring: list[str] = []
    for entry in chosen:
        path = owned_path(root, entry.name)
        path.unlink()
        out.append(f"removed {path.relative_to(root).as_posix()}")
        wiring.append(f"  replace {owned_token(entry)} with \"{entry.name}\"")
        for module in entry.runtime:
            rt = runtime_path(root, module)
            if not rt.exists():
                continue
            rel = rt.relative_to(root).as_posix()
            if any(owned_path(root, o.name).exists() and o.name not in removing and module in o.runtime
                   for o in ejectable()):
                out.append(f"  kept {rel}: another owned generator still reads it")
            elif _compare(rt.read_text(encoding="utf-8"),
                          packaged_runtime_path(module).read_text(encoding="utf-8")) != "identical":
                out.append(f"  kept {rel}: it differs from the package")
            else:
                rt.unlink()
                out.append(f"  removed {rel}")
    out.append("")
    out.append("metaobjects.config.yaml is not edited. In `generators`:")
    out.extend(wiring)
    return EjectResult(0, out, [])


def packaged_module_path(entry: GeneratorEntry) -> Path:
    assert entry.source_module is not None
    module = importlib.import_module(entry.source_module)
    assert module.__file__ is not None
    return Path(module.__file__)


def _normalised(text: str) -> Counter[str]:
    return Counter(line.rstrip() for line in text.splitlines() if line.strip())


def owned_status(root: Path, entry: GeneratorEntry) -> str | None:
    """``identical`` / ``DIFFERS: N behind, M of your own``, or ``None`` if not owned.

    Line-multiset comparison, the same shape as TS ``owned-copy.ts``: *behind* counts
    reference lines the copy lacks, *of your own* counts copy lines the reference lacks.
    """
    path = owned_path(root, entry.name)
    if entry.source is None or not path.exists():
        return None
    return _compare(path.read_text(encoding="utf-8"), ejected_source(entry))


def owned_companions(root: Path, entry: GeneratorEntry) -> list[tuple[Path, str]]:
    """``(relative path, status)`` of each owned runtime module *entry* ejects, against the
    installed copy. A generator and the runtime its output imports are one owned unit: the
    generator is ``identical`` only when every companion is too."""
    rows: list[tuple[Path, str]] = []
    for module in entry.runtime:
        path = runtime_path(root, module)
        if path.exists():
            rows.append((path.relative_to(root), _compare(
                path.read_text(encoding="utf-8"),
                packaged_runtime_path(module).read_text(encoding="utf-8"),
            )))
    return rows


def owned_verdict(root: Path, entry: GeneratorEntry) -> tuple[str, list[tuple[Path, str]]] | None:
    """The verdict ``--list`` prints for an owned generator plus its differing companions, or
    ``None`` if not owned. The generator file's own counts win when it differs; when it is
    identical but a companion differs, the verdict says so (TS: ``generator identical, N
    renderer(s) differ``) and the caller names each differing file."""
    own = owned_status(root, entry)
    if own is None:
        return None
    differing = [(p, st) for p, st in owned_companions(root, entry) if st != "identical"]
    if own == "identical" and differing:
        own = f"DIFFERS: generator identical, {len(differing)} runtime module(s) differ"
    return own, differing


def _line_diff(mine_text: str, ref_text: str) -> tuple[int, int]:
    """``(behind, of your own)``: reference lines the copy lacks, copy lines the reference lacks."""
    mine = _normalised(mine_text)
    ref = _normalised(ref_text)
    return sum((ref - mine).values()), sum((mine - ref).values())


def _status(behind: int, own: int) -> str:
    if behind == 0 and own == 0:
        return "identical"
    return f"DIFFERS: {behind} behind, {own} of your own"


def _compare(mine_text: str, ref_text: str) -> str:
    return _status(*_line_diff(mine_text, ref_text))


def runtime_status(root: Path) -> list[tuple[Path, str]]:
    """``(relative path, status)`` for each owned runtime copy, against the installed one.

    Same verdict shape as :func:`owned_status`, so ``--list`` can say when an upgrade
    changed runtime you own."""
    modules = sorted({m for e in ejectable() for m in e.runtime})
    rows: list[tuple[Path, str]] = []
    for module in modules:
        path = runtime_path(root, module)
        if path.exists():
            rows.append((path.relative_to(root), _compare(
                path.read_text(encoding="utf-8"),
                packaged_runtime_path(module).read_text(encoding="utf-8"),
            )))
    return rows


def build_owned(spec: str, root: Path, ctx: GeneratorBuildContext) -> tuple[Generator | None, str | None]:
    """Resolve a ``module:symbol`` generator entry against the project at *root*.

    The symbol may be a Generator instance, a Generator class (instantiated), or a factory: one taking ``template_root`` (the
    render-helper shape) gets the build context's template root; one taking a single
    positional argument gets the build context; otherwise it is called with none.
    """
    module_name, sep, symbol = spec.partition(":")
    if not sep or not module_name or not symbol:
        return None, (f"generator {spec!r} is neither a registered name nor a "
                      "'module:symbol' reference to an owned copy")
    obj, err = import_project_symbol(module_name, symbol, root)
    if err is not None:
        return None, f"generator {spec!r}: {err}"
    # A generator CLASS has `generate` too (unbound), so test for the class first: it must be
    # instantiated, not used as the generator.
    if inspect.isclass(obj) or (not hasattr(obj, "generate") and callable(obj)):
        params = inspect.signature(obj).parameters
        required = [p for p in params.values()
                    if p.default is inspect.Parameter.empty
                    and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
        try:
            if "template_root" in params:
                obj = obj(template_root=ctx.template_root or tempfile.gettempdir())
            elif len(required) == 1:
                obj = obj(ctx)
            else:
                obj = obj()
        except Exception as exc:
            return None, f"generator {spec!r}: factory {symbol}() raised: {exc}"
    if not hasattr(obj, "generate") or not hasattr(obj, "name"):
        return None, f"generator {spec!r}: {symbol!r} is not a generator (needs name and generate)"
    return obj, None

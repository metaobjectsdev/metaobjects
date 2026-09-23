"""`metaobjects eject` — copy a reference generator into the adopter's repo to own.

ADR-0034 Amendment 3: a generator is a reference helper, not a guarantee. The adopter
copies it with ``eject``, wires the copy into ``generators`` as ``module:symbol`` (the
syntax ``providers`` already accepts), and ``gen`` / ``verify --codegen`` run the copy.
Mirrors the TypeScript ``meta eject``: the copy is verbatim, an existing copy is never
overwritten without ``--force``, and the config is never edited — eject prints the entry
to wire instead.

A copy imports the same ``metaobjects.codegen.*`` module paths the packaged generator
does. Those module paths are the documented surface an owned generator builds on.
"""
from __future__ import annotations

import importlib
import inspect
import sys
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

#: Where an owned copy lands, relative to the project root. Mirrors the TS layout.
OWNED_DIR = Path("codegen") / "generators"


def owned_stem(name: str) -> str:
    """The module name of an owned copy: the stable name with ``-`` as ``_``."""
    return name.replace("-", "_")


def owned_path(root: Path, name: str) -> Path:
    return root / OWNED_DIR / f"{owned_stem(name)}.py"


def owned_token(entry: GeneratorEntry) -> str:
    """The ``module:symbol`` entry that wires an owned copy of *entry*."""
    return f"codegen.generators.{owned_stem(entry.name)}:{entry.symbol}"


def packaged_source(entry: GeneratorEntry) -> str:
    assert entry.source_module is not None
    module = importlib.import_module(entry.source_module)
    assert module.__file__ is not None
    return Path(module.__file__).read_text(encoding="utf-8")


def ejectable() -> list[GeneratorEntry]:
    return [e for e in GENERATOR_REGISTRY.values() if e.source is not None]


@dataclass
class EjectResult:
    code: int
    out: list[str]
    err: list[str]


def eject(names: list[str], root: Path, *, force: bool = False) -> EjectResult:
    """Copy each named generator. Every name is checked before any file is written."""
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
        target.write_text(packaged_source(entry), encoding="utf-8")
        out.append(f"ejected {n} -> {target.relative_to(root)}")
        out.append(f"  wire it: replace \"{n}\" in `generators` with {owned_token(entry)}")
    out.append("")
    out.append(
        "The copies are yours: edit them freely. Keep only one of the packaged name and your "
        "copy in `generators` — wiring both runs both, and they write the same files."
    )
    return EjectResult(0, out, [])


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
    mine = _normalised(path.read_text(encoding="utf-8"))
    ref = _normalised(packaged_source(entry))
    behind = sum((ref - mine).values())
    own = sum((mine - ref).values())
    if behind == 0 and own == 0:
        return "identical"
    return f"DIFFERS: {behind} behind, {own} of your own"


def build_owned(spec: str, root: Path, ctx: GeneratorBuildContext) -> tuple[Generator | None, str | None]:
    """Resolve a ``module:symbol`` generator entry against the project at *root*.

    The symbol may be a Generator, or a factory: one taking ``template_root`` (the
    render-helper shape) gets the build context's template root; one taking a single
    positional argument gets the build context; otherwise it is called with none.
    """
    module_name, sep, symbol = spec.partition(":")
    if not sep or not module_name or not symbol:
        return None, (f"generator {spec!r} is neither a registered name nor a "
                      "'module:symbol' reference to an owned copy")
    root_str = str(root.resolve())
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    # A module of the same name imported from another project (or an earlier copy) would
    # be reused from the cache; drop any entry that does not live under this root.
    top = module_name.split(".")[0]
    for key in [k for k in sys.modules if k == top or k.startswith(top + ".")]:
        file = getattr(sys.modules[key], "__file__", None)
        if file is None or not str(Path(file).resolve()).startswith(root_str):
            del sys.modules[key]
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # ImportError and anything raised at import time
        return None, f"generator {spec!r}: cannot import {module_name!r}: {exc}"
    obj = getattr(module, symbol, None)
    if obj is None:
        return None, f"generator {spec!r}: {module_name!r} has no attribute {symbol!r}"
    if not hasattr(obj, "generate") and callable(obj):
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

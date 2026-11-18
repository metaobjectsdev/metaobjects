"""Package-keyed output layout (#546): a value object is never renamed.

`output_layout: "package"` places each per-object module in the directory of its metadata
package and spells every import between generated modules as the matching relative import.
The flat layout is the default and stays byte-identical. Two objects that would emit one
module into one directory are refused with ERR_NAME_COLLISION, naming both nodes.
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataLoader
from metaobjects.codegen import import_path as ip
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.entity_model import entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import filter_allowlist_generator
from metaobjects.codegen.generators.names_generator import names_generator
from metaobjects.codegen.name_claims import ERR_NAME_COLLISION
from metaobjects.codegen.runner import run_gen


def _value(name: str, *fields: dict) -> dict:
    return {"object.value": {"name": name, "children": list(fields) or [{"field.string": {"name": "x"}}]}}


def _load(*packages: tuple[str, list[dict]]):
    sources = [
        InMemoryStringSource(json.dumps({"metadata.root": {"package": pkg, "children": children}}))
        for pkg, children in packages
    ]
    res = MetaDataLoader().load(sources)
    assert res.errors == [], res.errors
    return res.root


def _two_notes():
    return _load(
        ("acme::alpha", [_value("Note", {"field.string": {"name": "alphaOnly"}})]),
        ("acme::beta", [_value("Note", {"field.int": {"name": "betaOnly"}})]),
        (
            "acme::app",
            [
                _value(
                    "Digest",
                    {"field.object": {"name": "a", "@objectRef": "acme::alpha::Note"}},
                    {"field.object": {"name": "b", "@objectRef": "acme::beta::Note"}},
                )
            ],
        ),
    )


def _gen(root, out: Path, layout: str):
    return run_gen(
        GenConfig(out_dir=str(out), output_layout=layout),
        root,
        generators=[entity_model(), names_generator(), filter_allowlist_generator()],
    )


# -- the helper ---------------------------------------------------------------------------


def test_helper_paths_and_specifiers() -> None:
    assert ip.output_path("flat", "acme::alpha", "Note.py") == "Note.py"
    assert ip.output_path("package", "acme::alpha", "Note.py") == "acme/alpha/Note.py"
    assert ip.output_path("package", "", "Note.py") == "Note.py"
    assert ip.module_specifier("flat", "acme::a", "acme::b", "Note") == ".Note"
    assert ip.module_specifier("package", "acme::alpha", "acme::alpha", "Note") == ".Note"
    assert ip.module_specifier("package", "acme::alpha", "acme::beta", "Note") == "..beta.Note"
    assert ip.module_specifier("package", "acme::alpha", "other::x", "Note") == "...other.x.Note"
    assert ip.module_specifier("package", "acme::alpha", "", "Note") == "...Note"
    assert ip.module_specifier("package", "", "acme::alpha", "Note") == ".acme.alpha.Note"
    assert ip.root_module_specifier("package", "acme::alpha", "enums") == "...enums"
    assert ip.root_module_specifier("flat", "acme::alpha", "enums") == ".enums"


def test_layout_is_validated() -> None:
    with pytest.raises(ValueError, match="flat"):
        GenConfig(out_dir="x", output_layout="nested")


# -- collisions -----------------------------------------------------------------------------


def test_flat_layout_refuses_a_same_named_pair_naming_both_nodes(tmp_path: Path) -> None:
    with pytest.raises(ValueError) as exc:
        _gen(_two_notes(), tmp_path / "gen", "flat")
    msg = str(exc.value)
    assert ERR_NAME_COLLISION in msg
    assert "acme::alpha::Note" in msg and "acme::beta::Note" in msg
    assert 'output_layout: "package"' in msg


def test_package_layout_places_each_note_in_its_own_package(tmp_path: Path) -> None:
    out = tmp_path / "gen"
    _gen(_two_notes(), out, "package")
    assert (out / "acme" / "alpha" / "Note.py").is_file()
    assert (out / "acme" / "beta" / "Note.py").is_file()
    assert (out / "acme" / "app" / "Digest.py").is_file()
    assert not (out / "Note.py").exists()
    for d in ("acme", "acme/alpha", "acme/beta", "acme/app"):
        assert (out / d / "__init__.py").is_file(), d
    digest = (out / "acme" / "app" / "Digest.py").read_text()
    assert "from ..alpha.Note import Note as AcmeAlphaNote" in digest
    assert "from ..beta.Note import Note as AcmeBetaNote" in digest
    # the type itself is never renamed
    assert "class Note(BaseModel)" in (out / "acme" / "alpha" / "Note.py").read_text()


def test_package_layout_output_imports_and_works(tmp_path: Path) -> None:
    out = tmp_path / "pkgout"
    _gen(_two_notes(), out, "package")
    sys.path.insert(0, str(tmp_path))
    try:
        digest = importlib.import_module("pkgout.acme.app.Digest")
        alpha = importlib.import_module("pkgout.acme.alpha.Note")
        beta = importlib.import_module("pkgout.acme.beta.Note")
        d = digest.Digest(a=alpha.Note(alphaOnly="x"), b=beta.Note(betaOnly=3))
        assert d.a.alphaOnly == "x" and d.b.betaOnly == 3
        assert alpha.Note is not beta.Note
    finally:
        sys.path.remove(str(tmp_path))
        for name in [m for m in sys.modules if m.split(".")[0] == "pkgout"]:
            del sys.modules[name]


def test_two_objects_in_one_package_dir_still_collide_in_package_layout() -> None:
    """An abstract object emits nothing for the names generator; two *emitting* entities with
    one name in one directory cannot be loaded at all (the loader's own-package uniqueness), so
    the registry is exercised directly."""
    from metaobjects.codegen.name_claims import NameClaims

    claims = NameClaims()
    claims.claim("dir", "Note", "acme::a::Note", "rename one")
    claims.claim("dir", "Note", "acme::a::Note", "rename one")  # same claimant: fine
    claims.claim("other", "Note", "acme::b::Note", "rename one")  # other scope: fine
    with pytest.raises(ValueError, match=ERR_NAME_COLLISION):
        claims.claim("dir", "Note", "acme::b::Note", "rename one")


def test_flat_output_is_unchanged_for_a_model_without_a_clash(tmp_path: Path) -> None:
    root = _load(("acme::alpha", [_value("Note")]), ("acme::app", [_value("Digest",
                 {"field.object": {"name": "a", "@objectRef": "acme::alpha::Note"}})]))
    out = tmp_path / "gen"
    _gen(root, out, "flat")
    assert sorted(p.name for p in out.glob("*.py")) == ["Digest.py", "Note.py", "__init__.py"]
    assert "from .Note import Note" in (out / "Digest.py").read_text()


def test_a_derived_alias_landing_on_another_objects_name_is_refused(tmp_path: Path) -> None:
    """`AcmeAlphaNote` derived for ``acme::alpha::Note`` must not be a real object's name: a
    file that references both would bind one name twice (with ``from __future__ import
    annotations`` Pydantic resolves the field against the second binding, silently)."""
    root = _load(
        ("acme::alpha", [_value("Note")]),
        ("acme::beta", [_value("Note")]),
        ("acme", [_value("AcmeAlphaNote")]),
    )
    with pytest.raises(ValueError) as exc:
        _gen(root, tmp_path / "gen", "package")
    msg = str(exc.value)
    assert ERR_NAME_COLLISION in msg
    assert "acme::alpha::Note" in msg and "acme::AcmeAlphaNote" in msg
    assert "AcmeAlphaNote" in msg


# -- a tree Python cannot import is refused ------------------------------------------------


def _enum_consumer(pkg: str):
    """A shared enum at the root (so `enums.py` is emitted) and a value object in *pkg*."""
    return _load(
        ("", [{"field.enum": {"name": "Tier", "abstract": True, "@values": ["GOLD", "FREE"]}}]),
        (pkg, [_value("Plan", {"field.enum": {"name": "tier", "extends": "Tier"}})]),
    )


def test_a_package_directory_that_shadows_a_root_module_is_a_name_collision(tmp_path: Path) -> None:
    # A top-level package `enums` makes `enums/` win over the shared `enums.py`.
    with pytest.raises(ValueError, match=rf'{ERR_NAME_COLLISION}: the generated package directory "enums/"'):
        _gen(_enum_consumer("enums::billing"), tmp_path / "out", ip.OUTPUT_LAYOUT_PACKAGE)
    # The flat layout has no package directories, so the same model generates.
    _gen(_enum_consumer("enums::billing"), tmp_path / "flat", ip.OUTPUT_LAYOUT_FLAT)
    assert (tmp_path / "flat" / "Plan.py").is_file()


def test_a_package_segment_that_is_not_an_identifier_is_refused(tmp_path: Path) -> None:
    root = _load(("my-co::billing", [_value("Plan")]))
    with pytest.raises(ValueError, match=r'"my-co" is not a Python identifier'):
        _gen(root, tmp_path / "out", ip.OUTPUT_LAYOUT_PACKAGE)
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").rglob("*.py"))

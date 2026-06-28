from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.generator import (
    EmittedFile,
    GenContext,
    once_per_run,
    per_model,
    per_package,
)

CORPUS = Path(__file__).resolve().parents[4] / "fixtures" / "template-codegen-conformance"


def _ctx() -> GenContext:
    root = MetaDataLoader.from_directory(str(CORPUS / "metadata")).root
    objs = [c for c in root.children() if isinstance(c, MetaObject)]
    return GenContext(
        entities=objs, loaded_root=root, matches=lambda e: True,
        config=None, warn=lambda m: None,
    )


def test_per_package_one_file_per_package_sorted() -> None:
    ctx = _ctx()
    seen: list[str] = []

    def fn(pkg, ents, _ctx):
        seen.append(pkg)
        return EmittedFile(path=f"{pkg or '_'}/out.txt", content=str(len(ents)))

    files = per_package(fn)(ctx)
    from metaobjects.codegen.template_codegen.template_data import package_of

    pkgs = sorted({package_of(e) for e in ctx.entities})
    assert seen == pkgs
    assert len(files) == len(pkgs)


def test_per_model_is_once_per_run_alias() -> None:
    assert per_model is once_per_run
    ctx = _ctx()
    calls = {"n": 0}

    def fn(ents, _ctx):
        calls["n"] += 1
        return EmittedFile(path="all.txt", content=str(len(ents)))

    files = per_model(fn)(ctx)
    assert calls["n"] == 1
    assert len(files) == 1

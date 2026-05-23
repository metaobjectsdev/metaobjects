from metaobjects.codegen.generator import EmittedFile, GenContext, per_entity, once_per_run
from metaobjects.codegen.config import GenConfig
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _ctx(entities, matches=lambda e: True):
    return GenContext(entities=entities, loaded_root=None, matches=matches,
                      config=GenConfig(out_dir="o"), warn=lambda m: None)


def _obj(name):
    return MetaObject(TYPE_OBJECT, "entity", name)


def test_per_entity_runs_for_matched_only():
    objs = [_obj("A"), _obj("B")]
    gen = per_entity(lambda e, ctx: EmittedFile(path=f"{e.name}.py", content="x"))
    ctx = _ctx(objs, matches=lambda e: e.name == "A")
    files = gen(ctx)
    assert [f.path for f in files] == ["A.py"]


def test_once_per_run_called_once_with_all_matched():
    objs = [_obj("A"), _obj("B")]
    seen = {}

    def fn(entities, ctx):
        seen["names"] = [e.name for e in entities]
        return EmittedFile(path="barrel.py", content="x")

    files = once_per_run(fn)(_ctx(objs))
    assert seen["names"] == ["A", "B"]
    assert [f.path for f in files] == ["barrel.py"]

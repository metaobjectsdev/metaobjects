"""Runtime drift (Python half): a template variable that is not on the payload raises.

Shared corpus: ``fixtures/template-output-render-conformance/runtime-drift/``. The helpers are
generated against the clean ``templates/``; ``runtime-drift/templates/`` holds the same ref
with ``{{nmae}}`` for ``name``, standing in for text edited after codegen. The build-time gate
cannot see that, so the helper itself must raise at render time (``ERR_VAR_NOT_ON_PAYLOAD``)
instead of rendering ``Hello `` — for ``template.output`` and ``template.prompt``, Mustache.
"""
from __future__ import annotations

import pytest

from metaobjects.render.renderer import RenderError
from metaobjects.render.filesystem_provider import FilesystemProvider
from metaobjects.codegen.generators.render_helper_generator import RenderHelperGenerator
from importlib import import_module

from tests.codegen.test_render_helper_conformance import CORPUS, _ctx, _load_root, _materialize_and_import, _models

CLEAN = str(CORPUS / "templates")
DRIFTED = str(CORPUS / "runtime-drift" / "templates")


@pytest.mark.parametrize(
    ("module", "fn"),
    [
        ("welcome_page_render_helper", "render_welcome_page"),
        ("welcome_prompt_render_helper", "render_welcome_prompt"),
    ],
)
def test_helper_raises_on_variable_not_on_payload(tmp_path, module, fn) -> None:
    root = _load_root(CORPUS / "runtime-drift" / "meta.json")
    files = [f for f in RenderHelperGenerator(CLEAN).generate(_ctx(root)) if f.path == f"{module}.py"]
    assert len(files) == 1
    _materialize_and_import([*files, *_models(root)], tmp_path)
    helper = import_module(f"_rh_conf_pkg.{module}")
    render = getattr(helper, fn)

    assert render({"name": "Ada"}, FilesystemProvider(CLEAN)) == "Hello Ada"
    with pytest.raises(RenderError, match=r"ERR_VAR_NOT_ON_PAYLOAD \(nmae\)"):
        render({"name": "Ada"}, FilesystemProvider(DRIFTED))

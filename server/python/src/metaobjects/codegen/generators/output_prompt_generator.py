"""Output-prompt codegen — one ``<name>_output_prompt.py`` per json/xml
``template.output`` declaration.

FR-010 artifact 1 (Python port). For each ``template.output`` whose ``@format`` is
``json`` or ``xml`` and whose ``@payloadRef`` resolves to an ``object.value``, emits a
module exposing ``render_<name>_format(overrides=None) -> str`` backed by the render
engine's :func:`~metaobjects.render.render_output_format` (the "produce your answer
like this" fragment).

The baked :class:`~metaobjects.render.OutputFormatSpec`'s ``root_name`` is the payload
class name, so the prompt fragment and the ``extract_<name>()`` codegen agree on the
root element/object name. Mirrors the C# ``OutputPromptGenerator`` / Java
``SpringOutputPromptGenerator``. Skips: ``template.prompt``, missing/unresolved
``@payloadRef``, and ``@format`` values other than json/xml.
"""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen import output_format_spec_emitter as ofs
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.generators.payload_vo_generator import (
    payload_class_name,
    resolve_payload_vo,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.shared.base_types import TYPE_TEMPLATE

_GENERATOR_NAME = "output-prompt-generator"

# Only structured formats get a renderable output-format fragment.
_PROMPT_FORMATS = frozenset({tc.TEMPLATE_FORMAT_JSON, tc.TEMPLATE_FORMAT_XML})


def _emit_format_spec(
    payload: MetaObject, template: MetaData, root_name: str
) -> str:
    """The baked ``OutputFormatSpec`` literal. Module-level back-compat shim; the
    override seam is :meth:`OutputPromptGenerator._emit_format_spec`."""
    return ofs.spec_literal(payload, template, root_name)


def render_output_prompt(
    template: MetaData,
    root: MetaData,
    *,
    generator: "OutputPromptGenerator | None" = None,
) -> str | None:
    """Render one output-prompt module for a json/xml ``template.output`` node.

    When *generator* is supplied, its ``_emit_format_spec`` override is used to bake
    the ``OutputFormatSpec`` literal (the extension seam); when ``None`` the
    module-level default is used (byte-identical back-compat path).

    Returns ``None`` when the format is unsupported (not json/xml) or the
    ``@payloadRef`` can't be resolved to an ``object.value`` (defensive — the loader
    validation pass / the parser generator share this contract)."""
    fmt = template.attr(tc.TEMPLATE_ATTR_FORMAT)
    fmt_str = fmt if isinstance(fmt, str) else tc.TEMPLATE_FORMAT_DEFAULT
    if fmt_str.lower() not in _PROMPT_FORMATS:
        return None

    payload_ref = template.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    payload = resolve_payload_vo(root, payload_ref)
    if payload is None:
        return None

    template_name = template.name
    snake = _snake_case(template_name)
    render_fn = f"render_{snake}_format"
    # root_name == payload class name so the fragment and extract() agree.
    root_name = payload_class_name(template_name)
    emit_spec = generator._emit_format_spec if generator is not None else _emit_format_spec
    spec_literal = emit_spec(payload, template, root_name)

    fqn = (
        f"{payload.package}::{template_name}"
        if payload.package
        else template_name
    )

    lines: list[str] = [
        generated_header(template_name, fqn),
        "from __future__ import annotations\n",
        "from metaobjects.render import (",
        "    PROMPT_OVERRIDES_NONE,",
        "    FieldKind,",
        "    Format,",
        "    OutputFormatSpec,",
        "    PromptField,",
        "    PromptOverrides,",
        "    PromptStyle,",
        "    render_output_format,",
        ")",
        "",
        "",
        "# FR-010 artifact 1 — the baked output-format descriptor for this template.",
        f"_SPEC: OutputFormatSpec = {spec_literal}",
        "",
        "",
        f"def {render_fn}(overrides: PromptOverrides | None = None) -> str:",
        '    """The output-format instruction fragment ("produce your answer like this").',
        "",
        "    A comment-free guide / inline / example-only fragment teaching an LLM how to",
        "    shape its answer. Pass ``overrides`` to swap the style or override a field's",
        '    example / instruction at render time."""',
        "    return render_output_format(_SPEC, overrides or PROMPT_OVERRIDES_NONE)",
        "",
        "",
        f'__all__ = ["{render_fn}"]',
        "",
    ]
    return "\n".join(lines)


class OutputPromptGenerator:
    """Generator wrapping :func:`render_output_prompt`. Emits one file per json/xml
    ``template.output`` declared at root level."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        # ``filter`` matches the cross-generator contract even though this generator
        # iterates templates (not entities).
        self.filter = filter

    def _emit_format_spec(
        self, payload: MetaObject, template: MetaData, root_name: str
    ) -> str:
        """EXTENSION SEAM — the baked ``OutputFormatSpec`` literal. Defaults to the
        module-level :func:`_emit_format_spec`; override to inject custom field
        examples / instructions / style into the prompt fragment descriptor."""
        return _emit_format_spec(payload, template, root_name)

    def _render_module(self, template: MetaData, root: MetaData) -> str | None:
        """EXTENSION SEAM — render the whole output-prompt module for one
        ``template.output``. Defaults to :func:`render_output_prompt` (passing this
        instance so the ``_emit_format_spec`` override is honored). Override to
        pre/post-process the emitted source or replace the render path."""
        return render_output_prompt(template, root, generator=self)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        outputs = sorted(
            (
                c
                for c in root.own_children()
                if c.type == TYPE_TEMPLATE and c.sub_type == tc.TEMPLATE_SUBTYPE_OUTPUT
            ),
            key=lambda c: c.name,
        )
        for tmpl in outputs:
            content = self._render_module(tmpl, root)
            if content is None:
                # Not an error — text-format outputs and unresolved payloads are
                # simply skipped (no prompt fragment), matching the C# contract.
                continue
            files.append(
                EmittedFile(
                    path=f"{_snake_case(tmpl.name)}_output_prompt.py",
                    content=ruff_format(content),
                )
            )
        return files


def output_prompt_generator(
    *, filter: Callable[[MetaObject], bool] | None = None
) -> Generator:
    """Factory mirroring the C# ``OutputPromptGenerator`` / Java
    ``SpringOutputPromptGenerator``."""
    return OutputPromptGenerator(filter=filter)
